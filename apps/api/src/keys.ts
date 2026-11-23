import { KeyBundle, type PeerBundle, PreKey } from '@margin/protocol';
import * as v from 'valibot';
import { HttpError, json, notFound, param, parseBody } from './http';
import type { Account, Context, SocketData } from './shared';

// Public key bundles: publishing your own, topping up one-time prekeys, and fetching a
// friend's bundle to start a session with them.

const PREKEY_CAP = 200;
const PREKEY_LOW = 20;
// How soon after signing in a Mac may replace the account's identity key.
const REPLACE_WINDOW_MS = 10 * 60_000;

const PreKeysBody = v.object({ preKeys: v.pipe(v.array(PreKey), v.maxLength(PREKEY_CAP)) });

export function keyRoutes({ sql, online, limits, sendTo, accountByHandle, areFriends }: Context) {
  async function prekeyCount(accountId: string) {
    const [row] =
      await sql`SELECT COUNT(*) AS n FROM one_time_prekeys WHERE account_id = ${accountId}`;
    return Number(row.n);
  }

  return async (
    req: Request,
    url: URL,
    me: Account,
    session: Pick<SocketData, 'tokenHash' | 'signedInAt'>,
  ): Promise<Response | null> => {
    const { method } = req;
    const path = url.pathname;

    if (method === 'PUT' && path === '/keys') {
      const bundle = await parseBody(KeyBundle, req);
      const [existing] =
        await sql`SELECT identity_key FROM key_bundles WHERE account_id = ${me.id}`;
      // One account, one Mac: a different key means the account has moved to another Mac (a
      // new one, a reinstall, a wiped data folder). Only a sign-in from just now may move it,
      // not a session token kept from before.
      const moving = !!existing && existing.identity_key !== bundle.identityKey;
      if (moving && Date.now() - session.signedInAt > REPLACE_WINDOW_MS) {
        throw new HttpError(409, 'identity key already registered');
      }
      const row = {
        account_id: me.id,
        registration_id: bundle.registrationId,
        identity_key: bundle.identityKey,
        signed_prekey: JSON.stringify(bundle.signedPreKey),
        updated_at: Date.now(),
      };
      // Messages waiting for the old key can't be read on this Mac; each becomes a request to
      // its sender to send it again on a new session. Controls (receipts, previews, Undo
      // Send) refer to history this Mac doesn't have, so they just go.
      let unreadable: { id: string; from_id: string; sent_at: number }[] = [];
      await sql.begin(async (tx) => {
        await tx`INSERT INTO key_bundles ${tx(row)} ON CONFLICT (account_id) DO UPDATE SET
          registration_id = ${row.registration_id}, identity_key = ${row.identity_key},
          signed_prekey = ${row.signed_prekey}, updated_at = ${row.updated_at}`;
        if (moving) {
          await tx`DELETE FROM sessions WHERE account_id = ${me.id} AND token_hash <> ${session.tokenHash}`;
          unreadable = await tx`
            SELECT id, from_id, sent_at FROM queued_messages
            WHERE to_id = ${me.id} AND NOT control`;
          for (const q of unreadable) {
            if (online.has(q.from_id)) continue;
            await tx`INSERT INTO queued_resets ${tx({ to_id: q.from_id, from_id: me.id, message_id: q.id, sent_at: Number(q.sent_at) })}
              ON CONFLICT DO NOTHING`;
          }
          await tx`DELETE FROM queued_messages WHERE to_id = ${me.id}`;
        }
        await tx`DELETE FROM one_time_prekeys WHERE account_id = ${me.id}`;
        for (const pk of bundle.preKeys) {
          await tx`INSERT INTO one_time_prekeys ${tx({ account_id: me.id, key_id: pk.keyId, public_key: pk.publicKey })}
            ON CONFLICT DO NOTHING`;
        }
      });
      if (moving) {
        for (const socket of online.get(me.id)?.sockets ?? []) {
          if (socket.data.tokenHash !== session.tokenHash)
            socket.close(4003, 'signed in elsewhere');
        }
        for (const q of unreadable) sendTo(q.from_id, { t: 'reset', from: me.handle, id: q.id });
      }
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
    const keysFor = param(path, /^\/keys\/([^/]+)$/);
    if (method === 'GET' && keysFor !== null) {
      if (!limits.keys(me.id)) throw new HttpError(429, 'rate limited');
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
    return null;
  };
}
