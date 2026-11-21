import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Store } from './store';

// Your all-time token total: input + output + cache writes across Claude Code, Codex and
// OpenCode. Cache reads are left out: they replay the same context on every turn and would
// swamp the number. Everything is read from each tool's own records on this Mac; only the
// total ever leaves it.

export type TokenSources = { claudeProjects: string; codexSessions: string[]; opencodeDb: string };

export function defaultSources(home = homedir()): TokenSources {
  return {
    claudeProjects: join(home, '.claude', 'projects'),
    codexSessions: [join(home, '.codex', 'sessions'), join(home, '.codex', 'archived_sessions')],
    opencodeDb: join(home, '.local', 'share', 'opencode', 'opencode.db'),
  };
}

const n = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

// Claude Code transcripts: one `usage` per API response. Input excludes cache reads and
// cache writes, which are reported separately.
export function claudeTokens(usage: Record<string, unknown>) {
  return n(usage.input_tokens) + n(usage.output_tokens) + n(usage.cache_creation_input_tokens);
}

// Codex `token_count` events: a running total for the session. Its input includes cached
// (read) tokens, so they're subtracted; output already includes reasoning.
export function codexTokens(total: Record<string, unknown>) {
  const uncached = Math.max(0, n(total.input_tokens) - n(total.cached_input_tokens));
  return uncached + n(total.cache_write_input_tokens) + n(total.output_tokens);
}

// OpenCode sessions: input excludes cache reads; reasoning is counted apart from output.
export function opencodeTokens(row: Record<string, unknown>) {
  return (
    n(row.tokens_input) + n(row.tokens_output) + n(row.tokens_reasoning) + n(row.tokens_cache_write)
  );
}

function* jsonlFiles(dir: string): Generator<string> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(path);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path;
  }
}

const CHUNK = 8 * 1024 * 1024;

// Calls onLine for each complete new line since the stored cursor, and returns the new
// cursor. A partly written last line is left for next time.
async function readNewLines(path: string, from: number, onLine: (line: string) => void) {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return from;
  }
  // The file was replaced or truncated: read it again. Ids already counted are skipped.
  let offset = size < from ? 0 : from;
  let carry = Buffer.alloc(0);
  while (offset < size) {
    const bytes = Buffer.from(
      await Bun.file(path)
        .slice(offset, Math.min(size, offset + CHUNK))
        .arrayBuffer(),
    );
    offset += bytes.length;
    const data = carry.length ? Buffer.concat([carry, bytes]) : bytes;
    const end = data.lastIndexOf(0x0a);
    if (end < 0) {
      carry = data;
      continue;
    }
    for (const line of data.subarray(0, end).toString('utf8').split('\n')) if (line) onLine(line);
    carry = data.subarray(end + 1);
  }
  return offset - carry.length;
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

async function scanClaude(store: Store, dir: string) {
  for (const path of jsonlFiles(dir)) {
    const source = store.tokenSource(path);
    const responses: [id: string, tokens: number][] = [];
    const cursor = await readNewLines(path, Number(source?.cursor ?? 0), (line) => {
      if (!line.includes('"usage"')) return;
      const entry = parse(line);
      const message = entry?.message as Record<string, unknown> | undefined;
      const usage = message?.usage as Record<string, unknown> | undefined;
      if (entry?.type === 'assistant' && typeof message?.id === 'string' && usage) {
        responses.push([message.id, claudeTokens(usage)]);
      }
    });
    // A response written over several lines repeats its usage, and resumed or forked
    // sessions copy earlier lines into new files: count each response id once, anywhere.
    store.transaction(() => {
      let tokens = source?.tokens ?? 0;
      for (const [id, count] of responses) if (store.firstSighting(`claude:${id}`)) tokens += count;
      store.setTokenSource(path, tokens, String(cursor));
    });
  }
}

async function scanCodex(store: Store, dirs: string[]) {
  for (const dir of dirs) {
    for (const path of jsonlFiles(dir)) {
      const source = store.tokenSource(path);
      let tokens = source?.tokens ?? 0;
      const cursor = await readNewLines(path, Number(source?.cursor ?? 0), (line) => {
        if (!line.includes('"token_count"')) return;
        const payload = parse(line)?.payload as Record<string, unknown> | undefined;
        const info = payload?.info as Record<string, unknown> | undefined;
        const total = info?.total_token_usage as Record<string, unknown> | undefined;
        if (payload?.type === 'token_count' && total) tokens = Math.max(tokens, codexTokens(total));
      });
      store.setTokenSource(path, tokens, String(cursor));
    }
  }
}

function scanOpenCode(store: Store, path: string) {
  if (!existsSync(path)) return;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const tables = new Set(
      db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name),
    );
    const columns = 'id, tokens_input, tokens_output, tokens_reasoning, tokens_cache_write';
    // Newer OpenCode keeps sessions in session_v2 alongside the old table; take each id once.
    const best = new Map<string, number>();
    for (const table of ['session', 'session_v2'].filter((t) => tables.has(t))) {
      for (const row of db
        .query<Record<string, unknown>, []>(`SELECT ${columns} FROM ${table}`)
        .all()) {
        const id = String(row.id);
        best.set(id, Math.max(best.get(id) ?? 0, opencodeTokens(row)));
      }
    }
    store.transaction(() => {
      for (const [id, tokens] of best) {
        const key = `opencode:${id}`;
        // Deleting a session in OpenCode doesn't take tokens back.
        store.setTokenSource(key, Math.max(store.tokenSource(key)?.tokens ?? 0, tokens), null);
      }
    });
  } catch (e) {
    console.error(`[margind] OpenCode tokens: ${(e as Error).message}`);
  } finally {
    db?.close();
  }
}

export async function scanTokens(store: Store, sources: TokenSources) {
  await scanClaude(store, sources.claudeProjects);
  await scanCodex(store, sources.codexSessions);
  scanOpenCode(store, sources.opencodeDb);
  return store.tokenTotal();
}
