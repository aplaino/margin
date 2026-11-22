import type { PublicStats, ReporterEvent, Tool } from '@margin/protocol';
import { publicModel } from './presence';
import type { LocalSession } from './sessions';
import type { Store } from './store';

// The numbers on your card and profile, kept on this Mac by local day: the all-time token
// total when the day began (a day's tokens are what the total grew by since), time in a
// tool while not idle (and in which tool and model), prompts, new sessions and the longest
// session, and whether anything happened. Only the totals in PublicStats ever leave it.

type Day = {
  base: number;
  seconds: number;
  active: boolean;
  prompts?: number;
  sessions?: number;
  // The longest single session's time in a tool, in seconds.
  longest?: number;
  tools?: Record<string, number>;
  models?: Record<string, number>;
};

export type Stats14 = Required<Omit<PublicStats, 'tool' | 'model'>> &
  Pick<PublicStats, 'tool' | 'model'>;

const KEY = 'stats';
const PROMPTS = 'promptsTotal';
const KEEP = 14;
// A longer gap between ticks (sleep, margind stopped) isn't counted as time in a tool.
const MAX_TICK_MS = 2 * 60_000;
// A shell command or a local model request isn't a prompt to a coding tool.
const NOT_CODING = new Set<Tool>(['shell', 'ollama', 'lm-studio']);

// "2026-11-22" in this Mac's time zone.
export function dayOf(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const add = (into: Record<string, number>, key: string, n: number) => {
  into[key] = (into[key] ?? 0) + n;
};

const top = (counts: Record<string, number>) =>
  Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];

export class Stats {
  private days: Record<string, Day>;
  private total?: number;
  private lastTick?: number;
  // Time in a tool so far for each session this run, for the longest session.
  private sessionSeconds = new Map<string, number>();

  constructor(
    private store: Store,
    private now = () => Date.now(),
  ) {
    this.days = store.getJson<Record<string, Day>>(KEY) ?? {};
  }

  // The last `count` local days, oldest first, ending today.
  private recent(count: number) {
    const d = new Date(this.now());
    return Array.from({ length: count }, (_, i) =>
      dayOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (count - 1 - i)).getTime()),
    );
  }

  // Today's entry, begun with `base` as the day's starting total.
  private today(base = this.total ?? this.store.tokenTotal()) {
    const key = dayOf(this.now());
    let day = this.days[key];
    if (!day) {
      day = { base, seconds: 0, active: false };
      this.days[key] = day;
      const keep = new Set(this.recent(KEEP));
      for (const k of Object.keys(this.days)) if (!keep.has(k)) delete this.days[k];
    }
    return day;
  }

  private save() {
    this.store.setJson(KEY, this.days);
  }

  // After each token scan, with the all-time total.
  tokens(total: number) {
    const day = this.today(this.total ?? total);
    if (this.total !== undefined && total > this.total) day.active = true;
    this.total = total;
    this.save();
  }

  // Each event from a coding tool: a prompt counts, and so does a session the first time it's seen.
  event(event: ReporterEvent, newSession: boolean) {
    if (NOT_CODING.has(event.tool)) return;
    const prompt = event.event === 'prompt';
    if (!prompt && !newSession) return;
    const day = this.today();
    if (prompt) {
      day.prompts = (day.prompts ?? 0) + 1;
      this.store.setJson(PROMPTS, (this.store.getJson<number>(PROMPTS) ?? 0) + 1);
    }
    if (newSession) day.sessions = (day.sessions ?? 0) + 1;
    day.active = true;
    this.save();
  }

  // On each heartbeat: the time since the last one counts if you were working in a tool.
  tick(working?: LocalSession) {
    const now = this.now();
    const elapsed = this.lastTick === undefined ? 0 : now - this.lastTick;
    this.lastTick = now;
    if (!working || elapsed <= 0 || elapsed > MAX_TICK_MS) return;
    const seconds = elapsed / 1000;
    const day = this.today();
    day.seconds += seconds;
    day.active = true;
    day.tools ??= {};
    add(day.tools, working.tool, seconds);
    const model = publicModel(working.model);
    if (model) {
      day.models ??= {};
      add(day.models, model, seconds);
    }
    const key = `${working.tool}:${working.sessionId}`;
    const session = (this.sessionSeconds.get(key) ?? 0) + seconds;
    this.sessionSeconds.set(key, session);
    day.longest = Math.max(day.longest ?? 0, session);
    this.save();
  }

  view(total: number): Stats14 {
    const keys = this.recent(KEEP);
    const days = keys.map((k) => this.days[k]);
    const week = days.slice(-7);
    const today = days[KEEP - 1];
    const weekStart = week.find(Boolean);
    // A day's tokens run until the next day Margin saw (or now, for the last one).
    const daily = days.map((day, i) => {
      if (!day) return 0;
      const next = days.slice(i + 1).find(Boolean);
      return Math.max(0, (next ? next.base : total) - day.base);
    });
    const sum = (list: (Day | undefined)[], pick: (d: Day) => number) =>
      list.reduce((n, d) => n + (d ? pick(d) : 0), 0);
    const tools: Record<string, number> = {};
    const models: Record<string, number> = {};
    for (const day of week) {
      for (const [k, s] of Object.entries(day?.tools ?? {})) add(tools, k, s);
      for (const [k, s] of Object.entries(day?.models ?? {})) add(models, k, s);
    }
    const tool = top(tools) as Tool | undefined;
    const model = top(models);
    return {
      today: today ? Math.max(0, total - today.base) : 0,
      week: weekStart ? Math.max(0, total - weekStart.base) : 0,
      daily,
      minutes: Math.floor(sum(week, (d) => d.seconds) / 60),
      days: days.filter((d) => d?.active).length,
      promptsToday: today?.prompts ?? 0,
      promptsWeek: sum(week, (d) => d.prompts ?? 0),
      prompts: this.store.getJson<number>(PROMPTS) ?? 0,
      sessions: sum(week, (d) => d.sessions ?? 0),
      longest: Math.floor(Math.max(0, ...week.map((d) => d?.longest ?? 0)) / 60),
      ...(tool ? { tool } : {}),
      ...(model ? { model } : {}),
    };
  }
}
