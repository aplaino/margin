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

type HookGroup = {
  matcher?: string;
  hooks?: { type?: string; command?: string; timeout?: number }[];
};
type HookConfig = { hooks?: Record<string, HookGroup[]>; [key: string]: unknown };

function readConfig(path: string): HookConfig {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('unexpected config shape');
  return parsed;
}

const ours = (group: HookGroup) => group.hooks?.some((h) => h.command?.includes(MARKER)) ?? false;

function hooksInstalled(path: string, events: string[]) {
  try {
    const hooks = readConfig(path).hooks ?? {};
    return events.every((event) => (hooks[event] ?? []).some(ours));
  } catch {
    return false;
  }
}

function setHooks(path: string, events: string[], command: string | null) {
  const config = readConfig(path);
  const hooks = config.hooks ?? {};
  for (const event of Object.keys(hooks)) {
    const kept = (hooks[event] ?? []).filter((group) => !ours(group));
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (command) {
    for (const event of events) {
      hooks[event] = [
        ...(hooks[event] ?? []),
        { hooks: [{ type: 'command', command, timeout: 5 }] },
      ];
    }
  }
  if (Object.keys(hooks).length) config.hooks = hooks;
  else delete config.hooks;
  backup(path);
  writeAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
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
    claude: join(env.home, '.claude', 'settings.json'),
    codex: join(env.home, '.codex', 'hooks.json'),
    opencodeDir: join(env.home, '.config', 'opencode'),
    opencode: join(env.home, '.config', 'opencode', 'plugins', 'margin.js'),
    zshrc: join(env.home, '.zshrc'),
    zshInit: join(env.dataHome, 'init.zsh'),
  };
}

const contains = (path: string, text: string) =>
  existsSync(path) && readFileSync(path, 'utf8').includes(text);

export function toolStatus(env: ToolEnv): { tool: Tool; found: boolean; connected: boolean }[] {
  const f = files(env);
  return [
    {
      tool: 'claude-code',
      found: existsSync(dirname(f.claude)),
      connected: hooksInstalled(f.claude, CLAUDE_EVENTS),
    },
    {
      tool: 'codex',
      found: existsSync(dirname(f.codex)),
      connected: hooksInstalled(f.codex, CODEX_EVENTS),
    },
    { tool: 'opencode', found: existsSync(f.opencodeDir), connected: contains(f.opencode, MARKER) },
    { tool: 'shell', found: existsSync(f.zshrc), connected: contains(f.zshrc, MARKER) },
  ];
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

function hooksCurrent(path: string, events: string[], command: string) {
  try {
    const hooks = readConfig(path).hooks ?? {};
    return events.every((event) =>
      (hooks[event] ?? []).some((g) => g.hooks?.some((h) => h.command === command)),
    );
  } catch {
    return false;
  }
}

// After Margin moves (say, from Downloads into Applications), points its existing Claude Code
// and Codex hooks at where it is now. Returns the tools it changed.
export function repointTools(env: ToolEnv): Tool[] {
  if (!installed(env)) return [];
  const f = files(env);
  const changed: Tool[] = [];
  for (const [tool, path, events] of [
    ['claude-code', f.claude, CLAUDE_EVENTS],
    ['codex', f.codex, CODEX_EVENTS],
  ] as const) {
    const command = hookCommand(env, tool);
    let mine = false;
    try {
      const hooks = readConfig(path).hooks ?? {};
      mine = Object.values(hooks).some((groups) =>
        groups.some((g) => g.hooks?.some((h) => belongsHere(env, h.command))),
      );
    } catch {}
    if (mine && hooksInstalled(path, events) && !hooksCurrent(path, events, command)) {
      setHooks(path, events, command);
      changed.push(tool);
    }
  }
  return changed;
}

// Returns a note for the user when the tool needs a step of its own.
export function connectTool(env: ToolEnv, tool: Tool): string | undefined {
  const f = files(env);
  if (temporary(env) || (!development(env) && !installed(env))) {
    throw new ToolError(
      'Move Margin to Applications first. It’s running from a temporary copy, and hooks would stop working when it quits.',
    );
  }
  if (!toolStatus(env).find((t) => t.tool === tool)?.found)
    throw new ToolError(`${tool} isn’t installed`);
  switch (tool) {
    case 'claude-code':
      setHooks(f.claude, CLAUDE_EVENTS, hookCommand(env, tool));
      return undefined;
    case 'codex':
      setHooks(f.codex, CODEX_EVENTS, hookCommand(env, tool));
      return 'Open Codex and approve Margin’s hooks in /hooks.';
    case 'opencode':
      writeAtomic(f.opencode, opencodePlugin(env.socket));
      return 'Restart OpenCode to load the plugin.';
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
  }
}

export function disconnectTool(env: ToolEnv, tool: Tool) {
  const f = files(env);
  switch (tool) {
    case 'claude-code':
      if (existsSync(f.claude)) setHooks(f.claude, [], null);
      return;
    case 'codex':
      if (existsSync(f.codex)) setHooks(f.codex, [], null);
      return;
    case 'opencode':
      if (contains(f.opencode, MARKER)) unlinkSync(f.opencode);
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
