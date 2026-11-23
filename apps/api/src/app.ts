import { type Config, PROTOCOL } from '@margin/protocol';
import type { Server, SQL } from 'bun';
import { accountRoutes } from './account';
import { type CrashOptions, crashes } from './crashes';
import { friendRoutes } from './friends';
import { HttpError, json, notFound } from './http';
import { keyRoutes } from './keys';
import { realtime } from './realtime';
import { type Account, log, type Online, rateLimits, type SocketData, shared } from './shared';
import { type UpdateOptions, updates } from './updates';

// The server holds identity, the friend graph, public key bundles and ciphertext in
// transit. Presence lives in memory only. It never sees message plaintext.

export type GithubUser = { id: number; login: string; name: string | null };

export type Options = {
  githubClientId?: string;
  // Local development and tests only: sign in as any handle without GitHub.
  devAuth?: boolean;
  fetchGithubUser?: (token: string) => Promise<GithubUser | null>;
  retentionMs?: number;
  updates?: UpdateOptions;
  crashes?: CrashOptions;
  // Serves the website at / and its two assets.
  site?: (req: Request, url: URL) => Response | null;
};

export function createApp(sql: SQL, options: Options = {}) {
  const updateRoutes = options.updates ? updates(sql, options.updates) : undefined;
  const crashRoutes = crashes(sql, options.crashes);
  const online = new Map<string, Online>();
  const context = { sql, online, limits: rateLimits(), ...shared(sql, online) };
  const account = accountRoutes(context, options);
  const keys = keyRoutes(context);
  const friends = friendRoutes(context);
  const live = realtime(context, {
    retentionMs: options.retentionMs,
    authenticate: account.authenticate,
  });

  async function route(req: Request, url: URL): Promise<Response> {
    const { method } = req;
    const path = url.pathname;

    if (method === 'GET' && path === '/health') return json({ ok: true });
    const update = await updateRoutes?.(req, url);
    if (update) return update;
    const crash = await crashRoutes(req, url);
    if (crash) return crash;
    const page = options.site?.(req, url);
    if (page) return page;
    if (method === 'GET' && path === '/config') {
      const config: Config = { protocol: PROTOCOL, githubClientId: options.githubClientId ?? null };
      return json(config);
    }
    const signIn = await account.signIn(req, url);
    if (signIn) return signIn;

    const auth = await account.authenticate(req);
    if (!auth) throw new HttpError(401, 'unauthorized');
    const me: Account = { id: auth.id, handle: auth.handle };

    const response =
      (await account.signedIn(req, url, me, auth.tokenHash)) ??
      (await keys(req, url, me)) ??
      (await friends(req, url, me));
    if (response) return response;
    throw notFound();
  }

  return {
    async fetch(req: Request, server: Server<SocketData>) {
      const url = new URL(req.url);
      const protocol = req.headers.get('x-margin-protocol') ?? url.searchParams.get('protocol');
      if (protocol !== null && Number(protocol) !== PROTOCOL) {
        return json({ error: 'Margin needs an update', protocol: PROTOCOL }, 426);
      }
      if (url.pathname === '/ws') return live.upgrade(req, server);
      try {
        return await route(req, url);
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        log(`${req.method} ${url.pathname}`)(e);
        return json({ error: 'internal error' }, 500);
      }
    },
    websocket: live.websocket,
    drain: live.drain,
  };
}
