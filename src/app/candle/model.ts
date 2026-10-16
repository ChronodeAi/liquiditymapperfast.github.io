/**
 * The phone's Candle view, the parts that are only numbers: where each column of the screen goes, which prices the screen shows and in
 * rows of what size, which arrivals light the rail, the age ruler under the trail, and the view's own settings. No DOM and no canvas, so
 * every rule here is tested (tests/candle-model.test.mts).
 *
 * The screen, left to right: the trail's oldest edge, the bids (bars growing left from the candle), the candle with its footprint, the asks
 * (bars growing right), the arrival rail (orders as they come in, by arrival), and the price axis. The trail runs behind the book and the
 * candle, by exchange time, from the rail's left edge (now) to the left edge (the trail's window ago).
 */
export type TrailStyle = 'phosphor' | 'etched' | 'beads';
export const TRAIL_STYLES: readonly TrailStyle[] = ['phosphor', 'etched', 'beads'];
/** How far back the trail reaches, in ms: the full width of the screen. */
export const TRAIL_WINDOWS: readonly number[] = [30_000, 60_000, 120_000];
/** The candle's own timeframes (it does not follow the map's: an hourly candle seen from a cold start is mostly empty for most of an hour). */
export const CANDLE_TIMEFRAMES: readonly string[] = ['1m', '5m', '15m', '1h'];

/** `glass`: the candle is frosted glass with the trail diffused behind it, rather than a solid panel that hides it. */
export interface CandleSettings { style: TrailStyle; trailMs: number; tf: string; glass: boolean }
export const CANDLE_DEFAULTS: Readonly<CandleSettings> = Object.freeze({ style: 'phosphor', trailMs: 60_000, tf: '5m', glass: true });
/** The view's settings live apart from the page's saved state and layouts: they are a phone's, and a desktop never reads them. */
export const CANDLE_SETTINGS_KEY = 'hlm-candle-v1';

/** A saved value field by field, each one that does not check out replaced by its default. */
export function readCandleSettings(raw: unknown): CandleSettings {
  const o = raw && typeof raw === 'object' ? raw as Partial<Record<keyof CandleSettings, unknown>> : {};
  return {
    style: TRAIL_STYLES.includes(o.style as TrailStyle) ? o.style as TrailStyle : CANDLE_DEFAULTS.style,
    trailMs: typeof o.trailMs === 'number' && TRAIL_WINDOWS.includes(o.trailMs) ? o.trailMs : CANDLE_DEFAULTS.trailMs,
    tf: typeof o.tf === 'string' && CANDLE_TIMEFRAMES.includes(o.tf) ? o.tf : CANDLE_DEFAULTS.tf,
    glass: typeof o.glass === 'boolean' ? o.glass : CANDLE_DEFAULTS.glass,
  };
}

/** Columns of the screen in CSS px, left edge inclusive. Bids grow left from `bidX1`, asks right from `askX0`. */
export interface CandleLayout {
  w: number; h: number;
  /** The plot's top and bottom (the age ruler is below `plotY1`). */
  plotY0: number; plotY1: number;
  bidX0: number; bidX1: number; candleX0: number; candleX1: number; askX0: number; askX1: number;
  railX0: number; railX1: number; axisX0: number; axisX1: number;
  /** The trail: `trailX1` is now, `trailX0` the window ago. */
  trailX0: number; trailX1: number;
}

export const AXIS_W = 46, RAIL_W = 30, MARGIN = 6, GAP = 4, RULER_H = 18;

/**
 * Split a `w` x `h` view. The candle takes about three tenths of the width (96 to 140 px: two footprint numbers a row and their bars), the
 * book's two sides share what is left between the margin and the rail, and the trail spans everything left of the rail.
 */
export function candleLayout(w: number, h: number): CandleLayout {
  const axisX1 = w, axisX0 = w - AXIS_W, railX1 = axisX0, railX0 = railX1 - RAIL_W;
  const room = Math.max(0, railX0 - MARGIN);
  const candleW = Math.round(Math.max(96, Math.min(140, w * 0.3, room - 2 * GAP - 40)));
  const side = Math.max(20, Math.floor((room - candleW - 2 * GAP) / 2));
  const bidX0 = MARGIN, bidX1 = bidX0 + side, candleX0 = bidX1 + GAP, candleX1 = candleX0 + candleW, askX0 = candleX1 + GAP, askX1 = Math.min(railX0 - 2, askX0 + side);
  return { w, h, plotY0: 8, plotY1: Math.max(9, h - RULER_H), bidX0, bidX1, candleX0, candleX1, askX0, askX1, railX0, railX1, axisX0, axisX1, trailX0: 0, trailX1: railX0 };
}

/** The prices on screen: `p1` at `y0` (the top), `p0` at `y1`. */
export interface PriceScale { p0: number; p1: number; y0: number; y1: number }
export const yOf = (s: PriceScale, price: number): number => s.y0 + (s.p1 - price) / (s.p1 - s.p0) * (s.y1 - s.y0);
export const priceAt = (s: PriceScale, y: number): number => s.p1 - (y - s.y0) / (s.y1 - s.y0) * (s.p1 - s.p0);

/** The smallest span of prices shown, as a share of the price: a quiet bar is not blown up until its four ticks fill the screen. */
export const MIN_SPAN = 0.0012;

/**
 * Which prices to show for a candle from `lo` to `hi` with the price at `mark`: the candle and a third again, at least `MIN_SPAN` of the
 * price, times `zoom` (a pinch: above 1 shows more), moved by `pan` (price units) and then back far enough that the price stays inside the
 * middle four fifths, so the live edge is never off screen.
 */
export function priceSpan(lo: number, hi: number, mark: number, y0: number, y1: number, zoom = 1, pan = 0): PriceScale {
  const ref = mark > 0 ? mark : (lo + hi) / 2;
  const low = Math.min(lo > 0 ? lo : ref, ref), high = Math.max(hi > 0 ? hi : ref, ref);
  const span = Math.max((high - low) * 1.35, ref * MIN_SPAN) * Math.max(0.05, zoom);
  let mid = (low + high) / 2 + pan;
  const inner = span * 0.4;
  if (ref > mid + inner) mid = ref - inner; else if (ref < mid - inner) mid = ref + inner;
  return { p0: mid - span / 2, p1: mid + span / 2, y0, y1 };
}

/** The footprint row step for the screen: the finest recorded step doubled until a row is at least `minPx` tall. 0 before the step is known. */
export function rowStepFor(fine: number, scale: PriceScale, minPx = 16): number {
  if (!(fine > 0)) return 0;
  const pxPerPrice = (scale.y1 - scale.y0) / (scale.p1 - scale.p0);
  let step = fine;
  for (let i = 0; i < 40 && step * pxPerPrice < minPx; i++) step *= 2;
  return step;
}

/** One order as the rail reads it: its price, signed USD (a buy positive), when it arrived (the page's clock, ms) and its market (the ring's index). */
export interface Arrival { price: number; usd: number; at: number; inst: number }

/** What arrived at one row of the rail over a stretch: bought and sold USD, how many orders, the largest and its market, and the newest arrival. */
export interface RailCell { bin: number; buy: number; sell: number; count: number; largest: number; largestInst: number; at: number }

/** Add up the arrivals in [from, to] by row (`step` wide), busiest row first. */
export function railCells(orders: readonly Arrival[], step: number, from: number, to: number): RailCell[] {
  if (!(step > 0)) return [];
  const cells = new Map<number, RailCell>();
  for (const o of orders) {
    if (!(o.at >= from && o.at <= to) || !(o.price > 0) || !Number.isFinite(o.usd) || o.usd === 0) continue;
    const bin = Math.floor(o.price / step);
    let c = cells.get(bin); if (!c) { c = { bin, buy: 0, sell: 0, count: 0, largest: 0, largestInst: o.inst, at: o.at }; cells.set(bin, c); }
    const usd = Math.abs(o.usd);
    if (o.usd > 0) c.buy += usd; else c.sell += usd;
    c.count++; if (usd > c.largest) { c.largest = usd; c.largestInst = o.inst; } c.at = Math.max(c.at, o.at);
  }
  return [...cells.values()].sort((a, b) => (b.buy + b.sell) - (a.buy + a.sell));
}

/**
 * How long a flash takes to fade (ms), how long the mark of its exchange stays beside it, and the most lit at once (more than a handful at
 * once reads as noise, not as the large ones). A flashbulb's envelope: at full strength on arrival, falling off fast, then a short tail.
 */
export const FLASH_MS = 420, FLASH_MARK_MS = 1_200, MAX_FLASHES = 8;
export const flashStrength = (age: number): number => age < 0 || age >= FLASH_MS ? 0 : (1 - age / FLASH_MS) ** 1.6;

/**
 * The rows that flash now, from the arrivals of at least `minUsd` alone: a small order arriving later in a row must not light a large one's
 * flash again (nor date its exchange mark). Largest first, at most `max`, each with how lit it is (1 to 0) by its own arrival.
 */
export function flashes(orders: readonly Arrival[], step: number, minUsd: number, now: number, max = MAX_FLASHES): (RailCell & { k: number })[] {
  const cells = railCells(orders.filter(o => Math.abs(o.usd) >= minUsd), step, now - FLASH_MS, now);
  return cells.filter(c => now - c.at >= 0 && now - c.at < FLASH_MS)
    .sort((a, b) => b.largest - a.largest).slice(0, max)
    .map(c => ({ ...c, k: flashStrength(now - c.at) }));
}

/** A flash's radius (CSS px) for its largest order: `r0` at `lo` USD and below, `r1` at `hi` and above, logarithmic between. */
export function flashRadius(usd: number, lo: number, hi: number, r0 = 3, r1 = 9): number {
  if (!(usd > lo)) return r0;
  if (usd >= hi) return r1;
  return r0 + (r1 - r0) * Math.log(usd / lo) / Math.log(hi / lo);
}

/** The age ruler's marks: now at the right, then every quarter of the window, with how long ago each is in seconds. */
export function ageTicks(trailMs: number): { ms: number; seconds: number }[] {
  const out: { ms: number; seconds: number }[] = [];
  for (let i = 0; i <= 4; i++) out.push({ ms: trailMs * i / 4, seconds: Math.round(trailMs * i / 4000) });
  return out;
}

/** The x of an order `age` ms old on the trail (clamped to its ends). */
export const trailX = (l: Pick<CandleLayout, 'trailX0' | 'trailX1'>, age: number, trailMs: number): number => l.trailX1 - Math.max(0, Math.min(1, age / trailMs)) * (l.trailX1 - l.trailX0);

/** The time left in a bar as "m:ss" (or "h:mm:ss"). */
export function countdownText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

/** A stretch the recording may have missed: the page hidden (a phone suspends it), or a market's book off the map (its feed reconnecting). */
export interface Gap { from: number; to: number }

/**
 * Whether a forming bar's footprint can be judged (its imbalance colours and point of control): the recording began before the bar opened
 * (`recordedSince`, the source's first recorded time, 0 when unknown), no gap the page saw (`gaps`: the page hidden, a counted market's book
 * gone) touches the bar, and its minutes with rows (`Bar.minutes`) leave none out, but the one under way in its first seconds, whose first
 * trades may not be in the last answer yet. `minutes` counts the minutes any market traded in, so this is what can be told without a
 * coverage record per market: a market that stopped sending trades while its book stayed on the map is not seen (AGENTS.md, the Candle tab).
 */
export const MINUTE_GRACE_MS = 15_000;
export function barComplete(minutes: number | undefined, barT: number, now: number, recordedSince: number, gaps: readonly Gap[] = []): boolean {
  if (!(recordedSince > 0) || recordedSince > barT || minutes === undefined) return false;
  if (gaps.some(g => g.to >= barT && g.from <= now)) return false;
  const elapsed = Math.max(1, Math.ceil((now - barT) / 60_000)), into = (now - barT) % 60_000;
  return minutes >= elapsed || (minutes === elapsed - 1 && into < MINUTE_GRACE_MS);
}

/** The row with the most volume (bought and sold together), or -1: the footprint's point of control. */
export function pocIndex(rows: readonly (readonly [number, number, number])[]): number {
  let best = -1, most = 0;
  rows.forEach((r, i) => { const v = r[1] + r[2]; if (v > most) { most = v; best = i; } });
  return best;
}
