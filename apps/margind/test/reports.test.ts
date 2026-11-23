import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseIps, Reports, scrub, stackOf } from '../src/reports';

let root: string;
let logs: string;
let reports: Reports;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'margind-reports-'));
  logs = join(root, 'DiagnosticReports');
  mkdirSync(logs);
  writeFileSync(
    join(root, 'margind.log'),
    '[margind] running\n[margind] token scan failed (TypeError)\n',
  );
  reports = new Reports(root, '0.1.52', logs);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('scrubbing', () => {
  test('paths, emails, tokens, URL queries and named secrets go; what broke stays', () => {
    const text = [
      'TypeError: cannot read cwd of /Users/maya/code/secret-app/src',
      '    at recompute (/$bunfs/root/margind:812:14)',
      '    at /private/var/folders/x/T/tmp.abc/file',
      'friend maya-chen in acme/stealth-launch emailed maya@example.com',
      'token ghp_0123456789abcdefghijABCDEFGHIJ0123 at https://margin-api.fly.dev/crash?install=abc',
    ].join('\n');
    const out = scrub(text, ['maya-chen', 'acme/stealth-launch', 'stealth-launch'], '/Users/maya');
    for (const gone of [
      '/Users',
      'secret-app',
      'maya-chen',
      'stealth-launch',
      'maya@example.com',
      'ghp_',
      'install=abc',
      'tmp.abc',
    ])
      expect(out).not.toContain(gone);
    expect(out).toContain('TypeError: cannot read cwd of <path>');
    expect(out).toContain('at recompute (/$bunfs/root/margind:812:14)');
    expect(out).toContain('https://margin-api.fly.dev/crash');
  });

  test('stack frames keep their file and line, never the folders above them', () => {
    const text = [
      'PreKeyError',
      '    at initIncoming (/Users/maya/code/stealth-launch/node_modules/.bun/libsignal@6.0.0/node_modules/libsignal/src/session_builder.js:66:30)',
      '    at async <anonymous> (/Users/maya/code/stealth-launch/node_modules/@privacyresearch/libsignal-protocol-typescript/lib/session-cipher.js:205:44)',
      '    at /Users/maya/code/stealth-launch/node_modules/optionator/lib/index.js:20:39',
      '    at recompute (/Users/maya/maya-chen/apps/margind/src/tokens.ts:812:14)',
      '    at processTicksAndRejections (native:7:39)',
    ].join('\n');
    const out = scrub(text, ['maya-chen'], '/Users/maya');
    expect(out).toBe(
      [
        'PreKeyError',
        '    at initIncoming (node_modules/libsignal/src/session_builder.js:66:30)',
        '    at async <anonymous> (node_modules/@privacyresearch/libsignal-protocol-typescript/lib/session-cipher.js:205:44)',
        '    at node_modules/optionator/lib/index.js:20:39',
        '    at recompute (tokens.ts:812:14)',
        '    at processTicksAndRejections (native:7:39)',
      ].join('\n'),
    );
  });
});

describe('stacks', () => {
  test('keep an error’s type and code locations, and its message only when it’s Margin’s own', () => {
    const error = new TypeError('cannot read maya-chen/stealth-launch');
    const foreign = stackOf(error);
    expect(foreign.split('\n')[0]).toBe('TypeError');
    expect(foreign).not.toContain('stealth-launch');
    expect(foreign).toMatch(/\n\s+at /);
    expect(stackOf(error, true).split('\n')[0]).toBe(
      'TypeError: cannot read maya-chen/stealth-launch',
    );
    expect(stackOf('a string')).toBe('string');
    // A message with lines shaped like frames doesn't get through.
    const sneaky = new Error('oops\n    at maya-chen/stealth-launch (secret)');
    expect(stackOf(sneaky)).not.toContain('stealth-launch');
  });
});

describe('the queue', () => {
  test('a report is scrubbed, kept with an install id, and the same problem is kept once', () => {
    const add = () =>
      reports.add(
        {
          component: 'margind',
          kind: 'error',
          what: 'token scan failed (TypeError)',
          detail: 'at /Users/me/x',
        },
        [],
      );
    add();
    add();
    const pending = reports.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ version: '0.1.52', component: 'margind', kind: 'error' });
    expect(pending[0]?.detail).toBe('at <path>');
    expect(pending[0]?.install).toBe(reports.install());
    // Since the oldest waiting report, so the app can ask once errors have waited a while.
    const since = pending[0]?.at;
    expect(reports.state()).toEqual({ count: 1, crash: false, since });
    reports.add({ component: 'app', kind: 'crash', what: 'EXC_BAD_ACCESS', detail: '' });
    expect(reports.state()).toEqual({ count: 2, crash: true, since });
    reports.discard();
    expect(reports.state()).toEqual({ count: 0, crash: false, since: undefined });
  });

  test('keeps at most 20, dropping the oldest', () => {
    for (let i = 0; i < 25; i++)
      reports.add({ component: 'margind', kind: 'error', what: `problem ${i}`, detail: '' });
    const pending = reports.pending();
    expect(pending).toHaveLength(20);
    expect(pending.at(-1)?.what).toBe('problem 24');
  });

  test('sends each report, keeps them when the server is busy, and forgets refused ones', async () => {
    const received: unknown[] = [];
    let status = 503;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        received.push(await req.json());
        return new Response(null, { status });
      },
    });
    try {
      reports.add({ component: 'margind', kind: 'error', what: 'one', detail: '' });
      reports.add({ component: 'margind', kind: 'error', what: 'two', detail: '' });
      expect(await reports.send(server.url.origin)).toBe(0);
      expect(reports.state().count).toBe(2);
      status = 200;
      expect(await reports.send(server.url.origin)).toBe(2);
      expect(reports.state().count).toBe(0);
      expect(received.at(-1)).toMatchObject({ what: 'two', install: reports.install() });
    } finally {
      server.stop(true);
    }
  });
});

describe('macOS crash reports', () => {
  const ips = (exception: string) =>
    `${JSON.stringify({ app_name: 'Margin', app_version: '0.1.51', os_version: 'macOS 26.6.2 (25G83)' })}\n${JSON.stringify(
      {
        exception: { type: exception, signal: 'SIGSEGV' },
        asi: { 'libswiftCore.dylib': ['Fatal error: Unexpectedly found nil at /Users/me/x.swift'] },
        faultingThread: 0,
        threads: [
          {
            frames: [
              { imageIndex: 0, symbol: 'DrawerController.place(movingDrawer:)', imageOffset: 4242 },
            ],
          },
        ],
        usedImages: [{ name: 'Margin', path: '/Applications/Margin.app/Contents/MacOS/Margin' }],
      },
    )}`;

  test('the exception, the crashed thread and the app’s message are kept, never image paths', () => {
    const parsed = parseIps(ips('EXC_BAD_ACCESS'));
    expect(parsed?.what).toBe('EXC_BAD_ACCESS SIGSEGV');
    expect(parsed?.version).toBe('0.1.51');
    expect(parsed?.detail).toContain('DrawerController.place(movingDrawer:) (Margin +4242)');
    expect(parsed?.detail).not.toContain('/Applications');
  });

  test('only Margin’s crashes since the last look are picked up, and the first look only marks the time', () => {
    const old = join(logs, 'Margin-2026-11-20-100000.ips');
    writeFileSync(old, ips('EXC_CRASH'));
    utimesSync(old, new Date(1_000_000), new Date(1_000_000));
    reports.scanMacCrashes();
    expect(reports.state().count).toBe(0);

    // Written after the first look; dated a minute on, since some filesystems' timestamps
    // trail the clock by a few milliseconds.
    const later = new Date(Date.now() + 60_000);
    for (const name of ['Margin-2026-11-21-214641.ips', 'Safari-2026-11-21-214641.ips']) {
      writeFileSync(join(logs, name), ips('EXC_BAD_ACCESS'));
      utimesSync(join(logs, name), later, later);
    }
    reports.scanMacCrashes();
    const pending = reports.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      component: 'app',
      kind: 'crash',
      what: 'EXC_BAD_ACCESS SIGSEGV',
    });
    expect(pending[0]?.detail).toContain('message: Fatal error: Unexpectedly found nil at <path>');
  });
});
