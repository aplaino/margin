import { createApp } from './app';
import { migrate, openDb } from './db';
import { site } from './site';

const devAuth = process.env.MARGIN_DEV_AUTH === '1';
if (devAuth)
  console.warn(
    '[api] MARGIN_DEV_AUTH=1: anyone can sign in as any handle. Local development only.',
  );

// MARGIN_ENV=production refuses settings that are only safe on a laptop.
if (process.env.MARGIN_ENV === 'production') {
  const problems = [
    devAuth && 'MARGIN_DEV_AUTH must be off',
    !process.env.GITHUB_CLIENT_ID && 'GITHUB_CLIENT_ID is required',
    !process.env.DATABASE_URL?.startsWith('postgres') && 'DATABASE_URL must point at Postgres',
    // Update feed links must never come from a request's Host header.
    !process.env.MARGIN_PUBLIC_URL?.startsWith('https://') &&
      'MARGIN_PUBLIC_URL must be the https:// address',
  ].filter(Boolean);
  if (problems.length) {
    console.error(`[api] refusing to start in production: ${problems.join('; ')}`);
    process.exit(1);
  }
}

const sql = openDb();
await migrate(sql);

const app = createApp(sql, {
  devAuth,
  githubClientId: process.env.GITHUB_CLIENT_ID,
  site: await site(process.env.MARGIN_WEB_DIR ?? new URL('../../web', import.meta.url).pathname),
  updates: {
    dir: process.env.MARGIN_UPDATES_DIR ?? '/data/updates',
    releaseToken: process.env.RELEASE_TOKEN,
    publicUrl: process.env.MARGIN_PUBLIC_URL,
  },
});
const server = Bun.serve({
  port: Number(process.env.PORT ?? 8787),
  hostname: process.env.HOST ?? '127.0.0.1',
  fetch: app.fetch,
  websocket: app.websocket,
});
console.log(`[api] listening on ${server.url}`);
