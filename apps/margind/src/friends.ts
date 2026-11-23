import { Count, type Friend, FriendList, PeerBundle, type Push, Requests } from '@margin/protocol';
import * as v from 'valibot';
import { type Api, ApiError } from './api';
import { log } from './errors';
import { PREKEY_BATCH, type Signal } from './signal';
import type { Store } from './store';

// The friend list mirrored from the server, friends' pinned identity keys, and keeping
// enough of your own prekeys on the server for friends to start sessions with.

const KeyCount = v.object({ remaining: Count });

const PREKEY_LOW = 20;

export type FriendsDeps = {
  store: Store;
  signal: Signal;
  api: () => Api;
  push: (value: Push) => void;
  problem: (what: string, e?: unknown) => void;
  roster: () => Friend[];
  // Drops what's kept of a friend's presence once they're no longer a friend.
  forget: (handle: string) => void;
};

export function createFriends({ store, signal, api, push, problem, roster, forget }: FriendsDeps) {
  let requests: Requests = { incoming: [], outgoing: [] };

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
        forget(handle);
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

  return {
    syncFriends,
    fetchBundle,
    topUpPreKeys,
    requests: () => requests,
    clearRequests() {
      requests = { incoming: [], outgoing: [] };
    },
  };
}
