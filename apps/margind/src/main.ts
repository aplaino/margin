import { homedir } from 'node:os';
import { startDaemon } from './daemon';
import { keychainKey } from './keychain';
import { paths } from './paths';
import { runHook } from './reporters/hook';
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

const daemon = await startDaemon({
  paths: where,
  keys: keychainKey,
  server: process.env.MARGIN_SERVER ?? 'http://127.0.0.1:8787',
  devHandle: process.env.MARGIN_DEV_HANDLE,
  githubClientId: process.env.MARGIN_GITHUB_CLIENT_ID,
  tools: { home: homedir(), dataHome: where.home, socket: where.socket, self },
  tokenSources: defaultSources(),
});
console.error('[margind] running');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void daemon.stop().then(() => process.exit(0));
  });
}
