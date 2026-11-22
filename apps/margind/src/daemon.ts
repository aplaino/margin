import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import {
  BlockList,
  type ChatMessage,
  type ClientFrame,
  CONTROL,
  Config,
  Control,
  Count,
  Directory,
  Findable,
  type Friend,
  FriendList,
  PeerBundle,
  PROTOCOL,
  type PublicPresence,
  type Push,
  ReporterEvent,
  Request,
  Requests,
  type ServerFrame,
  Session,
  type Settings,
} from '@margin/protocol';
import * as v from 'valibot';
import { Api, ApiError } from './api';
import { Connection, type ConnectionState } from './connection';
import { type DeviceLogin, GitHubError, githubDeviceLogin } from './github';
import { idleSeconds } from './idle';
import type { KeyProvider } from './keychain';
import { defaultLocalModels, type LocalModelSources, LocalModels } from './local-models';
import { onLines, sendOnce, write } from './net';
import type { Paths } from './paths';
import {
  assertPublic,
  buildView,
  localSecrets,
  type PresenceView,
  shareable,
  withoutLocalDetails,
} from './presence';
import { type FetchRepo, originRepo, repoClassifier } from './repo';
import { Reports, stackOf } from './reports';
import { Sessions } from './sessions';
import { changedKey, healable, PREKEY_BATCH, Signal } from './signal';
import { Store } from './store';
import { scanTokens, type TokenSources } from './tokens';
import {
  connectTool,
  disconnectTool,
  repointTools,
  type ToolEnv,
  ToolError,
  toolStatus,
} from './tools';

export type DaemonOptions = {
  paths: Paths;
  keys: KeyProvider;
  server: string;
  tools: ToolEnv;
  tokenSources: TokenSources;
  // Development and tests: sign in through the server's dev login as this handle.
  devHandle?: string;
  devName?: string;
  // The GitHub OAuth app's client id, fixed per build.
  githubClientId?: string;
  deviceLogin?: DeviceLogin;
  fetchRepo?: FetchRepo;
  idle?: () => Promise<number>;
  isAlive?: (pid: number) => boolean;
  heartbeatMs?: number;
  tokenScanMs?: number;
  localModels?: LocalModelSources;
  localModelMs?: number;
  // The app's version, for crash reports, and where macOS keeps crash reports (tests).
  version?: string;
  crashLogs?: string;
};

const KeyCount = v.object({ remaining: Count });

const IDLE_AFTER_S = 5 * 60;
const STALE_MS = 90_000;
const PREKEY_LOW = 20;

// Other errors can carry paths, so only Margin's own messages are logged (or reported) in full.
const ownError = (e: unknown) =>
  e instanceof ApiError ||
  e instanceof DaemonError ||
  e instanceof GitHubError ||
  e instanceof ToolError;
const log = (what: string, e?: unknown) => {
  const own = ownError(e);
  const detail = e
    ? ` (${(e as Error).name ?? 'error'}${own ? `: ${(e as Error).message}` : ''})`
    : '';
  console.error(`[margind] ${what}${detail}`);
};

// Received chat text keeps newlines, tabs and joiners; every other control or format character goes.
// How long after sending a message you can still Undo Send.
const UNSEND_MS = 24 * 60 * 60_000;

function cleanChat(text: string) {
  const cleaned = text.replace(CONTROL, (c) => ('\t\n‌‍'.includes(c) ? c : '')).slice(0, 4000);
  return cleaned.trim() ? cleaned : null;
}

const errorText = (e: unknown) =>
  e instanceof ApiError ||
  e instanceof DaemonError ||
  e instanceof GitHubError ||
  e instanceof ToolError
    ? e.message
    : 'Something went wrong';

class DaemonError extends Error {}

export async function startDaemon(options: DaemonOptions) {
  const { paths } = options;
  if (existsSync(paths.socket)) {
    if (await sendOnce(paths.socket, { op: 'ping' }, 500))
      throw new DaemonError('margind is already running');
    unlinkSync(paths.socket);
  }

  const store = new Store(paths.db, options.keys(`db:${paths.home}`));
  // A build pointed at another server signs out of the old one (and forgets its friend
  // list) rather than keep reaching for it.
  const saved = store.account();
  if (saved && saved.server !== options.server) {
    store.setAccount(undefined);
    for (const friend of store.friends()) store.removeFriend(friend.handle, { keepSession: true });
    store.delete('friendLastSeen');
  }
  const signal = new Signal(store);
  const sessions = new Sessions(options.isAlive);
  const classify = repoClassifier(options.fetchRepo);
  const idle = options.idle ?? idleSeconds;
  const subscribers = new Set<Socket>();
  const friendPresence = new Map<string, { presence: PublicPresence; receivedAt: number }>();
  // When each friend was last online or idle, kept across restarts for the offline list.
  const lastSeen = new Map(
    Object.entries(store.getJson<Record<string, number>>('friendLastSeen') ?? {}),
  );
  let lastSeenSavedAt = 0;
  let requests: Requests = { incoming: [], outgoing: [] };
  let connection: Connection | undefined;
  let connectionState: ConnectionState | 'update-required' = 'offline';
  let view: PresenceView | undefined;
  let tokens = store.tokenTotal();
  let stopped = false;

  const account = () => store.account();
  const api = () => {
    const a = account();
    if (!a) throw new DaemonError('Sign in first');
    return new Api(a.server, a.token);
  };

  const push = (value: Push) => {
    for (const socket of subscribers) write(socket, value);
  };

  const reports = new Reports(paths.home, options.version ?? 'dev', options.crashLogs);
  // What mustn't leave this Mac in a report: your handle, friends' handles and names, repo
  // overrides, and local folders and session ids.
  const reportSecrets = () => [
    ...localSecrets(sessions.list()),
    ...(account()?.handle ? [account()?.handle ?? ''] : []),
    ...store.friends().flatMap((f) => [f.handle, ...(f.name ? [f.name] : [])]),
    ...Object.keys(store.settings().repos).flatMap((repo) => [repo, ...repo.split('/')]),
  ];
  // Being offline isn't a problem worth reporting.
  const offline = (e: unknown) =>
    e instanceof Error &&
    (e.name === 'TimeoutError' ||
      e.name === 'AbortError' ||
      /Connection|ECONN|Socket|ENOTFOUND|ENETUNREACH|EHOSTUNREACH/i.test(
        String((e as { code?: unknown }).code ?? ''),
      ));
  // A serious error: logged as before, and kept as a report the app offers to send.
  const problem = (what: string, e?: unknown) => {
    log(what, e);
    if (offline(e)) return;
    const error = e instanceof Error ? e : undefined;
    reports.add(
      {
        component: 'margind',
        kind: 'error',
        what: error ? `${what} (${error.name})` : what,
        detail: [
          error ? stackOf(error, ownError(error)) : '',
          '',
          'recent log:',
          reports.logTail(),
        ].join('\n'),
      },
      reportSecrets(),
    );
    push({ type: 'reports', ...reports.state() });
  };

  const savedTokens = () => store.getJson<Record<string, number>>('friendTokens') ?? {};

  function roster(): Friend[] {
    const now = Date.now();
    const lastTokens = savedTokens();
    return store.friends().map((f) => {
      const seen = friendPresence.get(f.handle);
      const fresh = seen && now - seen.receivedAt < STALE_MS;
      const known = seen?.presence.tokens ?? lastTokens[f.handle];
      const presence: PublicPresence = fresh
        ? {
            ...seen.presence,
            ...(seen.presence.status === 'offline' && known !== undefined ? { tokens: known } : {}),
          }
        : {
            status: 'offline',
            at: seen?.presence.at ?? 0,
            ...(known !== undefined ? { tokens: known } : {}),
          };
      return {
        handle: f.handle,
        ...(f.name ? { name: f.name } : {}),
        presence,
        lastSeenAt: lastSeen.get(f.handle) ?? 0,
        unread: store.unread(f.handle),
      };
    });
  }

  function selfPush(): Push {
    const a = account();
    return {
      type: 'self',
      ...(a ? { handle: a.handle } : {}),
      ...(a?.name ? { name: a.name } : {}),
      ...(view ? { presence: view.full, basic: view.basic } : {}),
      tokens,
      connection: !a ? 'signed-out' : connectionState,
      protocol: PROTOCOL,
    };
  }

  // The latest message in each chat with a current friend, for the Chats tab; the app keeps
  // it current from message pushes.
  const chats = (): Push => ({
    type: 'chats',
    chats: store.latest().filter((m) => store.friend(m.peer)),
  });

  const pushAll = () => {
    push(selfPush());
    push({ type: 'settings', settings: store.settings() });
    push({ type: 'tools', tools: toolStatus(options.tools) });
    push({ type: 'roster', friends: roster() });
    push({ type: 'requests', requests });
    push(chats());
  };

  // What friends see, recomputed from sessions, settings, idle time and tokens.
  // Recalculations overlap (a heartbeat and a tool event, say); one that a newer one has
  // overtaken is dropped, so stale activity never overwrites fresh.
  let generation = 0;
  async function recompute() {
    const mine = ++generation;
    const settings = store.settings();
    const session = sessions.current();
    const status = (await idle()) > IDLE_AFTER_S ? 'idle' : 'online';
    const remote = session?.cwd ? originRepo(session.cwd) : null;
    const activity =
      session && !settings.invisible
        ? shareable(session, await classify(remote), remote, settings)
        : undefined;
    let next = buildView({ status, activity, tokens, settings });
    const secrets = localSecrets(sessions.list());
    const full = withoutLocalDetails(next.full, secrets);
    try {
      assertPublic(full, secrets);
      assertPublic(next.basic, secrets);
      next = { ...next, full };
    } catch {
      // Fail closed: status (and tokens) only.
      problem('withheld activity that failed the privacy check');
      next = buildView({ status, tokens, settings });
    }
    if (mine !== generation) return;
    view = next;
    sendPresence();
    push(selfPush());
  }

  // Targeted view first, so close friends never flicker to the basic one.
  // Sent when it changes, and at least every 25 s so friends don't see you go stale (they
  // treat 90 s of silence as offline). The server caps how often presence may be sent.
  let lastSent = '';
  let lastSentAt = 0;
  let closeViewSent = false;
  function sendPresence(force = false) {
    if (!view || !connection?.connected) return;
    const key = JSON.stringify({
      ...view,
      full: { ...view.full, at: 0 },
      basic: { ...view.basic, at: 0 },
    });
    if (!force && key === lastSent && Date.now() - lastSentAt < 25_000) return;
    lastSent = key;
    lastSentAt = Date.now();
    // An empty list ends the close-friends view (invisible, or close friends only turned off),
    // so close friends don't keep seeing the activity they saw before.
    if (view.close.length || closeViewSent) {
      connection.send({ t: 'presence', presence: view.full, to: view.close });
    }
    closeViewSent = view.close.length > 0;
    connection.send({ t: 'presence', presence: view.basic });
  }

  async function refreshTokens() {
    try {
      const next = await scanTokens(store, options.tokenSources);
      if (next !== tokens) {
        tokens = next;
        await recompute();
      }
    } catch (e) {
      problem('token scan failed', e);
    }
  }

  // Mirror the server's friend list, pinning identity keys for new friends.
  async function syncFriends() {
    const client = api();
    const { friends } = await client.call(FriendList, 'GET', '/friends');
    requests = await client.call(Requests, 'GET', '/friends/requests');
    // Removals first, so nothing that goes wrong fetching keys can keep a removed friend.
    const current = new Set(friends.map((f) => f.handle));
    for (const { handle } of store.friends()) {
      if (!current.has(handle)) {
        store.removeFriend(handle);
        friendPresence.delete(handle);
        lastSeen.delete(handle);
      }
    }
    for (const friend of friends) {
      store.upsertFriend(friend.handle, friend.name);
      if (store.friend(friend.handle)?.identityKey) continue;
      // One friend's bad or missing keys don't stop the rest of the sync.
      await fetchBundle(friend.handle).catch((e) => problem('could not pin a friend’s keys', e));
    }
    push({ type: 'roster', friends: roster() });
    push({ type: 'requests', requests });
  }

  async function fetchBundle(handle: string) {
    try {
      const bundle = await api().call(PeerBundle, 'GET', `/keys/${handle}`);
      store.pin(handle, bundle);
      // A new identity key is trusted in the background (as Signal does by default): the
      // old session can't reach them any more. The safety number shows the new key.
      const pinned = store.friend(handle)?.identityKey;
      if (pinned && pinned !== bundle.identityKey) {
        log(`${handle}'s identity key changed`);
        store.repin(handle, bundle.identityKey);
        store.removeSignalSessions(handle);
      }
    } catch (e) {
      // They may not have published keys yet; the next sync tries again.
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
  }

  async function topUpPreKeys(remaining?: number) {
    const client = api();
    // An unreadable count throws and skips this round; the next sync tries again.
    const count = remaining ?? (await client.call(KeyCount, 'GET', '/keys/count')).remaining;
    if (count >= PREKEY_LOW) return;
    const preKeys = signal.replenish(PREKEY_BATCH);
    if (preKeys.length) await client.call(null, 'POST', '/keys/prekeys', { preKeys });
  }

  function flushOutbox() {
    for (const item of store.outbox()) {
      if (!connection?.send(item.frame as ClientFrame)) return;
    }
  }

  async function onPresence(from: string, presence: PublicPresence) {
    if (!store.friend(from)) return;
    const now = Date.now();
    const before = friendPresence.get(from);
    friendPresence.set(from, { presence, receivedAt: now });
    // Online and idle say they were here; offline only marks the moment they left.
    const wasHere =
      before && before.presence.status !== 'offline' && now - before.receivedAt < STALE_MS;
    if (presence.status !== 'offline' || wasHere) {
      lastSeen.set(from, now);
      // Saved when they leave, and at most once a minute while they're here.
      if (presence.status === 'offline' || now - lastSeenSavedAt > 60_000) {
        store.setJson('friendLastSeen', Object.fromEntries(lastSeen));
        lastSeenSavedAt = now;
      }
    }
    // Going offline carries no count, so the last one is kept for the offline list. Online
    // without one means they've chosen to hide it, so it's forgotten.
    if (presence.status !== 'offline') {
      const { [from]: _, ...others } = savedTokens();
      store.setJson(
        'friendTokens',
        presence.tokens === undefined ? others : { ...others, [from]: presence.tokens },
      );
    }
    push({ type: 'roster', friends: roster() });
  }

  async function onMessage(frame: Extract<ServerFrame, { t: 'message' }>) {
    const ack = () => connection?.send({ t: 'ack', id: frame.id });
    if (store.hasMessage(frame.id)) return ack();
    if (!store.friend(frame.from)?.identityKey) await syncFriends().catch(() => {});
    if (!store.friend(frame.from)) return ack();
    let text: string | null;
    try {
      text = cleanChat(await signal.decrypt(frame.from, frame.ciphertext));
    } catch (e) {
      // From a new identity key: trusted if it's the key the server has for them now, then
      // the message is asked for again on a session with that key.
      const key = changedKey(e);
      if (key) {
        if (await keyNowTrusted(frame.from, key)) askToResend(frame.from, frame.id);
        return ack();
      }
      // Retrying this frame can't help, so it's dropped rather than jam the queue. A lost
      // session asks the sender to start a new one and send it again.
      problem('dropped a message that could not be decrypted', e);
      if (healable(e)) askToResend(frame.from, frame.id);
      return ack();
    }
    if (!text) return ack();
    const message: ChatMessage = {
      id: frame.id,
      peer: frame.from,
      direction: 'in',
      text,
      sentAt: frame.sentAt,
    };
    store.saveMessage(message);
    ack();
    push({ type: 'message', message });
    push({ type: 'roster', friends: roster() });
  }

  // A control from a friend: an Undo Send is honoured for their own message, if it was
  // asked for within a day of sending (a little longer, for clocks and slow delivery).
  async function onControl(frame: Extract<ServerFrame, { t: 'control' }>) {
    const ack = () => connection?.send({ t: 'ack', id: frame.id });
    if (!store.friend(frame.from)) return ack();
    let control: Control;
    try {
      control = v.parse(Control, JSON.parse(await signal.decrypt(frame.from, frame.ciphertext)));
    } catch (e) {
      problem('dropped a control that could not be read', e);
      return ack();
    }
    const original = store.message(control.id);
    if (
      original?.peer === frame.from &&
      original.direction === 'in' &&
      original.state !== 'unsent' &&
      frame.sentAt - original.sentAt <= UNSEND_MS + 5 * 60_000
    ) {
      store.unsend(control.id);
      chatChanged(frame.from, control.id);
    }
    ack();
  }

  // The app redraws a changed message in place; the Chats tab and unread counts follow.
  function chatChanged(peer: string, id?: string) {
    const message = id ? store.message(id) : undefined;
    if (message) push({ type: 'message', message });
    else push({ type: 'history', with: peer, messages: store.history(peer) });
    push(chats());
    push({ type: 'roster', friends: roster() });
  }

  // Undo Send: tells the friend's margind to remove it too. One still waiting to leave this
  // Mac never goes.
  async function unsend(id: string) {
    const message = store.message(id);
    if (message?.direction !== 'out' || message.state === 'unsent') {
      throw new DaemonError('Only your own messages can be unsent');
    }
    if (Date.now() - message.sentAt > UNSEND_MS) {
      throw new DaemonError('Messages can only be unsent within 24 hours');
    }
    const to = message.peer;
    if (!store.friend(to)) throw new DaemonError(`${to} isn’t your friend`);
    store.dequeue(id);
    if (!signal.hasSession(to) && !store.bundle(to)) await fetchBundle(to);
    const control: Control = { t: 'unsend', id };
    const ciphertext = await signal.encrypt(to, JSON.stringify(control), store.bundle(to));
    const frame: ClientFrame = {
      t: 'send',
      id: crypto.randomUUID(),
      to,
      ciphertext,
      control: true,
    };
    store.transaction(() => {
      store.unsend(id);
      store.enqueue(frame.id, to, frame);
    });
    chatChanged(to, id);
    connection?.send(frame);
  }

  // At most 20 resend requests a minute to each friend.
  const resendAsks = new Map<string, number[]>();
  function askToResend(from: string, id: string) {
    const now = Date.now();
    const recent = (resendAsks.get(from) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= 20) return;
    resendAsks.set(from, [...recent, now]);
    connection?.send({ t: 'reset', to: from, id });
  }

  // A friend couldn't read one of your messages: start a new session from fresh keys (once,
  // however many messages they ask about) and send that message again.
  const lastReset = new Map<string, number>();
  async function onReset(from: string, id: string) {
    if (!store.friend(from)) return;
    const now = Date.now();
    if (now - (lastReset.get(from) ?? 0) > 60_000) {
      lastReset.set(from, now);
      store.removeSignalSessions(from);
      await fetchBundle(from);
    }
    const original = store.message(id);
    if (original?.direction !== 'out' || original.peer !== from || !store.bundle(from)) return;
    const ciphertext = await signal.encrypt(from, original.text, store.bundle(from));
    // A new id: the server has already delivered the old one. The chat keeps the original.
    const frame: ClientFrame = { t: 'send', id: crypto.randomUUID(), to: from, ciphertext };
    store.enqueue(frame.id, from, frame);
    connection?.send(frame);
  }

  // Checks a key a message arrived with against the server's current one, at most once a
  // minute per friend (each check uses up one of their prekeys).
  const lastKeyCheck = new Map<string, number>();
  async function keyNowTrusted(handle: string, key: string) {
    const now = Date.now();
    if (now - (lastKeyCheck.get(handle) ?? 0) > 60_000) {
      lastKeyCheck.set(handle, now);
      await fetchBundle(handle).catch((e) => problem('could not check a friend’s new keys', e));
    }
    return store.friend(handle)?.identityKey === key;
  }

  function onFrame(frame: ServerFrame) {
    const handle = async () => {
      switch (frame.t) {
        case 'presence':
          return onPresence(frame.from, frame.presence);
        case 'message':
          return onMessage(frame);
        case 'control':
          return onControl(frame);
        case 'reset':
          return onReset(frame.from, frame.id);
        case 'accepted': {
          store.dequeue(frame.id);
          store.setMessageState(frame.id, 'sent');
          const message = store.message(frame.id);
          if (message) push({ type: 'message', message });
          return;
        }
        case 'rejected':
          store.dequeue(frame.id);
          log('the server refused a message');
          return;
        case 'friends-changed':
          return syncFriends();
        case 'prekeys-low':
          return topUpPreKeys(frame.remaining);
        case 'error':
          log('the server reported an error');
          return;
      }
    };
    // Frames are handled in order, so a message never races the friend sync it needs.
    frames = frames.then(handle).catch((e) => problem(`handling ${frame.t} failed`, e));
  }
  let frames: Promise<unknown> = Promise.resolve();

  function connect() {
    const a = account();
    if (!a || stopped) return;
    connection?.stop();
    const client = new Api(a.server);
    connection = new Connection(a.server, a.token, {
      beforeConnect: async () => {
        try {
          await client.call(Config, 'GET', '/config');
          await client.withToken(a.token).call(null, 'GET', '/me');
          return true;
        } catch (e) {
          if (e instanceof ApiError && e.status === 426) {
            connectionState = 'update-required';
            push(selfPush());
            return false;
          }
          // The server no longer knows this session (signed out elsewhere, or reset).
          if (e instanceof ApiError && e.status === 401) {
            signOutLocally();
            return false;
          }
          return true;
        }
      },
      onState: (state) => {
        connectionState = state;
        push(selfPush());
        if (state === 'online') {
          // The server starts each connection knowing nothing about you.
          sendPresence(true);
          flushOutbox();
          void syncFriends()
            .then(() => topUpPreKeys())
            .catch((e) => log('sync after connecting failed', e));
          syncFindable();
        }
      },
      onFrame,
      onSessionEnded: () => {
        signOutLocally();
      },
    });
    void connection.start();
  }

  function signOutLocally() {
    connection?.stop();
    connection = undefined;
    store.setAccount(undefined);
    friendPresence.clear();
    lastSeen.clear();
    store.delete('friendLastSeen');
    requests = { incoming: [], outgoing: [] };
    connectionState = 'offline';
    pushAll();
  }

  async function login() {
    const client = new Api(options.server);
    let session: v.InferOutput<typeof Session>;
    if (options.devHandle) {
      session = await client.call(Session, 'POST', '/auth/dev', {
        handle: options.devHandle,
        ...(options.devName ? { name: options.devName } : {}),
      });
    } else {
      // The GitHub app Margin signs in through is fixed in the build, not taken from the
      // server, so a server can't route your sign-in through an app of its own.
      const clientId = options.githubClientId;
      if (!clientId) throw new DaemonError('This build of Margin has no GitHub sign-in configured');
      const config = await client.call(Config, 'GET', '/config');
      if (config.githubClientId !== clientId) {
        throw new DaemonError('This server isn’t set up for this version of Margin');
      }
      const deviceLogin = options.deviceLogin ?? githubDeviceLogin;
      const accessToken = await deviceLogin(clientId, (code) =>
        push({ type: 'login', state: 'code', ...code }),
      );
      session = await client.call(Session, 'POST', '/auth/github', { accessToken });
    }
    store.setAccount({ server: options.server, ...session });
    // A fresh account gets the full bundle; an existing one keeps its identity key.
    await api().call(null, 'PUT', '/keys', signal.bundle());
    push({ type: 'login', state: 'done' });
    pushAll();
    connect();
  }

  async function send(to: string, text: string) {
    if (!store.friend(to)) throw new DaemonError(`${to} isn’t your friend`);
    if (!signal.hasSession(to) && !store.bundle(to)) await fetchBundle(to);
    if (!signal.hasSession(to) && !store.bundle(to)) {
      throw new DaemonError(`${to} hasn’t finished setting up Margin yet`);
    }
    const ciphertext = await signal.encrypt(to, text, store.bundle(to));
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      peer: to,
      direction: 'out',
      text,
      sentAt: Date.now(),
      state: 'queued',
    };
    const frame: ClientFrame = { t: 'send', id: message.id, to, ciphertext };
    store.transaction(() => {
      store.saveMessage(message);
      store.enqueue(message.id, to, frame);
    });
    push({ type: 'message', message });
    connection?.send(frame);
    return message;
  }

  // The server keeps the one setting it needs: whether you can be found. A choice made on
  // this Mac is sent on every connection and whenever it's set; a Mac that hasn't made one
  // (a new install) takes the server's instead of overwriting it. Damaged settings show you
  // as unfindable, so the server is told so too.
  function syncFindable() {
    if (!account()) return;
    const settings = store.settings();
    const chosen =
      settings.damaged || store.getJson<Partial<Settings>>('settings')?.findable !== undefined;
    const request = chosen
      ? api().call(null, 'PUT', '/me/findable', { findable: settings.findable })
      : api()
          .call(Findable, 'GET', '/me/findable')
          .then(({ findable }) => {
            store.saveSettings({ ...store.settings(), findable });
            push({ type: 'settings', settings: store.settings() });
          });
    void request.catch((e) => log('could not update Find friends', e));
  }

  function updateSettings(patch: Partial<Settings>) {
    const current = store.settings();
    const next = { ...current, ...patch, share: { ...current.share, ...patch.share } };
    const { damaged: _, ...settings } = next as Settings & { damaged?: true };
    store.saveSettings(settings);
    push({ type: 'settings', settings: store.settings() });
    if (patch.findable !== undefined) syncFindable();
    void recompute();
    return store.settings();
  }

  async function handle(request: Request, socket: Socket): Promise<unknown> {
    switch (request.op) {
      case 'event':
        sessions.onEvent(request.event);
        if (request.event.event === 'stop') setTimeout(() => void refreshTokens(), 2000);
        void recompute();
        return undefined;
      case 'subscribe':
        subscribers.add(socket);
        socket.on('close', () => subscribers.delete(socket));
        write(socket, selfPush());
        write(socket, { type: 'settings', settings: store.settings() });
        write(socket, { type: 'tools', tools: toolStatus(options.tools) });
        write(socket, { type: 'roster', friends: roster() });
        write(socket, { type: 'requests', requests });
        write(socket, chats());
        if (reports.state().count) write(socket, { type: 'reports', ...reports.state() });
        return undefined;
      case 'ping':
        return { protocol: PROTOCOL };
      case 'reports.send': {
        const sent = await reports.send(options.server);
        push({ type: 'reports', ...reports.state() });
        return { sent };
      }
      case 'reports.discard':
        reports.discard();
        push({ type: 'reports', ...reports.state() });
        return undefined;
      case 'login':
        void login().catch((e) => {
          log('sign-in failed', e);
          push({ type: 'login', state: 'failed', error: errorText(e) });
        });
        return undefined;
      case 'logout':
        await api()
          .call(null, 'POST', '/auth/logout')
          .catch(() => {});
        signOutLocally();
        return undefined;
      case 'send':
        return send(request.to, request.text);
      case 'history': {
        const messages = store.history(request.with, request.before, request.limit);
        write(socket, { type: 'history', with: request.with, messages });
        return undefined;
      }
      case 'delete': {
        const message = store.message(request.id);
        if (!message) return undefined;
        store.deleteMessage(request.id);
        store.dequeue(request.id);
        chatChanged(message.peer);
        return undefined;
      }
      case 'unsend':
        return unsend(request.id);
      case 'chat.delete':
        store.deleteChat(request.handle);
        chatChanged(request.handle);
        return undefined;
      case 'read':
        store.markRead(request.handle);
        push({ type: 'roster', friends: roster() });
        return undefined;
      case 'friend.request':
        return api().call(null, 'POST', '/friends/requests', { handle: request.handle });
      case 'friend.accept':
        return api().call(null, 'POST', `/friends/requests/${request.handle}/accept`);
      case 'friend.decline':
        return api().call(null, 'DELETE', `/friends/requests/${request.handle}`);
      case 'friend.remove':
        return api().call(null, 'DELETE', `/friends/${request.handle}`);
      case 'block':
        return api().call(null, 'POST', `/blocks/${request.handle}`);
      case 'unblock':
        await api().call(null, 'DELETE', `/blocks/${request.handle}`);
        return api().call(BlockList, 'GET', '/blocks');
      case 'blocks':
        return api().call(BlockList, 'GET', '/blocks');
      case 'directory':
        return api().call(
          Directory,
          'GET',
          `/directory?q=${encodeURIComponent(request.query ?? '')}`,
        );
      case 'safety': {
        const key = store.friend(request.handle)?.identityKey;
        const me = account()?.handle;
        if (!key || !me) throw new DaemonError('Send a message first, so your keys are exchanged');
        return { handle: request.handle, safety: signal.safetyNumber(me, request.handle, key) };
      }
      case 'report':
        return api().call(null, 'POST', '/reports', {
          handle: request.handle,
          reason: request.reason,
        });
      case 'settings.set':
        return updateSettings(request.settings);
      case 'tools.connect': {
        const note = connectTool(options.tools, request.tool);
        push({ type: 'tools', tools: toolStatus(options.tools) });
        return note ? { note } : undefined;
      }
      case 'tools.disconnect':
        disconnectTool(options.tools, request.tool);
        push({ type: 'tools', tools: toolStatus(options.tools) });
        return undefined;
      case 'account.export':
        return api().call(null, 'GET', '/me/export');
      case 'account.delete':
        await api().call(null, 'DELETE', '/me');
        for (const f of store.friends()) store.removeFriend(f.handle);
        signOutLocally();
        return undefined;
    }
  }

  // A reporter event with an odd optional field keeps the event and drops the field.
  function parseRequest(input: unknown): Request | undefined {
    const parsed = v.safeParse(Request, input);
    if (parsed.success) return parsed.output;
    const event = (input as { op?: unknown; event?: Record<string, unknown> })?.event;
    if ((input as { op?: unknown })?.op !== 'event' || !event) return undefined;
    const { cwd: _c, model: _m, ...bare } = event;
    const retry = v.safeParse(ReporterEvent, bare);
    return retry.success ? { op: 'event', event: retry.output } : undefined;
  }

  const server = createServer((socket) => {
    socket.on('error', () => {});
    onLines(socket, (input) => {
      const request = parseRequest(input);
      if (!request) {
        write(socket, {
          type: 'result',
          op: 'unknown',
          ok: false,
          error: 'invalid request',
        } satisfies Push);
        return;
      }
      handle(request, socket).then(
        (data) => {
          if (request.op !== 'event' && request.op !== 'subscribe') {
            write(socket, {
              type: 'result',
              op: request.op,
              ok: true,
              ...(data === undefined ? {} : { data }),
            });
          }
        },
        (e) => {
          if (!(e instanceof ApiError || e instanceof DaemonError || e instanceof ToolError))
            problem(`${request.op} failed`, e);
          if (e instanceof ApiError && e.status === 426) {
            connectionState = 'update-required';
            push(selfPush());
          }
          write(socket, { type: 'result', op: request.op, ok: false, error: errorText(e) });
        },
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.socket, () => resolve());
  });
  chmodSync(paths.socket, 0o600);

  try {
    if (repointTools(options.tools).length) log('pointed tool hooks at where Margin is now');
  } catch (e) {
    problem('could not update tool hooks', e);
  }
  reports.scanMacCrashes(reportSecrets());
  await refreshTokens();
  await recompute();
  connect();

  const heartbeat = setInterval(() => {
    sessions.expire();
    void recompute();
    push({ type: 'roster', friends: roster() });
  }, options.heartbeatMs ?? 30_000);
  const tokenTimer = setInterval(() => void refreshTokens(), options.tokenScanMs ?? 60_000);
  const localModels = new LocalModels(
    options.localModels ?? defaultLocalModels(options.tools.home),
  );
  const localModelTimer = setInterval(async () => {
    const watched = toolStatus(options.tools);
    const on = (tool: string) => watched.some((t) => t.tool === tool && t.connected);
    const events = await localModels.poll({ ollama: on('ollama'), lmStudio: on('lm-studio') });
    for (const event of events) sessions.onEvent(event);
    if (events.length) void recompute();
  }, options.localModelMs ?? 10_000);

  return {
    store,
    signal,
    reportSecrets,
    async stop() {
      stopped = true;
      clearInterval(heartbeat);
      clearInterval(tokenTimer);
      clearInterval(localModelTimer);
      // Tell friends straight away rather than waiting for the server to notice.
      if (connection?.connected)
        connection.send({ t: 'presence', presence: { status: 'offline', at: Date.now() } });
      await Bun.sleep(50);
      connection?.stop();
      for (const socket of subscribers) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (existsSync(paths.socket)) unlinkSync(paths.socket);
      await frames.catch(() => {});
      store.close();
    },
  };
}

export type Daemon = Awaited<ReturnType<typeof startDaemon>>;
