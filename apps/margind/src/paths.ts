import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Everything margind keeps lives in one folder. MARGIN_HOME overrides it, so tests and
// several simulated users can run side by side on one machine.
export function paths(
  home = process.env.MARGIN_HOME ?? join(homedir(), 'Library', 'Application Support', 'Margin'),
) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Refuse a folder someone else could have prepared (a symlink, or not ours), and make
  // sure it's private even if it already existed.
  const stat = lstatSync(home);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid?.()) {
    throw new Error(`refusing to use ${home}: not a private folder owned by you`);
  }
  chmodSync(home, 0o700);
  return {
    home,
    db: join(home, 'margind.sqlite'),
    socket: join(home, 'margind.sock'),
    log: join(home, 'margind.log'),
  };
}

export type Paths = ReturnType<typeof paths>;
