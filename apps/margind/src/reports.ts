import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, release } from 'node:os';
import { join } from 'node:path';
import { CrashReport } from '@margin/protocol';
import * as v from 'valibot';

// Crashes and serious errors, kept on this Mac until the app asks you and you say send.
// Everything is scrubbed before it's written: paths, handles, names, repos, emails and
// anything token-like are removed, so a report holds what broke and never who or what you
// were working on.

const MAX_PENDING = 20;
const LOG_LINES = 50;

// Absolute paths outside the app's own bundle and macOS's frameworks, and ~/ paths.
const PATHS =
  /(?:~|\/(?:Users|private|var|tmp|Volumes|opt|home|Applications)|[A-Za-z]:\\)(?:[/\\][^\s:'"()<>[\],]*)*/g;
const EMAILS = /[^\s@<>()"']+@[^\s@<>()"']+\.[a-z]{2,}/gi;
const TOKENS = /[A-Za-z0-9+/_=-]{32,}/g;
const URL_QUERY = /(https?:\/\/[^\s?#]+)[?#][^\s]*/g;

export function scrub(text: string, secrets: string[] = [], home = homedir()) {
  let out = text.split(home).join('~');
  out = out.replace(URL_QUERY, '$1').replace(EMAILS, '<email>').replace(PATHS, '<path>');
  // Longest first, so a repo name goes before the handle inside it.
  for (const secret of [...new Set(secrets)]
    .filter((s) => s.length > 3)
    .sort((a, b) => b.length - a.length)) {
    out = out.replace(
      new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
      '<redacted>',
    );
  }
  return out.replace(TOKENS, '<token>');
}

// An error's stack for a report: its type and the code locations it passed through. The
// message is kept only for Margin's own errors (`own`): others can carry anything, which is
// why margind's log leaves their messages out too.
export function stackOf(e: unknown, own = false) {
  if (!(e instanceof Error)) return typeof e;
  const frames = (e.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line));
  return [own ? `${e.name}: ${e.message}` : e.name, ...frames].join('\n');
}

export class Reports {
  private dir: string;

  constructor(
    home: string,
    private version: string,
    // Where macOS writes crash reports; tests point it elsewhere.
    private crashLogs = join(homedir(), 'Library', 'Logs', 'DiagnosticReports'),
    private logFile = join(home, 'margind.log'),
  ) {
    this.dir = join(home, 'reports');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  // A random id for this install, made once. It identifies a Mac's reports, not a person.
  install() {
    const path = join(this.dir, 'install-id');
    const saved = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
    if (v.is(CrashReport.entries.install, saved)) return saved;
    const id = randomUUID();
    writeFileSync(path, id, { mode: 0o600 });
    return id;
  }

  // The end of margind's log, which records what it was doing (own messages only; see log()).
  logTail() {
    try {
      return readFileSync(this.logFile, 'utf8')
        .split('\n')
        .slice(-LOG_LINES - 1)
        .join('\n');
    } catch {
      return '';
    }
  }

  add(
    report: Pick<CrashReport, 'component' | 'kind' | 'what' | 'detail'> & {
      os?: string;
      version?: string;
    },
    secrets: string[] = [],
  ) {
    const what =
      scrub(report.what, secrets)
        .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
        .slice(0, 200) || 'unknown';
    // The same problem again is noted once until it's sent.
    if (
      this.pending().some(
        (r) => r.component === report.component && r.kind === report.kind && r.what === what,
      )
    )
      return;
    const candidate: CrashReport = {
      install: this.install(),
      version: (report.version ?? this.version).slice(0, 40),
      os: (report.os ?? `macOS ${release()}`).slice(0, 80),
      component: report.component,
      kind: report.kind,
      what,
      detail: scrub(report.detail, secrets)
        .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => ('\t\n'.includes(c) ? c : ''))
        .slice(-48_000),
      at: Date.now(),
    };
    if (!v.is(CrashReport, candidate)) return;
    writeFileSync(
      join(this.dir, `${candidate.at}-${String(process.hrtime.bigint()).padStart(20, '0')}.json`),
      JSON.stringify(candidate),
      {
        mode: 0o600,
      },
    );
    const files = this.files();
    for (const old of files.slice(0, Math.max(0, files.length - MAX_PENDING)))
      unlinkSync(join(this.dir, old));
  }

  private files() {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
  }

  pending(): CrashReport[] {
    return this.files().flatMap((f) => {
      try {
        const parsed = v.safeParse(
          CrashReport,
          JSON.parse(readFileSync(join(this.dir, f), 'utf8')),
        );
        return parsed.success ? [parsed.output] : [];
      } catch {
        return [];
      }
    });
  }

  state() {
    const pending = this.pending();
    return { count: pending.length, crash: pending.some((r) => r.kind === 'crash') };
  }

  discard() {
    for (const f of this.files()) unlinkSync(join(this.dir, f));
  }

  // Sends each report and forgets it once the server has it (or refuses it for good);
  // ones the server can't take right now stay for next time. Returns how many went.
  async send(server: string) {
    let sent = 0;
    for (const f of this.files()) {
      const path = join(this.dir, f);
      let body: string;
      try {
        body = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      const response = await fetch(`${server}/crash`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
      if (!response || response.status === 429 || response.status >= 500) break;
      unlinkSync(path);
      if (response.ok) sent++;
    }
    return sent;
  }

  // macOS's own crash reports for Margin.app or margind, written since the last look. The
  // first look only marks where to start, so crashes from before this existed aren't sent.
  scanMacCrashes(secrets: string[] = []) {
    const marker = join(this.dir, 'last-scan');
    const since = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) || 0 : undefined;
    writeFileSync(marker, String(Date.now()), { mode: 0o600 });
    if (since === undefined || !existsSync(this.crashLogs)) return;
    for (const name of readdirSync(this.crashLogs)) {
      const component = name.startsWith('margind-')
        ? 'margind'
        : name.startsWith('Margin-')
          ? 'app'
          : null;
      if (!component || !name.endsWith('.ips')) continue;
      const path = join(this.crashLogs, name);
      try {
        if (statSync(path).mtimeMs <= since) continue;
        const parsed = parseIps(readFileSync(path, 'utf8'));
        if (parsed) this.add({ component, kind: 'crash', ...parsed }, secrets);
      } catch {}
    }
  }
}

// A macOS .ips crash report: a JSON header line, then a JSON body. Only the exception, the
// crashed thread's frames (symbol and image name, never image paths) and any message the
// app left are kept.
export function parseIps(text: string) {
  const newline = text.indexOf('\n');
  if (newline < 0) return null;
  const header = JSON.parse(text.slice(0, newline)) as {
    app_version?: string;
    os_version?: string;
  };
  const body = JSON.parse(text.slice(newline + 1)) as {
    exception?: { type?: string; signal?: string };
    termination?: { indicator?: string };
    asi?: Record<string, string[]>;
    faultingThread?: number;
    threads?: { frames?: { imageIndex?: number; symbol?: string; imageOffset?: number }[] }[];
    usedImages?: { name?: string }[];
  };
  const exception = [body.exception?.type, body.exception?.signal].filter(Boolean).join(' ');
  const frames = body.threads?.[body.faultingThread ?? 0]?.frames ?? [];
  const lines = [
    exception && `exception: ${exception}`,
    body.termination?.indicator && `termination: ${body.termination.indicator}`,
    ...Object.values(body.asi ?? {})
      .flat()
      .map((m) => `message: ${m}`),
    'crashed thread:',
    ...frames
      .slice(0, 40)
      .map(
        (f) =>
          `  ${f.symbol ?? '?'} (${body.usedImages?.[f.imageIndex ?? -1]?.name ?? '?'} +${f.imageOffset ?? 0})`,
      ),
  ].filter(Boolean);
  return {
    what: exception || body.termination?.indicator || 'crash',
    detail: lines.join('\n'),
    ...(header.app_version ? { version: header.app_version } : {}),
    ...(header.os_version ? { os: header.os_version } : {}),
  };
}
