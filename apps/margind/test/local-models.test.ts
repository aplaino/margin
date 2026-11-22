import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalModels } from '../src/local-models';

// Stand-ins for Ollama's and LM Studio's local servers.
let ollama: { name: string; expires_at: string }[] = [];
let lmStudio: { id: string; state: string }[] = [];
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/api/ps') return Response.json({ models: ollama });
    if (path === '/api/v0/models') return Response.json({ object: 'list', data: lmStudio });
    return new Response('not found', { status: 404 });
  },
});

let root: string;
let models: LocalModels;
const both = { ollama: true, lmStudio: true };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'margind-local-'));
  ollama = [];
  lmStudio = [];
  models = new LocalModels({
    ollama: server.url.origin,
    lmStudio: server.url.origin,
    lmStudioHome: root,
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Ollama', () => {
  test('a model already loaded at startup isn’t activity; a request moving its expiry is', async () => {
    ollama = [{ name: 'qwen3-coder:30b', expires_at: '2026-11-21T20:00:00Z' }];
    expect(await models.poll(both)).toEqual([]);
    expect(await models.poll(both)).toEqual([]);
    ollama = [{ name: 'qwen3-coder:30b', expires_at: '2026-11-21T20:05:00Z' }];
    expect(await models.poll(both)).toEqual([
      { tool: 'ollama', event: 'prompt', sessionId: 'ollama', model: 'qwen3-coder:30b' },
    ]);
  });

  test('a model loading counts, and unloading ends the session', async () => {
    expect(await models.poll(both)).toEqual([]);
    ollama = [{ name: 'llama3.2', expires_at: 'a' }];
    expect((await models.poll(both))[0]?.event).toBe('prompt');
    ollama = [];
    expect(await models.poll(both)).toEqual([
      { tool: 'ollama', event: 'end', sessionId: 'ollama' },
    ]);
  });

  test('nothing is asked when it isn’t watched, and a server that isn’t running is quiet', async () => {
    const off = new LocalModels({
      ollama: 'http://127.0.0.1:9',
      lmStudio: 'http://127.0.0.1:9',
      lmStudioHome: join(root, 'missing'),
    });
    expect(await off.poll(both)).toEqual([]);
    ollama = [{ name: 'x', expires_at: 'a' }];
    await models.poll({ ollama: false, lmStudio: false });
    expect(await models.poll({ ollama: false, lmStudio: false })).toEqual([]);
  });
});

describe('LM Studio', () => {
  const log = () => {
    const dir = join(root, 'server-logs', '2026-11');
    mkdirSync(dir, { recursive: true });
    return join(dir, '2026-11-21.1.log');
  };

  test('a chat completion in the server log counts, with the loaded model', async () => {
    writeFileSync(log(), '[2026-11-21 19:00:00][INFO] Server started.\n');
    lmStudio = [
      { id: 'qwen/qwen3-coder-30b', state: 'loaded' },
      { id: 'other', state: 'not-loaded' },
    ];
    expect(await models.poll(both)).toEqual([]);
    appendFileSync(
      log(),
      '[2026-11-21 19:01:00][DEBUG] Received request: POST to /v1/chat/completions with body {"messages":[]}\n',
    );
    expect(await models.poll(both)).toEqual([
      {
        tool: 'lm-studio',
        event: 'prompt',
        sessionId: 'lm-studio',
        model: 'qwen/qwen3-coder-30b',
      },
    ]);
    expect(await models.poll(both)).toEqual([]);
  });

  test('listings (like Margin’s own) don’t count', async () => {
    writeFileSync(log(), '');
    await models.poll(both);
    appendFileSync(
      log(),
      '[2026-11-21 19:02:00][DEBUG] Received request: GET to /api/v1/models\n[2026-11-21 19:02:00][INFO] Returning 8 models from v1 API\n',
    );
    expect(await models.poll(both)).toEqual([]);
  });

  test('a chat in the app counts even with the server off', async () => {
    const chats = join(root, 'conversations');
    mkdirSync(chats);
    const chat = join(chats, '1.conversation.json');
    writeFileSync(chat, '{}');
    utimesSync(chat, new Date(1_000_000), new Date(1_000_000));
    utimesSync(chats, new Date(1_000_000), new Date(1_000_000));
    expect(await models.poll(both)).toEqual([]);
    writeFileSync(chat, '{"messages":[1]}');
    expect(await models.poll({ ollama: false, lmStudio: true })).toEqual([
      { tool: 'lm-studio', event: 'prompt', sessionId: 'lm-studio' },
    ]);
  });
});
