import type { PublicStats } from '@margin/protocol';
import type { Store } from './store';

// The numbers on your card: tokens today and this week, time in a tool this week and active
// days out of 14. Kept on this Mac by local day: the all-time token total when the day began
// (a day's tokens are what the total grew by since), seconds in a tool while not idle, and
// whether anything happened. Only the four totals ever leave it.

type Day = { base: number; seconds: number; active: boolean };

const KEY = 'stats';
const KEEP = 14;
// A longer gap between ticks (sleep, margind stopped) isn't counted as time in a tool.
const MAX_TICK_MS = 2 * 60_000;

// "2026-11-22" in this Mac's time zone.
export function dayOf(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class Stats {
  private days: Record<string, Day>;
  private total?: number;
  private lastTick?: number;

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
  private today(base: number) {
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

  // After each token scan, with the all-time total.
  tokens(total: number) {
    const day = this.today(this.total ?? total);
    if (this.total !== undefined && total > this.total) day.active = true;
    this.total = total;
    this.store.setJson(KEY, this.days);
  }

  // On each heartbeat: the time since the last one counts if you were working in a tool.
  tick(working: boolean) {
    const now = this.now();
    const elapsed = this.lastTick === undefined ? 0 : now - this.lastTick;
    this.lastTick = now;
    if (!working || elapsed <= 0 || elapsed > MAX_TICK_MS) return;
    const day = this.today(this.total ?? this.store.tokenTotal());
    day.seconds += elapsed / 1000;
    day.active = true;
    this.store.setJson(KEY, this.days);
  }

  view(total: number): Required<PublicStats> {
    const days = this.recent(KEEP);
    const week = days.slice(-7);
    const today = this.days[days[KEEP - 1] ?? ''];
    const weekStart = week.map((k) => this.days[k]).find(Boolean);
    const seconds = week.reduce((sum, k) => sum + (this.days[k]?.seconds ?? 0), 0);
    return {
      today: today ? Math.max(0, total - today.base) : 0,
      week: weekStart ? Math.max(0, total - weekStart.base) : 0,
      minutes: Math.floor(seconds / 60),
      days: days.filter((k) => this.days[k]?.active).length,
    };
  }
}
