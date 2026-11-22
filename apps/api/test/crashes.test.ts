import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Api, startApi } from './harness';

let api: Api;
const TOKEN = 'release-token-for-tests';
const INSTALL = '6f1c7d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';

const report = (overrides: Record<string, unknown> = {}) => ({
  install: INSTALL,
  version: '0.1.52',
  os: 'macOS 26.6.2 (25G83)',
  component: 'margind',
  kind: 'crash',
  what: 'TypeError',
  detail: 'TypeError: x is undefined\n    at recompute (/$bunfs/root/margind:812:14)',
  at: 1_700_000_000_000,
  ...overrides,
});

beforeEach(async () => {
  api = await startApi({ crashes: { readToken: TOKEN } });
});
afterEach(() => api.stop());

describe('crash reports', () => {
  test('a valid report is stored and read back only with the release token', async () => {
    expect((await api.call('/crash', { body: report() })).status).toBe(204);
    expect((await api.call('/crash')).status).toBe(401);
    expect((await api.call('/crash', { token: 'wrong' })).status).toBe(401);
    const read = await api.call('/crash', { token: TOKEN });
    expect(read.status).toBe(200);
    expect(read.body).toHaveLength(1);
    expect(read.body[0]).toMatchObject({
      install: INSTALL,
      what: 'TypeError',
      at: 1_700_000_000_000,
    });
  });

  test('anything outside the report shape, too big, or with control characters is refused', async () => {
    for (const bad of [
      report({ install: 'not-a-uuid' }),
      report({ component: 'server' }),
      report({ what: 'escape \u001b[2J' }),
      report({ account: 'maya-chen' }),
      report({ detail: 'x'.repeat(49_000) }),
    ]) {
      expect((await api.call('/crash', { body: bad })).status).toBe(400);
    }
    const huge = await fetch(`${api.base}/crash`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report({ detail: 'y'.repeat(70_000) })),
    });
    expect(huge.status).toBe(413);
    expect((await api.call('/crash', { token: TOKEN })).body).toHaveLength(0);
  });

  test('one install can send 30 a day', async () => {
    for (let i = 0; i < 30; i++)
      expect((await api.call('/crash', { body: report() })).status).toBe(204);
    expect((await api.call('/crash', { body: report() })).status).toBe(429);
    const other = report({ install: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' });
    expect((await api.call('/crash', { body: other })).status).toBe(204);
  });

  test('reading is off when no token is configured', async () => {
    await api.stop();
    api = await startApi();
    expect((await api.call('/crash', { body: report() })).status).toBe(204);
    expect((await api.call('/crash', { token: TOKEN })).status).toBe(404);
  });
});
