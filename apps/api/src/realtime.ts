import { ClientFrame, type PublicPresence, type ServerFrame } from '@margin/protocol';
import type { Server } from 'bun';
import * as v from 'valibot';
import { json } from './http';
import { type Context, log, type Socket, type SocketData } from './shared';

// The WebSocket side: presence views and their delivery, queueing ciphertext for friends who
// are away, and resend requests.

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// While you're offline, a friend can't fill the server for you: at most this many messages
// wait from each friend, and this many in all.
const QUEUE_PER_FRIEND = 500;
const QUEUE_PER_ACCOUNT = 5000;
// Open connections per account (each Mac has one; a few more for restarts overlapping).
const SOCKETS_PER_ACCOUNT = 10;

export function realtime(
  { sql, online, limits, visibleTo, sendTo, accountByHandle, areFriends, friendIds }: Context,
  options: {
    retentionMs?: number;
    authenticate: (req: Request) => Promise<SocketData | null>;
  },
) {
  const retentionMs = options.retentionMs ?? RETENTION_MS;

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
        const before = new Map([...targeted.keys()].map((id) => [id, visibleTo(entry, id)]));
        // An empty list ends the close-friends view: they see the default one again.
        entry.targeted = targeted;
        for (const id of targeted.keys()) {
          if (frame.presence.status !== 'offline' || before.get(id)) {
            sendTo(id, { t: 'presence', from: me.handle, presence: frame.presence });
          }
        }
        return;
      }
      const friends = (await friendIds(me.id)).filter((id) => !entry.targeted?.has(id));
      const before = new Map(friends.map((id) => [id, visibleTo(entry, id)]));
      entry.presence = frame.presence;
      for (const id of friends) {
        if (frame.presence.status !== 'offline' || before.get(id)) {
          sendTo(id, { t: 'presence', from: me.handle, presence: frame.presence });
        }
      }
      return;
    }

    if (frame.t === 'send') {
      const reject = (error: string) =>
        ws.send(JSON.stringify({ t: 'rejected', id: frame.id, error } satisfies ServerFrame));
      if (!limits.send(me.id) || !(frame.control ? limits.control(me.id) : limits.message(me.id))) {
        return reject('rate limited');
      }
      const peer = await accountByHandle(frame.to);
      if (!peer || !(await areFriends(me.id, peer.id))) return reject('not a friend');
      const [waiting] = await sql`
        SELECT COUNT(*) AS total, SUM(CASE WHEN from_id = ${me.id} THEN 1 ELSE 0 END) AS mine
        FROM queued_messages WHERE to_id = ${peer.id}`;
      if (
        Number(waiting?.mine ?? 0) >= QUEUE_PER_FRIEND ||
        Number(waiting?.total ?? 0) >= QUEUE_PER_ACCOUNT
      ) {
        return reject('queue full');
      }
      const sentAt = Date.now();
      const [inserted] = await sql`
        INSERT INTO queued_messages ${sql({
          id: frame.id,
          to_id: peer.id,
          from_id: me.id,
          sent_at: sentAt,
          ciphertext: JSON.stringify(frame.ciphertext),
          control: frame.control ?? false,
        })} ON CONFLICT DO NOTHING RETURNING id`;
      if (!inserted) {
        // A retry of our own message is fine; someone else's id is not.
        const [existing] = await sql`SELECT from_id FROM queued_messages WHERE id = ${frame.id}`;
        if (existing?.from_id !== me.id) return reject('duplicate id');
      } else {
        sendTo(peer.id, {
          t: frame.control ? 'control' : 'message',
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

    if (frame.t === 'reset') {
      if (!limits.reset(me.id)) return;
      const peer = await accountByHandle(frame.to);
      if (!peer || !(await areFriends(me.id, peer.id))) return;
      const reset: ServerFrame = { t: 'reset', from: me.handle, id: frame.id };
      if (online.has(peer.id)) return sendTo(peer.id, reset);
      await sql`INSERT INTO queued_resets ${sql({
        to_id: peer.id,
        from_id: me.id,
        message_id: frame.id,
        sent_at: Date.now(),
      })} ON CONFLICT DO NOTHING`;
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
      const presence = visibleTo(online.get(friend.id), me.id);
      if (presence)
        ws.send(
          JSON.stringify({ t: 'presence', from: friend.handle, presence } satisfies ServerFrame),
        );
    }

    await sql`DELETE FROM queued_messages WHERE sent_at < ${Date.now() - retentionMs}`;
    const queued = await sql`
      SELECT q.id, q.sent_at, q.ciphertext, q.control, a.handle FROM queued_messages q
      JOIN accounts a ON a.id = q.from_id WHERE q.to_id = ${me.id} ORDER BY q.sent_at`;
    for (const q of queued) {
      const frame: ServerFrame = {
        t: q.control ? 'control' : 'message',
        id: q.id,
        from: q.handle,
        sentAt: Number(q.sent_at),
        ciphertext: JSON.parse(q.ciphertext),
      };
      ws.send(JSON.stringify(frame));
    }

    // Requests to resend that came while this Mac was away; a resend is only useful while the
    // message itself could still be delivered.
    await sql`DELETE FROM queued_resets WHERE sent_at < ${Date.now() - retentionMs}`;
    const resets = await sql`
      SELECT r.message_id, a.handle FROM queued_resets r JOIN accounts a ON a.id = r.from_id
      WHERE r.to_id = ${me.id} ORDER BY r.sent_at`;
    for (const r of resets) {
      ws.send(
        JSON.stringify({ t: 'reset', from: r.handle, id: r.message_id } satisfies ServerFrame),
      );
    }
    await sql`DELETE FROM queued_resets WHERE to_id = ${me.id}`;
  }

  async function onClose(ws: Socket) {
    const me = ws.data;
    const entry = online.get(me.id);
    if (!entry?.sockets.delete(ws) || entry.sockets.size > 0) return;
    online.delete(me.id);
    for (const id of await friendIds(me.id)) {
      if (!visibleTo(entry, id)) continue;
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

  return {
    async upgrade(req: Request, server: Server<SocketData>) {
      const auth = await options.authenticate(req);
      if (!auth) return json({ error: 'unauthorized' }, 401);
      if ((online.get(auth.id)?.sockets.size ?? 0) >= SOCKETS_PER_ACCOUNT) {
        return json({ error: 'too many connections' }, 429);
      }
      return server.upgrade(req, { data: auth })
        ? undefined
        : json({ error: 'upgrade failed' }, 400);
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
