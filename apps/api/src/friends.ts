import { randomUUID } from 'node:crypto';
import { type BlockList, type Directory, type FriendList, Handle } from '@margin/protocol';
import * as v from 'valibot';
import { HttpError, json, notFound, param, parseBody } from './http';
import type { Account, Context } from './shared';

// The friend graph: friends, requests, the directory, blocks and reports.

const HandleBody = v.object({ handle: Handle });
const ReportBody = v.object({
  handle: Handle,
  reason: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
});

export function friendRoutes({
  sql,
  online,
  limits,
  visibleTo,
  sendTo,
  accountByHandle,
  areFriends,
  requestsOf,
}: Context) {
  async function blockedEitherWay(a: string, b: string) {
    const [row] = await sql`
      SELECT 1 AS ok FROM blocks
      WHERE (blocker_id = ${a} AND blocked_id = ${b}) OR (blocker_id = ${b} AND blocked_id = ${a})`;
    return !!row;
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
    const pa = visibleTo(online.get(a.id), b.id);
    const pb = visibleTo(online.get(b.id), a.id);
    if (pa) sendTo(b.id, { t: 'presence', from: a.handle, presence: pa });
    if (pb) sendTo(a.id, { t: 'presence', from: b.handle, presence: pb });
  }

  return async (req: Request, url: URL, me: Account): Promise<Response | null> => {
    const { method } = req;
    const path = url.pathname;

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

    // Find friends. Leaves out you, your friends, anyone who switched it off, anyone who has
    // blocked you and anyone you've blocked, so a block never shows.
    if (method === 'GET' && path === '/directory') {
      if (!limits.directory(me.id)) throw new HttpError(429, 'rate limited');
      const query = (url.searchParams.get('q') ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9 -]/g, '')
        .slice(0, 39);
      const like = `%${query}%`;
      const rows = await sql`
        SELECT a.handle, a.name,
          EXISTS (SELECT 1 FROM friend_requests r WHERE r.from_id = ${me.id} AND r.to_id = a.id) AS requested
        FROM accounts a
        WHERE a.id <> ${me.id} AND a.findable = TRUE
          AND (a.handle LIKE ${like} OR LOWER(COALESCE(a.name, '')) LIKE ${like})
          AND NOT EXISTS (SELECT 1 FROM friendships f WHERE f.a_id = ${me.id} AND f.b_id = a.id)
          AND NOT EXISTS (SELECT 1 FROM blocks b
            WHERE (b.blocker_id = a.id AND b.blocked_id = ${me.id}) OR (b.blocker_id = ${me.id} AND b.blocked_id = a.id))
        ORDER BY a.handle LIMIT 100`;
      const directory: Directory = {
        people: rows.map((r: { handle: string; name: string | null; requested: unknown }) => ({
          handle: r.handle,
          ...(r.name ? { name: r.name } : {}),
          requested: Boolean(Number(r.requested) || r.requested === true),
        })),
      };
      return json(directory);
    }
    if (method === 'GET' && path === '/blocks') {
      const rows = await sql`
        SELECT a.handle FROM blocks b JOIN accounts a ON a.id = b.blocked_id
        WHERE b.blocker_id = ${me.id} ORDER BY a.handle`;
      const list: BlockList = { blocked: rows.map((r: { handle: string }) => r.handle) };
      return json(list);
    }
    if (method === 'POST' && path === '/friends/requests') {
      if (!limits.request(me.id)) throw new HttpError(429, 'rate limited');
      const { handle } = await parseBody(HandleBody, req);
      const peer = await accountByHandle(handle);
      // Unknown and blocked handles get the same answer, so a block can't be detected.
      if (!peer || peer.id === me.id || (await blockedEitherWay(me.id, peer.id))) throw notFound();
      if (await areFriends(me.id, peer.id)) return json({ status: 'friends' });
      await sql`INSERT INTO friend_requests ${sql({ from_id: me.id, to_id: peer.id, created_at: Date.now() })}
        ON CONFLICT DO NOTHING`;
      // Looked for after saving ours: when both ask at the same moment, whichever looks second
      // finds the other's, so the two never end up waiting on each other.
      const [reverse] = await sql`
        SELECT 1 AS ok FROM friend_requests WHERE from_id = ${peer.id} AND to_id = ${me.id}`;
      if (reverse) {
        await befriend(me.id, peer.id);
        await friendsChanged(me, peer);
        return json({ status: 'friends' });
      }
      sendTo(peer.id, { t: 'friends-changed' });
      return json({ status: 'requested' });
    }
    const accept = param(path, /^\/friends\/requests\/([^/]+)\/accept$/);
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
    const decline = param(path, /^\/friends\/requests\/([^/]+)$/);
    if (method === 'DELETE' && decline !== null) {
      const peer = await accountByHandle(decline);
      if (!peer) throw notFound();
      await sql`DELETE FROM friend_requests
        WHERE (from_id = ${peer.id} AND to_id = ${me.id}) OR (from_id = ${me.id} AND to_id = ${peer.id})`;
      sendTo(me.id, { t: 'friends-changed' });
      sendTo(peer.id, { t: 'friends-changed' });
      return json({ ok: true });
    }
    const friend = param(path, /^\/friends\/([^/]+)$/);
    if (method === 'DELETE' && friend !== null) {
      const peer = await accountByHandle(friend);
      if (!peer) throw notFound();
      await unfriend(me.id, peer.id);
      await friendsChanged(me, peer);
      return json({ ok: true });
    }

    const block = param(path, /^\/blocks\/([^/]+)$/);
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
      await sql`DELETE FROM queued_resets WHERE from_id = ${peer.id} AND to_id = ${me.id}`;
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
    return null;
  };
}
