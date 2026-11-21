import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryKeys } from '../src/keychain';
import { Store } from '../src/store';
import {
  claudeTokens,
  codexTokens,
  opencodeTokens,
  scanTokens,
  type TokenSources,
} from '../src/tokens';

let dir: string;
let sources: TokenSources;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'margind-tokens-'));
  sources = {
    claudeProjects: join(dir, 'claude'),
    codexSessions: [join(dir, 'codex')],
    opencodeDb: join(dir, 'opencode.db'),
  };
  mkdirSync(join(sources.claudeProjects, 'proj', 'sess', 'subagents'), { recursive: true });
  mkdirSync(join(dir, 'codex', '2026', '11', '21'), { recursive: true });
  store = new Store(':memory:', memoryKeys()('t'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const assistant = (id: string, usage: Record<string, number>) =>
  `${JSON.stringify({ type: 'assistant', message: { id, model: 'claude-opus-5-5', usage } })}\n`;
const codexEvent = (total: Record<string, number>) =>
  `${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total } } })}\n`;

describe('counting rules', () => {
  test('Claude Code: input + output + cache writes, never cache reads', () => {
    expect(
      claudeTokens({
        input_tokens: 10,
        output_tokens: 200,
        cache_creation_input_tokens: 3000,
        cache_read_input_tokens: 999_999,
      }),
    ).toBe(3210);
  });

  test('Codex: cached input is part of input, so it is subtracted', () => {
    expect(
      codexTokens({
        input_tokens: 27_829,
        cached_input_tokens: 7_936,
        cache_write_input_tokens: 100,
        output_tokens: 5,
        total_tokens: 27_834,
      }),
    ).toBe(27_829 - 7_936 + 100 + 5);
  });

  test('OpenCode: reasoning counts, cache reads do not', () => {
    expect(
      opencodeTokens({
        tokens_input: 1,
        tokens_output: 2,
        tokens_reasoning: 4,
        tokens_cache_write: 8,
        tokens_cache_read: 1000,
      }),
    ).toBe(15);
  });

  test('garbage values count as zero', () => {
    expect(
      claudeTokens({
        input_tokens: -5,
        output_tokens: Number.NaN,
        cache_creation_input_tokens: '9' as never,
      }),
    ).toBe(0);
  });
});

describe('scanning', () => {
  test('a response split over lines, or copied into another file, counts once', async () => {
    const usage = { input_tokens: 1, output_tokens: 10, cache_creation_input_tokens: 100 };
    const main = join(sources.claudeProjects, 'proj', 'a.jsonl');
    writeFileSync(
      main,
      assistant('msg_1', usage) + assistant('msg_1', usage) + assistant('msg_2', usage),
    );
    writeFileSync(join(sources.claudeProjects, 'proj', 'resumed.jsonl'), assistant('msg_1', usage));
    writeFileSync(
      join(sources.claudeProjects, 'proj', 'sess', 'subagents', 'agent.jsonl'),
      assistant('msg_3', usage),
    );
    expect(await scanTokens(store, sources)).toBe(333);
  });

  test('only new lines are read, and a half-written line waits', async () => {
    const usage = { input_tokens: 0, output_tokens: 50 };
    const path = join(sources.claudeProjects, 'proj', 'a.jsonl');
    writeFileSync(path, assistant('msg_1', usage));
    expect(await scanTokens(store, sources)).toBe(50);

    const next = assistant('msg_2', usage);
    appendFileSync(path, next.slice(0, 20));
    expect(await scanTokens(store, sources)).toBe(50);
    appendFileSync(path, next.slice(20));
    expect(await scanTokens(store, sources)).toBe(100);
    expect(await scanTokens(store, sources)).toBe(100);
  });

  test('a rewritten file is read again without double counting', async () => {
    const usage = { output_tokens: 10 };
    const path = join(sources.claudeProjects, 'proj', 'a.jsonl');
    writeFileSync(path, assistant('msg_1', usage) + assistant('msg_2', usage));
    await scanTokens(store, sources);
    writeFileSync(path, assistant('msg_3', usage));
    expect(await scanTokens(store, sources)).toBe(30);
  });

  test('Codex uses the session running total', async () => {
    const path = join(dir, 'codex', '2026', '11', '21', 'rollout-1.jsonl');
    writeFileSync(
      path,
      codexEvent({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 5 }),
    );
    appendFileSync(
      path,
      codexEvent({ input_tokens: 300, cached_input_tokens: 100, output_tokens: 20 }),
    );
    appendFileSync(
      path,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } })}\n`,
    );
    expect(await scanTokens(store, sources)).toBe(220);
    appendFileSync(
      path,
      codexEvent({ input_tokens: 400, cached_input_tokens: 100, output_tokens: 20 }),
    );
    expect(await scanTokens(store, sources)).toBe(320);
  });

  test('OpenCode sessions are read once across both tables and never go down', async () => {
    const db = new Database(sources.opencodeDb, { create: true });
    const columns =
      'id TEXT, tokens_input INT, tokens_output INT, tokens_reasoning INT, tokens_cache_read INT, tokens_cache_write INT';
    db.exec(`CREATE TABLE session (${columns}); CREATE TABLE session_v2 (${columns});`);
    db.exec("INSERT INTO session VALUES ('s1', 10, 1, 0, 500, 0), ('s2', 5, 0, 0, 0, 0)");
    db.exec("INSERT INTO session_v2 VALUES ('s1', 10, 1, 0, 500, 0), ('s3', 1, 1, 1, 0, 1)");
    expect(await scanTokens(store, sources)).toBe(11 + 5 + 4);
    db.exec("DELETE FROM session WHERE id = 's2'");
    expect(await scanTokens(store, sources)).toBe(20);
    db.close();
  });

  test('missing tools are fine', async () => {
    rmSync(dir, { recursive: true, force: true });
    expect(await scanTokens(store, sources)).toBe(0);
  });
});
