import { timingSafeEqual } from 'node:crypto';

// Fixed-window limiter per key (an account, an install, an address) and action.
export function limiter(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  let sweepAt = 0;
  // Whether a key has a window open now (it was seen within the last window).
  const seen = (key: string) => (hits.get(key)?.resetAt ?? 0) > Date.now();
  const hit = (key: string) => {
    const now = Date.now();
    // Forget finished windows now and then, so keys anyone can make up don't pile up.
    if (now >= sweepAt) {
      for (const [k, e] of hits) if (e.resetAt <= now) hits.delete(k);
      sweepAt = now + windowMs;
    }
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    return ++entry.count <= limit;
  };
  return Object.assign(hit, { seen });
}

// A bearer token compared in constant time.
export function tokenMatches(header: string | null, token: string) {
  const given = Buffer.from(header?.match(/^Bearer (\S+)$/)?.[1] ?? '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
