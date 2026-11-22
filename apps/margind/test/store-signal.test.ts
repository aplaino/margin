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
    expect(store.settings()).toMatchObject({ invisible: true, findable: false, damaged: true });
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

  test('safety numbers match on both sides', () => {
    const { a, b } = pair();
    expect(a.signal.safetyNumber(b.signal.identityKey())).toBe(
      b.signal.safetyNumber(a.signal.identityKey()),
    );
    expect(a.signal.safetyNumber(b.signal.identityKey())).toMatch(/^[0-9a-f]{5}( [0-9a-f]{5}){3}$/);
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
