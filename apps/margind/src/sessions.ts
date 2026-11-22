import type { ReporterEvent, Tool } from '@margin/protocol';

export type LocalSession = {
  tool: Tool;
  sessionId: string;
  model?: string;
  cwd?: string;
  pid?: number;
  startedAt: number;
  lastEventAt: number;
  // Which session reported most recently, even within the same millisecond.
  order: number;
};

// Tools whose process outlives your use of them (Codex's app-server, OpenCode's server,
// a shell) end after a quiet spell. Claude Code ends when its process exits, or after an
// hour without events if its process couldn't be found. A local model server counts only
// while it's answering requests.
const QUIET_MS: Record<Tool, number> = {
  'claude-code': 60 * 60_000,
  codex: 15 * 60_000,
  opencode: 15 * 60_000,
  'gemini-cli': 15 * 60_000,
  'qwen-code': 15 * 60_000,
  factory: 15 * 60_000,
  codebuddy: 15 * 60_000,
  qoder: 15 * 60_000,
  'kimi-code': 15 * 60_000,
  cursor: 15 * 60_000,
  ollama: 10 * 60_000,
  'lm-studio': 10 * 60_000,
  shell: 10 * 60_000,
};

// What friends see when several are active: a coding tool, then a local model, then a shell.
const RANK: Partial<Record<Tool, number>> = { shell: 0, ollama: 1, 'lm-studio': 1 };

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
  private events = 0;

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
      order: ++this.events,
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

  // Friends see one activity: the highest ranked, then the most recently active.
  current(): LocalSession | undefined {
    const rank = (s: LocalSession) => RANK[s.tool] ?? 2;
    return this.list().toSorted((a, b) => rank(b) - rank(a) || b.order - a.order)[0];
  }
}
