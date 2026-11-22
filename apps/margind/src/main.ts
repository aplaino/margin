import { homedir } from 'node:os';
import { startDaemon } from './daemon';
import { keychainKey } from './keychain';
import { paths } from './paths';
import { runHook } from './reporters/hook';
import { Reports } from './reports';
import { defaultSources } from './tokens';

// Files margind creates are private to you.
process.umask(0o077);

// How tools should run margind: the built binary, or bun plus this script in development.
const self = Bun.main.startsWith('/$bunfs/') ? [process.execPath] : [process.execPath, Bun.main];

const [command, ...args] = process.argv.slice(2);
const where = paths();

if (command === 'hook') {
  await runHook(args[0] ?? '', where.socket);
  process.exit(0);
}

if (command !== undefined) {
  console.error('usage: margind [hook <tool>]');
  process.exit(2);
}

// An unexpected error is kept as a crash report (the app offers to send it), then margind
// exits and Margin.app starts it again.
const version = process.env.MARGIN_APP_VERSION ?? 'dev';
let secrets = (): string[] => [];
const crashed = (e: unknown) => {
  try {
    const reports = new Reports(where.home, version);
    const error = e instanceof Error ? e : new Error(typeof e);
    reports.add(
      {
        component: 'margind',
        kind: 'crash',
        what: error.name,
        detail: [error.stack ?? error.name, '', 'recent log:', reports.logTail()].join('\n'),
      },
      secrets(),
    );
  } catch {}
  console.error(`[margind] crashed (${e instanceof Error ? e.name : typeof e})`);
  process.exit(1);
};
process.on('uncaughtException', crashed);
process.on('unhandledRejection', crashed);

const daemon = await startDaemon({
  paths: where,
  keys: keychainKey,
  server: process.env.MARGIN_SERVER ?? 'http://127.0.0.1:8787',
  devHandle: process.env.MARGIN_DEV_HANDLE,
  githubClientId: process.env.MARGIN_GITHUB_CLIENT_ID,
  tools: { home: homedir(), dataHome: where.home, socket: where.socket, self },
  tokenSources: defaultSources(),
  version,
});
secrets = daemon.reportSecrets;
console.error('[margind] running');

// Started by Margin.app: stop if the app goes away without stopping us (a crash or a kill),
// rather than keep you looking online with no app.
const parent = Number(process.env.MARGIN_PARENT_PID);
if (parent > 0) {
  setInterval(() => {
    if (process.ppid !== parent) void daemon.stop().then(() => process.exit(0));
  }, 3000);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void daemon.stop().then(() => process.exit(0));
  });
}
