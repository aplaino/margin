import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Everything margind keeps lives in one folder. MARGIN_HOME overrides it, so tests and
// several simulated users can run side by side on one machine.
export function paths(
  home = process.env.MARGIN_HOME ?? join(homedir(), 'Library', 'Application Support', 'Margin'),
) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    home,
    db: join(home, 'margind.sqlite'),
    socket: join(home, 'margind.sock'),
    log: join(home, 'margind.log'),
  };
}

export type Paths = ReturnType<typeof paths>;
