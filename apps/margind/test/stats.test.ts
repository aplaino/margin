import { describe, expect, test } from 'bun:test';
import { memoryKeys } from '../src/keychain';
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

describe('stats', () => {
  test('history from before Margin counts toward all time, not today', () => {
    const { stats } = setup(at(22, 9));
    stats.tokens(5_000_000);
    expect(stats.view(5_000_000)).toEqual({ today: 0, week: 0, minutes: 0, days: 0 });
    stats.tokens(5_200_000);
    expect(stats.view(5_200_000)).toEqual({ today: 200_000, week: 200_000, minutes: 0, days: 1 });
  });

  test('today starts again at local midnight; the week keeps 7 days', () => {
    const { stats, set } = setup(at(14, 9));
    stats.tokens(1_000);
    stats.tokens(2_000); // 1,000 on the 14th
    set(at(20, 9));
    stats.tokens(2_000);
    stats.tokens(3_000); // 1,000 on the 20th
    set(at(21, 0, 1));
    stats.tokens(3_000);
    stats.tokens(3_500); // 500 on the 21st
    expect(stats.view(3_500)).toEqual({ today: 500, week: 1_500, minutes: 0, days: 3 });
    // A week on, only the 21st is in the week; the 14th is still one of the 14 days.
    set(at(27, 9));
    expect(stats.view(3_500)).toEqual({ today: 0, week: 500, minutes: 0, days: 3 });
  });

  test('time counts only while working, and never across a sleep', () => {
    const { stats, set } = setup(at(22, 9));
    stats.tokens(0);
    stats.tick(true);
    set(at(22, 9) + 30_000);
    stats.tick(true); // 30 s
    set(at(22, 9, 1));
    stats.tick(false); // idle: not counted
    set(at(22, 9, 1) + 30_000);
    stats.tick(true); // 30 s
    set(at(22, 11));
    stats.tick(true); // a two-hour gap: asleep
    for (let i = 1; i <= 120; i++) {
      set(at(22, 11) + i * 30_000);
      stats.tick(true);
    }
    expect(stats.view(0)).toEqual({ today: 0, week: 0, minutes: 61, days: 1 });
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
    expect(again.view(25)).toEqual({ today: 15, week: 15, minutes: 0, days: 1 });
  });
});
