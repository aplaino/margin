import { Handle, type PublicPresence, type Requests, type ServerFrame } from '@margin/protocol';
import type { ServerWebSocket, SQL } from 'bun';
import * as v from 'valibot';
import { limiter } from './limits';

// What the route and socket modules share: the account and connection types, each app's
// rate limits, and the lookups several of them need.

export type Account = { id: string; handle: string };
export type SocketData = Account & { tokenHash: string; signedInAt: number };
export type Socket = ServerWebSocket<SocketData>;
export type Online = {
  sockets: Set<Socket>;
  presence?: PublicPresence;
  // Close-friends view: viewer account id → what they see instead of the default.
  targeted?: Map<string, PublicPresence>;
};

export function rateLimits() {
  return {
    message: limiter(60, 60_000),
    // Receipts, previews and Undo Send, on their own budget so a friend's flood of messages
    // (each answered with a delivery receipt) can't use up yours.
    control: limiter(240, 60_000),
    // Every send, however it's marked, so marking messages as controls can't buy more.
    send: limiter(300, 60_000),
    // Each sign-in asks GitHub who you are; per address, since there's no account yet.
    signIn: limiter(30, 60 * 60_000),
    // Each fetch uses up one of a friend's one-time prekeys.
    keys: limiter(60, 60 * 60_000),
    reset: limiter(30, 60_000),
    presence: limiter(60, 60_000),
    request: limiter(20, 60 * 60_000),
    directory: limiter(300, 60 * 60_000),
  };
}
export type Limits = ReturnType<typeof rateLimits>;

export const log = (what: string) => (e: unknown) => console.error(`[api] ${what}: ${e}`);

export function shared(sql: SQL, online: Map<string, Online>) {
  const presenceFor = (entry: Online | undefined, viewerId: string) =>
    entry?.targeted?.get(viewerId) ?? entry?.presence;
  // What a friend can tell about someone: their view while they're online or idle, nothing
  // while they're offline or invisible. Offline is only ever sent as a change from this, so
  // nobody learns that an invisible friend is connected, or when they connect or leave.
  const visibleTo = (entry: Online | undefined, viewerId: string) => {
    const presence = presenceFor(entry, viewerId);
    return presence && presence.status !== 'offline' ? presence : undefined;
  };

  function sendTo(accountId: string, frame: ServerFrame) {
    const data = JSON.stringify(frame);
    for (const socket of online.get(accountId)?.sockets ?? []) socket.send(data);
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

  async function friendIds(accountId: string): Promise<string[]> {
    const rows = await sql`SELECT b_id FROM friendships WHERE a_id = ${accountId}`;
    return rows.map((r: { b_id: string }) => r.b_id);
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

  return { visibleTo, sendTo, accountByHandle, areFriends, friendIds, requestsOf };
}

// One app's state and lookups, handed to each module: tests run several apps in one process,
// so none of this lives at module level.
export type Context = ReturnType<typeof shared> & {
  sql: SQL;
  online: Map<string, Online>;
  limits: Limits;
};
