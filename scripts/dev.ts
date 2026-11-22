// bun run dev: a local Margin to look at and click through.
// Starts the server on 127.0.0.1:8787 (dev sign-in on), your own margind (your real token
// count, your real data folder), a set of simulated friends, and opens Margin.app.
// Server and simulated friends keep their data in .dev/, so restarts pick up where you left off.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import type { Push } from '@margin/protocol';
import { SQL } from 'bun';
import { createApp } from '../apps/api/src/app';
import { migrate } from '../apps/api/src/db';
import { type Daemon, startDaemon } from '../apps/margind/src/daemon';
import { onLines, sendOnce, write } from '../apps/margind/src/net';
import { paths } from '../apps/margind/src/paths';
import { dayOf } from '../apps/margind/src/stats';
import { Store } from '../apps/margind/src/store';

const ROOT = resolve(import.meta.dir, '..');
const DEV = join(ROOT, '.dev');
const PORT = 8787;
const SERVER = `http://127.0.0.1:${PORT}`;
const ME = process.env.MARGIN_DEV_AS ?? 'aplaino';

type Bot = {
  handle: string;
  name: string;
  tokens: number;
  tool?: 'claude-code' | 'codex' | 'opencode' | 'shell';
  model?: string;
  repo?: string;
  public?: boolean;
  idle?: boolean;
  // Goes offline a little after starting, to show last-seen.
  leaves?: boolean;
  // Sends you a friend request you haven't accepted.
  pending?: boolean;
  opening?: string[];
};

const BOTS: Bot[] = [
  {
    handle: 'maya-chen',
    name: 'Maya Chen',
    tokens: 48_100_000,
    tool: 'claude-code',
    model: 'claude-opus-5-5',
    repo: 'maya-chen/tidepool-ui',
    public: true,
  },
  {
    handle: 'leo-park',
    name: 'Leo Park',
    tokens: 21_700_000,
    tool: 'codex',
    model: 'gpt-6.1-sol',
    repo: 'leo-park/ledger',
    opening: ['hey, are you around later?', 'want to pair on the sync bug?'],
  },
  {
    handle: 'kai-tanaka',
    name: 'Kai Tanaka',
    tokens: 9_300_000,
    tool: 'claude-code',
    model: 'claude-fable-5-1',
    repo: 'kai-tanaka/notes',
  },
  {
    handle: 'nina-kowalski',
    name: 'Nina Kowalski',
    tokens: 33_600_000,
    tool: 'opencode',
    model: 'anthropic/claude-sonnet-5-5',
    repo: 'nkowalski/quill',
    public: true,
  },
  {
    handle: 'omar-haddad',
    name: 'Omar Haddad',
    tokens: 2_400_000,
    tool: 'shell',
    repo: 'omar-haddad/dotfiles',
  },
  {
    handle: 'sam-rivera',
    name: 'Sam Rivera',
    tokens: 12_900_000,
    tool: 'opencode',
    model: 'anthropic/claude-sonnet-5-5',
    repo: 'samr/glyphs',
    public: true,
    idle: true,
  },
  { handle: 'jules-martin', name: 'Jules Martin', tokens: 6_800_000, leaves: true },
  { handle: 'carol', name: 'Carol', tokens: 1_200_000, pending: true },
];

const REPLIES = [
  'ha, nice',
  'one sec, finishing this prompt',
  'yeah let’s do it',
  'just shipped mine too',
  'what model are you on?',
];

const PUBLIC = new Set(BOTS.filter((b) => b.public && b.repo).map((b) => b.repo));
// Dev only: the simulated friends' databases are keyed from their handle, so they reopen across runs.
const devKeys = (account: string) => createHash('sha256').update(`margin-dev:${account}`).digest();
const log = (message: string) => console.log(`[dev] ${message}`);

// A small client for a margind socket: requests with results, plus a push listener.
async function client(path: string) {
  const socket: Socket = connect(path);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const listeners: ((p: Push) => void)[] = [];
  onLines(socket, (value) => {
    for (const listener of listeners) listener(value as Push);
  });
  write(socket, { op: 'subscribe' });
  return {
    on: (listener: (p: Push) => void) => listeners.push(listener),
    notify: (request: Record<string, unknown>) => write(socket, request),
    request: (request: Record<string, unknown>) =>
      new Promise<Extract<Push, { type: 'result' }>>((resolve) => {
        const listener = (p: Push) => {
          if (p.type !== 'result' || p.op !== request.op) return;
          listeners.splice(listeners.indexOf(listener), 1);
          resolve(p);
        };
        listeners.push(listener);
        write(socket, request);
      }),
    until: (match: (p: Push) => boolean) =>
      new Promise<void>((resolve) => {
        const listener = (p: Push) => {
          if (!match(p)) return;
          listeners.splice(listeners.indexOf(listener), 1);
          resolve();
        };
        listeners.push(listener);
      }),
    close: () => socket.destroy(),
  };
}

// --- server
mkdirSync(DEV, { recursive: true });
const sql = new SQL(`sqlite://${join(DEV, 'server.db')}`);
await migrate(sql);
const app = createApp(sql, { devAuth: true });
let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    port: PORT,
    hostname: '127.0.0.1',
    fetch: app.fetch,
    websocket: app.websocket,
  });
} catch {
  console.error(`[dev] port ${PORT} is in use; is another \`bun run dev\` running?`);
  process.exit(1);
}
log(`server on ${SERVER}`);

// --- your margind
// An open Margin (installed or an earlier dev build) runs a margind of its own on the same
// socket, which would answer for this one and talk to its own server. Quit it first; its
// margind follows it out.
const mine = paths();
if (Bun.spawnSync(['pkill', '-TERM', '-f', 'Margin.app/Contents/MacOS/Margin$']).exitCode === 0) {
  log('quit the Margin that was open, so this run uses its own margind');
  for (let i = 0; i < 25 && (await sendOnce(mine.socket, { op: 'ping' }, 200)); i++)
    await Bun.sleep(200);
}
let margind: ReturnType<typeof Bun.spawn> | undefined;
if (await sendOnce(mine.socket, { op: 'ping' }, 500)) {
  log('your margind is already running; using it');
} else {
  margind = Bun.spawn([process.execPath, join(ROOT, 'apps/margind/src/main.ts')], {
    env: { ...process.env, MARGIN_SERVER: SERVER, MARGIN_DEV_HANDLE: ME },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  log(`started your margind (signs in as ${ME})`);
}

// --- the app (MARGIN_DEV_NO_APP=1 skips it, for running this headless)
const built = process.env.MARGIN_DEV_NO_APP
  ? undefined
  : Bun.spawnSync([join(ROOT, 'scripts/build-app.sh')], { stderr: 'inherit' });
if (!built) {
  log('not opening Margin.app (MARGIN_DEV_NO_APP)');
} else if (built.exitCode === 0) {
  const app = built.stdout.toString().trim();
  // `open` only brings forward a copy that's already running, so quit the old build first
  // (Margin treats SIGTERM as Quit).
  if (Bun.spawnSync(['pkill', '-TERM', '-f', `${app}/Contents/MacOS/Margin`]).exitCode === 0)
    await Bun.sleep(1000);
  Bun.spawnSync(['open', app]);
  log('opened Margin.app; it’s the strip at the edge of your screen');
} else {
  log('building Margin.app failed (see above)');
}

// A made-up fortnight for each friend in a tool, so their cards show stats rather than zeros.
function seedStats(where: ReturnType<typeof paths>, bot: Bot) {
  if (!bot.tool) return;
  const store = new Store(where.db, devKeys(`db:${where.home}`));
  const now = new Date();
  const days: Record<string, { base: number; seconds: number; active: boolean }> = {};
  let base = bot.tokens;
  for (let i = 0; i < 14; i++) {
    const active = i === 0 || (i * 7 + bot.name.length) % 3 !== 0;
    if (active) base -= Math.round(bot.tokens * 0.012 * (1 + (i % 4)));
    days[dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i).getTime())] = {
      base,
      seconds: active ? (40 + ((i * 13 + bot.name.length * 7) % 140)) * 60 : 0,
      active,
    };
  }
  store.setJson('stats', days);
  store.close();
}

// --- simulated friends
const bots: { bot: Bot; daemon: Daemon; c: Awaited<ReturnType<typeof client>> }[] = [];
for (const bot of BOTS) {
  const dir = join(DEV, 'bots', bot.handle);
  const home = join(dir, 'home');
  const transcripts = join(home, '.claude', 'projects', 'p');
  mkdirSync(transcripts, { recursive: true });
  const usage = {
    type: 'assistant',
    message: { id: `msg_${bot.handle}`, usage: { output_tokens: bot.tokens } },
  };
  writeFileSync(join(transcripts, 's.jsonl'), `${JSON.stringify(usage)}\n`);
  const where = paths(join(dir, 'data'));
  seedStats(where, bot);
  const daemon = await startDaemon({
    paths: where,
    keys: devKeys,
    server: SERVER,
    devHandle: bot.handle,
    devName: bot.name,
    tools: { home, dataHome: where.home, socket: where.socket, self: ['/usr/bin/true'] },
    tokenSources: {
      claudeProjects: join(home, '.claude', 'projects'),
      codexSessions: [],
      opencodeDb: join(home, 'none'),
    },
    fetchRepo: async (repo) => (PUBLIC.has(repo) ? { private: false, full_name: repo } : null),
    idle: async () => (bot.idle ? 600 : 0),
    isAlive: () => true,
  });
  const c = await client(where.socket);
  const online = c.until((p) => p.type === 'self' && p.connection === 'online');
  await c.request({ op: 'login' });
  await online;
  bots.push({ bot, daemon, c });
}
log(`${bots.length} simulated friends signed in`);

log(`waiting for you to sign in as ${ME} in the drawer (hover or click the strip, or press ⌥M)`);
while (!(await sql`SELECT 1 FROM accounts WHERE handle = ${ME}`).length) await Bun.sleep(1000);
log('you’re signed in; sending friend requests');

for (const { c } of bots) await c.request({ op: 'friend.request', handle: ME });
// Accept them on your behalf (all but the pending one), through your own margind.
const you = await client(mine.socket);
for (const { bot } of bots.filter((b) => !b.bot.pending)) {
  await you.request({ op: 'friend.accept', handle: bot.handle });
}
you.close();
await Bun.sleep(1500);

for (const { bot, c } of bots) {
  if (bot.tool && bot.repo) {
    const project = join(
      DEV,
      'bots',
      bot.handle,
      'home',
      'code',
      bot.repo.split('/')[1] ?? 'project',
    );
    mkdirSync(join(project, '.git'), { recursive: true });
    writeFileSync(
      join(project, '.git', 'config'),
      `[remote "origin"]\n\turl = https://github.com/${bot.repo}.git\n`,
    );
    const event = {
      tool: bot.tool,
      sessionId: `${bot.handle}-1`,
      cwd: project,
      ...(bot.model ? { model: bot.model } : {}),
    };
    c.notify({ op: 'event', event: { ...event, event: 'start' } });
    setInterval(() => c.notify({ op: 'event', event: { ...event, event: 'prompt' } }), 60_000);
  }
  // Reply to whatever you send.
  c.on((p) => {
    if (p.type !== 'message' || p.message.direction !== 'in' || p.message.peer !== ME) return;
    setTimeout(() => {
      void c.request({
        op: 'send',
        to: ME,
        text: REPLIES[Math.floor(Math.random() * REPLIES.length)],
      });
    }, 1500);
  });
  for (const text of bot.opening ?? []) {
    for (let attempt = 0; attempt < 5; attempt++) {
      if ((await c.request({ op: 'send', to: ME, text })).ok) break;
      await Bun.sleep(1000);
    }
  }
}
log('friends are online; Leo has sent you two messages');

for (const { bot, daemon } of bots.filter((b) => b.bot.leaves)) {
  setTimeout(() => {
    void daemon.stop().then(() => log(`${bot.name} went offline`));
  }, 20_000);
}

log('press Ctrl-C to stop (Margin.app stays open and shows that it lost its background service)');

let stopping = false;
process.on('SIGINT', async () => {
  if (stopping) process.exit(1);
  stopping = true;
  log('stopping');
  for (const { daemon, c } of bots) {
    c.close();
    await daemon.stop().catch(() => {});
  }
  margind?.kill('SIGTERM');
  await margind?.exited;
  server.stop(true);
  await app.drain();
  await sql.close();
  process.exit(0);
});
