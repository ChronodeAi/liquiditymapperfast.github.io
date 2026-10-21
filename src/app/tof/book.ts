import { TIMEFRAMES } from '../hub.ts';
import type { AppState, Market } from '../store.ts';
import { FlowCache } from '../delta/candles.ts';
import { deltaFlows, ensureDeltaFlow, type FlowLoader } from '../delta/flows.ts';
import { minZOf } from './settings.ts';
import { TOF_WINDOW, tofLevels, tofOf, tofScores, type TofCandle, type TofLevel } from './model.ts';

/**
 * The TOF pane's numbers, shared with the levels it draws on the main chart: the chart's own candles from `TOF_WINDOW` before the view to its
 * end, each venue's taker volume in them from the flow book, and each venue's reading, z and usual; their total's too, and the levels it leaves.
 */

/** The venues the pane reads, in order: Binance's and Bybit's perpetuals of the coin, where the page lists them. */
export const TOF_VENUES = ['binance', 'bybit'] as const;

/** One venue's candle: its reading, z and usual, and its taker buys and sells (USD). Null where nothing was recorded. */
export interface TofCell { tof: number | null; z: number | null; usual: number | null; buy: number; sell: number }
export interface TofRow { candle: TofCandle; cells: (TofCell | null)[]; total: number | null; z: number | null; usual: number | null }
export interface TofModel { ids: string[]; tf: number; rows: TofRow[]; levels: TofLevel[]; earliest: number | null }

const coinOf = (m: Market): string => String(m.base ?? '').toUpperCase().replace(/^XBT$/, 'BTC');

/** The coin's perpetual on each of `TOF_VENUES` that the page lists, in that order. */
export function tofIds(state: Pick<AppState, 'markets' | 'marketId'>): string[] {
  const idOf = (m: Market): string => m.instrumentId ?? m.id ?? '';
  const chart = state.markets.find(m => idOf(m) === state.marketId), coin = chart ? coinOf(chart) : '';
  if (!coin) return [];
  return TOF_VENUES.flatMap(venue => { const m = state.markets.find(x => x.venue === venue && x.marketType === 'perpetual' && coinOf(x) === coin && idOf(x)); return m ? [idOf(m)] : []; });
}

/** Works the model out once per change of what it depends on; the pane and the map both ask for it each frame. */
export class TofBook {
  #caches = new Map<string, FlowCache>();
  #last: { key: string; model: TofModel | null } | null = null;

  model(state: AppState, hub: FlowLoader, t0: number, t1: number, now: number): TofModel | null {
    const tf = TIMEFRAMES[state.timeframe] ?? 3_600_000, ids = tofIds(state), flow = hub.flow;
    const own = state.seriesInstrument === state.marketId ? state.candles : [];
    if (!ids.length || !own.length) return null;
    const from = Math.floor(t0 / tf) * tf - TOF_WINDOW * tf, to = Math.min(t1, now);
    const last = own[own.length - 1]!, key = `${ids.join(',')}|${tf}|${own.length}|${own[0]![0]}|${last[0]}|${last[2]}|${last[3]}|${last[4]}|${flow.version}|${from}|${Math.floor(to / 1000)}|${state.tof.from}`;
    if (this.#last?.key === key) return this.#last.model;
    ensureDeltaFlow(hub, ids, from, Date.now());
    const candles: TofCandle[] = own.filter(c => c[0] >= from && c[0] <= to).map(c => ({ t: c[0], o: c[1], h: c[2], l: c[3] }));
    const starts = candles.map(c => c.t);
    let earliest: number | null = null;
    const perVenue = ids.map(id => {
      let cache = this.#caches.get(id); if (!cache) { cache = new FlowCache(); this.#caches.set(id, cache); }
      const { raw, earliest: first } = deltaFlows(cache, flow, [id], starts, tf, now);
      if (first !== null && (earliest === null || first < earliest)) earliest = first;
      const tof = raw.map((f, i) => f ? tofOf(f.gross, candles[i]!) : null), { z, usual } = tofScores(tof);
      return raw.map((f, i): TofCell | null => f ? { tof: tof[i]!, z: z[i]!, usual: usual[i]!, buy: (f.gross + f.delta) / 2, sell: (f.gross - f.delta) / 2 } : null);
    });
    // The total counts a candle only when every venue has it, so a venue starting to record does not read as a burst.
    const totals = candles.map((_, i) => perVenue.every(v => v[i]?.tof !== null && v[i]?.tof !== undefined) ? perVenue.reduce((a, v) => a + v[i]!.tof!, 0) : null);
    const scored = tofScores(totals);
    const rows = candles.map((candle, i): TofRow => ({ candle, cells: perVenue.map(v => v[i] ?? null), total: totals[i]!, z: scored.z[i]!, usual: scored.usual[i]! }));
    const model: TofModel = { ids, tf, rows, levels: tofLevels(candles, totals, scored.z, minZOf(state.tof.from)), earliest };
    this.#last = { key, model };
    return model;
  }
}
