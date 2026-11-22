import { randomUUID } from 'node:crypto';
import { CrashReport } from '@margin/protocol';
import type { SQL } from 'bun';
import * as v from 'valibot';
import { limiter, tokenMatches } from './limits';

// Crash and error reports from Margin installs, scrubbed on the Mac before they're sent.
// Anyone can post one (a crash can come before sign-in), so each is size-capped and
// rate-limited per install and per address, and kept 90 days. Reading them takes the
// release token.

export type CrashOptions = {
  // Bearer token for reading reports; reading is off without one.
  readToken?: string;
  retentionMs?: number;
};

const MAX_BODY = 64 * 1024;
const RETENTION_MS = 90 * 24 * 60 * 60_000;

const json = (body: unknown, status = 200) => Response.json(body, { status });

// The body as text, or null once it passes `max` bytes, without reading the rest.
async function readLimited(req: Request, max: number) {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function crashes(sql: SQL, options: CrashOptions = {}) {
  const retentionMs = options.retentionMs ?? RETENTION_MS;
  const perInstall = limiter(30, 24 * 60 * 60_000);
  const perAddress = limiter(100, 60 * 60_000);
  // The install id is the sender's to choose, so new ids share one hourly allowance; installs
  // already heard from today keep their own budget, so a flood of made-up ids can't lock
  // them out.
  const newInstalls = limiter(1000, 60 * 60_000);
  // A hard ceiling on what's stored, whatever ids and addresses are claimed.
  const everything = limiter(5000, 60 * 60_000);

  async function receive(req: Request) {
    if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY)
      return json({ error: 'too large' }, 413);
    const text = await readLimited(req, MAX_BODY);
    if (text === null) return json({ error: 'too large' }, 413);
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      return json({ error: 'invalid JSON' }, 400);
    }
    const parsed = v.safeParse(CrashReport, input);
    if (!parsed.success) return json({ error: 'invalid report' }, 400);
    const report = parsed.output;
    // Fly puts the caller's address here; anything else counts as one unknown caller.
    const address = req.headers.get('fly-client-ip') ?? 'unknown';
    const admitted = perInstall.seen(report.install) || newInstalls('all');
    if (!admitted || !perAddress(address) || !perInstall(report.install) || !everything('all'))
      return json({ error: 'rate limited' }, 429);
    const now = Date.now();
    await sql`INSERT INTO crash_reports ${sql({ id: randomUUID(), ...report, received_at: now })}`;
    await sql`DELETE FROM crash_reports WHERE received_at < ${now - retentionMs}`;
    return new Response(null, { status: 204 });
  }

  async function list(req: Request, url: URL) {
    if (!options.readToken) return json({ error: 'not found' }, 404);
    if (!tokenMatches(req.headers.get('authorization'), options.readToken))
      return json({ error: 'unauthorized' }, 401);
    const since = Number(url.searchParams.get('since') ?? 0) || 0;
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 1), 500);
    const rows = await sql`
      SELECT * FROM crash_reports WHERE received_at > ${since} ORDER BY received_at DESC LIMIT ${limit}`;
    return json(
      rows.map((r: Record<string, unknown>) => ({
        ...r,
        at: Number(r.at),
        received_at: Number(r.received_at),
      })),
    );
  }

  return async (req: Request, url: URL): Promise<Response | null> => {
    if (url.pathname !== '/crash') return null;
    if (req.method === 'POST') return receive(req);
    if (req.method === 'GET') return list(req, url);
    return null;
  };
}
