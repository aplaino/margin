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
  for (const dir of [
    '.claude',
    '.codex',
    '.config/opencode',
    '.gemini',
    '.qwen',
    '.factory',
    '.codebuddy',
    '.qoder',
    '.kimi-code',
    '.cursor',
    '.ollama',
    '.lmstudio',
  ])
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
    const status = toolStatus(env);
    expect(status.map((t) => t.tool)).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'gemini-cli',
      'qwen-code',
      'factory',
      'codebuddy',
      'qoder',
      'kimi-code',
      'cursor',
      'ollama',
      'lm-studio',
      'shell',
    ]);
    expect(status.filter((t) => !t.found).map((t) => t.tool)).toEqual(['codex']);
    // Watching a local model server needs nothing installed, so it starts on.
    expect(status.filter((t) => t.connected).map((t) => t.tool)).toEqual(['ollama', 'lm-studio']);
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

  test('Qwen Code, CodeBuddy and Qoder: Claude Code’s layout in their own settings', () => {
    for (const [tool, dir] of [
      ['qwen-code', '.qwen'],
      ['codebuddy', '.codebuddy'],
      ['qoder', '.qoder'],
    ] as const) {
      const path = join(env.home, dir, 'settings.json');
      writeFileSync(path, JSON.stringify({ theme: 'dark' }));
      expect(connectTool(env, tool)).toContain('Restart');
      const hooks = read(path).hooks;
      expect(Object.keys(hooks)).toEqual([
        'SessionStart',
        'UserPromptSubmit',
        'Stop',
        'SessionEnd',
      ]);
      expect(hooks.Stop[0].hooks[0]).toMatchObject({ type: 'command', timeout: 5 });
      disconnectTool(env, tool);
      expect(read(path)).toEqual({ theme: 'dark' });
    }
  });

  test('Gemini CLI: its own event names, and a timeout in milliseconds', () => {
    connectTool(env, 'gemini-cli');
    const hooks = read(join(env.home, '.gemini', 'settings.json')).hooks;
    expect(Object.keys(hooks)).toEqual(['SessionStart', 'BeforeAgent', 'AfterAgent', 'SessionEnd']);
    expect(hooks.BeforeAgent[0].hooks[0].timeout).toBe(5000);
  });

  test('Factory: events at the top level of hooks.json, beside the user’s settings', () => {
    const path = join(env.home, '.factory', 'hooks.json');
    const theirs = { hooks: [{ type: 'command', command: 'say done' }] };
    writeFileSync(path, JSON.stringify({ hooksDisabled: false, Stop: [theirs] }));
    connectTool(env, 'factory');
    const config = read(path);
    expect(config.hooks).toBeUndefined();
    expect(config.Stop).toHaveLength(2);
    expect(config.SessionStart[0].hooks[0].command).toContain(MARKER);
    expect(toolStatus(env).find((t) => t.tool === 'factory')?.connected).toBe(true);
    disconnectTool(env, 'factory');
    expect(read(path)).toEqual({ hooksDisabled: false, Stop: [theirs] });
  });

  test('Cursor: commands listed directly under each event, with a version', () => {
    const path = join(env.home, '.cursor', 'hooks.json');
    connectTool(env, 'cursor');
    const config = read(path);
    expect(config.version).toBe(1);
    expect(Object.keys(config.hooks)).toEqual([
      'sessionStart',
      'beforeSubmitPrompt',
      'stop',
      'sessionEnd',
    ]);
    expect(config.hooks.stop[0]).toEqual({ command: hookCommand(env, 'cursor'), timeout: 5 });
    disconnectTool(env, 'cursor');
    expect(read(path)).toEqual({ version: 1 });
  });

  test('Kimi Code: [[hooks]] tables that parse, and only Margin’s are removed', () => {
    const path = join(env.home, '.kimi-code', 'config.toml');
    const theirs = [
      'default_model = "kimi-k2"',
      '',
      '[[hooks]]',
      'event = "Stop"',
      'command = "say done"',
      '',
      '[models.kimi-k2]',
      'provider = "moonshot"',
      'matrix = [',
      '  [1, 2],',
      ']',
      '',
    ].join('\n');
    writeFileSync(path, theirs);
    connectTool(env, 'kimi-code');
    connectTool(env, 'kimi-code');
    const parsed = Bun.TOML.parse(readFileSync(path, 'utf8')) as {
      hooks: { event: string; command: string; timeout: number }[];
      models: Record<string, unknown>;
    };
    expect(parsed.hooks.map((h) => h.event)).toEqual([
      'Stop',
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
      'SessionEnd',
    ]);
    expect(parsed.hooks[1]?.command).toBe(hookCommand(env, 'kimi-code'));
    expect(Object.keys(parsed.hooks[1] ?? {}).sort()).toEqual(['command', 'event', 'timeout']);
    expect(parsed.models['kimi-k2']).toEqual({ provider: 'moonshot', matrix: [[1, 2]] });
    expect(toolStatus(env).find((t) => t.tool === 'kimi-code')?.connected).toBe(true);
    disconnectTool(env, 'kimi-code');
    expect(readFileSync(path, 'utf8')).toBe(theirs);
  });

  test('Kimi Code: a config.toml that doesn’t parse is left alone', () => {
    const path = join(env.home, '.kimi-code', 'config.toml');
    writeFileSync(path, 'broken = [\n');
    expect(() => connectTool(env, 'kimi-code')).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('broken = [\n');
  });

  test('Ollama and LM Studio: switched off and on with a note in the data folder', () => {
    const connected = () => toolStatus(env).find((t) => t.tool === 'lm-studio')?.connected;
    disconnectTool(env, 'lm-studio');
    expect(connected()).toBe(false);
    expect(connectTool(env, 'lm-studio')).toBeUndefined();
    expect(connected()).toBe(true);
    rmSync(join(env.home, '.ollama'), { recursive: true });
    expect(toolStatus(env).find((t) => t.tool === 'ollama')).toMatchObject({
      found: false,
      connected: false,
    });
  });

  test('OpenCode: a plugin file that loads, and goes away again', async () => {
    connectTool(env, 'opencode');
    const path = join(env.home, '.config', 'opencode', 'plugins', 'margin.js');
    const plugin = await import(path);
    expect(plugin.default.id).toBe('margin');
    expect(readFileSync(path, 'utf8')).toContain(JSON.stringify(env.socket));
    disconnectTool(env, 'opencode');
    expect(toolStatus(env).find((t) => t.tool === 'opencode')?.connected).toBe(false);
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
    connectTool(old, 'cursor');
    connectTool(old, 'kimi-code');
    const moved = app('Margin');

    expect(repointTools(moved)).toEqual(['claude-code', 'codex', 'cursor', 'kimi-code']);
    expect(readFileSync(join(env.home, '.kimi-code', 'config.toml'), 'utf8')).toContain(
      'Margin.app',
    );
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

  test('Gemini CLI’s agent events count as a prompt and a stop', () => {
    expect(
      toEvent('gemini-cli', { hook_event_name: 'BeforeAgent', session_id: 's', prompt: 'x' }),
    ).toEqual({ tool: 'gemini-cli', event: 'prompt', sessionId: 's' });
    expect(toEvent('gemini-cli', { hook_event_name: 'AfterAgent', session_id: 's' })?.event).toBe(
      'stop',
    );
  });

  test('Cursor: the conversation is the session, the first workspace the folder, and the email stays', () => {
    const event = toEvent('cursor', {
      hook_event_name: 'beforeSubmitPrompt',
      conversation_id: '7f0c9a2e-1b2c-4d5e-8f90-123456789abc',
      generation_id: 'g',
      model: 'claude-4.5-sonnet',
      workspace_roots: ['/Users/me/app', '/Users/me/lib'],
      user_email: 'me@example.com',
      prompt: 'secret',
    });
    expect(event).toEqual({
      tool: 'cursor',
      event: 'prompt',
      sessionId: '7f0c9a2e-1b2c-4d5e-8f90-123456789abc',
      model: 'claude-4.5-sonnet',
      cwd: '/Users/me/app',
    });
  });

  test('an odd optional field is dropped, not the event; unknown events are ignored', () => {
    expect(
      toEvent('codex', { hook_event_name: 'Stop', session_id: 's', cwd: '/tmp/\u001b[2Jevil' }),
    ).toEqual({ tool: 'codex', event: 'stop', sessionId: 's' });
    expect(toEvent('codex', { hook_event_name: 'PreToolUse', session_id: 's' })).toBeNull();
    expect(toEvent('codex', { hook_event_name: 'Stop', session_id: '../../x' })).toBeNull();
  });
});
