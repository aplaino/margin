import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Push } from '@margin/protocol';
import { startDaemon } from '../src/daemon';
import { type Hang, type HangOptions, mainThread, sampleProcess, watchApp } from '../src/hangs';
import { memoryKeys } from '../src/keychain';
import { onLines, write } from '../src/net';
import { paths } from '../src/paths';
import { Reports } from '../src/reports';

// Real `sample` output: Margin's debug build with its main thread blocked (kill -USR1), and
// the installed app sitting idle.
const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8');
const HUNG = fixture('sample-hang.txt');
const IDLE = fixture('sample-idle.txt');

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const FAST: HangOptions = {
  tickMs: 10,
  pingMs: 20,
  hangMs: 100,
  hiddenAlertMs: 150,
  graceMs: 300,
  cooldownMs: 60_000,
};

describe('reading a sample', () => {
  test('keeps only the main thread, without addresses or the process’s paths', () => {
    const thread = mainThread(HUNG);
    if (!thread) throw new Error('no main thread');
    const text = thread.lines.join('\n');
    expect(thread.lines[0]).toContain('com.apple.main-thread');
    expect(text).toContain('+[NSThread sleepForTimeInterval:]');
    expect(text).toContain('main.swift:27');
    for (const gone of ['0x', 'HangTest.app', 'Binary Images', 'Parent Process', 'margin.daemon'])
      expect(text).not.toContain(gone);
    expect(thread.margin).toBe('closure #3 in closure #1 in main.swift:27');
    expect(thread.top).toBe('__semwait_signal');
    expect(thread.idle).toBe(false);
  });

  test('an app waiting for its next event is idle; a wait inside an alert is not', () => {
    expect(mainThread(IDLE)?.idle).toBe(true);
    const graph = (frames: string[]) =>
      [
        'Call graph:',
        '    100 Thread_1   DispatchQueue_1: com.apple.main-thread  (serial)',
        ...frames.map((f, i) => `    + ${'  '.repeat(i)}100 ${f}  (in AppKit) + 1  [0x1]`),
      ].join('\n');
    const wait = ['__CFRunLoopServiceMachPort', 'mach_msg2_trap'];
    expect(mainThread(graph(['-[NSApplication run]', '__CFRunLoopRun', ...wait]))?.idle).toBe(true);
    expect(
      mainThread(
        graph([
          '-[NSApplication run]',
          '__CFRunLoopRun',
          '-[NSAlert runModal]',
          '__CFRunLoopRun',
          ...wait,
        ]),
      )?.idle,
    ).toBe(false);
  });

  test('without a labelled main thread, the first thread listed is the main one', () => {
    const plain = HUNG.replace(/\s+DispatchQueue_1: com\.apple\.main-thread\s+\(serial\)/, '');
    expect(mainThread(plain)?.top).toBe('__semwait_signal');
    expect(mainThread('nothing useful')).toBeUndefined();
  });

  test.skipIf(process.platform !== 'darwin')(
    'sample reads a blocked process from outside',
    async () => {
      const blocked = Bun.spawn(['sleep', '30']);
      cleanup.push(() => blocked.kill());
      const thread = mainThread((await sampleProcess(blocked.pid)) ?? '');
      expect(thread?.idle).toBe(false);
      expect(thread?.lines.join('\n')).toContain('nanosleep');
    },
    30_000,
  );
});

// A pretend app: answers pings until told not to, like a main thread that's free or isn't.
function app(options: HangOptions & { stack?: string } = {}) {
  const hangs: Hang[] = [];
  const logs: string[] = [];
  const state = { answering: true, modal: false, modalHidden: false };
  let samples = 0;
  let missed: number | undefined;
  const answer = (n: number) =>
    watch.pong({ n, modal: state.modal, modalHidden: state.modalHidden });
  const watch = watchApp(
    4242,
    (n) =>
      queueMicrotask(() => {
        if (state.answering) answer(n);
        else missed = n;
      }),
    (h) => hangs.push(h),
    (l) => logs.push(l),
    {
      ...FAST,
      sample: async () => {
        samples++;
        return options.stack ?? HUNG;
      },
      ...options,
    },
  );
  // A ping that came while it was stuck is answered once it's free again.
  const resume = () => {
    state.answering = true;
    if (missed !== undefined) answer(missed);
    missed = undefined;
  };
  cleanup.push(() => watch.quitting());
  return { watch, hangs, logs, state, resume, samples: () => samples };
}

// Polls until `done` or the time runs out.
async function until(done: () => boolean, ms = 2000) {
  for (let waited = 0; waited < ms && !done(); waited += 10) await Bun.sleep(10);
}

describe('watching the app', () => {
  test('a hang gives one report, with how long it lasted and the main thread', async () => {
    const a = app();
    await Bun.sleep(60);
    a.state.answering = false;
    await until(() => a.samples() > 0);
    await Bun.sleep(150);
    a.resume();
    await until(() => a.hangs.length > 0);
    await Bun.sleep(200);
    expect(a.hangs).toHaveLength(1);
    expect(a.hangs[0]?.what).toBe('main thread hung in closure #3 in closure #1 in main.swift:27');
    expect(a.hangs[0]?.detail).toMatch(/^the main thread didn't answer for \d+\.\d s/);
    expect(a.hangs[0]?.detail).toContain('drawer closed, alert none');
    expect(a.hangs[0]?.detail).toContain('+[NSThread sleepForTimeInterval:]');
  });

  test('an idle main thread was only slow to answer: no report', async () => {
    const a = app({ stack: IDLE });
    await Bun.sleep(60);
    a.state.answering = false;
    await until(() => a.samples() > 0);
    a.resume();
    await until(() => a.logs.some((l) => l.includes('idle')));
    expect(a.hangs).toHaveLength(0);
  });

  test('nothing counts before the app has answered once (it’s starting up)', async () => {
    const a = app();
    a.state.answering = false;
    await Bun.sleep(400);
    expect(a.samples()).toBe(0);
  });

  test('quitting or relaunching during a hang isn’t one', async () => {
    const a = app();
    await Bun.sleep(60);
    a.state.answering = false;
    await until(() => a.samples() > 0);
    a.watch.quitting();
    await Bun.sleep(100);
    expect(a.hangs).toHaveLength(0);
  });

  test('a force quit ends a hang, and it’s still reported', async () => {
    const a = app();
    await Bun.sleep(60);
    a.state.answering = false;
    await until(() => a.samples() > 0);
    a.watch.disconnected();
    await until(() => a.hangs.length > 0);
    expect(a.hangs).toHaveLength(1);
    expect(a.hangs[0]?.detail).toContain('when Margin quit or margind stopped');
  });

  test('margind stopping during a hang keeps it, sampled or not', async () => {
    for (const sampled of [true, false]) {
      const a = app(sampled ? {} : { sample: () => new Promise(() => {}) });
      await Bun.sleep(60);
      a.state.answering = false;
      await Bun.sleep(sampled ? 200 : 150);
      a.watch.flush();
      expect(a.hangs).toHaveLength(1);
      expect(a.hangs[0]?.detail).toContain(
        sampled ? 'sleepForTimeInterval' : 'main thread: no sample',
      );
    }
  });

  test('after the Mac sleeps, a slow first answer isn’t a hang', async () => {
    let slept = 0;
    const a = app({ now: () => Date.now() + slept });
    await Bun.sleep(60);
    a.state.answering = false;
    // The wall clock jumps a minute across sleep, while margind's timers didn't run; the app
    // takes longer than a hang to answer, but within the grace period.
    slept = 60_000;
    await Bun.sleep(200);
    a.resume();
    await Bun.sleep(300);
    expect(a.samples()).toBe(0);
    expect(a.hangs).toHaveLength(0);
  });

  test('an alert with none of it on screen blocks the drawer, and is reported once', async () => {
    const a = app();
    await Bun.sleep(60);
    a.state.modal = true;
    a.state.modalHidden = true;
    await until(() => a.samples() > 0);
    a.state.modalHidden = false;
    await until(() => a.hangs.length > 0);
    expect(a.hangs).toHaveLength(1);
    expect(a.hangs[0]?.what).toStartWith('drawer blocked by a hidden alert in ');
    expect(a.hangs[0]?.detail).toMatch(/^an alert with none of it on screen blocked the drawer/);
  });

  test('an alert you can see never counts', async () => {
    const a = app();
    a.state.modal = true;
    await Bun.sleep(400);
    expect(a.samples()).toBe(0);
  });

  test('a second hang soon after isn’t sampled again', async () => {
    const a = app();
    for (let i = 0; i < 2; i++) {
      await Bun.sleep(60);
      a.state.answering = false;
      await Bun.sleep(250);
      a.resume();
    }
    await Bun.sleep(100);
    expect(a.samples()).toBe(1);
    expect(a.hangs).toHaveLength(1);
  });
});

describe('margind', () => {
  test('pings the app that subscribed with its pid and keeps a scrubbed hang report', async () => {
    const root = mkdtempSync(join(tmpdir(), 'margind-hangs-'));
    const where = paths(join(root, 'd'));
    const daemon = await startDaemon({
      paths: where,
      keys: memoryKeys(),
      server: 'http://127.0.0.1:9',
      tools: { home: root, dataHome: where.home, socket: where.socket, self: [] },
      tokenSources: { claudeProjects: root, codexSessions: [], opencodeDb: join(root, 'none') },
      idle: async () => 0,
      hangs: {
        ...FAST,
        // A source path from someone's Mac, which mustn't leave it.
        sample: async () => HUNG.replace('main.swift:27', '/Users/maya/acme/Margin/main.swift:27'),
      },
    });
    const socket = connect(where.socket);
    await new Promise((resolve) => socket.once('connect', resolve));
    cleanup.push(async () => {
      socket.destroy();
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    });
    const seen: Push[] = [];
    let answering = true;
    onLines(socket, (value) => {
      const p = value as Push;
      seen.push(p);
      if (p.type === 'ping' && answering) write(socket, { op: 'pong', n: p.n, menuBar: true });
    });
    write(socket, { op: 'subscribe', pid: process.pid });
    await until(() => seen.some((p) => p.type === 'ping'));
    await Bun.sleep(60);
    answering = false;
    await Bun.sleep(300);
    answering = true;
    const last = seen.findLast((p) => p.type === 'ping');
    if (last?.type === 'ping') write(socket, { op: 'pong', n: last.n, menuBar: true });
    await until(() => seen.some((p) => p.type === 'reports'));

    // Pongs are never answered with a result.
    expect(seen.some((p) => p.type === 'result')).toBe(false);
    const reports = new Reports(where.home, 'test').pending();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ component: 'app', kind: 'hang' });
    expect(reports[0]?.detail).toContain('app: menu bar, drawer closed');
    expect(reports[0]?.detail).toContain('main.swift:27');
    expect(reports[0]?.detail).not.toContain('maya');
    expect(reports[0]?.detail).toContain('recent log:');
    expect(seen.findLast((p) => p.type === 'reports')).toMatchObject({ count: 1, crash: false });
  });

  test('a subscriber without a pid (a test, a script) is never pinged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'margind-hangs-'));
    const where = paths(join(root, 'd'));
    const daemon = await startDaemon({
      paths: where,
      keys: memoryKeys(),
      server: 'http://127.0.0.1:9',
      tools: { home: root, dataHome: where.home, socket: where.socket, self: [] },
      tokenSources: { claudeProjects: root, codexSessions: [], opencodeDb: join(root, 'none') },
      idle: async () => 0,
      hangs: FAST,
    });
    const socket = connect(where.socket);
    await new Promise((resolve) => socket.once('connect', resolve));
    cleanup.push(async () => {
      socket.destroy();
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    });
    const seen: Push[] = [];
    onLines(socket, (p) => seen.push(p as Push));
    write(socket, { op: 'subscribe' });
    await Bun.sleep(200);
    expect(seen.some((p) => p.type === 'ping')).toBe(false);
  });
});
