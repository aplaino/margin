import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ClientFrame,
  CONTROL,
  type Config,
  type FriendList,
  Handle,
  KeyBundle,
  Name,
  type PeerBundle,
  PROTOCOL,
  PreKey,
  type PublicPresence,
  type Requests,
  type ServerFrame,
  type Session,
} from '@margin/protocol';
import type { Server, ServerWebSocket, SQL } from 'bun';
import * as v from 'valibot';
import { type UpdateOptions, updates } from './updates';

// The server holds identity, the friend graph, public key bundles and ciphertext in
// transit. Presence lives in memory only. It never sees message plaintext.

export type GithubUser = { id: number; login: string; name: string | null };

export type Options = {
  githubClientId?: string;
  // Local development and tests only: sign in as any handle without GitHub.
  devAuth?: boolean;
  fetchGithubUser?: (token: string) => Promise<GithubUser | null>;
  retentionMs?: number;
  updates?: UpdateOptions;
};

type Account = { id: string; handle: string };
type Socket = ServerWebSocket<Account & { tokenHash: string }>;
type Online = {
  sockets: Set<Socket>;
  presence?: PublicPresence;
  // Close-friends view: viewer account id → what they see instead of the default.
  targeted?: Map<string, PublicPresence>;
};

const PREKEY_CAP = 200;
const PREKEY_LOW = 20;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const AuthGithub = v.object({ accessToken: v.pipe(v.string(), v.minLength(1), v.maxLength(512)) });
const AuthDev = v.object({ handle: Handle, name: v.optional(Name) });
const HandleBody = v.object({ handle: Handle });
const ReportBody = v.object({
  handle: Handle,
  reason: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
});
const PreKeysBody = v.object({ preKeys: v.pipe(v.array(PreKey), v.maxLength(PREKEY_CAP)) });

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const notFound = () => new HttpError(404, 'not found');
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const json = (body: unknown, status = 200) => Response.json(body, { status });

// GitHub display names are free text; keep them only if they're safe to show.
function cleanName(name: string | null | undefined) {
  const cleaned = name?.replace(CONTROL, '').trim().slice(0, 64);
  return cleaned && v.is(Name, cleaned) ? cleaned : undefined;
}

async function parseBody<T extends v.GenericSchema>(schema: T, req: Request) {
  let input: unknown;
  try {
    input = await req.json();
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
  const result = v.safeParse(schema, input);
  if (!result.success) throw new HttpError(400, 'invalid request');
  return result.output as v.InferOutput<T>;
}

async function githubUser(token: string): Promise<GithubUser | null> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'margin',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const user = (await response.json()) as { id: number; login: string; name?: string | null };
  return { id: user.id, login: user.login, name: user.name ?? null };
}

// Fixed-window limiter per account and action.
function limiter(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    return ++entry.count <= limit;
  };
}

export function createApp(sql: SQL, options: Options = {}) {
  const fetchGithubUser = options.fetchGithubUser ?? githubUser;
  const updateRoutes = options.updates ? updates(sql, options.updates) : undefined;
  const retentionMs = options.retentionMs ?? RETENTION_MS;
  const online = new Map<string, Online>();
  const limits = {
    message: limiter(60, 60_000),
    presence: limiter(60, 60_000),
    request: limiter(20, 60 * 60_000),
  };

  const presenceFor = (entry: Online | undefined, viewerId: string) =>
    entry?.targeted?.get(viewerId) ?? entry?.presence;

  function sendTo(accountId: string, frame: ServerFrame) {
    const data = JSON.stringify(frame);
    for (const socket of online.get(accountId)?.sockets ?? []) socket.send(data);
  }

  async function authenticate(req: Request) {
    const token = req.headers.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];
    if (!token) return null;
    const tokenHash = hashToken(token);
    const [account] = await sql`
      SELECT a.id, a.handle FROM sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash = ${tokenHash}`;
    return account
      ? { id: account.id as string, handle: account.handle as string, tokenHash }
      : null;
  }

  async function accountByHandle(handle: string): Promise<Account | null> {
    if (!v.is(Handle, handle)) return null;
    const [account] = await sql`SELECT id, handle FROM accounts WHERE handle = ${handle}`;
    return account ? { id: account.id, handle: account.handle } : null;
  }

  async function areFriends(a: string, b: string) {
    const [row] = await sql`SELECT 1 AS ok FROM friendships WHERE a_id = ${a} AND b_id = ${b}`;
    return !!row;
  }

  async function blockedEitherWay(a: string, b: string) {
    const [row] = await sql`
      SELECT 1 AS ok FROM blocks
      WHERE (blocker_id = ${a} AND blocked_id = ${b}) OR (blocker_id = ${b} AND blocked_id = ${a})`;
    return !!row;
  }

  async function friendIds(accountId: string): Promise<string[]> {
    const rows = await sql`SELECT b_id FROM friendships WHERE a_id = ${accountId}`;
    return rows.map((r: { b_id: string }) => r.b_id);
  }

  async function befriend(a: string, b: string) {
    const now = Date.now();
    await sql`INSERT INTO friendships ${sql({ a_id: a, b_id: b, created_at: now })} ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO friendships ${sql({ a_id: b, b_id: a, created_at: now })} ON CONFLICT DO NOTHING`;
    await sql`DELETE FROM friend_requests
      WHERE (from_id = ${a} AND to_id = ${b}) OR (from_id = ${b} AND to_id = ${a})`;
  }

  async function unfriend(a: string, b: string) {
    await sql`DELETE FROM friendships WHERE (a_id = ${a} AND b_id = ${b}) OR (a_id = ${b} AND b_id = ${a})`;
    await sql`DELETE FROM friend_requests
      WHERE (from_id = ${a} AND to_id = ${b}) OR (from_id = ${b} AND to_id = ${a})`;
    online.get(a)?.targeted?.delete(b);
    online.get(b)?.targeted?.delete(a);
  }

  // Tell both sides to refetch; if they're now friends, exchange current presence.
  async function friendsChanged(a: Account, b: Account) {
    sendTo(a.id, { t: 'friends-changed' });
    sendTo(b.id, { t: 'friends-changed' });
    if (!(await areFriends(a.id, b.id))) return;
    const pa = presenceFor(online.get(a.id), b.id);
    const pb = presenceFor(online.get(b.id), a.id);
    if (pa) sendTo(b.id, { t: 'presence', from: a.handle, presence: pa });
    if (pb) sendTo(a.id, { t: 'presence', from: b.handle, presence: pb });
  }

  async function issueSession(accountId: string) {
    const token = randomBytes(32).toString('base64url');
    await sql`INSERT INTO sessions ${sql({ token_hash: hashToken(token), account_id: accountId, created_at: Date.now() })}`;
    return token;
  }

  async function login(handle: string, githubId: number | null, name?: string): Promise<Session> {
    const lower = handle.toLowerCase();
    if (!v.is(Handle, lower)) throw new HttpError(400, 'invalid handle');
    let [account] =
      githubId === null
        ? await sql`SELECT id, handle FROM accounts WHERE handle = ${lower} AND github_id IS NULL`
        : await sql`SELECT id, handle FROM accounts WHERE github_id = ${githubId}`;
    if (account) {
      await sql`UPDATE accounts SET name = ${name ?? null} WHERE id = ${account.id}`;
    } else {
      if (await accountByHandle(lower)) throw new HttpError(409, 'handle already registered');
      account = { id: randomUUID(), handle: lower };
      await sql`INSERT INTO accounts ${sql({
        id: account.id,
        handle: lower,
        github_id: githubId,
        name: name ?? null,
        created_at: Date.now(),
      })}`;
    }
    return {
      token: await issueSession(account.id),
      handle: account.handle,
      ...(name ? { name } : {}),
    };
  }

  async function exportAccount(me: Account) {
    const [account] =
      await sql`SELECT handle, name, github_id, created_at FROM accounts WHERE id = ${me.id}`;
    const handles = async (query: Promise<{ handle: string }[]>) =>
      (await query).map((r) => r.handle);
    const [keys] = await sql`SELECT updated_at FROM key_bundles WHERE account_id = ${me.id}`;
    const [prekeys] =
      await sql`SELECT COUNT(*) AS n FROM one_time_prekeys WHERE account_id = ${me.id}`;
    const [queued] = await sql`
      SELECT COUNT(*) AS n FROM queued_messages WHERE to_id = ${me.id} OR from_id = ${me.id}`;
    const [sessions] = await sql`SELECT COUNT(*) AS n FROM sessions WHERE account_id = ${me.id}`;
    return {
      account: {
        handle: account.handle,
        name: account.name ?? null,
        githubId: account.github_id === null ? null : Number(account.github_id),
        createdAt: Number(account.created_at),
      },
      friends: await handles(sql`
        SELECT a.handle FROM friendships f JOIN accounts a ON a.id = f.b_id WHERE f.a_id = ${me.id}`),
      requests: await requestsOf(me),
      blocked: await handles(sql`
        SELECT a.handle FROM blocks b JOIN accounts a ON a.id = b.blocked_id WHERE b.blocker_id = ${me.id}`),
      reports: (
        await sql`
          SELECT a.handle, r.reason, r.created_at FROM reports r JOIN accounts a ON a.id = r.reported_id
          WHERE r.reporter_id = ${me.id}`
      ).map((r: { handle: string; reason: string; created_at: number }) => ({
        handle: r.handle,
        reason: r.reason,
        createdAt: Number(r.created_at),
      })),
      // Public keys only; private keys never leave the device.
      keys: keys ? { updatedAt: Number(keys.updated_at), oneTimePrekeys: Number(prekeys.n) } : null,
      sessions: Number(sessions.n),
      // Message contents are end-to-end encrypted and live only on devices. Undelivered
      // ciphertext is held for at most 30 days.
      queuedMessages: Number(queued.n),
    };
  }

  async function deleteAccount(id: string) {
    await sql.begin(async (tx) => {
      await tx`DELETE FROM friendships WHERE a_id = ${id} OR b_id = ${id}`;
      await tx`DELETE FROM friend_requests WHERE from_id = ${id} OR to_id = ${id}`;
      await tx`DELETE FROM blocks WHERE blocker_id = ${id} OR blocked_id = ${id}`;
      await tx`DELETE FROM reports WHERE reporter_id = ${id}`;
      await tx`DELETE FROM queued_messages WHERE to_id = ${id} OR from_id = ${id}`;
      await tx`DELETE FROM one_time_prekeys WHERE account_id = ${id}`;
      await tx`DELETE FROM key_bundles WHERE account_id = ${id}`;
      await tx`DELETE FROM sessions WHERE account_id = ${id}`;
      await tx`DELETE FROM accounts WHERE id = ${id}`;
    });
  }

  async function requestsOf(me: Account): Promise<Requests> {
    const incoming = await sql`
      SELECT a.handle FROM friend_requests r JOIN accounts a ON a.id = r.from_id
      WHERE r.to_id = ${me.id} ORDER BY r.created_at`;
    const outgoing = await sql`
      SELECT a.handle FROM friend_requests r JOIN accounts a ON a.id = r.to_id
      WHERE r.from_id = ${me.id} ORDER BY r.created_at`;
    return {
      incoming: incoming.map((r: { handle: string }) => r.handle),
      outgoing: outgoing.map((r: { handle: string }) => r.handle),
    };
  }

  async function prekeyCount(accountId: string) {
    const [row] =
      await sql`SELECT COUNT(*) AS n FROM one_time_prekeys WHERE account_id = ${accountId}`;
    return Number(row.n);
  }

  async function route(req: Request, url: URL): Promise<Response> {
    const { method } = req;
    const path = url.pathname;
    const param = (pattern: RegExp) => {
      const match = path.match(pattern);
      return match ? decodeURIComponent(match[1] ?? '') : null;
    };

    if (method === 'GET' && path === '/health') return json({ ok: true });
    const update = await updateRoutes?.(req, url);
    if (update) return update;
    if (method === 'GET' && path === '/config') {
      const config: Config = { protocol: PROTOCOL, githubClientId: options.githubClientId ?? null };
      return json(config);
    }
    if (method === 'POST' && path === '/auth/github') {
      const { accessToken } = await parseBody(AuthGithub, req);
      // The GitHub token is used once to learn who you are, then discarded.
      const user = await fetchGithubUser(accessToken);
      if (!user) throw new HttpError(401, 'GitHub rejected the token');
      return json(await login(user.login, user.id, cleanName(user.name)));
    }
    if (method === 'POST' && path === '/auth/dev') {
      if (!options.devAuth) throw notFound();
      const { handle, name } = await parseBody(AuthDev, req);
      return json(await login(handle, null, name));
    }

    const auth = await authenticate(req);
    if (!auth) throw new HttpError(401, 'unauthorized');
    const me: Account = { id: auth.id, handle: auth.handle };

    if (method === 'POST' && path === '/auth/logout') {
      await sql`DELETE FROM sessions WHERE token_hash = ${auth.tokenHash}`;
      for (const socket of online.get(me.id)?.sockets ?? []) {
        if (socket.data.tokenHash === auth.tokenHash) socket.close(4001, 'signed out');
      }
      return json({ ok: true });
    }
    if (method === 'GET' && path === '/me') return json(me);
    if (method === 'GET' && path === '/me/export') return json(await exportAccount(me));
    if (method === 'DELETE' && path === '/me') {
      const friends = await friendIds(me.id);
      await deleteAccount(me.id);
      for (const socket of online.get(me.id)?.sockets ?? []) socket.close(4002, 'account deleted');
      online.delete(me.id);
      for (const id of friends) {
        sendTo(id, {
          t: 'presence',
          from: me.handle,
          presence: { status: 'offline', at: Date.now() },
        });
        sendTo(id, { t: 'friends-changed' });
      }
      return json({ ok: true });
    }

    if (method === 'PUT' && path === '/keys') {
      const bundle = await parseBody(KeyBundle, req);
      const [existing] =
        await sql`SELECT identity_key FROM key_bundles WHERE account_id = ${me.id}`;
      // Identity is account-level until device linking exists.
      if (existing && existing.identity_key !== bundle.identityKey) {
        throw new HttpError(409, 'identity key already registered');
      }
      const row = {
        account_id: me.id,
        registration_id: bundle.registrationId,
        identity_key: bundle.identityKey,
        signed_prekey: JSON.stringify(bundle.signedPreKey),
        updated_at: Date.now(),
      };
      await sql.begin(async (tx) => {
        await tx`INSERT INTO key_bundles ${tx(row)} ON CONFLICT (account_id) DO UPDATE SET
          registration_id = ${row.registration_id}, signed_prekey = ${row.signed_prekey},
          updated_at = ${row.updated_at}`;
        await tx`DELETE FROM one_time_prekeys WHERE account_id = ${me.id}`;
        for (const pk of bundle.preKeys) {
          await tx`INSERT INTO one_time_prekeys ${tx({ account_id: me.id, key_id: pk.keyId, public_key: pk.publicKey })}
            ON CONFLICT DO NOTHING`;
        }
      });
      return json({ ok: true, remaining: await prekeyCount(me.id) });
    }
    if (method === 'GET' && path === '/keys/count') {
      return json({ remaining: await prekeyCount(me.id) });
    }
    if (method === 'POST' && path === '/keys/prekeys') {
      const { preKeys } = await parseBody(PreKeysBody, req);
      const room = Math.max(0, PREKEY_CAP - (await prekeyCount(me.id)));
      for (const pk of preKeys.slice(0, room)) {
        await sql`INSERT INTO one_time_prekeys ${sql({ account_id: me.id, key_id: pk.keyId, public_key: pk.publicKey })}
          ON CONFLICT DO NOTHING`;
      }
      return json({ remaining: await prekeyCount(me.id) });
    }
    const keysFor = param(/^\/keys\/([^/]+)$/);
    if (method === 'GET' && keysFor !== null) {
      const peer = await accountByHandle(keysFor);
      // Only friends get prekeys, so strangers can't drain them.
      if (!peer || !(await areFriends(me.id, peer.id))) throw notFound();
      const [bundle] = await sql`SELECT * FROM key_bundles WHERE account_id = ${peer.id}`;
      if (!bundle) throw new HttpError(404, 'no keys published');
      const [preKey] = await sql`
        DELETE FROM one_time_prekeys WHERE account_id = ${peer.id}
          AND key_id = (SELECT key_id FROM one_time_prekeys WHERE account_id = ${peer.id} LIMIT 1)
        RETURNING key_id, public_key`;
      const remaining = await prekeyCount(peer.id);
      if (remaining < PREKEY_LOW) sendTo(peer.id, { t: 'prekeys-low', remaining });
      const response: PeerBundle = {
        handle: peer.handle,
        registrationId: Number(bundle.registration_id),
        identityKey: bundle.identity_key,
        signedPreKey: JSON.parse(bundle.signed_prekey),
        preKeys: preKey ? [{ keyId: Number(preKey.key_id), publicKey: preKey.public_key }] : [],
      };
      return json(response);
    }

    if (method === 'GET' && path === '/friends') {
      const rows = await sql`
        SELECT a.handle, a.name FROM friendships f JOIN accounts a ON a.id = f.b_id
        WHERE f.a_id = ${me.id} ORDER BY a.handle`;
      const list: FriendList = {
        friends: rows.map((r: { handle: string; name: string | null }) => ({
          handle: r.handle,
          ...(r.name ? { name: r.name } : {}),
        })),
      };
      return json(list);
    }
    if (method === 'GET' && path === '/friends/requests') return json(await requestsOf(me));
    if (method === 'POST' && path === '/friends/requests') {
      if (!limits.request(me.id)) throw new HttpError(429, 'rate limited');
      const { handle } = await parseBody(HandleBody, req);
      const peer = await accountByHandle(handle);
      // Unknown and blocked handles get the same answer, so a block can't be detected.
      if (!peer || peer.id === me.id || (await blockedEitherWay(me.id, peer.id))) throw notFound();
      if (await areFriends(me.id, peer.id)) return json({ status: 'friends' });
      const [reverse] = await sql`
        SELECT 1 AS ok FROM friend_requests WHERE from_id = ${peer.id} AND to_id = ${me.id}`;
      if (reverse) {
        await befriend(me.id, peer.id);
        await friendsChanged(me, peer);
        return json({ status: 'friends' });
      }
      await sql`INSERT INTO friend_requests ${sql({ from_id: me.id, to_id: peer.id, created_at: Date.now() })}
        ON CONFLICT DO NOTHING`;
      sendTo(peer.id, { t: 'friends-changed' });
      return json({ status: 'requested' });
    }
    const accept = param(/^\/friends\/requests\/([^/]+)\/accept$/);
    if (method === 'POST' && accept !== null) {
      const peer = await accountByHandle(accept);
      const [pending] = peer
        ? await sql`SELECT 1 AS ok FROM friend_requests WHERE from_id = ${peer.id} AND to_id = ${me.id}`
        : [];
      if (!peer || !pending) throw notFound();
      await befriend(me.id, peer.id);
      await friendsChanged(me, peer);
      return json({ status: 'friends' });
    }
    // Declines an incoming request or cancels an outgoing one.
    const decline = param(/^\/friends\/requests\/([^/]+)$/);
    if (method === 'DELETE' && decline !== null) {
      const peer = await accountByHandle(decline);
      if (!peer) throw notFound();
      await sql`DELETE FROM friend_requests
        WHERE (from_id = ${peer.id} AND to_id = ${me.id}) OR (from_id = ${me.id} AND to_id = ${peer.id})`;
      sendTo(me.id, { t: 'friends-changed' });
      sendTo(peer.id, { t: 'friends-changed' });
      return json({ ok: true });
    }
    const friend = param(/^\/friends\/([^/]+)$/);
    if (method === 'DELETE' && friend !== null) {
      const peer = await accountByHandle(friend);
      if (!peer) throw notFound();
      await unfriend(me.id, peer.id);
      await friendsChanged(me, peer);
      return json({ ok: true });
    }

    const block = param(/^\/blocks\/([^/]+)$/);
    if (block !== null && (method === 'POST' || method === 'DELETE')) {
      const peer = await accountByHandle(block);
      if (!peer || peer.id === me.id) throw notFound();
      if (method === 'DELETE') {
        await sql`DELETE FROM blocks WHERE blocker_id = ${me.id} AND blocked_id = ${peer.id}`;
        return json({ ok: true });
      }
      await unfriend(me.id, peer.id);
      await sql`INSERT INTO blocks ${sql({ blocker_id: me.id, blocked_id: peer.id, created_at: Date.now() })}
        ON CONFLICT DO NOTHING`;
      await sql`DELETE FROM queued_messages WHERE from_id = ${peer.id} AND to_id = ${me.id}`;
      await friendsChanged(me, peer);
      return json({ ok: true });
    }

    if (method === 'POST' && path === '/reports') {
      if (!limits.request(me.id)) throw new HttpError(429, 'rate limited');
      const { handle, reason } = await parseBody(ReportBody, req);
      const peer = await accountByHandle(handle);
      if (!peer) throw notFound();
      await sql`INSERT INTO reports ${sql({
        id: randomUUID(),
        reporter_id: me.id,
        reported_id: peer.id,
        reason,
        created_at: Date.now(),
      })}`;
      return json({ ok: true });
    }

    throw notFound();
  }

  async function onFrame(ws: Socket, raw: string | Buffer) {
    const me = ws.data;
    let input: unknown;
    try {
      input = JSON.parse(String(raw));
    } catch {
      return;
    }
    const parsed = v.safeParse(ClientFrame, input);
    if (!parsed.success) {
      ws.send(JSON.stringify({ t: 'error', error: 'invalid frame' } satisfies ServerFrame));
      return;
    }
    const frame = parsed.output;

    if (frame.t === 'presence') {
      if (!limits.presence(me.id)) return;
      const entry = online.get(me.id);
      if (!entry) return;
      // With `to`, this view replaces the targeted set: only those friends see it.
      if (frame.to) {
        const targeted = new Map<string, PublicPresence>();
        for (const handle of frame.to) {
          const peer = await accountByHandle(handle);
          if (peer && (await areFriends(me.id, peer.id))) targeted.set(peer.id, frame.presence);
        }
        entry.targeted = targeted;
        for (const id of targeted.keys()) {
          sendTo(id, { t: 'presence', from: me.handle, presence: frame.presence });
        }
        return;
      }
      entry.presence = frame.presence;
      for (const id of await friendIds(me.id)) {
        if (!entry.targeted?.has(id)) {
          sendTo(id, { t: 'presence', from: me.handle, presence: frame.presence });
        }
      }
      return;
    }

    if (frame.t === 'send') {
      const reject = (error: string) =>
        ws.send(JSON.stringify({ t: 'rejected', id: frame.id, error } satisfies ServerFrame));
      if (!limits.message(me.id)) return reject('rate limited');
      const peer = await accountByHandle(frame.to);
      if (!peer || !(await areFriends(me.id, peer.id))) return reject('not a friend');
      const sentAt = Date.now();
      const [inserted] = await sql`
        INSERT INTO queued_messages ${sql({
          id: frame.id,
          to_id: peer.id,
          from_id: me.id,
          sent_at: sentAt,
          ciphertext: JSON.stringify(frame.ciphertext),
        })} ON CONFLICT DO NOTHING RETURNING id`;
      if (!inserted) {
        // A retry of our own message is fine; someone else's id is not.
        const [existing] = await sql`SELECT from_id FROM queued_messages WHERE id = ${frame.id}`;
        if (existing?.from_id !== me.id) return reject('duplicate id');
      } else {
        sendTo(peer.id, {
          t: 'message',
          id: frame.id,
          from: me.handle,
          sentAt,
          ciphertext: frame.ciphertext,
        });
      }
      ws.send(JSON.stringify({ t: 'accepted', id: frame.id } satisfies ServerFrame));
      return;
    }

    if (frame.t === 'ack') {
      await sql`DELETE FROM queued_messages WHERE id = ${frame.id} AND to_id = ${me.id}`;
    }
  }

  async function onOpen(ws: Socket) {
    const me = ws.data;
    const entry = online.get(me.id) ?? { sockets: new Set<Socket>() };
    entry.sockets.add(ws);
    online.set(me.id, entry);

    const friends = await sql`
      SELECT a.id, a.handle FROM friendships f JOIN accounts a ON a.id = f.b_id WHERE f.a_id = ${me.id}`;
    for (const friend of friends) {
      const presence = presenceFor(online.get(friend.id), me.id);
      if (presence)
        ws.send(
          JSON.stringify({ t: 'presence', from: friend.handle, presence } satisfies ServerFrame),
        );
    }

    await sql`DELETE FROM queued_messages WHERE sent_at < ${Date.now() - retentionMs}`;
    const queued = await sql`
      SELECT q.id, q.sent_at, q.ciphertext, a.handle FROM queued_messages q JOIN accounts a ON a.id = q.from_id
      WHERE q.to_id = ${me.id} ORDER BY q.sent_at`;
    for (const q of queued) {
      const frame: ServerFrame = {
        t: 'message',
        id: q.id,
        from: q.handle,
        sentAt: Number(q.sent_at),
        ciphertext: JSON.parse(q.ciphertext),
      };
      ws.send(JSON.stringify(frame));
    }
  }

  async function onClose(ws: Socket) {
    const me = ws.data;
    const entry = online.get(me.id);
    if (!entry?.sockets.delete(ws) || entry.sockets.size > 0) return;
    online.delete(me.id);
    for (const id of await friendIds(me.id)) {
      sendTo(id, {
        t: 'presence',
        from: me.handle,
        presence: { status: 'offline', at: Date.now() },
      });
    }
  }

  // Each socket's frames are handled strictly in order: a targeted presence must be
  // applied before the default view that follows it.
  const queues = new WeakMap<Socket, Promise<void>>();
  const closing = new Set<Promise<void>>();
  const log = (what: string) => (e: unknown) => console.error(`[api] ${what}: ${e}`);

  return {
    async fetch(req: Request, server: Server<Account & { tokenHash: string }>) {
      const url = new URL(req.url);
      const protocol = req.headers.get('x-margin-protocol') ?? url.searchParams.get('protocol');
      if (protocol !== null && Number(protocol) !== PROTOCOL) {
        return json({ error: 'Margin needs an update', protocol: PROTOCOL }, 426);
      }
      if (url.pathname === '/ws') {
        const auth = await authenticate(req);
        if (!auth) return json({ error: 'unauthorized' }, 401);
        return server.upgrade(req, { data: auth })
          ? undefined
          : json({ error: 'upgrade failed' }, 400);
      }
      try {
        return await route(req, url);
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        log(`${req.method} ${url.pathname}`)(e);
        return json({ error: 'internal error' }, 500);
      }
    },
    websocket: {
      // Clients send presence every 30 s; a silent socket is dropped after 90 s.
      idleTimeout: 90,
      maxPayloadLength: 128 * 1024,
      open: (ws: Socket) => void onOpen(ws).catch(log('open')),
      message: (ws: Socket, raw: string | Buffer) => {
        const next = (queues.get(ws) ?? Promise.resolve())
          .then(async () => {
            await onFrame(ws, raw);
          })
          .catch(log('frame'));
        queues.set(ws, next);
      },
      close: (ws: Socket) => {
        const done = onClose(ws)
          .catch(log('close'))
          .finally(() => closing.delete(done));
        closing.add(done);
      },
    },
    // Waits for socket-close work (offline presence) to finish, for a clean shutdown.
    async drain() {
      await Bun.sleep(0);
      await Promise.all(closing);
    },
  };
}
