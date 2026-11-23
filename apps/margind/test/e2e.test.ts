import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
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
let app: ReturnType<typeof createApp>;
const keys: KeyProvider = memoryKeys();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'margin-e2e-'));
  sql = new SQL('sqlite://:memory:');
  await migrate(sql);
  app = createApp(sql, { devAuth: true });
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: app.fetch,
    websocket: app.websocket,
  });
});
afterAll(async () => {
  server.stop(true);
  await app.drain();
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

// The error a request failed with, or "ok".
const failure = (request: Promise<unknown>) =>
  request.then(
    () => 'ok',
    (e: Error) => e.message,
  );
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
      // Her history from before Margin isn't today's, and the session has only just begun.
      stats: { today: 0, week: 0, minutes: 0, days: 1, sessions: 1, promptsToday: 0 },
    });
  });

  test('a prompt in a repo you have hidden is not counted in stats', async () => {
    const total = () => maya.daemon.store.getJson<number>('promptsTotal') ?? 0;
    const start = total();
    await maya.app.request({
      op: 'settings.set',
      settings: { repos: { 'acme/stealth-launch': 'hidden' } },
    });
    const prompt = (sessionId: string, cwd: string) =>
      maya.app.notify({
        op: 'event',
        event: { tool: 'claude-code', event: 'prompt', sessionId, cwd },
      });
    prompt('hidden', project('maya', 'stealth', 'acme/stealth-launch'));
    prompt('abc', project('maya', 'tidepool-ui', 'maya/tidepool-ui'));
    for (let i = 0; i < 40 && total() === start; i++) await Bun.sleep(25);
    await Bun.sleep(150);
    expect(total()).toBe(start + 1);
    await maya.app.request({ op: 'settings.set', settings: { repos: {} } });
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

  test('close friends stop seeing activity the moment you go invisible', async () => {
    await maya.app.request({
      op: 'settings.set',
      settings: { audience: 'close', closeFriends: ['leo'] },
    });
    await leo.app.until(friendIn('maya', (f) => f.presence.activity?.tool === 'claude-code'));

    await maya.app.request({ op: 'settings.set', settings: { invisible: true } });
    const roster = await leo.app.next(friendIn('maya', (f) => f.presence.status === 'offline'));
    expect(friendOf(roster, 'maya')?.presence.activity).toBeUndefined();
    // Staying invisible doesn't refresh when Leo last saw her.
    const seen = friendOf(roster, 'maya')?.lastSeenAt ?? 0;
    expect(seen).toBeGreaterThan(0);
    await Bun.sleep(1000);
    const later = await leo.app.next(friendIn('maya', (f) => f.presence.status === 'offline'));
    expect(friendOf(later, 'maya')?.lastSeenAt).toBe(seen);

    await maya.app.request({
      op: 'settings.set',
      settings: { invisible: false, audience: 'everyone', closeFriends: [] },
    });
    await leo.app.until(friendIn('maya', (f) => f.presence.status === 'online'));
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

  test('a message the friend can’t read is sent again under a new session', async () => {
    // As after switching servers or losing Margin's data: Leo's side of the session is gone,
    // Maya's isn't.
    leo.daemon.store.removeSignalSessions('maya');
    const sent = (await maya.app.request({ op: 'send', to: 'leo', text: 'are you there?' })) as {
      id: string;
    };
    const received = await leo.app.until(
      (p) =>
        p.type === 'message' && p.message.direction === 'in' && p.message.text === 'are you there?',
    );
    expect(received.type === 'message' && received.message.id).not.toBe(sent.id);
    // Maya's chat still has it once, and Leo's reply goes through on the new session.
    expect(
      maya.daemon.store.history('leo').filter((m) => m.text === 'are you there?'),
    ).toHaveLength(1);
    await leo.app.request({ op: 'send', to: 'maya', text: 'yes, back now' });
    await maya.app.until(
      (p) =>
        p.type === 'message' && p.message.direction === 'in' && p.message.text === 'yes, back now',
    );
  });

  test('a message sent while the friend is offline arrives after their daemon restarts', async () => {
    leo.app.close();
    await leo.daemon.stop();
    const offline = await maya.app.until(friendIn('leo', (f) => f.presence.status === 'offline'));
    // Leo's last known count stays visible while he's offline.
    expect(friendOf(offline, 'leo')?.presence.tokens).toBe(0);

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
      'are you there?',
      'yes, back now',
      'see you tomorrow',
    ]);
    // Once Maya's Mac has acknowledged the delivery receipt, nothing is left on the server.
    await maya.app.until(
      (p) => p.type === 'message' && p.message.id === sent.id && p.message.state === 'delivered',
    );
    const queued = async () => Number((await sql`SELECT COUNT(*) AS n FROM queued_messages`)[0].n);
    for (let i = 0; i < 40 && (await queued()) > 0; i++) await Bun.sleep(25);
    expect(await queued()).toBe(0);
  });

  test('when a friend was last online survives a restart', async () => {
    leo.app.close();
    await leo.daemon.stop();
    const offline = await maya.app.until(friendIn('leo', (f) => f.presence.status === 'offline'));
    const seen = friendOf(offline, 'leo')?.lastSeenAt ?? 0;
    expect(seen).toBeGreaterThan(Date.now() - 60_000);

    maya.app.close();
    await maya.daemon.stop();
    maya = await startUser('maya');
    const roster = await maya.app.until(friendIn('leo', (f) => f.presence.status === 'offline'));
    expect(friendOf(roster, 'leo')?.lastSeenAt).toBe(seen);

    leo = await startUser('leo');
    await maya.app.until(friendIn('leo', (f) => f.presence.status === 'online'));
  });

  test('safety numbers match on both Macs', async () => {
    const mine = (await maya.app.request({ op: 'safety', handle: 'leo' })) as { safety: string };
    const theirs = (await leo.app.request({ op: 'safety', handle: 'maya' })) as { safety: string };
    expect(mine.safety).toMatch(/^\d{5}( \d{5}){11}$/);
    expect(mine.safety).toBe(theirs.safety);
  });

  test('a friend with a new identity key keeps messaging, with a new safety number', async () => {
    const before = (await maya.app.request({ op: 'safety', handle: 'leo' })) as { safety: string };
    // Leo starts over with new keys, and the server lets the key change (today's server
    // refuses it for an existing account).
    leo.app.close();
    await leo.daemon.stop();
    rmSync(join(root, 'leo', 'data'), { recursive: true, force: true });
    await sql`DELETE FROM key_bundles WHERE account_id = (SELECT id FROM accounts WHERE handle = 'leo')`;
    leo = await startUser('leo');
    await leo.app.request({ op: 'login' });
    await leo.app.until(friendIn('maya', () => true));

    // Both ways, without anyone accepting anything. Maya's first message goes out on the old
    // session, which Leo can't read; it's sent again on a new one.
    await leo.app.request({ op: 'send', to: 'maya', text: 'new laptop, who dis' });
    await maya.app.until(
      (p) =>
        p.type === 'message' &&
        p.message.direction === 'in' &&
        p.message.text === 'new laptop, who dis',
    );
    await maya.app.request({ op: 'send', to: 'leo', text: 'is that you?' });
    await leo.app.until(
      (p) =>
        p.type === 'message' && p.message.direction === 'in' && p.message.text === 'is that you?',
    );

    const now = (await maya.app.request({ op: 'safety', handle: 'leo' })) as { safety: string };
    const leos = (await leo.app.request({ op: 'safety', handle: 'maya' })) as { safety: string };
    expect(now.safety).toBe(leos.safety);
    expect(now.safety).not.toBe(before.safety);
  }, 15_000);

  test('Undo Send removes a message for both; Delete removes it only here', async () => {
    const sent = (await maya.app.request({ op: 'send', to: 'leo', text: 'wrong chat, sorry' })) as {
      id: string;
    };
    await leo.app.until(
      (p) => p.type === 'message' && p.message.id === sent.id && p.message.text !== '',
    );
    await maya.app.request({ op: 'unsend', id: sent.id });
    const gone = await leo.app.until<Extract<Push, { type: 'message' }>>(
      (p) => p.type === 'message' && p.message.id === sent.id && p.message.state === 'unsent',
    );
    expect(gone.message.text).toBe('');
    expect(maya.daemon.store.message(sent.id)).toMatchObject({ text: '', state: 'unsent' });
    expect(JSON.stringify(leo.daemon.store.history('maya'))).not.toContain('wrong chat');
    expect(await failure(maya.app.request({ op: 'unsend', id: sent.id }))).toContain(
      'own messages',
    );

    // Older than a day: only Delete is left.
    const old = crypto.randomUUID();
    maya.daemon.store.saveMessage({
      id: old,
      peer: 'leo',
      direction: 'out',
      text: 'from last week',
      sentAt: Date.now() - 7 * 24 * 60 * 60_000,
      state: 'sent',
    });
    expect(await failure(maya.app.request({ op: 'unsend', id: old }))).toContain('24 hours');

    // Delete: gone from Leo's Mac, still on Maya's; then the whole conversation, Leo's only.
    const kept = (await maya.app.request({ op: 'send', to: 'leo', text: 'keep this one' })) as {
      id: string;
    };
    await leo.app.until((p) => p.type === 'message' && p.message.id === kept.id);
    await leo.app.request({ op: 'delete', id: kept.id });
    expect(leo.daemon.store.message(kept.id)).toBeUndefined();
    expect(maya.daemon.store.message(kept.id)?.text).toBe('keep this one');
    await leo.app.request({ op: 'chat.delete', handle: 'maya' });
    expect(leo.daemon.store.history('maya')).toEqual([]);
    expect(maya.daemon.store.history('leo').length).toBeGreaterThan(0);
  });

  test('read receipts: delivered, then read once they open the chat, unless they turn them off', async () => {
    const sent = (await maya.app.request({
      op: 'send',
      to: 'leo',
      text: 'did you see the PR?',
    })) as {
      id: string;
    };
    await maya.app.until(
      (p) => p.type === 'message' && p.message.id === sent.id && p.message.state === 'delivered',
    );
    await leo.app.request({ op: 'read', handle: 'maya' });
    await maya.app.until(
      (p) =>
        p.type === 'history' &&
        p.with === 'leo' &&
        p.messages.some((m) => m.id === sent.id && m.state === 'read'),
    );
    expect(maya.daemon.store.message(sent.id)?.readAt).toBeGreaterThan(0);

    // Off: Leo's Mac still says delivered, never read.
    await leo.app.request({ op: 'settings.set', settings: { readReceipts: false } });
    const quiet = (await maya.app.request({ op: 'send', to: 'leo', text: 'no rush' })) as {
      id: string;
    };
    await maya.app.until(
      (p) => p.type === 'message' && p.message.id === quiet.id && p.message.state === 'delivered',
    );
    await leo.app.request({ op: 'read', handle: 'maya' });
    // Anything Leo sends after reading arrives after a receipt would have.
    const reply = (await leo.app.request({ op: 'send', to: 'maya', text: 'looking now' })) as {
      id: string;
    };
    await maya.app.until((p) => p.type === 'message' && p.message.id === reply.id);
    expect(maya.daemon.store.message(quiet.id)?.state).toBe('delivered');
    await leo.app.request({ op: 'settings.set', settings: { readReceipts: true } });

    // Invisible: no delivery or read receipt says Leo's Mac is here.
    await leo.app.request({ op: 'settings.set', settings: { invisible: true } });
    const hidden = (await maya.app.request({ op: 'send', to: 'leo', text: 'you there?' })) as {
      id: string;
    };
    await leo.app.until((p) => p.type === 'message' && p.message.id === hidden.id);
    await leo.app.request({ op: 'read', handle: 'maya' });
    const after = (await leo.app.request({ op: 'send', to: 'maya', text: 'brb' })) as {
      id: string;
    };
    await maya.app.until((p) => p.type === 'message' && p.message.id === after.id);
    expect(maya.daemon.store.message(hidden.id)?.state).toBe('sent');
    await leo.app.request({ op: 'settings.set', settings: { invisible: false } });
  });

  test('a link preview from the sender reaches the friend, only for a link in the message', async () => {
    const url = 'https://open.spotify.com/track/0UqKPaKqC3tWU4o8BB7owl';
    const preview = { url, title: 'Midnight City', detail: 'M83 · Song · 2011', site: 'Spotify' };
    const sent = (await maya.app.request({ op: 'send', to: 'leo', text: `listen ${url}` })) as {
      id: string;
    };
    await leo.app.until((p) => p.type === 'message' && p.message.id === sent.id);
    await maya.app.request({ op: 'preview', to: 'leo', preview });
    const got = await leo.app.until<Extract<Push, { type: 'message' }>>(
      (p) => p.type === 'message' && p.message.id === sent.id && !!p.message.preview,
    );
    expect(got.message.preview).toEqual(preview);
    expect(maya.daemon.store.message(sent.id)?.preview).toEqual(preview);

    // A preview for a link that isn't in a recent message goes nowhere.
    await maya.app.request({
      op: 'preview',
      to: 'leo',
      preview: { url: 'https://example.com/elsewhere', title: 'Not this' },
    });
    expect(JSON.stringify(maya.daemon.store.history('leo'))).not.toContain('Not this');
  });

  test('a message the server refuses ends Not Delivered, and Try Again sends it', async () => {
    // Leo removed Maya on the server, and her margind hasn't heard yet.
    const pair = await sql`
      SELECT f.* FROM friendships f JOIN accounts a ON a.id = f.a_id JOIN accounts b ON b.id = f.b_id
      WHERE a.handle IN ('maya', 'leo') AND b.handle IN ('maya', 'leo')`;
    for (const row of pair) {
      await sql`DELETE FROM friendships WHERE a_id = ${row.a_id} AND b_id = ${row.b_id}`;
    }

    const errors = spyOn(console, 'error');
    const sent = (await maya.app.request({
      op: 'send',
      to: 'leo',
      text: 'still on for friday?',
    })) as {
      id: string;
    };
    await maya.app.until(
      (p) => p.type === 'message' && p.message.id === sent.id && p.message.state === 'failed',
    );
    await maya.app.until(
      (p) => p.type === 'chats' && p.chats.some((m) => m.id === sent.id && m.state === 'failed'),
    );
    expect(maya.daemon.store.outbox()).toEqual([]);
    const logged = errors.mock.calls.map((c) => String(c[0]));
    errors.mockRestore();
    expect(logged).toContain('[margind] the server refused a message (not a friend)');
    expect(logged.join('\n')).not.toMatch(new RegExp(`friday|leo|${sent.id}`));

    // Friends again: Try Again sends it under the same id.
    for (const row of pair) await sql`INSERT INTO friendships ${sql(row)}`;
    await maya.app.request({ op: 'retry', id: sent.id });
    await leo.app.until(
      (p) =>
        p.type === 'message' &&
        p.message.id === sent.id &&
        p.message.text === 'still on for friday?',
    );
    await maya.app.until(
      (p) => p.type === 'message' && p.message.id === sent.id && p.message.state === 'delivered',
    );
    expect(await failure(maya.app.request({ op: 'retry', id: sent.id }))).toContain(
      'wasn’t delivered',
    );
  });

  test('removing a friend clears them on both sides', async () => {
    const gone = (user: User, handle: string) =>
      user.app.next((p) => p.type === 'roster' && !p.friends.some((f) => f.handle === handle));
    // One still waiting to leave Maya's Mac when she removes Leo won't go: it failed.
    const waiting = crypto.randomUUID();
    maya.daemon.store.transaction(() => {
      maya.daemon.store.saveMessage({
        id: waiting,
        peer: 'leo',
        direction: 'out',
        text: 'never sent',
        sentAt: Date.now(),
        state: 'queued',
      });
      maya.daemon.store.enqueue(waiting, 'leo', {}, 'message');
    });
    const removed = Promise.all([gone(maya, 'leo'), gone(leo, 'maya')]);
    await maya.app.request({ op: 'friend.remove', handle: 'leo' });
    await removed;
    expect(maya.daemon.store.message(waiting)?.state).toBe('failed');
    expect(maya.daemon.store.outbox()).toEqual([]);
    const error = await maya.app.request({ op: 'send', to: 'leo', text: 'hello?' }).then(
      () => 'sent',
      (e: Error) => e.message,
    );
    expect(error).toBe('leo isn’t your friend');
  });

  test('a blocked person can’t find you, and unblocking undoes it', async () => {
    const find = async (who: typeof maya, handle: string) =>
      (
        (await who.app.request({ op: 'directory', query: handle })) as {
          people: { handle: string }[];
        }
      ).people.map((p) => p.handle);
    expect(await find(leo, 'maya')).toEqual(['maya']);
    await maya.app.request({ op: 'block', handle: 'leo' });
    expect(await find(leo, 'maya')).toEqual([]);
    expect(await maya.app.request({ op: 'blocks' })).toEqual({ blocked: ['leo'] });
    expect(await maya.app.request({ op: 'unblock', handle: 'leo' })).toEqual({ blocked: [] });
    expect(await find(leo, 'maya')).toEqual(['maya']);
  });

  test('stop both', async () => {
    for (const u of [maya, leo]) {
      u.app.close();
      await u.daemon.stop();
    }
  });
});
