import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import {
  BlockList,
  Config,
  Directory,
  Findable,
  PROTOCOL,
  type Push,
  ReporterEvent,
  Request,
  type ServerFrame,
  Session,
  type Settings,
} from '@margin/protocol';
import * as v from 'valibot';
import { Api, ApiError } from './api';
import { createChat } from './chat';
import { Connection, type ConnectionState } from './connection';
import { DaemonError, errorText, log, ownError } from './errors';
import { createFriends } from './friends';
import { type DeviceLogin, githubDeviceLogin } from './github';
import { type HangOptions, type Watch, watchApp } from './hangs';
import { idleSeconds } from './idle';
import type { KeyProvider } from './keychain';
import { defaultLocalModels, type LocalModelSources, LocalModels } from './local-models';
import { onLines, sendOnce, write } from './net';
import type { Paths } from './paths';
import { localSecrets } from './presence';
import { createPresence } from './presence-sync';
import { type FetchRepo, repoClassifier } from './repo';
import { Reports, stackOf } from './reports';
import { Sessions } from './sessions';
import { Signal } from './signal';
import { Store } from './store';
import type { TokenSources } from './tokens';
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
  // How long a message the server turned away for being too many waits before going again.
  retryMs?: number;
  // The app's version, for crash reports, and where macOS keeps crash reports (tests).
  version?: string;
  crashLogs?: string;
  hangs?: HangOptions;
};

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
  // The app's connection, watched for its main thread stopping (see hangs.ts).
  const watches = new Map<Socket, Watch>();
  let connection: Connection | undefined;
  let connectionState: ConnectionState | 'update-required' = 'offline';
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
  const hang = (what: string, detail: string) => {
    reports.add(
      {
        component: 'app',
        kind: 'hang',
        what,
        detail: [detail, '', 'recent log:', reports.logTail()].join('\n'),
      },
      reportSecrets(),
    );
    push({ type: 'reports', ...reports.state() });
  };

  const presence = createPresence({
    store,
    sessions,
    classify,
    idle,
    tokenSources: options.tokenSources,
    connection: () => connection,
    connectionState: () => connectionState,
    push,
    problem,
  });
  const { roster, selfPush, recompute, refreshTokens } = presence;
  const friends = createFriends({
    store,
    signal,
    api,
    push,
    problem,
    roster,
    forget: presence.forget,
  });
  const { syncFriends, topUpPreKeys } = friends;
  const chat = createChat({
    store,
    signal,
    connection: () => connection,
    push,
    problem,
    roster,
    syncFriends,
    fetchBundle: friends.fetchBundle,
    retryMs: options.retryMs,
  });
  const { chats, chatChanged } = chat;

  const pushAll = () => {
    push(selfPush());
    push({ type: 'settings', settings: store.settings() });
    push({ type: 'tools', tools: toolStatus(options.tools) });
    push({ type: 'roster', friends: roster() });
    push({ type: 'requests', requests: friends.requests() });
    push(chats());
  };

  function onFrame(frame: ServerFrame) {
    const handle = async () => {
      switch (frame.t) {
        case 'presence':
          return presence.onPresence(frame.from, frame.presence);
        case 'message':
          return chat.onMessage(frame);
        case 'control':
          return chat.onControl(frame);
        case 'reset':
          return chat.onReset(frame.from, frame.id);
        case 'accepted':
          return chat.onAccepted(frame.id);
        case 'rejected':
          return chat.onRejected(frame.id, frame.error);
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
          presence.sendPresence(true);
          chat.flushOutbox();
          void syncFriends()
            .then(() => topUpPreKeys())
            .catch((e) => log('sync after connecting failed', e));
          syncFindable();
        }
      },
      onFrame,
      onSessionEnded: (elsewhere) => {
        if (elsewhere) push({ type: 'login', state: 'elsewhere' });
        signOutLocally();
      },
    });
    void connection.start();
  }

  function signOutLocally() {
    connection?.stop();
    connection = undefined;
    store.setAccount(undefined);
    presence.forgetAll();
    friends.clearRequests();
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
    // A fresh account gets the full bundle; one signed in on another Mac moves here, with
    // this Mac's key. Only then is it signed in here.
    await client.withToken(session.token).call(null, 'PUT', '/keys', signal.bundle());
    store.setAccount({ server: options.server, ...session });
    push({ type: 'login', state: 'done' });
    pushAll();
    connect();
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

  function updateSettings(patch: Extract<Request, { op: 'settings.set' }>['settings']) {
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
        presence
          .countEvent(request.event, sessions.onEvent(request.event))
          .catch((e) => problem('could not count a tool event', e));
        if (request.event.event === 'stop') setTimeout(() => void refreshTokens(), 2000);
        void recompute();
        return undefined;
      case 'subscribe':
        subscribers.add(socket);
        socket.on('close', () => {
          subscribers.delete(socket);
          watches.get(socket)?.disconnected();
          watches.delete(socket);
        });
        if (request.pid && !watches.has(socket))
          watches.set(
            socket,
            watchApp(
              request.pid,
              (n) => write(socket, { type: 'ping', n } satisfies Push),
              (h) => hang(h.what, h.detail),
              (line) => log(line),
              options.hangs,
            ),
          );
        write(socket, selfPush());
        write(socket, { type: 'settings', settings: store.settings() });
        write(socket, { type: 'tools', tools: toolStatus(options.tools) });
        write(socket, { type: 'roster', friends: roster() });
        write(socket, { type: 'requests', requests: friends.requests() });
        write(socket, chats());
        if (reports.state().count) write(socket, { type: 'reports', ...reports.state() });
        return undefined;
      case 'ping':
        return { protocol: PROTOCOL };
      case 'pong':
        watches.get(socket)?.pong(request);
        return undefined;
      case 'app.quitting':
        watches.get(socket)?.quitting();
        watches.delete(socket);
        return undefined;
      case 'reports.send': {
        const sent = await reports.send(options.server);
        push({ type: 'reports', ...reports.state() });
        return { sent };
      }
      case 'reports.discard':
        reports.discard();
        push({ type: 'reports', ...reports.state() });
        return undefined;
      case 'reports.list':
        return { reports: reports.pending() };
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
        return chat.send(request.to, request.text);
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
      case 'preview':
        return chat.attachPreview(request.to, request.preview);
      case 'unsend':
        return chat.unsend(request.id);
      case 'retry':
        return chat.retry(request.id);
      case 'chat.delete':
        store.deleteChat(request.handle);
        chatChanged(request.handle);
        return undefined;
      case 'read': {
        const newest = store.markRead(request.handle);
        push({ type: 'roster', friends: roster() });
        if (newest && store.settings().readReceipts && store.friend(request.handle)) {
          chat.sendReceipt(request.handle, { t: 'read', id: newest });
        }
        return undefined;
      }
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
          if (!['event', 'subscribe', 'pong', 'app.quitting'].includes(request.op)) {
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

  const heartbeat = setInterval(presence.heartbeat, options.heartbeatMs ?? 30_000);
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
      chat.stop();
      // Tell friends straight away rather than waiting for the server to notice.
      if (connection?.connected)
        connection.send({ t: 'presence', presence: { status: 'offline', at: Date.now() } });
      await Bun.sleep(50);
      connection?.stop();
      for (const watch of watches.values()) watch.flush();
      for (const socket of subscribers) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (existsSync(paths.socket)) unlinkSync(paths.socket);
      await frames.catch(() => {});
      store.close();
    },
  };
}

export type Daemon = Awaited<ReturnType<typeof startDaemon>>;
