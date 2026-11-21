import type { ReporterEvent, Tool } from '@margin/protocol';

export type LocalSession = {
  tool: Tool;
  sessionId: string;
  model?: string;
  cwd?: string;
  pid?: number;
  startedAt: number;
  lastEventAt: number;
};

// Tools whose process outlives your use of them (Codex's app-server, OpenCode's server,
// a shell) end after a quiet spell. Claude Code ends when its process exits, or after an
// hour without events if its process couldn't be found.
const QUIET_MS: Record<Tool, number> = {
  'claude-code': 60 * 60_000,
  codex: 15 * 60_000,
  opencode: 15 * 60_000,
  shell: 10 * 60_000,
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export class Sessions {
  private sessions = new Map<string, LocalSession>();

  constructor(private isAlive: (pid: number) => boolean = alive) {}

  list() {
    return [...this.sessions.values()];
  }

  onEvent(event: ReporterEvent, now = Date.now()) {
    const key = `${event.tool}:${event.sessionId}`;
    if (event.event === 'end') {
      this.sessions.delete(key);
      return;
    }
    const existing = this.sessions.get(key);
    this.sessions.set(key, {
      tool: event.tool,
      sessionId: event.sessionId,
      model: event.model ?? existing?.model,
      cwd: event.cwd ?? existing?.cwd,
      pid: event.pid ?? existing?.pid,
      startedAt: existing?.startedAt ?? now,
      lastEventAt: now,
    });
  }

  // Drops sessions whose tool exited or went quiet. Returns true if any ended.
  expire(now = Date.now()) {
    let changed = false;
    for (const [key, s] of this.sessions) {
      const exited = s.tool === 'claude-code' && s.pid !== undefined && !this.isAlive(s.pid);
      if (exited || now - s.lastEventAt > QUIET_MS[s.tool]) {
        this.sessions.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  // Friends see one activity: an AI tool beats a bare shell, then the most recently active.
  current(): LocalSession | undefined {
    const rank = (s: LocalSession) => (s.tool === 'shell' ? 0 : 1);
    return this.list().toSorted((a, b) => rank(b) - rank(a) || b.lastEventAt - a.lastEventAt)[0];
  }
}
