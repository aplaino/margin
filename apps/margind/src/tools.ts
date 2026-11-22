import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  type Stats,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Tool } from '@margin/protocol';

// Connecting a tool adds Margin's hook to that tool's own config; disconnecting removes
// only Margin's entries. Every file is backed up before it's changed, and a config that
// can't be parsed is left alone rather than overwritten.

// Failures with a message fit to show you in the drawer.
export class ToolError extends Error {}

// Every line Margin adds carries this, so it can always find (and remove) its own entries.
export const MARKER = 'MARGIN_HOOK=1';

export type ToolEnv = {
  home: string; // the user's home folder
  dataHome: string; // margind's data folder
  socket: string;
  self: string[]; // how to run margind: [bun, main.ts] in development, [binary] when built
};

const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd', 'PostModelSwitch'];
// Codex fires SessionEnd only when the next session starts, so it's not used.
const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'];
// The tools that copied Claude Code's hooks, without its model-switch event.
const CLAUDE_STYLE = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'];

// Tools with JSON hook files. Most use Claude Code's layout (events under `hooks`, each a list
// of groups holding commands); Factory's hooks.json has the events at the top level, and
// Cursor lists commands directly under each event.
type Layout = 'claude' | 'top-level' | 'cursor';
type JsonHooks = {
  file: string[];
  events: string[];
  layout: Layout;
  timeout: number;
  note?: string;
};

const restart = (name: string) => `Restart ${name} to load Margin’s hooks.`;

const JSON_HOOKS: Partial<Record<Tool, JsonHooks>> = {
  'claude-code': {
    file: ['.claude', 'settings.json'],
    events: CLAUDE_EVENTS,
    layout: 'claude',
    timeout: 5,
  },
  codex: {
    file: ['.codex', 'hooks.json'],
    events: CODEX_EVENTS,
    layout: 'claude',
    timeout: 5,
    note: 'Open Codex and approve Margin’s hooks in /hooks.',
  },
  'gemini-cli': {
    file: ['.gemini', 'settings.json'],
    events: ['SessionStart', 'BeforeAgent', 'AfterAgent', 'SessionEnd'],
    layout: 'claude',
    // Gemini CLI counts hook timeouts in milliseconds.
    timeout: 5000,
    note: restart('Gemini CLI'),
  },
  'qwen-code': {
    file: ['.qwen', 'settings.json'],
    events: CLAUDE_STYLE,
    layout: 'claude',
    timeout: 5,
    note: restart('Qwen Code'),
  },
  // Droid reloads its hooks when the file changes.
  factory: {
    file: ['.factory', 'hooks.json'],
    events: CLAUDE_STYLE,
    layout: 'top-level',
    timeout: 5,
  },
  codebuddy: {
    file: ['.codebuddy', 'settings.json'],
    events: CLAUDE_STYLE,
    layout: 'claude',
    timeout: 5,
    note: restart('CodeBuddy'),
  },
  qoder: {
    file: ['.qoder', 'settings.json'],
    events: CLAUDE_STYLE,
    layout: 'claude',
    timeout: 5,
    note: restart('Qoder'),
  },
  cursor: {
    file: ['.cursor', 'hooks.json'],
    events: ['sessionStart', 'beforeSubmitPrompt', 'stop', 'sessionEnd'],
    layout: 'cursor',
    timeout: 5,
    note: restart('Cursor'),
  },
};

const KIMI_EVENTS = CLAUDE_STYLE;

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const stamp = () => new Date().toISOString().replace(/\D/g, '').slice(0, 14);

export function hookCommand(env: ToolEnv, tool: Tool) {
  return `${MARKER} MARGIN_HOME=${quote(env.dataHome)} ${env.self.map(quote).join(' ')} hook ${tool}`;
}

function backup(path: string) {
  if (existsSync(path)) copyFileSync(path, `${path}.margin-backup-${stamp()}`);
}

// Write via a temporary file so a crash never leaves a half-written config.
function writeAtomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o644;
  const temp = `${path}.margin-tmp`;
  writeFileSync(temp, text, { mode });
  renameSync(temp, path);
}

type HookEntry = {
  matcher?: string;
  command?: string;
  timeout?: number;
  hooks?: { type?: string; command?: string; timeout?: number }[];
};
type HookConfig = { [key: string]: unknown };

function readConfig(path: string): HookConfig {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('unexpected config shape');
  return parsed;
}

// The object holding the events: the file itself, or its `hooks` key.
function eventMap(config: HookConfig, layout: Layout): Record<string, unknown> {
  if (layout === 'top-level') return config;
  const hooks = config.hooks;
  return hooks && typeof hooks === 'object' && !Array.isArray(hooks)
    ? (hooks as Record<string, unknown>)
    : {};
}

const entriesOf = (value: unknown): HookEntry[] => (Array.isArray(value) ? value : []);
const commandsOf = (entry: HookEntry) => [
  entry.command,
  ...(entry.hooks ?? []).map((h) => h.command),
];
const ours = (entry: HookEntry) => commandsOf(entry).some((c) => c?.includes(MARKER));

function readEvents(path: string, layout: Layout) {
  try {
    return eventMap(readConfig(path), layout);
  } catch {
    return {};
  }
}

function hooksInstalled(path: string, spec: JsonHooks) {
  const events = readEvents(path, spec.layout);
  return spec.events.every((event) => entriesOf(events[event]).some(ours));
}

function setHooks(path: string, spec: JsonHooks, command: string | null) {
  const config = readConfig(path);
  const events = eventMap(config, spec.layout);
  for (const [event, value] of Object.entries(events)) {
    if (!Array.isArray(value)) continue;
    const kept = entriesOf(value).filter((entry) => !ours(entry));
    if (kept.length) events[event] = kept;
    else delete events[event];
  }
  if (command) {
    const entry: HookEntry =
      spec.layout === 'cursor'
        ? { command, timeout: spec.timeout }
        : { hooks: [{ type: 'command', command, timeout: spec.timeout }] };
    for (const event of spec.events) events[event] = [...entriesOf(events[event]), entry];
    if (spec.layout === 'cursor') config.version ??= 1;
  }
  if (spec.layout !== 'top-level') {
    if (Object.keys(events).length) config.hooks = events;
    else delete config.hooks;
  }
  backup(path);
  writeAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
}

// Kimi Code keeps hooks as [[hooks]] tables in config.toml, each with exactly event, command,
// matcher and timeout (anything else and Kimi won't start). Margin's tables are cut out whole
// and appended at the end; the file must parse before and after.
type KimiHook = { event?: string; command?: string };

function kimiHooks(path: string): KimiHook[] {
  try {
    const parsed = Bun.TOML.parse(readFileSync(path, 'utf8')) as { hooks?: unknown };
    return Array.isArray(parsed.hooks) ? parsed.hooks : [];
  } catch {
    return [];
  }
}

const kimiInstalled = (path: string) =>
  KIMI_EVENTS.every((event) =>
    kimiHooks(path).some((h) => h.event === event && h.command?.includes(MARKER)),
  );

function setKimiHooks(path: string, command: string | null) {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  Bun.TOML.parse(text);
  // Split at table headers and drop the [[hooks]] tables that run Margin.
  const blocks: string[][] = [[]];
  for (const line of text.split('\n')) {
    if (/^\s*\[\[?[\w."' -]+\]\]?\s*(#.*)?$/.test(line)) blocks.push([]);
    blocks.at(-1)?.push(line);
  }
  const kept = blocks
    .filter((b) => !(b[0]?.trim() === '[[hooks]]' && b.some((line) => line.includes(MARKER))))
    .flat()
    .join('\n')
    .replace(/\n*$/, '\n');
  const added = command
    ? KIMI_EVENTS.map(
        (event) =>
          `\n[[hooks]]\nevent = "${event}"\ncommand = ${JSON.stringify(command)}\ntimeout = 5\n`,
      ).join('')
    : '';
  const next = (kept.trim() ? kept : '') + added;
  Bun.TOML.parse(next);
  backup(path);
  writeAtomic(path, next);
}

function opencodePlugin(socket: string) {
  return `// ${MARKER}: Margin's OpenCode plugin. Forwards session events (never prompt text) to margind.
import { connect } from 'node:net';

const SOCKET = ${JSON.stringify(socket)};

function send(event) {
  const conn = connect(SOCKET);
  conn.on('error', () => {});
  conn.on('connect', () => conn.end(JSON.stringify({ op: 'event', event: { tool: 'opencode', ...event } }) + '\\n'));
}

const model = (m) => (m?.providerID && m?.id ? m.providerID + '/' + m.id : undefined);

export default {
  id: 'margin',
  setup: async (ctx) => {
    // session.created can fire before this subscription starts, so look up the folder once
    // per session on its first step.
    const known = new Set();
    const directory = async (sessionID) => {
      if (known.has(sessionID)) return undefined;
      known.add(sessionID);
      return (await ctx.session.get({ sessionID }).catch(() => undefined))?.location?.directory;
    };
    (async () => {
      for await (const e of ctx.event.subscribe()) {
        const d = e?.data ?? {};
        if (!d.sessionID) continue;
        if (e.type === 'session.created') {
          known.add(d.sessionID);
          send({ event: 'start', sessionId: d.sessionID, model: model(d.model), cwd: d.location?.directory });
        } else if (e.type === 'session.inbox.enqueued') {
          send({ event: 'prompt', sessionId: d.sessionID });
        } else if (e.type === 'session.step.started') {
          send({ event: 'prompt', sessionId: d.sessionID, model: model(d.model), cwd: await directory(d.sessionID) });
        } else if (e.type === 'session.archived' || e.type === 'session.deleted') {
          known.delete(d.sessionID);
          send({ event: 'end', sessionId: d.sessionID });
        }
      }
    })().catch(() => {});
  },
};
`;
}

// zsh writes to the socket itself (no process per prompt), at most once a minute per folder.
function zshInit(socket: string) {
  return `# ${MARKER}: Margin shell presence. Sends the current folder to margind (it stays on this Mac).
zmodload zsh/net/socket zsh/datetime 2>/dev/null || return 0
typeset -g _margin_sock=${quote(socket)} _margin_dir="" _margin_at=0
_margin_report() {
  [[ -S $_margin_sock ]] || return 0
  [[ $PWD == $_margin_dir ]] && (( EPOCHSECONDS - _margin_at < 60 )) && return 0
  _margin_dir=$PWD _margin_at=$EPOCHSECONDS
  local dir=\${PWD//[[:cntrl:]]/}; dir=\${dir//\\\\/\\\\\\\\}; dir=\${dir//\\"/\\\\\\"}
  zsocket $_margin_sock 2>/dev/null || return 0
  local fd=$REPLY
  print -u $fd -r -- "{\\"op\\":\\"event\\",\\"event\\":{\\"tool\\":\\"shell\\",\\"event\\":\\"prompt\\",\\"sessionId\\":\\"shell-$$\\",\\"cwd\\":\\"$dir\\",\\"pid\\":$$}}"
  exec {fd}>&-
}
autoload -Uz add-zsh-hook && add-zsh-hook precmd _margin_report
`;
}

function files(env: ToolEnv) {
  return {
    opencodeDir: join(env.home, '.config', 'opencode'),
    opencode: join(env.home, '.config', 'opencode', 'plugins', 'margin.js'),
    kimi: join(env.home, '.kimi-code', 'config.toml'),
    zshrc: join(env.home, '.zshrc'),
    zshInit: join(env.dataHome, 'init.zsh'),
    // Created on Ollama's first run, whether from the app or Homebrew.
    ollama: join(env.home, '.ollama'),
    lmStudio: join(env.home, '.lmstudio'),
  };
}

// Ollama and LM Studio need nothing installed: margind watches them while they're on, and
// turning one off leaves a note in its data folder.
const LOCAL_MODELS: Partial<Record<Tool, string>> = { ollama: 'ollama', 'lm-studio': 'lm-studio' };
const watchOff = (env: ToolEnv, tool: Tool) => join(env.dataHome, `${LOCAL_MODELS[tool]}.off`);

const jsonFile = (env: ToolEnv, spec: JsonHooks) => join(env.home, ...spec.file);

const contains = (path: string, text: string) =>
  existsSync(path) && readFileSync(path, 'utf8').includes(text);

// In the order Settings lists them.
const TOOLS: Tool[] = [
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
];

function status(env: ToolEnv, tool: Tool): { found: boolean; connected: boolean } {
  const f = files(env);
  const spec = JSON_HOOKS[tool];
  if (spec) {
    const path = jsonFile(env, spec);
    return { found: existsSync(dirname(path)), connected: hooksInstalled(path, spec) };
  }
  switch (tool) {
    case 'opencode':
      return { found: existsSync(f.opencodeDir), connected: contains(f.opencode, MARKER) };
    case 'kimi-code':
      return { found: existsSync(dirname(f.kimi)), connected: kimiInstalled(f.kimi) };
    case 'ollama':
    case 'lm-studio': {
      const found = existsSync(tool === 'ollama' ? f.ollama : f.lmStudio);
      return { found, connected: found && !existsSync(watchOff(env, tool)) };
    }
    case 'shell':
      return { found: existsSync(f.zshrc), connected: contains(f.zshrc, MARKER) };
    default:
      return { found: false, connected: false };
  }
}

export function toolStatus(env: ToolEnv): { tool: Tool; found: boolean; connected: boolean }[] {
  return TOOLS.map((tool) => ({ tool, ...status(env, tool) }));
}

// macOS runs a downloaded app that hasn't been moved from a temporary copy that vanishes
// when it quits; hooks pointing there would quietly stop working.
const temporary = (env: ToolEnv) => env.self.some((p) => p.includes('/AppTranslocation/'));

// A development run is bun plus a script; a built Margin is its one margind binary.
const development = (env: ToolEnv) => env.self.length > 1;

// Hooks run on every prompt, so they may only point at an installed Margin: margind inside a
// .app in /Applications or ~/Applications, in a bundle nobody else can write to. Not a
// temporary copy, a mounted disk image, or anywhere under /tmp.
export function installed(env: ToolEnv) {
  const binary = env.self[0] ?? '';
  const match = binary.match(
    /^(\/Applications|.+\/Applications)\/[^/]+\.app\/Contents\/MacOS\/margind$/,
  );
  if (env.self.length !== 1 || !match) return false;
  if (match[1] !== '/Applications' && match[1] !== join(env.home, 'Applications')) return false;
  const macos = dirname(binary);
  const contents = dirname(macos);
  const bundle = dirname(contents);
  try {
    // No symlinks anywhere on the way: the path checked is the path that runs.
    if (realpathSync(binary) !== binary) return false;
    // /Applications is root-owned but writable by admins on every Mac; that's the one exception.
    const apps = lstatSync(match[1]);
    if (apps.isSymbolicLink() || (match[1] === '/Applications' ? apps.uid !== 0 : !safe(apps)))
      return false;
    return [bundle, contents, macos, binary].every((path) => {
      const stat = lstatSync(path);
      return !stat.isSymbolicLink() && safe(stat);
    });
  } catch {
    return false;
  }
}

// Owned by you or root, and writable by nobody else.
const safe = (stat: Stats) =>
  !(stat.mode & 0o022) && (stat.uid === process.getuid?.() || stat.uid === 0);

// Margin's own hook for this data folder (another Margin setup's hooks are not ours to move).
const belongsHere = (env: ToolEnv, command: string | undefined) =>
  !!command?.includes(MARKER) && command.includes(`MARGIN_HOME=${quote(env.dataHome)} `);

// After Margin moves (say, from Downloads into Applications), points its existing hooks at
// where it is now. Returns the tools it changed.
export function repointTools(env: ToolEnv): Tool[] {
  if (!installed(env)) return [];
  const changed: Tool[] = [];
  for (const [tool, spec] of Object.entries(JSON_HOOKS) as [Tool, JsonHooks][]) {
    const path = jsonFile(env, spec);
    const command = hookCommand(env, tool);
    const commands = Object.values(readEvents(path, spec.layout))
      .flatMap(entriesOf)
      .flatMap(commandsOf);
    const mine = commands.some((c) => belongsHere(env, c));
    const current = spec.events.every((event) =>
      entriesOf(readEvents(path, spec.layout)[event]).some((e) => commandsOf(e).includes(command)),
    );
    if (mine && hooksInstalled(path, spec) && !current) {
      setHooks(path, spec, command);
      changed.push(tool);
    }
  }
  const kimi = files(env).kimi;
  const command = hookCommand(env, 'kimi-code');
  const hooks = kimiHooks(kimi);
  if (
    hooks.some((h) => belongsHere(env, h.command)) &&
    kimiInstalled(kimi) &&
    !KIMI_EVENTS.every((event) => hooks.some((h) => h.event === event && h.command === command))
  ) {
    setKimiHooks(kimi, command);
    changed.push('kimi-code');
  }
  return changed;
}

// Returns a note for the user when the tool needs a step of its own.
export function connectTool(env: ToolEnv, tool: Tool): string | undefined {
  const f = files(env);
  if (LOCAL_MODELS[tool]) {
    if (!status(env, tool).found) throw new ToolError(`${tool} isn’t installed`);
    if (existsSync(watchOff(env, tool))) unlinkSync(watchOff(env, tool));
    return undefined;
  }
  if (temporary(env) || (!development(env) && !installed(env))) {
    throw new ToolError(
      'Move Margin to Applications first. It’s running from a temporary copy, and hooks would stop working when it quits.',
    );
  }
  if (!status(env, tool).found) throw new ToolError(`${tool} isn’t installed`);
  const spec = JSON_HOOKS[tool];
  if (spec) {
    setHooks(jsonFile(env, spec), spec, hookCommand(env, tool));
    return spec.note;
  }
  switch (tool) {
    case 'opencode':
      writeAtomic(f.opencode, opencodePlugin(env.socket));
      return 'Restart OpenCode to load the plugin.';
    case 'kimi-code':
      setKimiHooks(f.kimi, hookCommand(env, tool));
      return restart('Kimi Code');
    case 'shell': {
      writeAtomic(f.zshInit, zshInit(env.socket));
      if (!contains(f.zshrc, MARKER)) {
        const rc = readFileSync(f.zshrc, 'utf8');
        backup(f.zshrc);
        writeAtomic(
          f.zshrc,
          `${rc.replace(/\n*$/, '\n')}[ -f ${quote(f.zshInit)} ] && source ${quote(f.zshInit)} # ${MARKER}\n`,
        );
      }
      return 'Open a new terminal window.';
    }
    default:
      return undefined;
  }
}

export function disconnectTool(env: ToolEnv, tool: Tool) {
  const f = files(env);
  if (LOCAL_MODELS[tool]) {
    writeAtomic(watchOff(env, tool), '');
    return;
  }
  const spec = JSON_HOOKS[tool];
  if (spec) {
    const path = jsonFile(env, spec);
    if (existsSync(path)) setHooks(path, spec, null);
    return;
  }
  switch (tool) {
    case 'opencode':
      if (contains(f.opencode, MARKER)) unlinkSync(f.opencode);
      return;
    case 'kimi-code':
      if (contains(f.kimi, MARKER)) setKimiHooks(f.kimi, null);
      return;
    case 'shell':
      if (contains(f.zshrc, MARKER)) {
        const rc = readFileSync(f.zshrc, 'utf8');
        backup(f.zshrc);
        writeAtomic(
          f.zshrc,
          rc
            .split('\n')
            .filter((line) => !line.includes(MARKER))
            .join('\n'),
        );
      }
      if (existsSync(f.zshInit)) unlinkSync(f.zshInit);
      return;
  }
}
