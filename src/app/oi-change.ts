import type { OiBar } from './store.ts';

/**
 * The change in open interest that each bar stands for: its close minus the close of the bar before it (the first bar has none, so 0).
 * Open interest is a level that is read now and then, and a bar that holds a single reading has the same open and close: only the step
 * from one bar's close to the next shows that it moved. The pane, the statistics under the footprint and the sounds all use this one
 * definition, so what one shows the others mean.
 */
export function oiDeltas(bars: readonly OiBar[]): Float64Array {
  const out = new Float64Array(bars.length);
  for (let i = 1; i < bars.length; i++) out[i] = bars[i]![4] - bars[i - 1]![4];
  return out;
}

/** The same by bar time, for a lookup (the first bar, which has no bar before it, is left out). */
export function oiDeltaByTime(bars: Iterable<OiBar>): Map<number, number> {
  const sorted = [...bars].sort((a, b) => a[0] - b[0]), delta = oiDeltas(sorted), out = new Map<number, number>();
  for (let i = 1; i < sorted.length; i++) out.set(sorted[i]![0], delta[i]!);
  return out;
}

/** One venue's open-interest bars (its perpetual, in coins) on the chart's timeframe. */
export interface OiPart { id: string; bars: readonly OiBar[] }
/**
 * Several venues' open interest added together (the aggregated pane): `bars` the sum at every bar time any of them has, `venues` how many
 * it counts there, and `change` each bar's change of open interest with `counted`, the venues it is made of.
 *
 * Open interest is a level read now and then, so a venue with no bar at a time (it was read every five minutes, or a reading was missed) is
 * counted at its last reading for up to `carryMs`. A bar's change is the sum of each venue's own change from the bar before (one timeframe
 * earlier) over the venues present at both, never the difference of two sums: a venue whose readings start (or stop) would otherwise show
 * as its whole open interest opened (or closed) in one bar. A bar with no venue present at both has no change.
 */
export interface OiSum { bars: OiBar[]; venues: number[]; change: Map<number, number>; counted: Map<number, number> }
export function sumOi(parts: readonly OiPart[], tfMs: number, carryMs = Math.max(2 * tfMs, 10 * 60_000)): OiSum {
  const times = [...new Set(parts.flatMap(p => p.bars.map(b => b[0])))].sort((a, b) => a - b);
  // Each venue's bar (its own, or its last reading carried) at each time, or null.
  const at = parts.map(part => {
    const own = new Map(part.bars.map(b => [b[0], b] as const)), out: (OiBar | null)[] = [];
    let last: OiBar | null = null;
    for (const t of times) {
      const bar = own.get(t);
      if (bar) { last = bar; out.push(bar); }
      else out.push(last && t - last[0] <= carryMs ? [t, last[4], last[4], last[4], last[4]] : null);
    }
    return out;
  });
  const bars: OiBar[] = [], venues: number[] = [], change = new Map<number, number>(), counted = new Map<number, number>();
  times.forEach((t, i) => {
    const bar: OiBar = [t, 0, 0, 0, 0]; let n = 0, d = 0, both = 0;
    for (const series of at) {
      const b = series[i]; if (!b) continue;
      n++; bar[1] += b[1]; bar[2] += b[2]; bar[3] += b[3]; bar[4] += b[4];
      const before = i > 0 && times[i - 1] === t - tfMs ? series[i - 1] : null;
      if (before) { d += b[4] - before[4]; both++; }
    }
    if (!n) return;
    bars.push(bar); venues.push(n);
    if (both) { change.set(t, d); counted.set(t, both); }
  });
  return { bars, venues, change, counted };
}

const sums = new WeakMap<readonly OiPart[], { tfMs: number; sum: OiSum }>();
/** `sumOi` worked out once per set of parts and timeframe (what the store holds is replaced, never changed, so its reference says when). */
export function oiSumOf(parts: readonly OiPart[], tfMs: number): OiSum {
  const held = sums.get(parts);
  if (held && held.tfMs === tfMs) return held.sum;
  const sum = sumOi(parts, tfMs); sums.set(parts, { tfMs, sum });
  return sum;
}

/**
 * Each bar's change of open interest, by bar time, as every view of it counts it: the venues' own changes added up when the pane adds venues
 * together (`parts`), else the bar's close minus the close of the bar before.
 */
export function oiChangeByTime(bars: readonly OiBar[], parts: readonly OiPart[], tfMs: number): Map<number, number> {
  return parts.length > 1 ? oiSumOf(parts, tfMs).change : oiDeltaByTime(bars);
}
