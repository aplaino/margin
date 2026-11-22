import { SQL } from 'bun';

// The same SQL runs on Postgres (staging, production) and SQLite (tests). Timestamps are epoch ms.
export function openDb(url = process.env.DATABASE_URL ?? 'sqlite://:memory:') {
  return new SQL(url);
}

// Ordered and append-only: never edit a shipped migration, add a new one.
// Each runs once, in a transaction, and is recorded in schema_migrations.
const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE accounts (
      id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, github_id BIGINT UNIQUE, name TEXT,
      created_at BIGINT NOT NULL)`,
    `CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at BIGINT NOT NULL)`,
    `CREATE INDEX sessions_account ON sessions (account_id)`,
    `CREATE TABLE key_bundles (
      account_id TEXT PRIMARY KEY, registration_id BIGINT NOT NULL, identity_key TEXT NOT NULL,
      signed_prekey TEXT NOT NULL, updated_at BIGINT NOT NULL)`,
    `CREATE TABLE one_time_prekeys (
      account_id TEXT NOT NULL, key_id BIGINT NOT NULL, public_key TEXT NOT NULL,
      PRIMARY KEY (account_id, key_id))`,
    `CREATE TABLE friend_requests (
      from_id TEXT NOT NULL, to_id TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (from_id, to_id))`,
    `CREATE TABLE friendships (
      a_id TEXT NOT NULL, b_id TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (a_id, b_id))`,
    `CREATE TABLE blocks (
      blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at BIGINT NOT NULL,
      PRIMARY KEY (blocker_id, blocked_id))`,
    `CREATE TABLE reports (
      id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL, reported_id TEXT NOT NULL, reason TEXT NOT NULL,
      created_at BIGINT NOT NULL)`,
    // Ciphertext only, deleted on ack or after the retention window.
    `CREATE TABLE queued_messages (
      id TEXT PRIMARY KEY, to_id TEXT NOT NULL, from_id TEXT NOT NULL, sent_at BIGINT NOT NULL,
      ciphertext TEXT NOT NULL)`,
    `CREATE INDEX queued_messages_to ON queued_messages (to_id, sent_at)`,
  ],
  // Margin.app releases served to Sparkle; the zips themselves are on disk.
  [
    `CREATE TABLE releases (
      build BIGINT PRIMARY KEY, version TEXT NOT NULL, signature TEXT NOT NULL, length BIGINT NOT NULL,
      min_system TEXT NOT NULL, created_at BIGINT NOT NULL)`,
  ],
  // Crash and error reports, scrubbed on the Mac, from an anonymous install id; kept 90 days.
  [
    `CREATE TABLE crash_reports (
      id TEXT PRIMARY KEY, install TEXT NOT NULL, version TEXT NOT NULL, os TEXT NOT NULL,
      component TEXT NOT NULL, kind TEXT NOT NULL, what TEXT NOT NULL, detail TEXT NOT NULL,
      at BIGINT NOT NULL, received_at BIGINT NOT NULL)`,
    `CREATE INDEX crash_reports_received ON crash_reports (received_at)`,
  ],
];

export const TABLES = [
  'accounts',
  'sessions',
  'key_bundles',
  'one_time_prekeys',
  'friend_requests',
  'friendships',
  'blocks',
  'reports',
  'queued_messages',
  'releases',
  'crash_reports',
  'schema_migrations',
];

export async function migrate(sql: SQL) {
  await sql.unsafe(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version BIGINT PRIMARY KEY, applied_at BIGINT NOT NULL)',
  );
  const rows: { version: number | string }[] = await sql`SELECT version FROM schema_migrations`;
  const applied = new Set(rows.map((r) => Number(r.version)));
  for (const [i, statements] of MIGRATIONS.entries()) {
    const version = i + 1;
    if (applied.has(version)) continue;
    await sql.begin(async (tx) => {
      for (const statement of statements) await tx.unsafe(statement);
      await tx`INSERT INTO schema_migrations ${tx({ version, applied_at: Date.now() })}`;
    });
  }
}
