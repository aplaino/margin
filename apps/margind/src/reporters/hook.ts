import { ReporterEvent, type Tool } from '@margin/protocol';
import * as v from 'valibot';
import { sendOnce } from '../net';

// The command each hooked tool runs: reads the payload on stdin and forwards a whitelisted
// event to margind. Prompts, replies, emails and everything else in the payload are dropped
// here. Prints nothing (on session start and prompt submit, stdout would be added to the
// model's context) and never fails the tool.

// Claude Code's names, which most tools copied, then Gemini CLI's and Cursor's.
const EVENTS: Record<string, ReporterEvent['event']> = {
  SessionStart: 'start',
  UserPromptSubmit: 'prompt',
  Stop: 'stop',
  SessionEnd: 'end',
  PostModelSwitch: 'model',
  BeforeAgent: 'prompt',
  AfterAgent: 'stop',
  sessionStart: 'start',
  beforeSubmitPrompt: 'prompt',
  stop: 'stop',
  sessionEnd: 'end',
};

// The tools whose hooks run this command.
export const HOOKED: Tool[] = [
  'claude-code',
  'codex',
  'gemini-cli',
  'qwen-code',
  'factory',
  'codebuddy',
  'qoder',
  'kimi-code',
  'cursor',
];

export function toEvent(tool: Tool, payload: Record<string, unknown>): ReporterEvent | null {
  const event = EVENTS[String(payload.hook_event_name)];
  // Cursor calls the session a conversation and gives the open folders instead of a cwd.
  const sessionId = payload.session_id ?? payload.conversation_id;
  if (!event || typeof sessionId !== 'string') return null;
  const model = event === 'model' ? payload.to_model : payload.model;
  const roots = payload.workspace_roots;
  const cwd = payload.cwd ?? (Array.isArray(roots) ? roots[0] : undefined);
  const candidate = {
    tool,
    event,
    sessionId,
    ...(typeof model === 'string' ? { model } : {}),
    ...(typeof cwd === 'string' ? { cwd } : {}),
  };
  if (v.is(ReporterEvent, candidate)) return candidate;
  // Keep the event even if an optional field is odd.
  const bare = { tool, event, sessionId };
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
    const known = HOOKED.find((t) => t === tool);
    if (!known) return;
    const event = toEvent(known, JSON.parse(await Bun.stdin.text()));
    if (!event) return;
    const pid = tool === 'claude-code' ? claudePid() : undefined;
    await sendOnce(socket, { op: 'event', event: { ...event, ...(pid ? { pid } : {}) } });
  } catch {}
}
