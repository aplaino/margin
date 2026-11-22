import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ReporterEvent } from '@margin/protocol';

// Ollama and LM Studio have no hooks. margind asks their local servers what's loaded and
// counts a model as in use only while it's answering requests. It never starts either one,
// and only the model name can leave the Mac.

export type LocalModelSources = {
  ollama: string;
  lmStudio: string;
  // LM Studio's own folder: server logs and in-app chats.
  lmStudioHome: string;
};

export const defaultLocalModels = (home: string): LocalModelSources => ({
  ollama: 'http://127.0.0.1:11434',
  lmStudio: 'http://127.0.0.1:1234',
  lmStudioHome: join(home, '.lmstudio'),
});

// A request LM Studio's server answered with a model (not a listing like Margin's own).
const LM_STUDIO_REQUEST =
  /(?:Received request: POST to|POST request to) \/(?:v1|api\/v\d)\/(?:chat\/completions|completions|responses|messages|chat)\b|Running chat completion/;

async function getJson(url: string): Promise<unknown> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}

const newest = (dir: string) => {
  try {
    return readdirSync(dir).sort().at(-1);
  } catch {
    return undefined;
  }
};

const mtime = (path: string) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

export class LocalModels {
  private primed = { ollama: false, lmStudio: false };
  private ollamaExpiry = new Map<string, unknown>();
  private log = { path: '', size: 0 };
  private chatsAt = 0;

  constructor(private sources: LocalModelSources) {}

  // Events for whichever of the two is being watched.
  async poll(watch: { ollama: boolean; lmStudio: boolean }): Promise<ReporterEvent[]> {
    const events: ReporterEvent[] = [];
    if (watch.ollama) events.push(...(await this.ollama()));
    if (watch.lmStudio) events.push(...(await this.lmStudio()));
    return events;
  }

  // Each request moves a model's unload time forward, so a changed expires_at means it was
  // just used. A model that appears after the first look was loaded by a request.
  private async ollama(): Promise<ReporterEvent[]> {
    const data = (await getJson(`${this.sources.ollama}/api/ps`)) as
      | { models?: { name?: unknown; expires_at?: unknown }[] }
      | undefined;
    const models = (Array.isArray(data?.models) ? data.models : []).filter(
      (m): m is { name: string; expires_at?: unknown } => typeof m?.name === 'string',
    );
    const primed = this.primed.ollama;
    const used = models.find((m) => primed && this.ollamaExpiry.get(m.name) !== m.expires_at);
    const hadModels = this.ollamaExpiry.size > 0;
    this.ollamaExpiry = new Map(models.map((m) => [m.name, m.expires_at]));
    this.primed.ollama = true;
    if (used) return [{ tool: 'ollama', event: 'prompt', sessionId: 'ollama', model: used.name }];
    if (hadModels && !models.length) return [{ tool: 'ollama', event: 'end', sessionId: 'ollama' }];
    return [];
  }

  // Requests to LM Studio's server show up in its log; chats inside the app change files in
  // its conversations folder. The loaded model is asked for only once something happened.
  private async lmStudio(): Promise<ReporterEvent[]> {
    const primed = this.primed.lmStudio;
    this.primed.lmStudio = true;
    const used = this.lmStudioLog(primed) || this.lmStudioChats(primed);
    if (!used) return [];
    const data = (await getJson(`${this.sources.lmStudio}/api/v0/models`)) as
      | { data?: { id?: unknown; state?: unknown }[] }
      | undefined;
    const loaded = (Array.isArray(data?.data) ? data.data : []).find(
      (m) => m?.state === 'loaded' && typeof m.id === 'string',
    );
    return [
      {
        tool: 'lm-studio',
        event: 'prompt',
        sessionId: 'lm-studio',
        ...(typeof loaded?.id === 'string' ? { model: loaded.id } : {}),
      },
    ];
  }

  // Reads only what was added to today's log since the last look, at most 64 KB of it. The
  // text is matched here and never kept.
  private lmStudioLog(primed: boolean) {
    const logs = join(this.sources.lmStudioHome, 'server-logs');
    const month = newest(logs);
    const file = month && newest(join(logs, month));
    if (!month || !file) return false;
    const path = join(logs, month, file);
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      return false;
    }
    const from = path === this.log.path && size >= this.log.size ? this.log.size : 0;
    this.log = { path, size };
    if (!primed || size === from) return false;
    const length = Math.min(size - from, 65_536);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    return LM_STUDIO_REQUEST.test(buffer.toString('utf8'));
  }

  private lmStudioChats(primed: boolean) {
    const dir = join(this.sources.lmStudioHome, 'conversations');
    if (!existsSync(dir)) return false;
    let latest = mtime(dir);
    for (const name of readdirSync(dir)) latest = Math.max(latest, mtime(join(dir, name)));
    const changed = primed && latest > this.chatsAt;
    this.chatsAt = latest;
    return changed;
  }
}
