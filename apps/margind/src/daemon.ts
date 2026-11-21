import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import {
  type ChatMessage,
  type ClientFrame,
  CONTROL,
  Config,
  Count,
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
import { type DeviceLogin, githubDeviceLogin } from './github';
import { idleSeconds } from './idle';
import type { KeyProvider } from './keychain';
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
import { Sessions } from './sessions';
import { PREKEY_BATCH, Signal } from './signal';
import { Store } from './store';
import { scanTokens, type TokenSources } from './tokens';
import { connectTool, disconnectTool, type ToolEnv, toolStatus } from './tools';

export type DaemonOptions = {
  paths: Paths;
  keys: KeyProvider;
  server: string;
  tools: ToolEnv;
  tokenSources: TokenSources;
  // Development and tests: sign in through the server's dev login as this handle.
  devHandle?: string;
  // The GitHub OAuth app's client id, fixed per build.
  githubClientId?: string;
  deviceLogin?: DeviceLogin;
  fetchRepo?: FetchRepo;
  idle?: () => Promise<number>;
  isAlive?: (pid: number) => boolean;
  heartbeatMs?: number;
  tokenScanMs?: number;
};

const KeyCount = v.object({ remaining: Count });

const IDLE_AFTER_S = 5 * 60;
const STALE_MS = 90_000;
const PREKEY_LOW = 20;

const log = (what: string, e?: unknown) =>
  console.error(`[margind] ${what}${e ? ` (${(e as Error).name ?? 'error'})` : ''}`);

// Received chat text keeps newlines, tabs and joiners; every other control or format character goes.
function cleanChat(text: string) {
  const cleaned = text.replace(CONTROL, (c) => ('\t\n‌‍'.includes(c) ? c : '')).slice(0, 4000);
  return cleaned.trim() ? cleaned : null;
}

const errorText = (e: unknown) =>
  e instanceof ApiError || e instanceof DaemonError ? e.message : 'Something went wrong';

class DaemonError extends Error {}

export async function startDaemon(options: DaemonOptions) {
  const { paths } = options;
  if (existsSync(paths.socket)) {
    if (await sendOnce(paths.socket, { op: 'ping' }, 500))
      throw new DaemonError('margind is already running');
    unlinkSync(paths.socket);
  }

  const store = new Store(paths.db, options.keys(`db:${paths.home}`));
  const signal = new Signal(store);
  const sessions = new Sessions(options.isAlive);
  const classify = repoClassifier(options.fetchRepo);
  const idle = options.idle ?? idleSeconds;
  const subscribers = new Set<Socket>();
  const friendPresence = new Map<string, { presence: PublicPresence; lastSeenAt: number }>();
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

  const savedTokens = () => store.getJson<Record<string, number>>('friendTokens') ?? {};

  function roster(): Friend[] {
    const now = Date.now();
    const lastTokens = savedTokens();
    return store.friends().map((f) => {
      const seen = friendPresence.get(f.handle);
      const fresh = seen && now - seen.lastSeenAt < STALE_MS;
      const known = seen?.presence.tokens ?? lastTokens[f.handle];
      const presence: PublicPresence = fresh
        ? seen.presence
        : {
            status: 'offline',
            at: seen?.presence.at ?? 0,
            ...(known !== undefined ? { tokens: known } : {}),
          };
      return {
        handle: f.handle,
        ...(f.name ? { name: f.name } : {}),
        presence,
        lastSeenAt: seen?.lastSeenAt ?? 0,
        unread: store.unread(f.handle),
      };
    });
  }

  function selfPush(): Push {
    const a = account();
    return {
      type: 'self',
      ...(a ? { handle: a.handle } : {}),
      ...(view ? { presence: view.full } : {}),
      tokens,
      connection: !a ? 'signed-out' : connectionState,
      protocol: PROTOCOL,
    };
  }

  const pushAll = () => {
    push(selfPush());
    push({ type: 'settings', settings: store.settings() });
    push({ type: 'tools', tools: toolStatus(options.tools) });
    push({ type: 'roster', friends: roster() });
    push({ type: 'requests', requests });
  };

  // What friends see, recomputed from sessions, settings, idle time and tokens.
  async function recompute() {
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
      log('withheld activity that failed the privacy check');
      next = buildView({ status, tokens, settings });
    }
    view = next;
    sendPresence();
    push(selfPush());
  }

  // Targeted view first, so close friends never flicker to the basic one.
  function sendPresence() {
    if (!view || !connection?.connected) return;
    if (view.close.length) connection.send({ t: 'presence', presence: view.full, to: view.close });
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
      log('token scan failed', e);
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
      }
    }
    for (const friend of friends) {
      store.upsertFriend(friend.handle, friend.name);
      if (store.friend(friend.handle)?.identityKey) continue;
      // One friend's bad or missing keys don't stop the rest of the sync.
      await fetchBundle(friend.handle).catch((e) => log('could not pin a friend’s keys', e));
    }
    push({ type: 'roster', friends: roster() });
    push({ type: 'requests', requests });
  }

  async function fetchBundle(handle: string) {
    try {
      store.pin(handle, await api().call(PeerBundle, 'GET', `/keys/${handle}`));
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
    friendPresence.set(from, { presence, lastSeenAt: Date.now() });
    if (presence.tokens !== undefined)
      store.setJson('friendTokens', { ...savedTokens(), [from]: presence.tokens });
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
      // Retrying can't help (wrong key, forged sender, replay): drop it rather than jam the queue.
      log('dropped a message that could not be decrypted', e);
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

  function onFrame(frame: ServerFrame) {
    const handle = async () => {
      switch (frame.t) {
        case 'presence':
          return onPresence(frame.from, frame.presence);
        case 'message':
          return onMessage(frame);
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
    frames = frames.then(handle).catch((e) => log(`handling ${frame.t} failed`, e));
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
          sendPresence();
          flushOutbox();
          void syncFriends()
            .then(() => topUpPreKeys())
            .catch((e) => log('sync after connecting failed', e));
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
    requests = { incoming: [], outgoing: [] };
    connectionState = 'offline';
    pushAll();
  }

  async function login() {
    const client = new Api(options.server);
    let session: v.InferOutput<typeof Session>;
    if (options.devHandle) {
      session = await client.call(Session, 'POST', '/auth/dev', { handle: options.devHandle });
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

  function updateSettings(patch: Partial<Settings>) {
    const current = store.settings();
    const next = { ...current, ...patch, share: { ...current.share, ...patch.share } };
    const { damaged: _, ...settings } = next as Settings & { damaged?: true };
    store.saveSettings(settings);
    push({ type: 'settings', settings: store.settings() });
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
        return undefined;
      case 'ping':
        return { protocol: PROTOCOL };
      case 'login':
        void login().catch((e) => push({ type: 'login', state: 'failed', error: errorText(e) }));
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
          if (!(e instanceof ApiError || e instanceof DaemonError)) log(`${request.op} failed`, e);
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

  await refreshTokens();
  await recompute();
  connect();

  const heartbeat = setInterval(() => {
    sessions.expire();
    void recompute();
    push({ type: 'roster', friends: roster() });
  }, options.heartbeatMs ?? 30_000);
  const tokenTimer = setInterval(() => void refreshTokens(), options.tokenScanMs ?? 60_000);

  return {
    store,
    signal,
    async stop() {
      stopped = true;
      clearInterval(heartbeat);
      clearInterval(tokenTimer);
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
