import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Friend, Push } from '@margin/protocol';
import { SQL } from 'bun';
import { createApp } from '../../api/src/app';
import { migrate } from '../../api/src/db';
import { type Daemon, startDaemon } from '../src/daemon';
import { type KeyProvider, memoryKeys } from '../src/keychain';
import { onLines, write } from '../src/net';
import { paths } from '../src/paths';

// Two users, each with their own margind and encrypted store, talking through a real
// server on this machine. Everything either one's app is told is recorded, so the test
// can check that nothing private ever reached the other side.

let root: string;
let server: ReturnType<typeof Bun.serve>;
let sql: SQL;
const keys: KeyProvider = memoryKeys();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'margin-e2e-'));
  sql = new SQL('sqlite://:memory:');
  await migrate(sql);
  const app = createApp(sql, { devAuth: true });
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: app.fetch,
    websocket: app.websocket,
  });
});
afterAll(async () => {
  server.stop(true);
  await sql.close();
  rmSync(root, { recursive: true, force: true });
});

const publicRepos = new Set(['maya/tidepool-ui']);

function project(user: string, name: string, origin: string) {
  const dir = join(root, user, 'home', 'code', name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(
    join(dir, '.git', 'config'),
    `[remote "origin"]\n\turl = https://github.com/${origin}.git\n`,
  );
  return dir;
}

function claudeTranscript(user: string, outputTokens: number) {
  const dir = join(root, user, 'home', '.claude', 'projects', 'p');
  mkdirSync(dir, { recursive: true });
  const line = {
    type: 'assistant',
    message: { id: `msg_${user}`, usage: { output_tokens: outputTokens } },
  };
  writeFileSync(join(dir, 's.jsonl'), `${JSON.stringify(line)}\n`);
}

type User = Awaited<ReturnType<typeof startUser>>;

async function startUser(handle: string) {
  const home = join(root, handle, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const where = paths(join(root, handle, 'data'));
  const daemon: Daemon = await startDaemon({
    paths: where,
    keys,
    server: server.url.href.replace(/\/$/, ''),
    devHandle: handle,
    tools: { home, dataHome: where.home, socket: where.socket, self: ['/usr/bin/true'] },
    tokenSources: {
      claudeProjects: join(home, '.claude', 'projects'),
      codexSessions: [],
      opencodeDb: join(home, 'none.db'),
    },
    fetchRepo: async (repo) => (publicRepos.has(repo) ? { private: false, full_name: repo } : null),
    idle: async () => 0,
    isAlive: () => true,
    heartbeatMs: 300,
    tokenScanMs: 300,
  });
  const app = await connectApp(where.socket);
  return { handle, daemon, app, where };
}

// Stands in for Margin.app: subscribes, records every push, sends requests.
async function connectApp(path: string) {
  const socket: Socket = connect(path);
  await new Promise((resolve) => socket.once('connect', resolve));
  const seen: Push[] = [];
  const waiters: { match: (p: Push) => boolean; resolve: (p: Push) => void }[] = [];
  onLines(socket, (value) => {
    const push = value as Push;
    seen.push(push);
    for (const w of waiters.splice(0)) {
      if (w.match(push)) w.resolve(push);
      else waiters.push(w);
    }
  });
  write(socket, { op: 'subscribe' });
  const until = <T extends Push>(match: (p: Push) => boolean, timeoutMs = 5000): Promise<T> => {
    const found = seen.findLast(match);
    if (found) return Promise.resolve(found as T);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for a push')), timeoutMs);
      waiters.push({
        match,
        resolve: (p) => {
          clearTimeout(timer);
          resolve(p as T);
        },
      });
    });
  };
  return {
    seen,
    until,
    // Waits for the next matching push only (ignores what was already received).
    next: <T extends Push>(match: (p: Push) => boolean, timeoutMs = 5000): Promise<T> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for a push')),
          timeoutMs,
        );
        waiters.push({
          match,
          resolve: (p) => {
            clearTimeout(timer);
            resolve(p as T);
          },
        });
      }),
    async request(request: Record<string, unknown>) {
      const result = this.next<Extract<Push, { type: 'result' }>>(
        (p) => p.type === 'result' && p.op === request.op,
      );
      write(socket, request);
      const reply = await result;
      if (!reply.ok) throw new Error(reply.error);
      return reply.data;
    },
    // Fire and forget, like a tool's hook.
    notify: (request: Record<string, unknown>) => write(socket, request),
    close: () => socket.destroy(),
  };
}

const friendIn = (handle: string, match: (f: Friend) => boolean) => (p: Push) =>
  p.type === 'roster' && p.friends.some((f) => f.handle === handle && match(f));
const friendOf = (p: Push, handle: string) =>
  p.type === 'roster' ? p.friends.find((f) => f.handle === handle) : undefined;

let maya: User;
let leo: User;

describe('two users, two daemons, one server', () => {
  test('both sign in and become friends', async () => {
    claudeTranscript('maya', 48_100);
    maya = await startUser('maya');
    leo = await startUser('leo');
    for (const u of [maya, leo]) {
      await u.app.request({ op: 'login' });
      await u.app.until(
        (p) => p.type === 'self' && p.connection === 'online' && p.handle === u.handle,
      );
    }

    await maya.app.request({ op: 'friend.request', handle: 'leo' });
    await leo.app.until((p) => p.type === 'requests' && p.requests.incoming.includes('maya'));
    await leo.app.request({ op: 'friend.accept', handle: 'maya' });
    await maya.app.until(friendIn('leo', () => true));
    await leo.app.until(friendIn('maya', () => true));
    expect(maya.daemon.store.friend('leo')?.identityKey).toBe(leo.daemon.signal.identityKey());
    expect(leo.daemon.store.friend('maya')?.identityKey).toBe(maya.daemon.signal.identityKey());
  });

  test('a friend sees the tool, model, public repo and token total', async () => {
    maya.app.notify({
      op: 'event',
      event: {
        tool: 'claude-code',
        event: 'start',
        sessionId: 'abc',
        model: 'claude-opus-5-5[1m]',
        cwd: project('maya', 'tidepool-ui', 'maya/tidepool-ui'),
      },
    });
    const roster = await leo.app.until(
      friendIn('maya', (f) => f.presence.activity?.tool === 'claude-code'),
    );
    expect(friendOf(roster, 'maya')?.presence).toMatchObject({
      status: 'online',
      tokens: 48_100,
      activity: {
        tool: 'claude-code',
        model: 'claude-opus-5-5',
        project: { visibility: 'public', repo: 'maya/tidepool-ui' },
      },
    });
  });

  test('a private project shows as "private project" and nothing from it leaks', async () => {
    const secret = project('maya', 'acme-secret-client', 'acme/stealth-launch');
    maya.app.notify({
      op: 'event',
      event: { tool: 'codex', event: 'prompt', sessionId: 'priv', cwd: secret },
    });
    await leo.app.until(friendIn('maya', (f) => f.presence.activity?.tool === 'codex'));
    const roster = await leo.app.until(
      friendIn('maya', (f) => f.presence.activity?.tool === 'codex'),
    );
    expect(friendOf(roster, 'maya')?.presence.activity?.project).toEqual({ visibility: 'private' });
    const everything = JSON.stringify(leo.app.seen).toLowerCase();
    for (const leak of [
      'acme',
      'stealth',
      'secret-client',
      '/code/',
      'priv"',
      root.toLowerCase(),
    ]) {
      expect(everything).not.toContain(leak);
    }
  });

  test('hiding tokens and going invisible take effect on the other machine', async () => {
    await maya.app.request({
      op: 'settings.set',
      settings: { share: { tool: true, model: true, repo: true, time: true, tokens: false } },
    });
    await leo.app.next(
      friendIn('maya', (f) => f.presence.status === 'online' && f.presence.tokens === undefined),
    );

    await maya.app.request({ op: 'settings.set', settings: { invisible: true } });
    const roster = await leo.app.next(friendIn('maya', (f) => f.presence.status === 'offline'));
    expect(friendOf(roster, 'maya')?.presence.activity).toBeUndefined();

    await maya.app.request({
      op: 'settings.set',
      settings: {
        invisible: false,
        share: { tool: true, model: true, repo: true, time: true, tokens: true },
      },
    });
    await leo.app.next(
      friendIn('maya', (f) => f.presence.status === 'online' && f.presence.tokens === 48_100),
    );
  });

  test('end-to-end encrypted chat both ways, with unread counts', async () => {
    const sent = (await maya.app.request({
      op: 'send',
      to: 'leo',
      text: 'shipped the new parser!',
    })) as {
      id: string;
    };
    const received = await leo.app.until(
      (p) => p.type === 'message' && p.message.direction === 'in' && p.message.id === sent.id,
    );
    expect(received.type === 'message' && received.message.text).toBe('shipped the new parser!');
    await maya.app.until(
      (p) => p.type === 'message' && p.message.id === sent.id && p.message.state === 'sent',
    );
    await leo.app.until(friendIn('maya', (f) => f.unread === 1));

    // The server only ever held ciphertext.
    const queued = await sql`SELECT ciphertext FROM queued_messages`;
    expect(JSON.stringify(queued)).not.toContain('parser');

    await leo.app.request({ op: 'read', handle: 'maya' });
    await leo.app.until(friendIn('maya', (f) => f.unread === 0));
    await leo.app.request({
      op: 'send',
      to: 'maya',
      text: 'nice, how fast is it now?\nbenchmarks?',
    });
    await maya.app.until(
      (p) => p.type === 'message' && p.message.text === 'nice, how fast is it now?\nbenchmarks?',
    );
  });

  test('a message sent while the friend is offline arrives after their daemon restarts', async () => {
    leo.app.close();
    await leo.daemon.stop();
    await maya.app.until(friendIn('leo', (f) => f.presence.status === 'offline'));

    const sent = (await maya.app.request({ op: 'send', to: 'leo', text: 'see you tomorrow' })) as {
      id: string;
    };
    await maya.app.until(
      (p) => p.type === 'message' && p.message.id === sent.id && p.message.state === 'sent',
    );

    leo = await startUser('leo');
    await leo.app.until(
      (p) =>
        p.type === 'message' && p.message.id === sent.id && p.message.text === 'see you tomorrow',
    );
    const history = await new Promise<Push>((resolve) => {
      leo.app.next((p) => p.type === 'history').then(resolve);
      void leo.app.request({ op: 'history', with: 'maya' });
    });
    expect(history.type === 'history' && history.messages.map((m) => m.text)).toEqual([
      'shipped the new parser!',
      'nice, how fast is it now?\nbenchmarks?',
      'see you tomorrow',
    ]);
    const [{ n }] = await sql`SELECT COUNT(*) AS n FROM queued_messages`;
    expect(Number(n)).toBe(0);
  });

  test('removing a friend clears them on both sides', async () => {
    await maya.app.request({ op: 'friend.remove', handle: 'leo' });
    await leo.app.until((p) => p.type === 'roster' && !p.friends.some((f) => f.handle === 'maya'));
    const error = await maya.app.request({ op: 'send', to: 'leo', text: 'hello?' }).then(
      () => 'sent',
      (e: Error) => e.message,
    );
    expect(error).toBe('leo isn’t your friend');
  });

  test('stop both', async () => {
    for (const u of [maya, leo]) {
      u.app.close();
      await u.daemon.stop();
    }
  });
});
