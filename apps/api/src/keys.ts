import { KeyBundle, type PeerBundle, PreKey } from '@margin/protocol';
import * as v from 'valibot';
import { HttpError, json, notFound, param, parseBody } from './http';
import type { Account, Context } from './shared';

// Public key bundles: publishing your own, topping up one-time prekeys, and fetching a
// friend's bundle to start a session with them.

const PREKEY_CAP = 200;
const PREKEY_LOW = 20;

const PreKeysBody = v.object({ preKeys: v.pipe(v.array(PreKey), v.maxLength(PREKEY_CAP)) });

export function keyRoutes({ sql, limits, sendTo, accountByHandle, areFriends }: Context) {
  async function prekeyCount(accountId: string) {
    const [row] =
      await sql`SELECT COUNT(*) AS n FROM one_time_prekeys WHERE account_id = ${accountId}`;
    return Number(row.n);
  }

  return async (req: Request, url: URL, me: Account): Promise<Response | null> => {
    const { method } = req;
    const path = url.pathname;

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
