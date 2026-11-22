import { timingSafeEqual } from 'node:crypto';

// Fixed-window limiter per key (an account, an install, an address) and action.
export function limiter(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    return ++entry.count <= limit;
  };
}

// A bearer token compared in constant time.
export function tokenMatches(header: string | null, token: string) {
  const given = Buffer.from(header?.match(/^Bearer (\S+)$/)?.[1] ?? '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
