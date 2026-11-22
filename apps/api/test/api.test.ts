import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PROTOCOL, type ServerFrame } from '@margin/protocol';
import { migrate, openDb } from '../src/db';
import { type Api, bundle, ciphertext, startApi, uuid } from './harness';

let api: Api;
beforeEach(async () => {
  api = await startApi();
});
afterEach(async () => {
  await api.stop();
});

type Frame<T extends ServerFrame['t']> = Extract<ServerFrame, { t: T }>;
const presenceFrom =
  (handle: string) =>
  (f: ServerFrame): f is Frame<'presence'> =>
    f.t === 'presence' && f.from === handle;
const messageFrom =
  (handle: string) =>
  (f: ServerFrame): f is Frame<'message'> =>
    f.t === 'message' && f.from === handle;

describe('versions and auth', () => {
  test('reports its protocol and refuses clients on another one', async () => {
    expect((await api.call('/config')).body).toEqual({ protocol: PROTOCOL, githubClientId: null });
    const old = await api.call('/config', {
      headers: { 'x-margin-protocol': String(PROTOCOL + 1) },
    });
    expect(old.status).toBe(426);
    expect(old.body.error).toBe('Margin needs an update');
  });

  test('everything but config and sign-in needs a session', async () => {
    expect((await api.call('/friends')).status).toBe(401);
    expect((await api.call('/friends', { token: 'nope' })).status).toBe(401);
  });

  test('dev sign-in is off unless enabled', async () => {
    const prod = await startApi({ devAuth: false });
    expect((await prod.call('/auth/dev', { body: { handle: 'maya' } })).status).toBe(404);
    await prod.stop();
  });

  test('GitHub sign-in keeps one account per GitHub id and cleans the display name', async () => {
    const users: Record<string, { id: number; login: string; name: string | null }> = {
      good: { id: 7, login: 'Maya-Chen', name: '  Maya‮ Chen\u0007 ' },
      renamed: { id: 7, login: 'maya-chen', name: 'Maya C.' },
      squatter: { id: 8, login: 'maya-chen', name: null },
    };
    const gh = await startApi({ fetchGithubUser: async (token) => users[token] ?? null });

    const first = await gh.call('/auth/github', { body: { accessToken: 'good' } });
    expect(first.body).toMatchObject({ handle: 'maya-chen', name: 'Maya Chen' });
    const again = await gh.call('/auth/github', { body: { accessToken: 'renamed' } });
    expect((await gh.call('/me', { token: again.body.token })).body.handle).toBe('maya-chen');

    expect((await gh.call('/auth/github', { body: { accessToken: 'squatter' } })).status).toBe(409);
    expect((await gh.call('/auth/github', { body: { accessToken: 'unknown' } })).status).toBe(401);
    expect((await gh.call('/auth/github', { body: {} })).status).toBe(400);
    await gh.stop();
  });

  test('signing out ends that session and closes its socket', async () => {
    const maya = await api.user('maya');
    const socket = await maya.connect();
    expect((await maya.call('/auth/logout', { method: 'POST' })).status).toBe(200);
    expect((await socket.closed()).code).toBe(4001);
    expect((await maya.call('/me')).status).toBe(401);
  });
});

describe('friends', () => {
  test('request, accept, list with names, remove', async () => {
    const maya = await api.user('maya', 'Maya Chen');
    const leo = await api.user('leo');
    const leoSocket = await leo.connect();

    expect((await maya.call('/friends/requests', { body: { handle: 'leo' } })).body.status).toBe(
      'requested',
    );
    await leoSocket.next((f) => f.t === 'friends-changed');
    expect((await leo.call('/friends/requests')).body).toEqual({
      incoming: ['maya'],
      outgoing: [],
    });
    expect((await maya.call('/friends/requests')).body).toEqual({
      incoming: [],
      outgoing: ['leo'],
    });

    expect((await leo.call('/friends/requests/maya/accept', { method: 'POST' })).body.status).toBe(
      'friends',
    );
    expect((await leo.call('/friends')).body).toEqual({
      friends: [{ handle: 'maya', name: 'Maya Chen' }],
    });
    expect((await maya.call('/friends')).body).toEqual({ friends: [{ handle: 'leo' }] });

    await maya.call('/friends/leo', { method: 'DELETE' });
    expect((await leo.call('/friends')).body.friends).toEqual([]);
  });

  test('a mutual request makes friends at once', async () => {
    const maya = await api.user('maya');
    const leo = await api.user('leo');
    await maya.call('/friends/requests', { body: { handle: 'leo' } });
    expect((await leo.call('/friends/requests', { body: { handle: 'maya' } })).body.status).toBe(
      'friends',
    );
    expect((await maya.call('/friends/requests')).body).toEqual({ incoming: [], outgoing: [] });
  });

  test('requests sent at the same moment make friends, not two crossed requests', async () => {
    const maya = await api.user('maya');
    const leo = await api.user('leo');
    await Promise.all([
      maya.call('/friends/requests', { body: { handle: 'leo' } }),
      leo.call('/friends/requests', { body: { handle: 'maya' } }),
    ]);
    expect(
      (await maya.call('/friends')).body.friends.map((f: { handle: string }) => f.handle),
    ).toEqual(['leo']);
    expect((await maya.call('/friends/requests')).body).toEqual({ incoming: [], outgoing: [] });
    expect((await leo.call('/friends/requests')).body).toEqual({ incoming: [], outgoing: [] });
  });

  test('crossed requests left by the old race are made into friendships', async () => {
    const sql = openDb();
    await migrate(sql);
    const now = Date.now();
    await sql`INSERT INTO friend_requests ${sql([
      { from_id: 'a', to_id: 'b', created_at: now },
      { from_id: 'b', to_id: 'a', created_at: now },
      { from_id: 'a', to_id: 'c', created_at: now },
    ])}`;
    const [{ last }] = await sql`SELECT MAX(version) AS last FROM schema_migrations`;
    await sql`DELETE FROM schema_migrations WHERE version = ${last}`;
    await migrate(sql);
    const friendships: unknown = await sql`SELECT a_id, b_id FROM friendships ORDER BY a_id`;
    expect(friendships).toEqual([
      { a_id: 'a', b_id: 'b' },
      { a_id: 'b', b_id: 'a' },
    ]);
    const left: unknown = await sql`SELECT from_id, to_id FROM friend_requests`;
    expect(left).toEqual([{ from_id: 'a', to_id: 'c' }]);
    await sql.close();
  });

  test('declining clears the request for both', async () => {
    const maya = await api.user('maya');
    const leo = await api.user('leo');
    await maya.call('/friends/requests', { body: { handle: 'leo' } });
    await leo.call('/friends/requests/maya', { method: 'DELETE' });
    expect((await maya.call('/friends/requests')).body.outgoing).toEqual([]);
    expect((await leo.call('/friends/requests/maya/accept', { method: 'POST' })).status).toBe(404);
  });

  test('a block looks exactly like an unknown handle', async () => {
    const maya = await api.user('maya');
    const troll = await api.user('troll');
    await api.befriend(maya, troll);
    await maya.call('/blocks/troll', { method: 'POST' });

    const blocked = await troll.call('/friends/requests', { body: { handle: 'maya' } });
    const unknown = await troll.call('/friends/requests', { body: { handle: 'nobody-here' } });
    expect(blocked).toEqual(unknown);
    expect((await troll.call('/friends')).body.friends).toEqual([]);
  });

  test('rejects malformed handles before touching the database', async () => {
    const maya = await api.user('maya');
    for (const handle of ['../admin', 'Maya', 'a b', '']) {
      expect((await maya.call('/friends/requests', { body: { handle } })).status).toBe(400);
    }
    expect((await maya.call('/friends/..%2Fadmin', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('keys', () => {
  test('only friends get a bundle, and each fetch uses up one prekey', async () => {
    const maya = await api.user('maya');
    const leo = await api.user('leo');
    const stranger = await api.user('stranger');
    expect((await maya.call('/keys', { method: 'PUT', body: bundle(3) })).body.remaining).toBe(3);

    expect((await stranger.call('/keys/maya')).status).toBe(404);
    await api.befriend(maya, leo);
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await leo.call('/keys/maya')).body.preKeys[0]?.keyId);
    expect(ids).toEqual([1, 2, 3, undefined]);
    expect((await maya.call('/keys/count')).body.remaining).toBe(0);
  });

  test('warns the owner when prekeys run low', async () => {
    const maya = await api.user('maya');
    const leo = await api.user('leo');
    await api.befriend(maya, leo);
    await maya.call('/keys', { method: 'PUT', body: bundle(20) });
    const socket = await maya.connect();
    await leo.call('/keys/maya');
    expect(await socket.next((f) => f.t === 'prekeys-low')).toEqual({
      t: 'prekeys-low',
      remaining: 19,
    });
  });

  test('top-ups are capped at 200', async () => {
    const maya = await api.user('maya');
    await maya.call('/keys', { method: 'PUT', body: bundle(150) });
    const more = bundle(100, 1000).preKeys;
    expect((await maya.call('/keys/prekeys', { body: { preKeys: more } })).body.remaining).toBe(
      200,
    );
    expect(
      (await maya.call('/keys/prekeys', { body: { preKeys: bundle(201).preKeys } })).status,
    ).toBe(400);
  });

  test('the identity key cannot be swapped', async () => {
    const maya = await api.user('maya');
    const first = bundle();
    await maya.call('/keys', { method: 'PUT', body: first });
    expect((await maya.call('/keys', { method: 'PUT', body: bundle() })).status).toBe(409);
    expect(
      (await maya.call('/keys', { method: 'PUT', body: bundle(5, 1, first.identityKey) })).status,
    ).toBe(200);
  });

  test('rejects malformed bundles', async () => {
    const maya = await api.user('maya');
    const bad = { ...bundle(), identityKey: 'not base64!' };
    expect((await maya.call('/keys', { method: 'PUT', body: bad })).status).toBe(400);
  });
});

describe('presence', () => {
  test('friends see it, strangers do not, and extra fields are dropped', async () => {
    const maya = await api.user('maya');
    const leo = await api.user('leo');
    const stranger = await api.user('stranger');
    await api.befriend(maya, leo);
    const [m, l, s] = [await maya.connect(), await leo.connect(), await stranger.connect()];

    m.send({
      t: 'presence',
      presence: {
        status: 'online',
        at: 1,
        tokens: 42,
        cwd: '/Users/maya/secret',
        activity: { tool: 'codex' },
      },
    });
    expect(await l.next(presenceFrom('maya'))).toEqual({
      t: 'presence',
      from: 'maya',
      presence: { status: 'online', at: 1, tokens: 42, activity: { tool: 'codex' } },
    });
    expect(await s.unexpected(presenceFrom('maya'))).toEqual([]);
  });

  test('a friend who connects later gets the current presence', async () => {
    const maya = await api.user('maya');
    const leo = await api.user('leo');
    await api.befriend(maya, leo);
    const m = await maya.connect();
    const sentinel = await leo.connect();
    m.send({ t: 'presence', presence: { status: 'idle', at: 5 } });
    await sentinel.next(presenceFrom('maya'));

    const later = await leo.connect();
    expect((await later.next(presenceFrom('maya'))).presence).toEqual({ status: 'idle', at: 5 });
  });

  test('close friends see activity, others only the basic view, even when sent back to back', async () => {
    const maya = await api.user('maya');
    const close = await api.user('close');
    const other = await api.user('other');
    await api.befriend(maya, close);
    await api.befriend(maya, other);
    const m = await maya.connect();
    const [c, o] = [await close.connect(), await other.connect()];

    const full = { status: 'online' as const, at: 2, activity: { tool: 'claude-code' as const } };
    m.send({ t: 'presence', presence: full, to: ['close'] });
    m.send({ t: 'presence', presence: { status: 'online', at: 2 } });

    expect((await c.next(presenceFrom('maya'))).presence).toEqual(full);
    expect((await o.next(presenceFrom('maya'))).presence).toEqual({ status: 'online', at: 2 });
    expect(await c.unexpected(presenceFrom('maya'))).toEqual([]);
  });

  test('an invisible friend is never seen connecting, staying or leaving', async () => {
    const maya = await api.user('maya');
    const leo = await api.user('leo');
    await api.befriend(maya, leo);
    const l = await leo.connect();
    const m = await maya.connect();

    // Invisible from the start, with the 30-second repeats: nothing reaches Leo.
    m.send({ t: 'presence', presence: { status: 'offline', at: 1 } });
    m.send({ t: 'presence', presence: { status: 'offline', at: 2 } });
    expect(await l.unexpected(presenceFrom('maya'))).toEqual([]);
    const later = await leo.connect();
    expect(await later.unexpected(presenceFrom('maya'))).toEqual([]);

    // Going online and then invisible is news once.
    m.send({ t: 'presence', presence: { status: 'online', at: 3 } });
    expect((await l.next(presenceFrom('maya'))).presence).toEqual({ status: 'online', at: 3 });
    m.send({ t: 'presence', presence: { status: 'offline', at: 4 } });
    expect((await l.next(presenceFrom('maya'))).presence).toEqual({ status: 'offline', at: 4 });
    m.send({ t: 'presence', presence: { status: 'offline', at: 5 } });
    m.ws.close();
    expect(await l.unexpected(presenceFrom('maya'))).toEqual([]);
  });

  test('an empty close-friends list ends their view, so they see invisible too', async () => {
    const maya = await api.user('maya');
    const close = await api.user('close');
    await api.befriend(maya, close);
    const m = await maya.connect();
    const c = await close.connect();

    const full = { status: 'online' as const, at: 2, activity: { tool: 'claude-code' as const } };
    m.send({ t: 'presence', presence: full, to: ['close'] });
    m.send({ t: 'presence', presence: { status: 'online', at: 2 } });
    expect((await c.next(presenceFrom('maya'))).presence).toEqual(full);

    m.send({ t: 'presence', presence: { status: 'offline', at: 3 }, to: [] });
    m.send({ t: 'presence', presence: { status: 'offline', at: 3 } });
    expect((await c.next(presenceFrom('maya'))).presence).toEqual({ status: 'offline', at: 3 });
    const later = await close.connect();
    expect(await later.unexpected(presenceFrom('maya'))).toEqual([]);
  });

  test('friends see offline when the last socket closes', async () => {
    const maya = await api.user('maya');
    const leo = await api.user('leo');
    await api.befriend(maya, leo);
    const l = await leo.connect();
    const m = await maya.connect();
    m.send({ t: 'presence', presence: { status: 'online', at: 1 } });
    await l.next(presenceFrom('maya'));
    m.ws.close();
    const frame = await l.next(presenceFrom('maya'));
    expect(frame.t === 'presence' && frame.presence.status).toBe('offline');
  });

  test('invalid frames get an error, not a crash', async () => {
    const maya = await api.user('maya');
    const m = await maya.connect();
    m.send({ t: 'presence', presence: { status: 'dancing', at: 1 } });
    expect(await m.next((f) => f.t === 'error')).toEqual({ t: 'error', error: 'invalid frame' });
    m.ws.send('not json');
    m.send({ t: 'presence', presence: { status: 'online', at: 1 } });
    expect(await m.unexpected((f) => f.t === 'error')).toEqual([]);
  });
});

describe('resend requests', () => {
  const resetFrom = (handle: string) => (f: ServerFrame) => f.t === 'reset' && f.from === handle;

  test('reach the sender at once, or when they next connect, and only between friends', async () => {
    const maya = await api.user('maya');
    const leo = await api.user('leo');
    const stranger = await api.user('stranger');
    await api.befriend(maya, leo);
    const [m, l, s] = [await maya.connect(), await leo.connect(), await stranger.connect()];
    const [live, later] = [uuid(), uuid()];

    l.send({ t: 'reset', to: 'maya', id: live });
    expect(await m.next(resetFrom('leo'))).toEqual({ t: 'reset', from: 'leo', id: live });

    m.ws.close();
    await m.closed();
    l.send({ t: 'reset', to: 'maya', id: later });
    s.send({ t: 'reset', to: 'maya', id: uuid() });
    await Bun.sleep(50);
    const back = await maya.connect();
    expect(await back.next(resetFrom('leo'))).toEqual({ t: 'reset', from: 'leo', id: later });
    expect(await back.unexpected((f) => f.t === 'reset')).toEqual([]);
    // Delivered once.
    const again = await maya.connect();
    expect(await again.unexpected((f) => f.t === 'reset')).toEqual([]);
  });
});

describe('messages', () => {
  test('delivered live, with the sender set by the server', async () => {
    const maya = await api.user('maya');
    const leo = await api.user('leo');
    await api.befriend(maya, leo);
    const [m, l] = [await maya.connect(), await leo.connect()];
    const id = uuid();

    m.send({ t: 'send', id, to: 'leo', ciphertext, from: 'someone-else' });
    expect(await m.next((f) => f.t === 'accepted')).toEqual({ t: 'accepted', id });
    const delivered = await l.next(messageFrom('maya'));
    expect(delivered).toMatchObject({ t: 'message', id, from: 'maya', ciphertext });
  });

  test('queued while offline, delivered on connect, kept until acked', async () => {
    const maya = await api.user('maya');
    const leo = await api.user('leo');
    await api.befriend(maya, leo);
    const m = await maya.connect();
    const id = uuid();
    m.send({ t: 'send', id, to: 'leo', ciphertext });
    await m.next((f) => f.t === 'accepted');

    const first = await leo.connect();
    expect((await first.next(messageFrom('maya'))).t === 'message').toBe(true);
    first.ws.close();
    await first.closed();

    // Not acked: delivered again.
    const second = await leo.connect();
    await second.next(messageFrom('maya'));
    second.send({ t: 'ack', id });
    await Bun.sleep(50);
    second.ws.close();
    await second.closed();

    const third = await leo.connect();
    expect(await third.unexpected(messageFrom('maya'))).toEqual([]);
  });

  test('a control is delivered as its own frame, live and from the queue', async () => {
    const maya = await api.user('maya');
    const leo = await api.user('leo');
    await api.befriend(maya, leo);
    const m = await maya.connect();
    const queued = uuid();
    m.send({ t: 'send', id: queued, to: 'leo', ciphertext, control: true });
    await m.next((f) => f.t === 'accepted');
    const l = await leo.connect();
    expect(await l.next((f) => f.t === 'control')).toMatchObject({ id: queued, from: 'maya' });
    const live = uuid();
    m.send({ t: 'send', id: live, to: 'leo', ciphertext, control: true });
    expect(await l.next((f) => f.t === 'control' && f.id === live)).toMatchObject({ from: 'maya' });
    expect(await l.unexpected(messageFrom('maya'))).toEqual([]);
  });

  test('a retry of the same id is accepted once; someone else reusing it is rejected', async () => {
    const maya = await api.user('maya');
    const leo = await api.user('leo');
    const sam = await api.user('sam');
    await api.befriend(maya, leo);
    await api.befriend(sam, leo);
    const [m, s] = [await maya.connect(), await sam.connect()];
    const id = uuid();

    m.send({ t: 'send', id, to: 'leo', ciphertext });
    m.send({ t: 'send', id, to: 'leo', ciphertext });
    await m.next((f) => f.t === 'accepted');
    await m.next((f) => f.t === 'accepted');
    s.send({ t: 'send', id, to: 'leo', ciphertext });
    expect(await s.next((f) => f.t === 'rejected')).toEqual({
      t: 'rejected',
      id,
      error: 'duplicate id',
    });

    const l = await leo.connect();
    await l.next(messageFrom('maya'));
    expect(await l.unexpected((f) => f.t === 'message')).toEqual([]);
  });

  test('only friends can be messaged, and acks only touch your own queue', async () => {
    const maya = await api.user('maya');
    const leo = await api.user('leo');
    const stranger = await api.user('stranger');
    await api.befriend(maya, leo);
    const s = await stranger.connect();
    const strangerId = uuid();
    s.send({ t: 'send', id: strangerId, to: 'leo', ciphertext });
    expect(await s.next((f) => f.t === 'rejected')).toMatchObject({ error: 'not a friend' });

    const m = await maya.connect();
    const id = uuid();
    m.send({ t: 'send', id, to: 'leo', ciphertext });
    await m.next((f) => f.t === 'accepted');
    s.send({ t: 'ack', id });
    await Bun.sleep(50);
    const l = await leo.connect();
    expect((await l.next(messageFrom('maya'))).t).toBe('message');
  });

  test('blocking drops what the blocked person queued', async () => {
    const maya = await api.user('maya');
    const troll = await api.user('troll');
    await api.befriend(maya, troll);
    const t = await troll.connect();
    t.send({ t: 'send', id: uuid(), to: 'maya', ciphertext });
    await t.next((f) => f.t === 'accepted');
    await maya.call('/blocks/troll', { method: 'POST' });
    const m = await maya.connect();
    expect(await m.unexpected(messageFrom('troll'))).toEqual([]);
  });

  test('undelivered ciphertext expires', async () => {
    const short = await startApi({ retentionMs: 50 });
    const maya = await short.user('maya');
    const leo = await short.user('leo');
    await short.befriend(maya, leo);
    const m = await maya.connect();
    m.send({ t: 'send', id: uuid(), to: 'leo', ciphertext });
    await m.next((f) => f.t === 'accepted');
    await Bun.sleep(100);
    const l = await leo.connect();
    expect(await l.unexpected(messageFrom('maya'))).toEqual([]);
    await short.stop();
  });
});

describe('account', () => {
  test('export lists what the server holds, without message contents or private keys', async () => {
    const maya = await api.user('maya', 'Maya Chen');
    const leo = await api.user('leo');
    await api.befriend(maya, leo);
    await maya.call('/keys', { method: 'PUT', body: bundle(3) });
    await maya.call('/reports', { body: { handle: 'leo', reason: 'spam' } });

    const { body } = await maya.call('/me/export');
    expect(body).toMatchObject({
      account: { handle: 'maya', name: 'Maya Chen', githubId: null },
      friends: ['leo'],
      requests: { incoming: [], outgoing: [] },
      blocked: [],
      reports: [{ handle: 'leo', reason: 'spam' }],
      keys: { oneTimePrekeys: 3 },
      sessions: 1,
      queuedMessages: 0,
    });
  });

  test('deleting removes everything and frees the handle', async () => {
    const maya = await api.user('maya');
    const leo = await api.user('leo');
    await api.befriend(maya, leo);
    await maya.call('/keys', { method: 'PUT', body: bundle(3) });
    const l = await leo.connect();
    const m = await maya.connect();
    m.send({ t: 'send', id: uuid(), to: 'leo', ciphertext });
    await m.next((f) => f.t === 'accepted');
    await l.next(messageFrom('maya'));

    expect((await maya.call('/me', { method: 'DELETE' })).status).toBe(200);
    expect((await m.closed()).code).toBe(4002);
    await l.next((f) => f.t === 'friends-changed');
    expect((await leo.call('/friends')).body.friends).toEqual([]);
    expect((await maya.call('/me')).status).toBe(401);

    for (const table of [
      'accounts',
      'sessions',
      'key_bundles',
      'one_time_prekeys',
      'friendships',
      'queued_messages',
    ]) {
      const [row] = await api.sql.unsafe(`SELECT COUNT(*) AS n FROM ${table}`);
      expect([table, Number(row.n)]).toEqual([
        table,
        table === 'accounts' || table === 'sessions' ? 1 : 0,
      ]);
    }
    expect((await api.user('maya')).handle).toBe('maya');
  });
});
