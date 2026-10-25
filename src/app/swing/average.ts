import type { SwingCandle } from './model.ts';

/**
 * LMF's own index of a coin from its venues' candles: open, high, low and close each averaged over the venues that have the candle, as an
 * exchange index averages its exchanges. A candle is kept only where at least half of the venues that have any candles have it, so a
 * stretch few venues reach back to, or a candle only the quickest venue has opened, is never one venue's price.
 */
export function averageCandles(venues: readonly (readonly SwingCandle[])[]): SwingCandle[] {
  const reporting = venues.filter(v => v.length).length;
  if (!reporting) return [];
  const need = Math.ceil(reporting / 2), sums = new Map<number, { n: number; o: number; h: number; l: number; c: number }>();
  for (const series of venues) {
    for (const k of series) {
      const s = sums.get(k.t);
      if (s) { s.n++; s.o += k.o; s.h += k.h; s.l += k.l; s.c += k.c; } else sums.set(k.t, { n: 1, o: k.o, h: k.h, l: k.l, c: k.c });
    }
  }
  const out: SwingCandle[] = [];
  for (const [t, s] of sums) if (s.n >= need) out.push({ t, o: s.o / s.n, h: s.h / s.n, l: s.l / s.n, c: s.c / s.n });
  return out.sort((a, b) => a.t - b.t);
}

/**
 * The average moved with the trades of one of its venues (the chart's own market) between reads. Its newest candle moves as that venue has
 * since it was read: the close by as much, the high and low by any new extreme. A candle the venue has opened since the read is added at
 * the average's level (the venue's candle shifted by the gap between the two at the newest read candle). `read` is that venue's candles
 * as read, in time order; `live` its newest candle as traded.
 */
export function withLive(average: readonly SwingCandle[], read: readonly SwingCandle[], live: SwingCandle): SwingCandle[] {
  const last = average[average.length - 1];
  if (!last || live.t < last.t) return [...average];
  let at: SwingCandle | undefined;
  for (let i = read.length - 1; i >= 0; i--) if (read[i]!.t <= last.t) { if (read[i]!.t === last.t) at = read[i]; break; }
  if (!at) return [...average];
  const out = average.slice();
  if (live.t === last.t) {
    const c = last.c + (live.c - at.c);
    out[out.length - 1] = { t: last.t, o: last.o, h: Math.max(last.h + Math.max(0, live.h - at.h), c, last.o), l: Math.min(last.l + Math.min(0, live.l - at.l), c, last.o), c };
  } else {
    const shift = last.c - at.c;
    out.push({ t: live.t, o: live.o + shift, h: live.h + shift, l: live.l + shift, c: live.c + shift });
  }
  return out;
}
