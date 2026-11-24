import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type PeerBundle } from '@margin/protocol';
import { memoryKeys } from '../src/keychain';
import { Signal } from '../src/signal';
import { Store } from '../src/store';

const dirs: string[] = [];
const keys = memoryKeys();
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'margind-'));
  dirs.push(dir);
  const path = join(dir, 'margind.sqlite');
  return { path, store: new Store(path, keys(dir)) };
}

const peerBundle = (handle: string, signal: Signal): PeerBundle => {
  const bundle = signal.bundle();
  return { ...bundle, handle, preKeys: bundle.preKeys.slice(0, 1) };
};

function pair() {
  const alice = { store: new Store(':memory:', keys('alice')) };
  const bob = { store: new Store(':memory:', keys('bob')) };
  const a = { ...alice, signal: new Signal(alice.store) };
  const b = { ...bob, signal: new Signal(bob.store) };
  a.store.upsertFriend('bob');
  b.store.upsertFriend('alice');
  a.store.pin('bob', peerBundle('bob', b.signal));
  b.store.pin('alice', peerBundle('alice', a.signal));
  return { a, b };
}

describe('store', () => {
  test('message text, names and settings are not readable on disk', () => {
    const { path, store } = tempStore();
    store.upsertFriend('maya', 'Maya Secretname');
    store.saveMessage({
      id: crypto.randomUUID(),
      peer: 'maya',
      direction: 'in',
      text: 'the launch code',
      sentAt: 1,
    });
    store.saveSettings({ ...DEFAULT_SETTINGS, repos: { 'acme/stealth-project': 'hidden' } });
    store.setTokenSource('/Users/me/clients/acme-secret/session.jsonl', 10, '0');
    store.close();
    const raw = [path, `${path}-wal`]
      .map((p) => {
        try {
          return readFileSync(p).toString('latin1');
        } catch {
          return '';
        }
      })
      .join('');
    for (const secret of ['launch code', 'Secretname', 'stealth-project', 'acme-secret']) {
      expect(raw.includes(secret)).toBe(false);
    }
  });

  test('a store opened with the wrong key cannot read anything', () => {
    const { path, store } = tempStore();
    store.set('x', 'secret');
    store.close();
    const wrong = new Store(path, keys('someone-else'));
    expect(() => wrong.get('x')).toThrow();
  });

  test('unread counts reset when read, and history pages backwards', () => {
    const store = new Store(':memory:', keys('u'));
    for (let i = 1; i <= 5; i++) {
      store.saveMessage({
        id: crypto.randomUUID(),
        peer: 'leo',
        direction: 'in',
        text: `m${i}`,
        sentAt: i,
      });
    }
    expect(store.unread('leo')).toBe(5);
    store.markRead('leo');
    expect(store.unread('leo')).toBe(0);
    store.saveMessage({
      id: crypto.randomUUID(),
      peer: 'leo',
      direction: 'in',
      text: 'm6',
      sentAt: 6,
    });
    expect(store.unread('leo')).toBe(1);
    expect(store.history('leo', 4, 2).map((m) => m.text)).toEqual(['m2', 'm3']);
  });

  test('a read receipt never marks what is still waiting to leave, or a time still to come', () => {
    const store = new Store(':memory:', keys('r'));
    const out = (id: string, sentAt: number, state: 'queued' | 'sent' | 'delivered') =>
      store.saveMessage({ id, peer: 'leo', direction: 'out', text: id, sentAt, state });
    out('waiting', 1, 'queued');
    out('sent', 2, 'sent');
    out('seen', 3, 'delivered');
    out('later', 4, 'sent');
    expect(store.readUpTo('maya', 'seen', 10)).toBe(false);
    expect(store.readUpTo('leo', 'seen', Date.now() + 60 * 60_000)).toBe(true);
    expect(store.history('leo').map((m) => [m.id, m.state])).toEqual([
      ['waiting', 'queued'],
      ['sent', 'read'],
      ['seen', 'read'],
      ['later', 'sent'],
    ]);
    expect(store.message('seen')?.readAt).toBeLessThanOrEqual(Date.now());
  });

  test('removing a friend ends the session, unless only switching servers', () => {
    const store = new Store(':memory:', keys('k'));
    store.upsertFriend('leo');
    store.storeSignalSession('leo.1', '{}');
    store.removeFriend('leo', { keepSession: true });
    expect(store.loadSignalSession('leo.1')).not.toBeNull();
    store.upsertFriend('leo');
    store.removeFriend('leo');
    expect(store.loadSignalSession('leo.1')).toBeNull();
  });

  test('the newest message in each chat, most recent chat first', () => {
    const store = new Store(':memory:', keys('l'));
    const save = (peer: string, direction: 'in' | 'out', text: string, sentAt: number) =>
      store.saveMessage({ id: crypto.randomUUID(), peer, direction, text, sentAt });
    save('leo', 'in', 'hi', 1);
    save('sam', 'out', 'lunch?', 2);
    save('leo', 'out', 'hey leo', 3);
    expect(store.latest().map((m) => [m.peer, m.text])).toEqual([
      ['leo', 'hey leo'],
      ['sam', 'lunch?'],
    ]);
  });

  test('an unsent message keeps its place but not its text, and stops counting as unread', () => {
    const store = new Store(':memory:', keys('u2'));
    const id = crypto.randomUUID();
    store.saveMessage({ id, peer: 'leo', direction: 'in', text: 'oops', sentAt: 1 });
    expect(store.unread('leo')).toBe(1);
    store.unsend(id);
    expect(store.message(id)).toMatchObject({ text: '', state: 'unsent' });
    expect(store.unread('leo')).toBe(0);
    // The server confirming it afterwards doesn't bring it back.
    store.setMessageState(id, 'sent');
    expect(store.message(id)?.state).toBe('unsent');
  });

  test('deleting a message or a whole chat touches only this Mac’s copy of that chat', () => {
    const store = new Store(':memory:', keys('del'));
    const save = (peer: string, text: string, sentAt: number) =>
      store.saveMessage({ id: crypto.randomUUID(), peer, direction: 'in', text, sentAt });
    save('leo', 'one', 1);
    save('leo', 'two', 2);
    save('sam', 'hi', 3);
    const [first] = store.history('leo');
    store.deleteMessage(first?.id ?? '');
    expect(store.history('leo').map((m) => m.text)).toEqual(['two']);
    store.deleteChat('leo');
    expect(store.history('leo')).toEqual([]);
    expect(store.unread('leo')).toBe(0);
    expect(store.history('sam').map((m) => m.text)).toEqual(['hi']);
  });

  test('search finds text in any chat, newest first, ignoring case and unsent messages', () => {
    const store = new Store(':memory:', keys('search'));
    const save = (peer: string, text: string, sentAt: number) => {
      const id = crypto.randomUUID();
      store.saveMessage({ id, peer, direction: 'in', text, sentAt });
      return id;
    };
    save('leo', 'the Big fixtures', 1);
    save('sam', 'nothing here', 2);
    const gone = save('sam', 'big plans', 3);
    save('maya', 'BIG news', 4);
    store.unsend(gone);
    expect(store.search('big').map((m) => [m.peer, m.text])).toEqual([
      ['maya', 'BIG news'],
      ['leo', 'the Big fixtures'],
    ]);
    expect(store.search('big', 1)).toHaveLength(1);
    expect(store.search('missing')).toEqual([]);
  });

  test('a chat opened at an old message starts a little before it and runs to the newest', () => {
    const store = new Store(':memory:', keys('around'));
    const ids: string[] = [];
    for (let i = 1; i <= 100; i++) {
      const id = crypto.randomUUID();
      ids.push(id);
      store.saveMessage({ id, peer: 'leo', direction: 'in', text: `m${i}`, sentAt: i });
    }
    const around = store.historyAround('leo', ids[9] ?? '', 3);
    expect(around.map((m) => m.text).slice(0, 4)).toEqual(['m7', 'm8', 'm9', 'm10']);
    expect(around.at(-1)?.text).toBe('m100');
    expect(around).toHaveLength(94);
    // Already in the latest page, or not in this chat: the latest page.
    expect(store.historyAround('leo', ids[95] ?? '')).toEqual(store.history('leo'));
    expect(store.historyAround('sam', ids[9] ?? '')).toEqual(store.history('sam'));
  });

  test('a saved message id is never stored twice', () => {
    const store = new Store(':memory:', keys('d'));
    const id = crypto.randomUUID();
    store.saveMessage({ id, peer: 'leo', direction: 'in', text: 'first', sentAt: 1 });
    store.saveMessage({ id, peer: 'leo', direction: 'in', text: 'replayed', sentAt: 2 });
    expect(store.history('leo').map((m) => m.text)).toEqual(['first']);
  });

  test('the first pinned identity key wins', () => {
    const store = new Store(':memory:', keys('p'));
    store.upsertFriend('leo');
    const bundle = (identityKey: string): PeerBundle => ({
      handle: 'leo',
      registrationId: 1,
      identityKey,
      signedPreKey: { keyId: 1, publicKey: 'AA==', signature: 'AA==' },
      preKeys: [],
    });
    store.pin('leo', bundle('first'));
    store.pin('leo', bundle('second'));
    expect(() => store.pin('leo', { ...bundle('third'), handle: 'mallory' })).toThrow(
      'different handle',
    );
    expect(store.friend('leo')?.identityKey).toBe('first');
  });

  test('damaged settings fail closed: invisible and unfindable, not the share-everything defaults', () => {
    const store = new Store(':memory:', keys('s'));
    expect(store.settings()).toEqual(DEFAULT_SETTINGS);
    store.setJson('settings', {
      audience: 'the whole internet',
      repos: { 'acme/secret': 'hidden' },
    });
    expect(store.settings()).toMatchObject({
      invisible: true,
      findable: false,
      readReceipts: false,
      damaged: true,
    });
  });

  test('database files are readable only by you', () => {
    const { path, store } = tempStore();
    store.set('x', 'y');
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      expect((statSync(file).mode & 0o777).toString(8)).toBe('600');
    }
  });

  test('removing a friend only touches their own Signal sessions', () => {
    const store = new Store(':memory:', keys('rm'));
    store.storeSignalSession('leo.1', '{}');
    store.storeSignalSession('leon.1', '{}');
    store.removeFriend('leo');
    expect(store.loadSignalSession('leo.1')).toBeNull();
    expect(store.loadSignalSession('leon.1')).not.toBeNull();
    expect(() => store.removeFriend('%')).toThrow();
  });
});

describe('signal', () => {
  test('a conversation both ways, starting from a prekey message', async () => {
    const { a, b } = pair();
    const first = await a.signal.encrypt('bob', 'hi bob', peerBundle('bob', b.signal));
    expect(first.type).toBe(3);
    expect(await b.signal.decrypt('alice', first)).toBe('hi bob');

    // Bob already has a session from Alice's first message, so no bundle is needed.
    const reply = await b.signal.encrypt('alice', 'hi alice');
    expect(await a.signal.decrypt('bob', reply)).toBe('hi alice');
    const next = await a.signal.encrypt('bob', 'second', peerBundle('bob', b.signal));
    expect(next.type).toBe(1);
    expect(await b.signal.decrypt('alice', next)).toBe('second');
  });

  test('the prekey used to start a session is deleted', async () => {
    const { a, b } = pair();
    const used = peerBundle('bob', b.signal).preKeys[0]?.keyId;
    await b.signal.decrypt(
      'alice',
      await a.signal.encrypt('bob', 'x', peerBundle('bob', b.signal)),
    );
    expect(b.store.preKeyIds()).not.toContain(used);
  });

  test('someone else claiming to be alice is rejected', async () => {
    const { b } = pair();
    const malloryStore = new Store(':memory:', keys('mallory'));
    const mallory = new Signal(malloryStore);
    malloryStore.upsertFriend('bob');
    malloryStore.pin('bob', peerBundle('bob', b.signal));
    const forged = await mallory.encrypt('bob', 'it is me, alice', peerBundle('bob', b.signal));
    await expect(b.signal.decrypt('alice', forged)).rejects.toThrow();
  });

  test('replenished prekeys never reuse an id', () => {
    const store = new Store(':memory:', keys('r'));
    const signal = new Signal(store);
    for (const id of store.preKeyIds()) store.removePreKey(id);
    const ids = signal.replenish(3).map((p) => p.keyId);
    expect(Math.min(...ids)).toBeGreaterThan(50);
  });

  test('the local prekey supply is capped at 200', () => {
    const store = new Store(':memory:', keys('cap'));
    const signal = new Signal(store);
    for (let i = 0; i < 10; i++) signal.replenish();
    expect(store.preKeyIds().length).toBe(200);
    expect(signal.replenish()).toEqual([]);
  });

  test('safety numbers match on both sides, and change with either key or handle', () => {
    const { a, b } = pair();
    const fromAlice = a.signal.safetyNumber('alice', 'bob', b.signal.identityKey());
    expect(b.signal.safetyNumber('bob', 'alice', a.signal.identityKey())).toBe(fromAlice);
    expect(fromAlice).toMatch(/^\d{5}( \d{5}){11}$/);
    expect(a.signal.safetyNumber('alice', 'bobby', b.signal.identityKey())).not.toBe(fromAlice);
    const other = new Signal(new Store(':memory:', keys('other')));
    expect(a.signal.safetyNumber('alice', 'bob', other.identityKey())).not.toBe(fromAlice);
  });
});

describe('paths', () => {
  test('the data folder is private, and a symlink is refused', async () => {
    const { paths } = await import('../src/paths');
    const base = mkdtempSync(join(tmpdir(), 'margind-paths-'));
    dirs.push(base);
    const home = join(base, 'home');
    const { mkdirSync, symlinkSync } = await import('node:fs');
    mkdirSync(home, { mode: 0o755 });
    paths(home);
    expect((statSync(home).mode & 0o777).toString(8)).toBe('700');
    symlinkSync(home, join(base, 'link'));
    expect(() => paths(join(base, 'link'))).toThrow('not a private folder');
  });
});
