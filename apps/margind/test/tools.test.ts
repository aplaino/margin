import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { toEvent } from '../src/reporters/hook';
import {
  connectTool,
  disconnectTool,
  hookCommand,
  MARKER,
  repointTools,
  type ToolEnv,
  ToolError,
  toolStatus,
} from '../src/tools';

let env: ToolEnv;
let root: string;

beforeEach(() => {
  // The real path: macOS's temp folder is behind a symlink, which an install must not be.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'margind-tools-')));
  const home = join(root, 'home');
  env = {
    home,
    dataHome: join(root, "Application Support/Mar'gin"),
    socket: join(root, 'margind.sock'),
    self: ['/usr/bin/env', 'margind'],
  };
  mkdirSync(env.dataHome, { recursive: true });
  for (const dir of ['.claude', '.codex', '.config/opencode'])
    mkdirSync(join(home, dir), { recursive: true });
  writeFileSync(join(home, '.zshrc'), 'export PATH=$HOME/bin:$PATH\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const claudeSettings = () => join(env.home, '.claude', 'settings.json');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const backups = (dir: string) => readdirSync(dir).filter((f) => f.includes('.margin-backup-'));

describe('connecting tools', () => {
  test('reports which tools are installed and connected', () => {
    rmSync(join(env.home, '.codex'), { recursive: true });
    expect(toolStatus(env)).toEqual([
      { tool: 'claude-code', found: true, connected: false },
      { tool: 'codex', found: false, connected: false },
      { tool: 'opencode', found: true, connected: false },
      { tool: 'shell', found: true, connected: false },
    ]);
    expect(() => connectTool(env, 'codex')).toThrow('isn’t installed');
  });

  test('Claude Code: adds hooks beside the user’s own, once, and removes only Margin’s', () => {
    const theirs = { hooks: [{ type: 'command', command: '/usr/local/bin/vibe-island stop' }] };
    writeFileSync(claudeSettings(), JSON.stringify({ model: 'opus', hooks: { Stop: [theirs] } }));

    connectTool(env, 'claude-code');
    connectTool(env, 'claude-code');
    const settings = read(claudeSettings());
    expect(settings.model).toBe('opus');
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.Stop[0]).toEqual(theirs);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(toolStatus(env)[0]?.connected).toBe(true);
    expect(backups(join(env.home, '.claude')).length).toBeGreaterThan(0);

    disconnectTool(env, 'claude-code');
    expect(read(claudeSettings())).toEqual({ model: 'opus', hooks: { Stop: [theirs] } });
  });

  test('a config that cannot be parsed is left untouched', () => {
    writeFileSync(claudeSettings(), '{ "model": "opus", // a comment\n}');
    expect(() => connectTool(env, 'claude-code')).toThrow();
    expect(readFileSync(claudeSettings(), 'utf8')).toBe('{ "model": "opus", // a comment\n}');
  });

  test('Codex: hooks plus a note about approving them', () => {
    expect(connectTool(env, 'codex')).toContain('/hooks');
    const hooks = read(join(env.home, '.codex', 'hooks.json')).hooks;
    expect(Object.keys(hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop']);
    disconnectTool(env, 'codex');
    expect(read(join(env.home, '.codex', 'hooks.json'))).toEqual({});
  });

  test('OpenCode: a plugin file that loads, and goes away again', async () => {
    connectTool(env, 'opencode');
    const path = join(env.home, '.config', 'opencode', 'plugins', 'margin.js');
    const plugin = await import(path);
    expect(plugin.default.id).toBe('margin');
    expect(readFileSync(path, 'utf8')).toContain(JSON.stringify(env.socket));
    disconnectTool(env, 'opencode');
    expect(toolStatus(env)[2]?.connected).toBe(false);
  });

  test('zsh: one sourced line and a script zsh accepts', () => {
    connectTool(env, 'shell');
    connectTool(env, 'shell');
    const rc = readFileSync(join(env.home, '.zshrc'), 'utf8');
    expect(rc.split('\n').filter((l) => l.includes(MARKER))).toHaveLength(1);
    const check = Bun.spawnSync(['zsh', '-n', join(env.dataHome, 'init.zsh')]);
    expect(check.exitCode).toBe(0);
    disconnectTool(env, 'shell');
    expect(readFileSync(join(env.home, '.zshrc'), 'utf8')).toBe('export PATH=$HOME/bin:$PATH\n');
  });

  test('the hook command survives spaces and quotes in paths', () => {
    const command = hookCommand(
      { ...env, self: ['/usr/bin/printenv', 'MARGIN_HOME'] },
      'claude-code',
    );
    const run = Bun.spawnSync(['sh', '-c', command.replace(/ hook claude-code$/, '')]);
    expect(run.stdout.toString().trim()).toBe(env.dataHome);
  });
});

describe('when Margin moves', () => {
  // A fake Margin.app in the test home's Applications folder.
  function app(name: string, mode = 0o755) {
    const macos = join(env.home, 'Applications', `${name}.app`, 'Contents', 'MacOS');
    mkdirSync(macos, { recursive: true });
    writeFileSync(join(macos, 'margind'), '');
    for (const path of [
      join(env.home, 'Applications', `${name}.app`),
      macos,
      join(macos, 'margind'),
    ]) {
      chmodSync(path, mode);
    }
    return { ...env, self: [join(macos, 'margind')] };
  }

  test('a temporary copy, a disk image or a writable bundle can’t connect tools', () => {
    for (const self of [
      '/private/var/folders/x/T/AppTranslocation/ABC/d/Margin.app/Contents/MacOS/margind',
      '/Volumes/Margin/Margin.app/Contents/MacOS/margind',
      '/tmp/Margin.app/Contents/MacOS/margind',
    ]) {
      expect(() => connectTool({ ...env, self: [self] }, 'claude-code')).toThrow(ToolError);
    }
    expect(() => connectTool(app('Shared', 0o777), 'claude-code')).toThrow(ToolError);
    // A writable Contents folder, or a symlink on the way, is enough to refuse.
    const contents = app('Loose');
    chmodSync(dirname(dirname(contents.self[0] ?? '')), 0o777);
    expect(() => connectTool(contents, 'claude-code')).toThrow(ToolError);
    const real = app('Real');
    symlinkSync(
      join(env.home, 'Applications', 'Real.app'),
      join(env.home, 'Applications', 'Link.app'),
    );
    const linked = {
      ...real,
      self: [join(env.home, 'Applications', 'Link.app', 'Contents', 'MacOS', 'margind')],
    };
    expect(() => connectTool(linked, 'claude-code')).toThrow(ToolError);
  });

  test('hooks left pointing at an old install are re-pointed, and others’ hooks stay', () => {
    const theirs = { hooks: [{ type: 'command', command: '/usr/local/bin/other stop' }] };
    writeFileSync(claudeSettings(), JSON.stringify({ hooks: { Stop: [theirs] } }));
    const old = app('Old');
    connectTool(old, 'claude-code');
    connectTool(old, 'codex');
    const moved = app('Margin');

    expect(repointTools(moved)).toEqual(['claude-code', 'codex']);
    const stop = read(claudeSettings()).hooks.Stop;
    expect(stop).toHaveLength(2);
    expect(stop[0]).toEqual(theirs);
    expect(stop[1].hooks[0].command).toContain('Margin.app');
    expect(repointTools(moved)).toEqual([]);
  });

  test('a copy that isn’t installed, or another setup’s hooks, are never re-pointed', () => {
    connectTool(app('Old'), 'claude-code');
    expect(
      repointTools({ ...env, self: ['/Volumes/Margin/Margin.app/Contents/MacOS/margind'] }),
    ).toEqual([]);
    expect(repointTools({ ...app('Margin'), dataHome: join(root, 'someone-else') })).toEqual([]);
  });

  test('tools that were never connected are left alone', () => {
    expect(repointTools(app('Margin'))).toEqual([]);
  });
});

describe('hook reporter', () => {
  test('keeps only whitelisted fields', () => {
    const event = toEvent('claude-code', {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'abc-123',
      prompt: 'my secret prompt',
      cwd: '/Users/me/app',
      transcript_path: '/Users/me/.claude/x.jsonl',
    });
    expect(event).toEqual({
      tool: 'claude-code',
      event: 'prompt',
      sessionId: 'abc-123',
      cwd: '/Users/me/app',
    });
  });

  test('a model switch reports the new model', () => {
    const event = toEvent('claude-code', {
      hook_event_name: 'PostModelSwitch',
      session_id: 's',
      from_model: 'a',
      to_model: 'claude-fable-5-1',
    });
    expect(event?.model).toBe('claude-fable-5-1');
  });

  test('an odd optional field is dropped, not the event; unknown events are ignored', () => {
    expect(
      toEvent('codex', { hook_event_name: 'Stop', session_id: 's', cwd: '/tmp/\u001b[2Jevil' }),
    ).toEqual({ tool: 'codex', event: 'stop', sessionId: 's' });
    expect(toEvent('codex', { hook_event_name: 'PreToolUse', session_id: 's' })).toBeNull();
    expect(toEvent('codex', { hook_event_name: 'Stop', session_id: '../../x' })).toBeNull();
  });
});
