import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Freeze detection. margind pings the app over the socket and the app answers from its main
// thread. When it hasn't answered for a few seconds, margind samples the app from outside (a
// hung main thread can't report on itself) and keeps a 'hang' report once it's over. An
// alert that blocks the drawer with none of it on screen counts too: the main thread still
// answers then, but Margin can't be used.

export type Pong = {
  n: number;
  menuBar?: boolean;
  expanded?: boolean;
  modal?: boolean;
  modalHidden?: boolean;
};
export type Hang = { what: string; detail: string };
export type Sampler = (pid: number) => Promise<string | undefined>;
export type HangOptions = {
  tickMs?: number;
  pingMs?: number;
  // No answer for this long is a hang; a hidden alert for this long blocks the drawer.
  hangMs?: number;
  hiddenAlertMs?: number;
  // After the Mac wakes (or margind itself was held up), before anything counts again.
  graceMs?: number;
  // Sampling takes a few seconds of CPU, so at most one per this long.
  cooldownMs?: number;
  sample?: Sampler;
  // Tests: a clock that can jump, as the wall clock does across sleep.
  now?: () => number;
};

type Episode = {
  kind: 'hang' | 'alert';
  since: number;
  text?: string;
  sampledAt?: number;
  ended?: { at: number; quit: boolean };
  reported?: boolean;
};

export function watchApp(
  pid: number,
  ping: (n: number) => void,
  onHang: (hang: Hang) => void,
  log: (line: string) => void,
  options: HangOptions = {},
) {
  const tickMs = options.tickMs ?? 1000;
  const pingMs = options.pingMs ?? 2000;
  const hangMs = options.hangMs ?? 5000;
  const hiddenAlertMs = options.hiddenAlertMs ?? 30_000;
  const graceMs = options.graceMs ?? 15_000;
  const cooldownMs = options.cooldownMs ?? 10 * 60_000;
  const sample = options.sample ?? sampleProcess;
  const clock = options.now ?? Date.now;

  let n = 0;
  let waiting: { n: number; at: number } | undefined;
  let pingedAt = 0;
  // Nothing counts until the app has answered once (it's still starting up before that).
  let answered = false;
  let state: Pong | undefined;
  let hiddenSince: number | undefined;
  let lastTick = clock();
  let quietUntil = 0;
  let cooldownUntil = 0;
  let current: Episode | undefined;
  let closed = false;

  const report = (e: Episode) => {
    if (e.reported) return;
    e.reported = true;
    if (current === e) current = undefined;
    const thread = e.text ? mainThread(e.text) : undefined;
    if (e.kind === 'hang' && thread?.idle) {
      log('the app was slow to answer, but its main thread was idle');
      return;
    }
    const seconds = (((e.ended?.at ?? clock()) - e.since) / 1000).toFixed(1);
    const lasted =
      e.kind === 'hang'
        ? e.ended?.quit
          ? `the main thread hadn't answered for ${seconds} s when Margin quit or margind stopped`
          : `the main thread didn't answer for ${seconds} s`
        : e.ended?.quit
          ? `an alert with none of it on screen blocked the drawer for ${seconds} s, until Margin quit or margind stopped`
          : `an alert with none of it on screen blocked the drawer for ${seconds} s`;
    log(
      e.kind === 'hang'
        ? `the app hung (${seconds} s)`
        : `a hidden alert blocked the app (${seconds} s)`,
    );
    const where = thread?.margin ?? thread?.top ?? 'an unknown place';
    onHang({
      what:
        e.kind === 'hang'
          ? `main thread hung in ${where}`
          : `drawer blocked by a hidden alert in ${where}`,
      detail: [
        lasted,
        state
          ? `app: ${state.menuBar ? 'menu bar' : 'screen edge'}, drawer ${state.expanded ? 'open' : 'closed'}, alert ${state.modal ? (state.modalHidden ? 'up, not on screen' : 'up') : 'none'}`
          : 'app: no answer yet',
        '',
        thread && e.sampledAt
          ? `main thread, sampled ${((e.sampledAt - e.since) / 1000).toFixed(1)} s in:`
          : 'main thread: no sample',
        ...(thread?.lines ?? []),
      ].join('\n'),
    });
  };

  const end = (e: Episode, quit: boolean) => {
    if (e.ended) return;
    e.ended = { at: clock(), quit };
    if (e.sampledAt) report(e);
  };

  const begin = (kind: Episode['kind'], since: number) => {
    cooldownUntil = clock() + cooldownMs;
    const e: Episode = { kind, since };
    current = e;
    log(
      kind === 'hang'
        ? 'the app stopped answering; sampling it'
        : 'a hidden alert is blocking the app; sampling it',
    );
    sample(pid)
      .catch(() => undefined)
      .then((text) => {
        e.text = text;
        e.sampledAt = clock();
        if (e.ended) report(e);
      });
  };

  const tick = () => {
    const now = clock();
    // margind didn't run (the Mac slept, or margind was held up), so nothing is known about
    // the app for that time: start again, and give it a moment.
    if (now - lastTick > tickMs * 3) {
      waiting = undefined;
      hiddenSince = undefined;
      quietUntil = now + graceMs;
    }
    lastTick = now;
    if (!waiting && now - pingedAt >= pingMs) {
      waiting = { n: ++n, at: now };
      pingedAt = now;
      ping(n);
    }
    if (!answered || current || now < quietUntil || now < cooldownUntil) return;
    if (waiting && now - waiting.at >= hangMs) begin('hang', waiting.at);
    else if (hiddenSince !== undefined && now - hiddenSince >= hiddenAlertMs)
      begin('alert', hiddenSince);
  };
  const timer = setInterval(tick, tickMs);
  tick();

  const close = () => {
    closed = true;
    clearInterval(timer);
  };

  return {
    pong(pong: Pong) {
      if (closed || pong.n !== waiting?.n) return;
      waiting = undefined;
      answered = true;
      state = pong;
      hiddenSince = pong.modal && pong.modalHidden ? (hiddenSince ?? clock()) : undefined;
      if (current?.kind === 'hang' || (current?.kind === 'alert' && hiddenSince === undefined))
        end(current, false);
    },
    // Quitting, or relaunching for an update: what was going on isn't a hang.
    quitting() {
      if (current && !current.ended) current = undefined;
      close();
    },
    // The app went away (a force quit ends a hang this way).
    disconnected() {
      if (closed) return;
      close();
      if (current) end(current, true);
    },
    // margind is stopping: keep what's known now, sampled or not.
    flush() {
      if (closed) return;
      close();
      const e = current;
      if (!e) return;
      end(e, true);
      report(e);
    },
  };
}

export type Watch = ReturnType<typeof watchApp>;

// /usr/bin/sample can read another process's stacks (it has Apple's entitlement for that),
// so it works on a hung app: one second of samples, written to a file read once and deleted.
export async function sampleProcess(pid: number): Promise<string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), 'margin-sample-'));
  try {
    const file = join(dir, 'sample.txt');
    const child = Bun.spawn(['/usr/bin/sample', String(pid), '1', '-mayDie', '-file', file], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const timer = setTimeout(() => child.kill(), 60_000);
    await child.exited;
    clearTimeout(timer);
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A frame's function, and its source line when there is one (top-level code in main.swift
// has closures with no function name to go by).
const symbol = (frame: string) => {
  const name = frame.split('  (in ')[0]?.trim() ?? frame;
  const line = frame.match(/\s(\S+:\d+)$/)?.[1];
  return line && !line.startsWith('/<') ? `${name} ${line}` : name;
};

// The main thread's part of a `sample` call graph, cleaned for a report: no addresses, and
// source files without their folders (the rest of the output, with the process's path and
// every loaded image's, is left out). Also the heaviest path through it: where most samples
// ended (`top`), the deepest of Margin's own frames on the way (`margin`), and whether the
// thread was only waiting for the next event in the app's own run loop (`idle`).
export function mainThread(text: string) {
  const all = text.split('\n');
  // It's labelled while it's running the main queue; otherwise it's the first thread listed.
  const labelled = all.findIndex((l) => /^\s*\d+ Thread_\S+.*com\.apple\.main-thread/.test(l));
  const start = labelled >= 0 ? labelled : all.indexOf('Call graph:') + 1;
  if (start <= 0 || !/^\s*\d+ Thread_/.test(all[start] ?? '')) return undefined;
  const raw = [all[start] ?? ''];
  for (const line of all.slice(start + 1)) {
    if (!/^\s*[+!:|\s]*\d+ /.test(line) || /^\s*\d+ Thread_/.test(line)) break;
    raw.push(line);
  }
  const lines = raw.map((line) =>
    line
      .replace(/\s+\[0x[0-9a-f]+\]/g, '')
      .replace(/\s*load address 0x[0-9a-f]+ \+ 0x[0-9a-f]+/g, '')
      .replace(/(?:\/[^\s/]+)+\/([^\s/]+:\d+)/g, '$1')
      .slice(0, 300)
      .trimEnd(),
  );

  const total = Number(raw[0]?.match(/^\s*(\d+)/)?.[1] ?? 0);
  const heaviest: { depth: number; count: number; frame: string }[] = [];
  for (const line of lines.slice(1)) {
    const m = line.match(/^([\s+!:|]*)(\d+) (.*)$/);
    const last = heaviest.at(-1);
    if (!m || (last && (m[1] ?? '').length <= last.depth)) break;
    heaviest.push({ depth: (m[1] ?? '').length, count: Number(m[2]), frame: m[3] ?? '' });
  }
  const top = heaviest.at(-1);
  const margin = heaviest.findLast((f) => f.frame.includes('(in Margin)'));
  // Idle: most samples sat in the outer run loop's wait for a Mach message. A nested run loop
  // (an alert, a menu, a RunLoop.run inside code) isn't idle, nor is a wait anywhere else.
  const wait = heaviest.findLastIndex((f) => f.frame.startsWith('__CFRunLoopServiceMachPort'));
  const idle =
    !!top &&
    total > 0 &&
    top.count / total >= 0.9 &&
    wait >= 0 &&
    heaviest.slice(wait + 1).every((f) => f.frame.startsWith('mach_msg')) &&
    heaviest.filter((f) => f.frame.startsWith('__CFRunLoopRun ')).length === 1;

  return {
    lines: lines.slice(0, 200),
    top: top ? symbol(top.frame) : undefined,
    margin: margin ? symbol(margin.frame) : undefined,
    idle,
  };
}
