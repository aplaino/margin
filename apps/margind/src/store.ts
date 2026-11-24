import { Database } from 'bun:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import {
  type ChatMessage,
  DEFAULT_SETTINGS,
  Handle,
  type LinkPreview,
  type PeerBundle,
  Settings,
} from '@margin/protocol';
import * as v from 'valibot';

export type Account = { server: string; token: string; handle: Handle; name?: string };
export type Friend = { handle: Handle; name?: string; identityKey?: string };

// Ordered and append-only, tracked with PRAGMA user_version.
const MIGRATIONS = [
  `CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL);
   CREATE TABLE signal_sessions (address TEXT PRIMARY KEY, record BLOB NOT NULL);
   CREATE TABLE prekeys (id INTEGER PRIMARY KEY, pub BLOB NOT NULL, priv BLOB NOT NULL);
   CREATE TABLE friends (handle TEXT PRIMARY KEY, name BLOB, identity_key TEXT, bundle BLOB, added_at INTEGER NOT NULL);
   CREATE TABLE messages (
     id TEXT PRIMARY KEY, peer TEXT NOT NULL, direction TEXT NOT NULL, body BLOB NOT NULL,
     sent_at INTEGER NOT NULL, state TEXT);
   CREATE INDEX messages_peer ON messages (peer, sent_at);
   CREATE TABLE reads (peer TEXT PRIMARY KEY, at INTEGER NOT NULL);
   CREATE TABLE outbox (id TEXT PRIMARY KEY, peer TEXT NOT NULL, frame BLOB NOT NULL, created_at INTEGER NOT NULL);
   -- Token bookkeeping. Sources are keyed by a hash of their path, so no project names are stored.
   CREATE TABLE token_sources (key TEXT PRIMARY KEY, tokens INTEGER NOT NULL, cursor TEXT);
   CREATE TABLE token_seen (id TEXT PRIMARY KEY);`,
  // Read receipts: when a friend read your message.
  `ALTER TABLE messages ADD COLUMN read_at INTEGER;`,
  // A link's preview, sealed like the text.
  `ALTER TABLE messages ADD COLUMN preview BLOB;`,
  // What each outbox entry carries, for logging a refusal. Messages an earlier margind
  // dropped from the outbox after a refusal were left "queued"; they failed.
  `ALTER TABLE outbox ADD COLUMN kind TEXT;
   UPDATE messages SET state = 'failed'
     WHERE direction = 'out' AND state = 'queued' AND id NOT IN (SELECT id FROM outbox);`,
];

// A chat message, the same message sent again under a new session, or a control.
export type OutboxKind = 'message' | 'resend' | 'delivered' | 'read' | 'preview' | 'unsend';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// SQLite with AES-256-GCM on every sensitive column: private keys, Signal sessions,
// message text, names, the outbox and settings.
export class Store {
  private db: Database;

  constructor(
    path: string,
    private key: Buffer,
  ) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      if (path !== ':memory:' && existsSync(file)) chmodSync(file, 0o600);
    }
    const { user_version } = this.db
      .query<{ user_version: number }, []>('PRAGMA user_version')
      .get() ?? {
      user_version: 0,
    };
    for (let version = user_version; version < MIGRATIONS.length; version++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[version] ?? '');
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
      })();
    }
  }

  close() {
    this.db.close();
  }

  private seal(plain: Uint8Array | string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  private open(sealed: Uint8Array): Buffer {
    const buf = Buffer.from(sealed);
    const decipher = createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
  }

  get(key: string): Buffer | null {
    const row = this.db
      .query<{ value: Uint8Array }, [string]>('SELECT value FROM kv WHERE key = ?')
      .get(key);
    return row ? this.open(row.value) : null;
  }

  set(key: string, value: Uint8Array | string) {
    this.db
      .query('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
      .run(key, this.seal(value));
  }

  delete(key: string) {
    this.db.query('DELETE FROM kv WHERE key = ?').run(key);
  }

  getJson<T>(key: string): T | undefined {
    const value = this.get(key);
    return value ? (JSON.parse(value.toString()) as T) : undefined;
  }

  setJson(key: string, value: unknown) {
    this.set(key, JSON.stringify(value));
  }

  account(): Account | undefined {
    return this.getJson<Account>('account');
  }

  setAccount(account: Account | undefined) {
    if (account) this.setJson('account', account);
    else this.delete('account');
  }

  // Damaged settings fail closed: invisible until you look at them, because they might
  // have held a "hidden" repo override that the defaults would no longer honour.
  settings(): Settings & { damaged?: true } {
    const saved = this.getJson<Partial<Settings>>('settings');
    if (!saved) return DEFAULT_SETTINGS;
    const merged = {
      ...DEFAULT_SETTINGS,
      ...saved,
      share: { ...DEFAULT_SETTINGS.share, ...saved.share },
    };
    const parsed = v.safeParse(Settings, merged);
    return parsed.success
      ? parsed.output
      : {
          ...DEFAULT_SETTINGS,
          invisible: true,
          findable: false,
          readReceipts: false,
          linkPreviews: false,
          damaged: true,
        };
  }

  saveSettings(settings: Settings) {
    this.setJson('settings', v.parse(Settings, settings));
  }

  loadSignalSession(address: string): Buffer | null {
    const row = this.db
      .query<{ record: Uint8Array }, [string]>(
        'SELECT record FROM signal_sessions WHERE address = ?',
      )
      .get(address);
    return row ? this.open(row.record) : null;
  }

  storeSignalSession(address: string, record: string) {
    this.db
      .query('INSERT OR REPLACE INTO signal_sessions (address, record) VALUES (?, ?)')
      .run(address, this.seal(record));
  }

  addPreKey(id: number, pub: Buffer, priv: Buffer) {
    this.db
      .query('INSERT OR REPLACE INTO prekeys (id, pub, priv) VALUES (?, ?, ?)')
      .run(id, pub, this.seal(priv));
  }

  loadPreKey(id: number) {
    const row = this.db
      .query<{ pub: Uint8Array; priv: Uint8Array }, [number]>(
        'SELECT pub, priv FROM prekeys WHERE id = ?',
      )
      .get(id);
    return row ? { pubKey: Buffer.from(row.pub), privKey: this.open(row.priv) } : undefined;
  }

  preKeyIds(): number[] {
    return this.db
      .query<{ id: number }, []>('SELECT id FROM prekeys ORDER BY id')
      .all()
      .map((r) => r.id);
  }

  removePreKey(id: number) {
    this.db.query('DELETE FROM prekeys WHERE id = ?').run(id);
  }

  friends(): Friend[] {
    return this.db
      .query<{ handle: string; name: Uint8Array | null; identity_key: string | null }, []>(
        'SELECT handle, name, identity_key FROM friends ORDER BY handle',
      )
      .all()
      .map((r) => ({
        handle: r.handle,
        ...(r.name ? { name: this.open(r.name).toString() } : {}),
        ...(r.identity_key ? { identityKey: r.identity_key } : {}),
      }));
  }

  friend(handle: string): Friend | undefined {
    return this.friends().find((f) => f.handle === handle);
  }

  upsertFriend(handle: Handle, name?: string) {
    this.db
      .query(
        `INSERT INTO friends (handle, name, added_at) VALUES (?, ?, ?)
         ON CONFLICT (handle) DO UPDATE SET name = excluded.name`,
      )
      .run(handle, name ? this.seal(name) : null, Date.now());
  }

  // The identity key is pinned once; the bundle is kept for starting the first session.
  // Pinned under the handle that was asked for, never one taken from the response.
  pin(handle: Handle, bundle: PeerBundle) {
    if (bundle.handle !== handle) throw new Error('keys returned for a different handle');
    this.db
      .query(
        'UPDATE friends SET identity_key = COALESCE(identity_key, ?), bundle = ? WHERE handle = ?',
      )
      .run(bundle.identityKey, this.seal(JSON.stringify(bundle)), handle);
  }

  // A friend's new identity key, replacing the pinned one.
  repin(handle: Handle, identityKey: string) {
    this.db.query('UPDATE friends SET identity_key = ? WHERE handle = ?').run(identityKey, handle);
  }

  bundle(handle: string): PeerBundle | undefined {
    const row = this.db
      .query<{ bundle: Uint8Array | null }, [string]>('SELECT bundle FROM friends WHERE handle = ?')
      .get(handle);
    return row?.bundle ? JSON.parse(this.open(row.bundle).toString()) : undefined;
  }

  // Forgets the friend and anything waiting to be sent to them, which then failed. Chat
  // history stays.
  // Removing someone ends the encrypted session too, as it does on their side. Switching
  // servers keeps it (keepSession), since the friends on the other server still have theirs.
  removeFriend(handle: string, { keepSession = false } = {}) {
    v.parse(Handle, handle);
    this.db.query('DELETE FROM friends WHERE handle = ?').run(handle);
    this.db.query('DELETE FROM outbox WHERE peer = ?').run(handle);
    this.db
      .query(
        "UPDATE messages SET state = 'failed' WHERE peer = ? AND direction = 'out' AND state = 'queued'",
      )
      .run(handle);
    if (!keepSession) this.removeSignalSessions(handle);
  }

  removeSignalSessions(handle: string) {
    // Signal addresses are "<handle>.<deviceId>"; match that exact prefix.
    const prefix = `${handle}.`;
    this.db
      .query('DELETE FROM signal_sessions WHERE substr(address, 1, ?) = ?')
      .run(prefix.length, prefix);
  }

  hasMessage(id: string) {
    return !!this.db.query('SELECT 1 FROM messages WHERE id = ?').get(id);
  }

  saveMessage(message: ChatMessage) {
    this.db
      .query(
        'INSERT OR IGNORE INTO messages (id, peer, direction, body, sent_at, state) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        message.id,
        message.peer,
        message.direction,
        this.seal(message.text),
        message.sentAt,
        message.state ?? null,
      );
  }

  // An unsent message stays unsent, and a delivered or read one doesn't go back, whatever
  // the server says about it afterwards.
  setMessageState(id: string, state: 'queued' | 'sent' | 'failed') {
    this.db
      .query(
        "UPDATE messages SET state = ? WHERE id = ? AND state NOT IN ('unsent', 'delivered', 'read')",
      )
      .run(state, id);
  }

  // A friend's Mac has your message `id`. True if that changed anything.
  delivered(peer: string, id: string) {
    return (
      this.db
        .query(
          `UPDATE messages SET state = 'delivered'
           WHERE id = ? AND peer = ? AND direction = 'out' AND state IN ('queued', 'sent')`,
        )
        .run(id, peer).changes > 0
    );
  }

  // A friend has read up to your message `id`: it and everything you sent them before it
  // that has left this Mac. Never later than this Mac's clock.
  readUpTo(peer: string, id: string, at: number) {
    const row = this.db
      .query<{ sent_at: number }, [string, string]>(
        "SELECT sent_at FROM messages WHERE id = ? AND peer = ? AND direction = 'out'",
      )
      .get(id, peer);
    if (!row) return false;
    return (
      this.db
        .query(
          `UPDATE messages SET state = 'read', read_at = ?
           WHERE peer = ? AND direction = 'out' AND sent_at <= ?
             AND state IN ('sent', 'delivered')`,
        )
        .run(Math.min(at, Date.now()), peer, row.sent_at).changes > 0
    );
  }

  // Undo Send: the text (and any link preview) is gone, a marker stays in its place.
  unsend(id: string) {
    this.db
      .query("UPDATE messages SET state = 'unsent', body = ?, preview = NULL WHERE id = ?")
      .run(this.seal(''), id);
  }

  setPreview(id: string, preview: LinkPreview) {
    this.db
      .query('UPDATE messages SET preview = ? WHERE id = ?')
      .run(this.seal(JSON.stringify(preview)), id);
  }

  deleteMessage(id: string) {
    this.db.query('DELETE FROM messages WHERE id = ?').run(id);
  }

  // The whole conversation, from this Mac. The friend keeps theirs.
  deleteChat(peer: string) {
    this.db.query('DELETE FROM messages WHERE peer = ?').run(peer);
    this.db.query('DELETE FROM reads WHERE peer = ?').run(peer);
  }

  message(id: string): ChatMessage | undefined {
    const row = this.db.query<MessageRow, [string]>('SELECT * FROM messages WHERE id = ?').get(id);
    return row ? this.toMessage(row) : undefined;
  }

  history(peer: string, before = Number.MAX_SAFE_INTEGER, limit = 50): ChatMessage[] {
    return this.db
      .query<MessageRow, [string, number, number]>(
        `SELECT * FROM (SELECT * FROM messages WHERE peer = ? AND sent_at < ? ORDER BY sent_at DESC LIMIT ?)
         ORDER BY sent_at`,
      )
      .all(peer, before, limit)
      .map((r) => this.toMessage(r));
  }

  // A chat opened at a search result: a few messages before it, then everything up to the
  // newest, so new messages still arrive at the end. The latest page when it's already there.
  historyAround(peer: string, id: string, context = 20): ChatMessage[] {
    const latest = this.history(peer);
    const target = this.db
      .query<{ sent_at: number }, [string, string]>(
        'SELECT sent_at FROM messages WHERE id = ? AND peer = ?',
      )
      .get(id, peer);
    if (!target || latest.some((m) => m.id === id)) return latest;
    const from = this.history(peer, target.sent_at, context)[0]?.sentAt ?? target.sent_at;
    return this.db
      .query<MessageRow, [string, number]>(
        'SELECT * FROM messages WHERE peer = ? AND sent_at >= ? ORDER BY sent_at',
      )
      .all(peer, from)
      .map((r) => this.toMessage(r));
  }

  // Messages whose text contains `query`, ignoring case, newest first. Bodies are sealed, so
  // each is opened here; unsent ones have no text left to match.
  search(query: string, limit = 50): ChatMessage[] {
    const needle = query.toLocaleLowerCase();
    const found: ChatMessage[] = [];
    for (const row of this.db
      .query<MessageRow, []>(
        "SELECT * FROM messages WHERE state IS NOT 'unsent' ORDER BY sent_at DESC",
      )
      .iterate()) {
      if (!this.open(row.body).toString().toLocaleLowerCase().includes(needle)) continue;
      found.push(this.toMessage(row));
      if (found.length === limit) break;
    }
    return found;
  }

  // The newest message with each person, most recent conversation first.
  latest(): ChatMessage[] {
    const seen = new Set<string>();
    return this.db
      .query<MessageRow, []>(
        `SELECT m.* FROM messages m
         JOIN (SELECT peer, MAX(sent_at) AS at FROM messages GROUP BY peer) l
           ON m.peer = l.peer AND m.sent_at = l.at
         ORDER BY m.sent_at DESC`,
      )
      .all()
      .filter((r) => !seen.has(r.peer) && seen.add(r.peer))
      .map((r) => this.toMessage(r));
  }

  private toMessage(r: MessageRow): ChatMessage {
    return {
      id: r.id,
      peer: r.peer,
      direction: r.direction,
      text: this.open(r.body).toString(),
      sentAt: r.sent_at,
      ...(r.state ? { state: r.state } : {}),
      ...(r.read_at ? { readAt: r.read_at } : {}),
      ...(r.preview ? { preview: JSON.parse(this.open(r.preview).toString()) } : {}),
    };
  }

  unread(peer: string): number {
    const row = this.db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM messages WHERE peer = ? AND direction = 'in'
           AND state IS NOT 'unsent'
           AND sent_at > COALESCE((SELECT at FROM reads WHERE peer = ?), 0)`,
      )
      .get(peer, peer);
    return row?.n ?? 0;
  }

  // Everything received from this friend so far counts as read. Returns the newest message
  // if that's newly read, for a read receipt.
  markRead(peer: string): string | undefined {
    const row = this.db
      .query<{ id: string; sent_at: number; before: number | null }, [string, string]>(
        `SELECT id, sent_at, (SELECT at FROM reads WHERE peer = ?) AS before FROM messages
         WHERE peer = ? AND direction = 'in' AND state IS NOT 'unsent'
         ORDER BY sent_at DESC LIMIT 1`,
      )
      .get(peer, peer);
    if (!row || (row.before !== null && row.sent_at <= row.before)) return undefined;
    this.db.query('INSERT OR REPLACE INTO reads (peer, at) VALUES (?, ?)').run(peer, row.sent_at);
    return row.id;
  }

  enqueue(id: string, peer: string, frame: unknown, kind: OutboxKind) {
    this.db
      .query(
        'INSERT OR REPLACE INTO outbox (id, peer, frame, created_at, kind) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, peer, this.seal(JSON.stringify(frame)), Date.now(), kind);
  }

  outbox(): { id: string; peer: string; frame: unknown }[] {
    return this.db
      .query<{ id: string; peer: string; frame: Uint8Array }, []>(
        'SELECT id, peer, frame FROM outbox ORDER BY created_at',
      )
      .all()
      .map((r) => ({ id: r.id, peer: r.peer, frame: JSON.parse(this.open(r.frame).toString()) }));
  }

  // What it carried, if it was still waiting.
  dequeue(id: string): OutboxKind | null | undefined {
    return this.db
      .query<{ kind: OutboxKind | null }, [string]>(
        'DELETE FROM outbox WHERE id = ? RETURNING kind',
      )
      .get(id)?.kind;
  }

  tokenSource(path: string): { tokens: number; cursor: string | null } | undefined {
    return (
      this.db
        .query<{ tokens: number; cursor: string | null }, [string]>(
          'SELECT tokens, cursor FROM token_sources WHERE key = ?',
        )
        .get(sha256(path)) ?? undefined
    );
  }

  setTokenSource(path: string, tokens: number, cursor: string | null) {
    this.db
      .query('INSERT OR REPLACE INTO token_sources (key, tokens, cursor) VALUES (?, ?, ?)')
      .run(sha256(path), tokens, cursor);
  }

  // True the first time an id is seen, so one API response is never counted twice.
  firstSighting(id: string) {
    return (
      this.db.query('INSERT OR IGNORE INTO token_seen (id) VALUES (?)').run(sha256(id)).changes > 0
    );
  }

  tokenTotal(): number {
    return (
      this.db.query<{ n: number | null }, []>('SELECT SUM(tokens) AS n FROM token_sources').get()
        ?.n ?? 0
    );
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

type MessageRow = {
  id: string;
  peer: string;
  direction: 'in' | 'out';
  body: Uint8Array;
  sent_at: number;
  state: 'queued' | 'sent' | 'delivered' | 'read' | 'unsent' | 'failed' | null;
  read_at: number | null;
  preview: Uint8Array | null;
};
