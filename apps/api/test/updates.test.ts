import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Api, startApi } from './harness';

let api: Api;
let dir: string;
const TOKEN = 'release-token-for-tests';
const SIGNATURE = 'aGVsbG8gdGhpcyBpcyBub3QgYSByZWFsIHNpZ25hdHVyZSBidXQgaXQgbG9va3MgbGlrZSBvbmU=';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'margin-updates-'));
  api = await startApi({
    updates: { dir, releaseToken: TOKEN, publicUrl: 'https://margin.example' },
  });
});
afterEach(async () => {
  await api.stop();
  rmSync(dir, { recursive: true, force: true });
});

function upload(
  build: number,
  body: string | Uint8Array = 'zip bytes',
  overrides: Record<string, string> = {},
) {
  return fetch(`${api.base}/updates/releases`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'x-release-version': `0.1.${build}`,
      'x-release-build': String(build),
      'x-release-signature': SIGNATURE,
      'x-release-min-system': '26.0',
      ...overrides,
    },
    body: body as BodyInit,
  });
}

describe('releases', () => {
  test('need the release token', async () => {
    expect((await upload(1, 'x', { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await upload(1, 'x', { authorization: '' })).status).toBe(401);
    const closed = await startApi({ updates: { dir } });
    const response = await fetch(`${closed.base}/updates/releases`, { method: 'POST', body: 'x' });
    expect(response.status).toBe(404);
    await closed.stop();
  });

  test('reject odd versions, signatures and empty bodies', async () => {
    expect((await upload(1, 'x', { 'x-release-version': '1.0' })).status).toBe(400);
    expect((await upload(1, 'x', { 'x-release-signature': '"/><evil/>' })).status).toBe(400);
    expect((await upload(1, 'x', { 'x-release-build': '-3' })).status).toBe(400);
    expect((await upload(1, '')).status).toBe(400);
  });

  test('each build must be newer than the last', async () => {
    expect((await upload(2)).status).toBe(200);
    expect((await upload(2)).status).toBe(409);
    expect((await upload(1)).status).toBe(409);
    expect((await upload(3)).status).toBe(200);
  });

  test('the appcast lists the newest releases with their signatures and public links', async () => {
    await upload(1, 'first');
    await upload(2, 'second build');
    const response = await fetch(`${api.base}/updates/appcast.xml`);
    expect(response.headers.get('content-type')).toContain('xml');
    const xml = await response.text();
    expect(xml.indexOf('<sparkle:version>2</sparkle:version>')).toBeLessThan(
      xml.indexOf('<sparkle:version>1</sparkle:version>'),
    );
    expect(xml).toContain('url="https://margin.example/updates/Margin-2.zip" length="12"');
    expect(xml).toContain(`sparkle:edSignature="${SIGNATURE}"`);
    expect(xml).toContain('<sparkle:minimumSystemVersion>26.0</sparkle:minimumSystemVersion>');
  });

  test('zips download as uploaded, and /download gives the newest as Margin.zip', async () => {
    const bytes = new Uint8Array([80, 75, 3, 4, 0, 1, 2, 255]);
    await upload(1, 'old');
    await upload(2, bytes);
    const exact = await fetch(`${api.base}/updates/Margin-2.zip`);
    expect(new Uint8Array(await exact.arrayBuffer())).toEqual(bytes);
    const latest = await fetch(`${api.base}/download`);
    expect(latest.headers.get('content-disposition')).toBe('attachment; filename="Margin.zip"');
    expect(new Uint8Array(await latest.arrayBuffer())).toEqual(bytes);
    expect(readdirSync(dir).sort()).toEqual(['Margin-1.zip', 'Margin-2.zip']);
  });

  test('nothing else on disk can be reached', async () => {
    await upload(1);
    for (const path of [
      '/updates/Margin-9.zip',
      '/updates/..%2F..%2Fetc%2Fpasswd',
      '/updates/Margin-1.zip.partial',
    ]) {
      const response = await fetch(api.base + path);
      expect(response.ok).toBe(false);
      expect(response.headers.get('content-type')).not.toBe('application/zip');
    }
  });

  test('before any release, /download says so', async () => {
    const response = await fetch(`${api.base}/download`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'no release yet' });
  });
});
