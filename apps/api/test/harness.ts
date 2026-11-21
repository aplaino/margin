import { randomBytes } from 'node:crypto';
import type { ClientFrame, KeyBundle, ServerFrame } from '@margin/protocol';
import { SQL } from 'bun';
import { createApp, type Options } from '../src/app';
import { migrate, TABLES } from '../src/db';

type Init = { method?: string; body?: unknown; headers?: Record<string, string> };
// Test replies are inspected loosely; the server's own types are checked in src.
// biome-ignore lint/suspicious/noExplicitAny: test-only convenience
export type Reply = { status: number; body: any };
type Caller = { handle: string; call: (path: string, init?: Init) => Promise<Reply> };

// Runs against in-memory SQLite, or Postgres when TEST_DATABASE_URL is set (wiped first).
export async function startApi(options: Options = {}) {
  const pg = process.env.TEST_DATABASE_URL;
  const sql = new SQL(pg ?? 'sqlite://:memory:');
  if (pg) for (const table of TABLES) await sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
  await migrate(sql);
  const app = createApp(sql, { devAuth: true, ...options });
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: app.fetch,
    websocket: app.websocket,
  });
  const base = server.url.href.replace(/\/$/, '');
  const sockets: Client[] = [];

  async function call(path: string, init: Init & { token?: string } = {}): Promise<Reply> {
    const response = await fetch(base + path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  async function user(handle: string, name?: string) {
    const reply = await call('/auth/dev', { body: { handle, ...(name ? { name } : {}) } });
    if (reply.status !== 200) throw new Error(`sign in ${handle}: ${JSON.stringify(reply.body)}`);
    const token: string = reply.body.token;
    return {
      handle,
      token,
      call: (path: string, init: Init = {}) => call(path, { ...init, token }),
      connect: async () => {
        const client = await connect(base, token);
        sockets.push(client);
        return client;
      },
    };
  }

  async function befriend(a: Caller, b: Caller) {
    await a.call('/friends/requests', { body: { handle: b.handle } });
    const reply = await b.call(`/friends/requests/${a.handle}/accept`, { method: 'POST' });
    if (reply.status !== 200) throw new Error(`befriend: ${JSON.stringify(reply.body)}`);
  }

  return {
    sql,
    base,
    call,
    user,
    befriend,
    async stop() {
      for (const socket of sockets) socket.ws.close();
      server.stop(true);
      await sql.close();
    },
  };
}

export type Api = Awaited<ReturnType<typeof startApi>>;
export type User = Awaited<ReturnType<Api['user']>>;
export type Client = Awaited<ReturnType<typeof connect>>;

export async function connect(base: string, token: string) {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, {
    headers: { authorization: `Bearer ${token}` },
  } as unknown as string[]);
  const buffer: ServerFrame[] = [];
  const waiters: { match: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }[] = [];
  let closed: { code: number } | null = null;
  const closeWaiters: ((e: { code: number }) => void)[] = [];

  ws.onmessage = (event) => {
    const frame = JSON.parse(String(event.data)) as ServerFrame;
    const waiter = waiters.findIndex((w) => w.match(frame));
    if (waiter >= 0) waiters.splice(waiter, 1)[0]?.resolve(frame);
    else buffer.push(frame);
  };
  ws.onclose = (event) => {
    closed = { code: event.code };
    for (const resolve of closeWaiters.splice(0)) resolve(closed);
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  return {
    ws,
    send: (frame: ClientFrame | Record<string, unknown>) => ws.send(JSON.stringify(frame)),
    // Resolves with the first frame (already received or future) that matches, consuming it.
    next<T extends ServerFrame = ServerFrame>(
      match: ((f: ServerFrame) => f is T) | ((f: ServerFrame) => boolean),
      timeoutMs = 2000,
    ): Promise<T> {
      const index = buffer.findIndex(match);
      if (index >= 0) return Promise.resolve(buffer.splice(index, 1)[0] as T);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for a frame')),
          timeoutMs,
        );
        waiters.push({
          match,
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f as T);
          },
        });
      });
    },
    // Waits a moment and returns any buffered frames that match (expected: none).
    async unexpected(match: (f: ServerFrame) => boolean, waitMs = 150) {
      await Bun.sleep(waitMs);
      return buffer.filter(match);
    },
    closed: () =>
      closed ? Promise.resolve(closed) : new Promise<{ code: number }>((r) => closeWaiters.push(r)),
  };
}

const b64 = (bytes: number) => randomBytes(bytes).toString('base64');

export function bundle(preKeyCount = 5, firstKeyId = 1, identityKey = b64(33)): KeyBundle {
  return {
    registrationId: 1234,
    identityKey,
    signedPreKey: { keyId: 1, publicKey: b64(33), signature: b64(64) },
    preKeys: Array.from({ length: preKeyCount }, (_, i) => ({
      keyId: firstKeyId + i,
      publicKey: b64(33),
    })),
  };
}

export const uuid = () => crypto.randomUUID();
export const ciphertext = { type: 1, body: b64(48) };
