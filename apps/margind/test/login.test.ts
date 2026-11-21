import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Push } from '@margin/protocol';
import { SQL } from 'bun';
import { createApp } from '../../api/src/app';
import { migrate } from '../../api/src/db';
import { Api, ApiError } from '../src/api';
import { startDaemon } from '../src/daemon';
import { memoryKeys } from '../src/keychain';
import { onLines, write } from '../src/net';
import { paths } from '../src/paths';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup(serverClientId: string, buildClientId: string | undefined) {
  const sql = new SQL('sqlite://:memory:');
  await migrate(sql);
  const app = createApp(sql, {
    githubClientId: serverClientId,
    fetchGithubUser: async (token) =>
      token === 'gh-token' ? { id: 1, login: 'Maya', name: 'Maya Chen' } : null,
  });
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: app.fetch,
    websocket: app.websocket,
  });
  const root = mkdtempSync(join(tmpdir(), 'margind-login-'));
  const where = paths(join(root, 'd'));
  const usedClientIds: string[] = [];
  const daemon = await startDaemon({
    paths: where,
    keys: memoryKeys(),
    server: server.url.href.replace(/\/$/, ''),
    githubClientId: buildClientId,
    deviceLogin: async (clientId, onCode) => {
      usedClientIds.push(clientId);
      onCode({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' });
      return 'gh-token';
    },
    tools: { home: root, dataHome: where.home, socket: where.socket, self: [] },
    tokenSources: { claudeProjects: root, codexSessions: [], opencodeDb: join(root, 'none') },
    idle: async () => 0,
  });
  const socket = connect(where.socket);
  await new Promise((resolve) => socket.once('connect', resolve));
  const seen: Push[] = [];
  onLines(socket, (p) => seen.push(p as Push));
  write(socket, { op: 'subscribe' });
  cleanup.push(async () => {
    socket.destroy();
    await daemon.stop();
    server.stop(true);
    await app.drain();
    await sql.close();
    rmSync(root, { recursive: true, force: true });
  });
  const waitFor = async (match: (p: Push) => boolean) => {
    for (let i = 0; i < 100 && !seen.some(match); i++) await Bun.sleep(20);
    return seen.find(match);
  };
  return { socket, seen, waitFor, usedClientIds };
}

describe('signing in with GitHub', () => {
  test('uses the build’s GitHub app, shows the code, then connects', async () => {
    const { socket, waitFor, usedClientIds } = await setup('Iv1.margin', 'Iv1.margin');
    write(socket, { op: 'login' });
    expect(await waitFor((p) => p.type === 'login' && p.state === 'code')).toMatchObject({
      userCode: 'ABCD-1234',
    });
    expect(await waitFor((p) => p.type === 'self' && p.connection === 'online')).toMatchObject({
      handle: 'maya',
    });
    expect(usedClientIds).toEqual(['Iv1.margin']);
  });

  test('refuses a server that names a different GitHub app, before contacting GitHub', async () => {
    const { socket, waitFor, usedClientIds } = await setup('Iv1.someone-elses-app', 'Iv1.margin');
    write(socket, { op: 'login' });
    const failed = await waitFor((p) => p.type === 'login' && p.state === 'failed');
    expect(failed).toMatchObject({ error: 'This server isn’t set up for this version of Margin' });
    expect(usedClientIds).toEqual([]);
  });

  test('a build without a GitHub app cannot start GitHub sign-in', async () => {
    const { socket, waitFor, usedClientIds } = await setup('Iv1.margin', undefined);
    write(socket, { op: 'login' });
    expect(await waitFor((p) => p.type === 'login' && p.state === 'failed')).toBeTruthy();
    expect(usedClientIds).toEqual([]);
  });
});

describe('signing out', () => {
  test('returns the app to the signed-out state', async () => {
    const { socket, waitFor } = await setup('Iv1.margin', 'Iv1.margin');
    write(socket, { op: 'login' });
    await waitFor((p) => p.type === 'self' && p.connection === 'online');
    write(socket, { op: 'logout' });
    await waitFor((p) => p.type === 'self' && p.connection === 'signed-out');
  });
});

describe('server errors', () => {
  test('control characters in an error message are removed', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.json({ error: 'nope\u001b[2J‮ gotcha' }, { status: 400 }),
    });
    cleanup.push(() => void server.stop(true));
    const error = await new Api(server.url.href.replace(/\/$/, ''))
      .call(null, 'GET', '/x')
      .catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe('nope[2J gotcha');
  });
});
