import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { CONTROL, Findable, Handle, Name, type Session } from '@margin/protocol';
import * as v from 'valibot';
import type { GithubUser, Options } from './app';
import { HttpError, json, notFound, parseBody } from './http';
import type { Account, Context } from './shared';

// Signing in and out, and the signed-in account itself: export, delete, findable.

const AuthGithub = v.object({ accessToken: v.pipe(v.string(), v.minLength(1), v.maxLength(512)) });
const AuthDev = v.object({ handle: Handle, name: v.optional(Name) });

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

// GitHub display names are free text; keep them only if they're safe to show.
function cleanName(name: string | null | undefined) {
  const cleaned = name?.replace(CONTROL, '').trim().slice(0, 64);
  return cleaned && v.is(Name, cleaned) ? cleaned : undefined;
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

export function accountRoutes(
  { sql, online, limits, visibleTo, sendTo, accountByHandle, friendIds, requestsOf }: Context,
  options: Options,
) {
  const fetchGithubUser = options.fetchGithubUser ?? githubUser;

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
      await tx`DELETE FROM queued_resets WHERE to_id = ${id} OR from_id = ${id}`;
      await tx`DELETE FROM one_time_prekeys WHERE account_id = ${id}`;
      await tx`DELETE FROM key_bundles WHERE account_id = ${id}`;
      await tx`DELETE FROM sessions WHERE account_id = ${id}`;
      await tx`DELETE FROM accounts WHERE id = ${id}`;
    });
  }

  // The routes that come before a session exists.
  async function signIn(req: Request, url: URL): Promise<Response | null> {
    const { method } = req;
    const path = url.pathname;
    if (method === 'POST' && path === '/auth/github') {
      if (!limits.signIn(req.headers.get('fly-client-ip') ?? 'unknown')) {
        throw new HttpError(429, 'rate limited');
      }
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
    return null;
  }

  async function signedIn(
    req: Request,
    url: URL,
    me: Account,
    tokenHash: string,
  ): Promise<Response | null> {
    const { method } = req;
    const path = url.pathname;
    if (method === 'POST' && path === '/auth/logout') {
      await sql`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
      for (const socket of online.get(me.id)?.sockets ?? []) {
        if (socket.data.tokenHash === tokenHash) socket.close(4001, 'signed out');
      }
      return json({ ok: true });
    }
    if (method === 'GET' && path === '/me') return json(me);
    if (method === 'GET' && path === '/me/export') return json(await exportAccount(me));
    if (method === 'DELETE' && path === '/me') {
      const friends = await friendIds(me.id);
      await deleteAccount(me.id);
      const entry = online.get(me.id);
      for (const socket of entry?.sockets ?? []) socket.close(4002, 'account deleted');
      online.delete(me.id);
      for (const id of friends) {
        if (visibleTo(entry, id)) {
          sendTo(id, {
            t: 'presence',
            from: me.handle,
            presence: { status: 'offline', at: Date.now() },
          });
        }
        sendTo(id, { t: 'friends-changed' });
      }
      return json({ ok: true });
    }
    if (method === 'GET' && path === '/me/findable') {
      const [row] = await sql`SELECT findable FROM accounts WHERE id = ${me.id}`;
      return json({ findable: Boolean(Number(row?.findable) || row?.findable === true) });
    }
    if (method === 'PUT' && path === '/me/findable') {
      const { findable } = await parseBody(Findable, req);
      await sql`UPDATE accounts SET findable = ${findable} WHERE id = ${me.id}`;
      return json({ findable });
    }
    return null;
  }

  return { authenticate, signIn, signedIn };
}
