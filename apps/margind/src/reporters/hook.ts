import { ReporterEvent, type Tool } from '@margin/protocol';
import * as v from 'valibot';
import { sendOnce } from '../net';

// The command Claude Code and Codex run on each hook: reads the payload on stdin and
// forwards a whitelisted event to margind. Prompts, replies and everything else in the
// payload are dropped here. Prints nothing (on SessionStart and UserPromptSubmit, stdout
// would be added to the model's context) and never fails the tool.

const EVENTS: Record<string, ReporterEvent['event']> = {
  SessionStart: 'start',
  UserPromptSubmit: 'prompt',
  Stop: 'stop',
  SessionEnd: 'end',
  PostModelSwitch: 'model',
};

export function toEvent(tool: Tool, payload: Record<string, unknown>): ReporterEvent | null {
  const event = EVENTS[String(payload.hook_event_name)];
  if (!event || typeof payload.session_id !== 'string') return null;
  const model = event === 'model' ? payload.to_model : payload.model;
  const candidate = {
    tool,
    event,
    sessionId: payload.session_id,
    ...(typeof model === 'string' ? { model } : {}),
    ...(typeof payload.cwd === 'string' ? { cwd: payload.cwd } : {}),
  };
  if (v.is(ReporterEvent, candidate)) return candidate;
  // Keep the event even if an optional field is odd.
  const bare = { tool, event, sessionId: payload.session_id };
  return v.is(ReporterEvent, bare) ? bare : null;
}

// The hook runs under a shell spawned by Claude Code; walk up to the claude process so
// margind notices when it exits without a SessionEnd. Codex runs hooks in a long-lived
// app-server, so its PID says nothing about the session.
function claudePid(): number | undefined {
  let pid = process.ppid;
  for (let depth = 0; depth < 6 && pid > 1; depth++) {
    const out = Bun.spawnSync(['ps', '-o', 'ppid=,comm=', '-p', String(pid)])
      .stdout.toString()
      .trim();
    const match = out.match(/^(\d+)\s+(.+)$/);
    if (!match) return undefined;
    if (/(^|\/)claude$/.test(match[2] ?? '')) return pid;
    pid = Number(match[1]);
  }
  return undefined;
}

export async function runHook(tool: string, socket: string) {
  try {
    if (tool !== 'claude-code' && tool !== 'codex') return;
    const event = toEvent(tool, JSON.parse(await Bun.stdin.text()));
    if (!event) return;
    const pid = tool === 'claude-code' ? claudePid() : undefined;
    await sendOnce(socket, { op: 'event', event: { ...event, ...(pid ? { pid } : {}) } });
  } catch {}
}
