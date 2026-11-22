import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Api, startApi } from './harness';

let api: Api;
beforeEach(async () => {
  api = await startApi();
});
afterEach(() => api.stop());

const handles = (reply: { body: { people: { handle: string }[] } }) =>
  reply.body.people.map((p) => p.handle);

describe('find friends', () => {
  test('lists people who can be found, never you or your friends, and marks who you asked', async () => {
    const maya = await api.user('maya', 'Maya Chen');
    const leo = await api.user('leo', 'Leo Park');
    const nina = await api.user('nina');
    await api.befriend(maya, leo);
    expect(handles(await maya.call('/directory'))).toEqual(['nina']);
    await maya.call('/friends/requests', { body: { handle: 'nina' } });
    expect((await maya.call('/directory')).body.people).toEqual([
      { handle: 'nina', requested: true },
    ]);
    expect(handles(await nina.call('/directory'))).toEqual(['leo', 'maya']);
    expect((await nina.call('/directory')).body.people[1]).toEqual({
      handle: 'maya',
      name: 'Maya Chen',
      requested: false,
    });
  });

  test('switching off findable hides you from everyone, and back on shows you again', async () => {
    const maya = await api.user('maya');
    const leo = await api.user('leo');
    expect(
      (await leo.call('/me/findable', { method: 'PUT', body: { findable: false } })).status,
    ).toBe(200);
    expect(handles(await maya.call('/directory'))).toEqual([]);
    await leo.call('/me/findable', { method: 'PUT', body: { findable: true } });
    expect(handles(await maya.call('/directory'))).toEqual(['leo']);
  });

  test('a block hides both people from each other, and shows in the blocker’s list until undone', async () => {
    const maya = await api.user('maya');
    const leo = await api.user('leo');
    await api.user('nina');
    await maya.call('/blocks/leo', { method: 'POST', body: {} });
    expect(handles(await maya.call('/directory'))).toEqual(['nina']);
    expect(handles(await leo.call('/directory'))).toEqual(['nina']);
    expect((await maya.call('/blocks')).body).toEqual({ blocked: ['leo'] });
    await maya.call('/blocks/leo', { method: 'DELETE' });
    expect((await maya.call('/blocks')).body).toEqual({ blocked: [] });
    expect(handles(await leo.call('/directory'))).toEqual(['maya', 'nina']);
  });

  test('searches handles and names, ignoring case and stray characters', async () => {
    const maya = await api.user('maya');
    await api.user('leo-park', 'Leo Park');
    await api.user('nina');
    expect(handles(await maya.call('/directory?q=PARK'))).toEqual(['leo-park']);
    expect(handles(await maya.call('/directory?q=ni%25na'))).toEqual(['nina']);
  });

  test('needs a session, and a bad findable body is refused', async () => {
    const maya = await api.user('maya');
    expect((await api.call('/directory')).status).toBe(401);
    expect(
      (await maya.call('/me/findable', { method: 'PUT', body: { findable: 'yes' } })).status,
    ).toBe(400);
  });
});
