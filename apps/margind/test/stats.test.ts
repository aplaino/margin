import { describe, expect, test } from 'bun:test';
import type { ReporterEvent } from '@margin/protocol';
import { memoryKeys } from '../src/keychain';
import type { LocalSession } from '../src/sessions';
import { Stats } from '../src/stats';
import { Store } from '../src/store';

// Local times, so day boundaries follow this Mac's time zone as they do in margind.
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute).getTime();

function setup(start: number) {
  const store = new Store(':memory:', memoryKeys()('t'));
  let now = start;
  const stats = new Stats(store, () => now);
  return { store, stats, set: (ms: number) => (now = ms) };
}

const session = (over: Partial<LocalSession> = {}): LocalSession => ({
  tool: 'claude-code',
  sessionId: 'a',
  model: 'claude-opus-5-5',
  startedAt: 0,
  lastEventAt: 0,
  order: 1,
  ...over,
});

const event = (over: Partial<ReporterEvent>): ReporterEvent => ({
  tool: 'claude-code',
  event: 'prompt',
  sessionId: 'a',
  ...over,
});

describe('stats', () => {
  test('history from before Margin counts toward all time, not today', () => {
    const { stats } = setup(at(22, 9));
    stats.tokens(5_000_000);
    expect(stats.view(5_000_000)).toMatchObject({ today: 0, week: 0, minutes: 0, days: 0 });
    stats.tokens(5_200_000);
    expect(stats.view(5_200_000)).toMatchObject({
      today: 200_000,
      week: 200_000,
      minutes: 0,
      days: 1,
    });
  });

  test('today starts again at local midnight; the week keeps 7 days; daily keeps 14', () => {
    const { stats, set } = setup(at(14, 9));
    stats.tokens(1_000);
    stats.tokens(2_000); // 1,000 on the 14th
    set(at(20, 9));
    stats.tokens(2_000);
    stats.tokens(3_000); // 1,000 on the 20th
    set(at(21, 0, 1));
    stats.tokens(3_000);
    stats.tokens(3_500); // 500 on the 21st
    const view = stats.view(3_500);
    expect(view).toMatchObject({ today: 500, week: 1_500, days: 3 });
    expect(view.daily).toEqual([0, 0, 0, 0, 0, 0, 1_000, 0, 0, 0, 0, 0, 1_000, 500]);
    // A week on, only the 21st is in the week; the 14th is still one of the 14 days.
    set(at(27, 9));
    expect(stats.view(3_500)).toMatchObject({ today: 0, week: 500, days: 3 });
  });

  test('time counts only while working, and never across a sleep', () => {
    const { stats, set } = setup(at(22, 9));
    stats.tokens(0);
    stats.tick(session());
    set(at(22, 9) + 30_000);
    stats.tick(session()); // 30 s
    set(at(22, 9, 1));
    stats.tick(undefined); // idle: not counted
    set(at(22, 9, 1) + 30_000);
    stats.tick(session()); // 30 s
    set(at(22, 11));
    stats.tick(session()); // a two-hour gap: asleep
    for (let i = 1; i <= 120; i++) {
      set(at(22, 11) + i * 30_000);
      stats.tick(session());
    }
    expect(stats.view(0)).toMatchObject({ minutes: 61, days: 1, longest: 61 });
  });

  test('prompts and sessions count coding tools only; the longest session and main tool win', () => {
    const { stats, set } = setup(at(22, 9));
    stats.tokens(0);
    stats.event(event({}), true);
    stats.event(event({}), false);
    stats.event(event({ event: 'stop' }), false);
    stats.event(event({ tool: 'codex', sessionId: 'b' }), true);
    stats.event(event({ tool: 'shell', sessionId: 'shell-1' }), true);
    stats.event(event({ tool: 'ollama', sessionId: 'ollama' }), true);
    // 20 minutes in Claude Code's session, then 5 in Codex.
    stats.tick(session());
    for (let i = 1; i <= 40; i++) {
      set(at(22, 9) + i * 30_000);
      stats.tick(session());
    }
    const codex = session({ tool: 'codex', sessionId: 'b', model: 'gpt-6.1-sol' });
    for (let i = 41; i <= 50; i++) {
      set(at(22, 9) + i * 30_000);
      stats.tick(codex);
    }
    expect(stats.view(0)).toMatchObject({
      promptsToday: 3,
      promptsWeek: 3,
      prompts: 3,
      sessions: 2,
      minutes: 25,
      longest: 20,
      tool: 'claude-code',
      model: 'claude-opus-5-5',
    });
    // The next day: today starts again, the week and all time keep counting.
    set(at(23, 9));
    stats.event(event({}), false);
    expect(stats.view(0)).toMatchObject({ promptsToday: 1, promptsWeek: 4, prompts: 4 });
  });

  test('a model named like a local folder is never recorded, so it can never be sent later', () => {
    const { stats, set } = setup(at(22, 9));
    const local = session({ model: 'acme-secret-v2' });
    stats.tick(local, ['acme-secret']);
    set(at(22, 9) + 30_000);
    stats.tick(local, ['acme-secret']);
    const view = stats.view(0);
    expect(view.model).toBeUndefined();
    expect(view.tool).toBe('claude-code');
  });

  test('days older than 14 are dropped, and the log survives a restart', () => {
    const { store, stats, set } = setup(at(1, 9));
    stats.tokens(0);
    stats.tokens(10);
    set(at(16, 9));
    stats.tokens(10);
    stats.tokens(20);
    expect(Object.keys(store.getJson<Record<string, unknown>>('stats') ?? {})).toEqual([
      '2026-11-16',
    ]);
    const again = new Stats(store, () => at(16, 10));
    again.tokens(25);
    expect(again.view(25)).toMatchObject({ today: 15, week: 15, minutes: 0, days: 1 });
  });
});
