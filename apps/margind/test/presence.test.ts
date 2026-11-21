import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type PublicPresence, type Settings } from '@margin/protocol';
import {
  assertPublic,
  buildView,
  LeakError,
  localSecrets,
  publicModel,
  shareable,
  withoutLocalDetails,
} from '../src/presence';
import { originRepo, repoClassifier } from '../src/repo';
import { type LocalSession, Sessions } from '../src/sessions';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repoDir(config: string | null, gitFile = false) {
  const dir = mkdtempSync(join(tmpdir(), 'margind-repo-'));
  dirs.push(dir);
  if (gitFile) writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere');
  else if (config !== null) {
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'config'), config);
  }
  mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
  return join(dir, 'src', 'deep');
}

const origin = (url: string) =>
  `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*\n`;

const session = (overrides: Partial<LocalSession> = {}): LocalSession => ({
  tool: 'claude-code',
  sessionId: 'sess-7f3a9c',
  model: 'claude-opus-5-5',
  cwd: '/Users/me/clients/acme-secret',
  startedAt: 1_700_000_123_456,
  lastEventAt: 1_700_000_200_000,
  order: 1,
  ...overrides,
});

const settings = (overrides: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  ...overrides,
});

describe('repo', () => {
  test('reads the GitHub origin from any subfolder, over https or ssh', () => {
    expect(originRepo(repoDir(origin('https://github.com/maya-chen/tidepool-ui.git')))).toBe(
      'maya-chen/tidepool-ui',
    );
    expect(originRepo(repoDir(origin('git@github.com:samr/glyphs.git')))).toBe('samr/glyphs');
  });

  test('only github.com itself counts, not hosts that merely contain it', () => {
    for (const url of [
      'https://evilgithub.com/maya/app.git',
      'https://github.com.example.org/maya/app.git',
      'https://example.org/github.com/maya/app.git',
      'git@gitlab.com:github.com/maya.git',
    ]) {
      expect(originRepo(repoDir(origin(url)))).toBeNull();
    }
    expect(originRepo(repoDir(origin('ssh://git@github.com/maya/app.git')))).toBe('maya/app');
    expect(originRepo(repoDir(origin('https://token@github.com/maya/app')))).toBe('maya/app');
  });

  test('anything unusual is no repo at all', () => {
    expect(originRepo(repoDir(origin('https://gitlab.com/a/b.git')))).toBeNull();
    expect(originRepo(repoDir(null, true))).toBeNull();
    expect(originRepo(repoDir(origin('https://github.com/a/b;rm -rf ~.git')))).toBeNull();
    expect(originRepo('/')).toBeNull();
  });

  test('only a repo GitHub confirms as public is public, and failures are not cached', async () => {
    let calls = 0;
    const responses: Record<string, unknown> = {
      'maya/open': { private: false, full_name: 'maya/open' },
      'maya/closed': { private: true, full_name: 'maya/closed' },
      'maya/weird': { private: false, full_name: '../../etc' },
    };
    const classify = repoClassifier(async (repo) => {
      calls++;
      if (repo === 'maya/down') throw new Error('offline');
      return (responses[repo] as never) ?? null;
    });
    expect(await classify('maya/open')).toEqual({ visibility: 'public', repo: 'maya/open' });
    expect(await classify('maya/closed')).toEqual({ visibility: 'private' });
    expect(await classify('maya/weird')).toEqual({ visibility: 'private' });
    expect(await classify('maya/gone')).toEqual({ visibility: 'private' });
    expect(await classify(null)).toEqual({ visibility: 'private' });
    await classify('maya/down');
    await classify('maya/down');
    const before = calls;
    await classify('maya/open');
    expect(calls).toBe(before);
  });
});

describe('sessions', () => {
  test('ends on an end event, when Claude Code exits, or after going quiet', () => {
    const living = new Set([100]);
    const sessions = new Sessions((pid) => living.has(pid));
    sessions.onEvent({ tool: 'claude-code', event: 'start', sessionId: 'a', pid: 100 }, 0);
    sessions.onEvent({ tool: 'codex', event: 'prompt', sessionId: 'b' }, 0);
    sessions.onEvent({ tool: 'shell', event: 'prompt', sessionId: 'c' }, 0);
    sessions.onEvent({ tool: 'opencode', event: 'start', sessionId: 'd' }, 0);
    sessions.onEvent({ tool: 'opencode', event: 'end', sessionId: 'd' }, 0);
    expect(sessions.list().length).toBe(3);

    expect(sessions.expire(11 * 60_000)).toBe(true);
    expect(sessions.list().map((s) => s.tool)).toEqual(['claude-code', 'codex']);
    expect(sessions.expire(16 * 60_000)).toBe(true);
    expect(sessions.list().map((s) => s.tool)).toEqual(['claude-code']);
    living.clear();
    sessions.expire(16 * 60_000);
    expect(sessions.list()).toEqual([]);
  });

  test('the session that reported last wins, even in the same millisecond', () => {
    const sessions = new Sessions(() => true);
    sessions.onEvent({ tool: 'claude-code', event: 'start', sessionId: 'a' }, 1000);
    sessions.onEvent({ tool: 'codex', event: 'prompt', sessionId: 'b' }, 1000);
    expect(sessions.current()?.tool).toBe('codex');
    sessions.onEvent({ tool: 'claude-code', event: 'prompt', sessionId: 'a' }, 1000);
    expect(sessions.current()?.tool).toBe('claude-code');
  });

  test('keeps the model and start time across events, and an AI tool beats the shell', () => {
    const sessions = new Sessions(() => true);
    sessions.onEvent(
      { tool: 'claude-code', event: 'start', sessionId: 'a', model: 'claude-opus-5-5' },
      1000,
    );
    sessions.onEvent({ tool: 'claude-code', event: 'prompt', sessionId: 'a' }, 2000);
    sessions.onEvent({ tool: 'shell', event: 'prompt', sessionId: 'z' }, 3000);
    expect(sessions.current()).toMatchObject({
      tool: 'claude-code',
      model: 'claude-opus-5-5',
      startedAt: 1000,
    });
  });
});

describe('what friends see', () => {
  const publicRepo = { visibility: 'public' as const, repo: 'maya/open' };

  test('a public repo is named; a private one never is', () => {
    expect(shareable(session(), publicRepo, 'maya/open', settings())?.project).toEqual({
      visibility: 'public',
      repo: 'maya/open',
    });
    expect(
      shareable(session(), { visibility: 'private' }, 'acme/secret', settings())?.project,
    ).toEqual({
      visibility: 'private',
    });
  });

  test('each sharing switch removes its field', () => {
    const off = (key: keyof Settings['share']) =>
      shareable(
        session(),
        publicRepo,
        'maya/open',
        settings({ share: { ...DEFAULT_SETTINGS.share, [key]: false } }),
      );
    expect(off('tool')?.tool).toBeUndefined();
    expect(off('model')?.model).toBeUndefined();
    expect(off('repo')?.project).toBeUndefined();
    expect(off('time')?.since).toBeUndefined();
  });

  test('repo overrides hide a repo entirely or keep it private, ignoring case', () => {
    expect(
      shareable(session(), publicRepo, 'Maya/Open', settings({ repos: { 'maya/open': 'hidden' } })),
    ).toBeUndefined();
    expect(
      shareable(session(), publicRepo, 'maya/open', settings({ repos: { 'Maya/Open': 'private' } }))
        ?.project,
    ).toEqual({ visibility: 'private' });
  });

  test('a renamed repo honours an override under either name; hidden wins', () => {
    const renamed = { visibility: 'public' as const, repo: 'maya/new-name' };
    expect(
      shareable(
        session(),
        renamed,
        'maya/old-name',
        settings({ repos: { 'maya/new-name': 'hidden' } }),
      ),
    ).toBeUndefined();
    expect(
      shareable(
        session(),
        renamed,
        'maya/old-name',
        settings({ repos: { 'maya/old-name': 'private' } }),
      )?.project,
    ).toEqual({ visibility: 'private' });
    expect(
      shareable(
        session(),
        renamed,
        'maya/old-name',
        settings({ repos: { 'maya/old-name': 'private', 'maya/new-name': 'hidden' } }),
      ),
    ).toBeUndefined();
  });

  test('the session start is rounded down to the minute', () => {
    expect(shareable(session(), publicRepo, null, settings())?.since).toBe(1_700_000_100_000);
  });

  test('model names lose suffixes, or are dropped if odd', () => {
    expect(publicModel('claude-opus-5-5[1m]')).toBe('claude-opus-5-5');
    expect(publicModel('anthropic/claude-sonnet-5-5')).toBe('anthropic/claude-sonnet-5-5');
    expect(publicModel('my model (local)')).toBeUndefined();
    expect(publicModel('acme-proxy/internal-finetune')).toBe('internal-finetune');
    expect(publicModel('ollama-at-work/llama4')).toBe('llama4');
    expect(publicModel(undefined)).toBeUndefined();
  });

  test('close friends get the full view, everyone else just status and tokens', () => {
    const activity = shareable(session(), publicRepo, null, settings());
    const view = buildView({
      status: 'online',
      activity,
      tokens: 42,
      settings: settings({ audience: 'close', closeFriends: ['leo'] }),
      now: 5,
    });
    expect(view.close).toEqual(['leo']);
    expect(view.full.activity).toEqual(activity);
    expect(view.basic).toEqual({ status: 'online', tokens: 42, at: 5 });
  });

  test('invisible is indistinguishable from offline, and tokens can be hidden', () => {
    const invisible = buildView({
      status: 'online',
      tokens: 42,
      settings: settings({ invisible: true }),
      now: 5,
    });
    expect(invisible).toEqual({
      full: { status: 'offline', at: 5 },
      basic: { status: 'offline', at: 5 },
      close: [],
    });
    const hidden = buildView({
      status: 'idle',
      tokens: 42,
      settings: settings({ share: { ...DEFAULT_SETTINGS.share, tokens: false } }),
      now: 5,
    });
    expect(hidden.full).toEqual({ status: 'idle', at: 5 });
  });

  test('nothing from a private project leaves the machine', () => {
    const s = session();
    const activity = shareable(s, { visibility: 'private' }, 'acme/secret-thing', settings());
    const view = buildView({ status: 'online', activity, tokens: 1, settings: settings() });
    const sent = JSON.stringify(view).toLowerCase();
    for (const secret of ['acme', 'secret', 'clients', '/users', 'sess-7f3a9c'])
      expect(sent).not.toContain(secret);
    expect(() => assertPublic(view.full, localSecrets([s]))).not.toThrow();
  });

  test('every folder name in a project path counts as local, and only the model is dropped for it', () => {
    const secrets = localSecrets([session({ cwd: '/Users/me/clients/acme-secret/web' })]);
    expect(secrets).toEqual(expect.arrayContaining(['clients', 'acme-secret', 'web', 'Users']));
    const presence: PublicPresence = {
      status: 'online',
      at: 1,
      activity: { tool: 'opencode', model: 'acme-secret-v2', project: { visibility: 'private' } },
    };
    expect(withoutLocalDetails(presence, secrets)).toEqual({
      status: 'online',
      at: 1,
      activity: { tool: 'opencode', project: { visibility: 'private' } },
    });
    const clean: PublicPresence = {
      status: 'online',
      at: 1,
      activity: { model: 'claude-opus-5-5' },
    };
    expect(withoutLocalDetails(clean, secrets)).toBe(clean);
  });

  test('the final check refuses extra fields and local details in the model', () => {
    const extra = { status: 'online', at: 1, cwd: '/Users/me' } as unknown as PublicPresence;
    expect(() => assertPublic(extra, [])).toThrow(LeakError);
    const leaky: PublicPresence = {
      status: 'online',
      at: 1,
      activity: { model: 'acme-secret-finetune' },
    };
    expect(() => assertPublic(leaky, localSecrets([session()]))).toThrow(LeakError);
  });
});
