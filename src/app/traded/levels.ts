import type { ProfileAnswer } from '../../shared/footprint.ts';
import { levelsOf, rowOf, type ValueLevels } from '../../shared/profile.ts';
import type { CandleRow } from '../store.ts';
import { dayWindows, lastWindows, sessionWindows, weekWindows, type ProfileWindow } from './sessions.ts';
import { resolveZone, type TradedSettings } from './settings.ts';

/**
 * The step the traded column asks its rows on: one that both its display rows and the point of control's rows are whole multiples of (and
 * of the recorder's own step, `fine`), so the bars and the levels are each read exactly from the same answer.
 */
export function requestStep(display: number, poc: number, fine: number): number {
  const a = Math.max(1, Math.round(display / fine)), b = Math.max(1, Math.round(poc / fine));
  let x = a, y = b; while (y) [x, y] = [y, x % y];
  return x * fine;
}

/** The point of control and the value area of a traded-volume answer: every instrument's rows on rows of `step`, every price that traded. */
export function answerLevels(answer: ProfileAnswer, step: number, share: number): ValueLevels | null {
  const rows = new Map<number, number>();
  for (const inst of answer.instruments) for (const [low, buy, sell] of inst.rows) {
    // A recorded row lies inside one level row (its step divides the level's): its middle says which.
    const key = rowOf(low + inst.step / 2, step);
    rows.set(key, (rows.get(key) ?? 0) + buy + sell);
  }
  return levelsOf(rows, step, share);
}

/**
 * When a past point of control was first traded through after its window ended: the first candle from `after` whose range reaches it,
 * `tolerance` either side (half a row: the levels are read from every venue, the candles are one market's, a little apart). Null when no
 * candle held reaches it: the level is still naked as far as the candles go.
 */
export function touchedAt(price: number, after: number, candles: readonly CandleRow[], tolerance: number): number | null {
  for (const c of candles) {
    if (c[0] < after) continue;
    if (c[3] - tolerance <= price && price <= c[2] + tolerance) return c[0];
  }
  return null;
}

/**
 * The windows the lines are drawn for (days, weeks or sessions; none for what is on the chart): the last `count` of each kind that have begun,
 * of those that touch [t0, t1]. Days and weeks start in the settings' zone (`page`: the page's clock).
 */
export function linesWindows(s: TradedSettings, pageZone: 'local' | 'utc', t0: number, t1: number, now: number): ProfileWindow[] {
  if (s.period === 'view') return [];
  const zone = resolveZone(s.zone, pageZone), end = Math.min(t1, now);
  const all = s.period === 'day' ? dayWindows(zone, t0, end) : s.period === 'week' ? weekWindows(zone, t0, end)
    : sessionWindows(s.sessions, t0, end, z => resolveZone(z, pageZone));
  return lastWindows(all, s.count, now);
}

/** How far before the chart's right edge the column looks for a window: a session on weekdays only is three days back over a weekend. */
const COLUMN_LOOKBACK_MS = 8 * 86_400_000;

/**
 * The window the traded column adds up when the settings pick days, weeks or sessions: the newest one that has begun by the chart's right edge
 * (`t1`, or now when that is earlier), which is the last of the windows the lines are drawn for; of the sessions, one that is under way before
 * one that has ended. Null for what is on the chart, and when no window of the period began in the eight days before (no session is on): the
 * column then follows the chart. It looks back from the right edge, not from the chart's left one, so a chart too short to hold a window
 * still has one.
 */
export function columnWindow(s: TradedSettings, pageZone: 'local' | 'utc', t1: number, now: number): ProfileWindow | null {
  const end = Math.min(t1, now), found = linesWindows({ ...s, count: 1 }, pageZone, end - COLUMN_LOOKBACK_MS, end, now);
  for (let i = found.length - 1; i >= 0; i--) if (found[i]!.to > end) return found[i]!;
  return found[found.length - 1] ?? null;
}

/** The zone a window's dates are read in: a session's own (its start is a date there), else the zone days and weeks start in. */
export function windowZone(w: ProfileWindow, s: TradedSettings, pageZone: 'local' | 'utc'): string {
  if (w.key.startsWith('session|')) {
    const def = s.sessions.find(x => x.id === w.key.split('|')[1]);
    if (def) return resolveZone(def.zone, pageZone);
  }
  return resolveZone(s.zone, pageZone);
}

/**
 * What the column's header calls its window: a session by its name and date, a week by "Week" and the date of its first day, a day by its date.
 * `date` writes a time as a date in the window's zone; `week` is the word for a week.
 */
export function windowLabel(w: ProfileWindow, date: (t: number) => string, week: string): string {
  const kind = w.key.slice(0, w.key.indexOf('|'));
  if (kind === 'session') return w.name ? `${w.name} ${date(w.from)}` : date(w.from);
  return kind === 'week' ? `${week} ${date(w.from)}` : date(w.from);
}
