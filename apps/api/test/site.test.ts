import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { site } from '../src/site';
import { type Api, startApi } from './harness';

let api: Api;
beforeAll(async () => {
  api = await startApi({ site: await site(join(import.meta.dir, '../../web')) });
});
afterAll(() => api.stop());

test('serves the page and its assets with a strict content policy', async () => {
  for (const [path, type] of [
    ['/', 'text/html'],
    ['/site.css', 'text/css'],
    ['/site.js', 'text/javascript'],
  ]) {
    const response = await fetch(api.base + path);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toStartWith(type ?? '');
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  }
});

test('the page loads nothing from anywhere else', async () => {
  const html = await (await fetch(`${api.base}/`)).text();
  expect(html).toContain('<h1>Margin</h1>');
  expect(html.match(/(src|href)="(https?:)?\/\//g)).toBeNull();
});

test('answers HEAD too, for link previews and uptime checks', async () => {
  expect((await fetch(`${api.base}/`, { method: 'HEAD' })).status).toBe(200);
});

test('other paths still fall through to the API', async () => {
  expect((await fetch(`${api.base}/index.html`)).status).toBe(401);
});
