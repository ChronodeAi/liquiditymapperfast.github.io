import { TIMEFRAMES } from '../../shared/series.ts';
import { CANDLE_VENUES } from '../../shared/history.ts';
import { instrumentIdFor, type Coin } from '../../shared/coins.ts';
import { PRICE_QUERY_BARS, priceInstrument, priceListing, type PriceHistoryAnswer, type PriceTarget } from '../../shared/price-history.ts';
import { currentCoin } from '../coin.ts';
import type { AppState } from '../store.ts';
import { averageCandles, withLive } from './average.ts';
import { swingRows, type SwingCandle, type SwingRow } from './model.ts';

export type SwingReader = (id: string, tf: string, from: number, to: number, signal: AbortSignal) => Promise<PriceHistoryAnswer>;
export interface SwingModel {
  rows: SwingRow[]; tfMs: number;
  /** The markets in the average: every venue read so far that has candles. */
  venues: PriceTarget[];
  /** `loading` before the first answer, `failed` when there is still nothing after one, `empty` when the history has no candles. */
  status: 'ok' | 'loading' | 'failed' | 'empty';
}

/** Read each venue's newest stretch again this often; it is all a reading of the candle under way needs from the history. */
const REFRESH_MS = 60_000;
/** The newest stretch read again: enough to replace the candles that may have closed since the last read. */
const TAIL_BARS = 50;
/**
 * A venue whose first read fails is asked for half as many candles the next minute, down to this: a venue that builds the timeframe from
 * finer candles (Coinbase's and Deribit's 4h from 1h) can take more pages for `PRICE_QUERY_BARS` than a read's deadline allows.
 */
const MIN_FIRST_BARS = 250;

/** Every market of the coin whose price history the page reads, one listing per venue: for BTC, eleven. */
export function swingTargets(coin: Coin): PriceTarget[] {
  const out: PriceTarget[] = [];
  for (const venue of CANDLE_VENUES) {
    const id = instrumentIdFor(venue, coin), target = id ? priceListing(coin, id) : null;
    if (target) out.push(target);
  }
  return out;
}

interface VenueRead {
  target: PriceTarget; candles: Map<number, SwingCandle>; status: SwingModel['status']; readAt: number; inflight: AbortController | null;
  /** How many candles the first read asks for (halved after each failed first read). */
  first: number;
}

/**
 * The Swing pane's candles and readings. The readings need a few hundred candles before the ones in view, more than the chart holds and
 * older than the server records, so the candles come from the public price histories at the chart's timeframe of every venue the page
 * reads that lists the coin (`swingTargets`), averaged candle by candle into LMF's own index of it (`averageCandles`). Each venue is read
 * for the most one read gives (`PRICE_QUERY_BARS`, up to now; half as many after a failed first read) once per coin and timeframe, then for
 * its newest stretch every minute while the pane draws; one that cannot be read is left out of the average until it can. Where the chart
 * shows one of those markets, its newest candle moves the average's between reads (`withLive`), so the candle under way moves with the
 * trades. Replay cuts every candle not closed at its moment (one under way would carry its future). The readings are worked out once per
 * change.
 */
export class SwingBook {
  #key = '';
  #venues: VenueRead[] = [];
  #version = 0;
  #average: { version: number; candles: SwingCandle[]; reads: Map<string, SwingCandle[]> } | null = null;
  #cache: { key: string; model: SwingModel } | null = null;

  constructor(private read: SwingReader | null, private changed: () => void, private now: () => number = Date.now) {}

  /** The readings for the coin and the chart's timeframe, as of `at` (cut there when `replay`); null without a venue to read. */
  model(state: AppState, at: number, replay: boolean): SwingModel | null {
    const tf = state.timeframe, tfMs = TIMEFRAMES[tf];
    if (!tfMs || !this.read) return null;
    const coin = currentCoin(), key = `${coin.coin}|${tfMs}`;
    if (key !== this.#key) {
      for (const v of this.#venues) v.inflight?.abort();
      this.#key = key; this.#version++;
      this.#venues = swingTargets(coin).map(target => ({ target, candles: new Map(), status: 'loading', readAt: 0, inflight: null, first: PRICE_QUERY_BARS }));
    }
    if (!this.#venues.length) return null;
    for (const v of this.#venues) this.#refresh(v, tf, tfMs);
    // The chart's own newest candle, where it is one of the averaged markets: the candle under way as trades come.
    const chart = priceInstrument(state.seriesInstrument || state.marketId), own = replay ? undefined : state.candles[state.candles.length - 1];
    const live = own && this.#venues.some(v => v.target.id === chart) ? { t: own[0], o: own[1], h: own[2], l: own[3], c: own[4] } : null;
    const cacheKey = `${key}|${this.#version}|${live ? `${chart},${live.t},${live.o},${live.h},${live.l},${live.c}` : ''}|${replay ? Math.floor(at / tfMs) : ''}`;
    if (this.#cache?.key === cacheKey) return this.#cache.model;
    if (this.#average?.version !== this.#version) {
      const reads = new Map(this.#venues.map(v => [v.target.id, [...v.candles.values()].sort((a, b) => a.t - b.t)]));
      this.#average = { version: this.#version, candles: averageCandles([...reads.values()]), reads };
    }
    let candles = live ? withLive(this.#average.candles, this.#average.reads.get(chart) ?? [], live) : this.#average.candles;
    if (replay) candles = candles.filter(c => c.t + tfMs <= at);
    const status: SwingModel['status'] = candles.length ? 'ok'
      : this.#venues.some(v => v.status === 'loading') ? 'loading' : this.#venues.every(v => v.status === 'failed') ? 'failed' : 'empty';
    const model: SwingModel = { rows: swingRows(candles), tfMs, venues: this.#venues.filter(v => v.candles.size).map(v => v.target), status };
    this.#cache = { key: cacheKey, model };
    return model;
  }

  #refresh(v: VenueRead, tf: string, tfMs: number): void {
    const now = this.now();
    if (v.inflight || now - v.readAt < REFRESH_MS) return;
    const to = Math.ceil((now + 1) / tfMs) * tfMs, bars = v.candles.size ? TAIL_BARS : v.first;
    const controller = v.inflight = new AbortController(), key = this.#key;
    this.read!(v.target.id, tf, to - bars * tfMs, to, controller.signal).then(answer => {
      if (key !== this.#key) return;
      for (const c of answer.candles) v.candles.set(c[0], { t: c[0], o: c[1], h: c[2], l: c[3], c: c[4] });
      v.status = v.candles.size ? 'ok' : answer.status === 'failed' || answer.status === 'stale' ? 'failed' : 'empty';
      if (!v.candles.size && v.status === 'failed') v.first = Math.max(MIN_FIRST_BARS, Math.floor(v.first / 2));
    }, () => {
      if (key === this.#key && !v.candles.size) { v.status = 'failed'; v.first = Math.max(MIN_FIRST_BARS, Math.floor(v.first / 2)); }
    }).finally(() => {
      if (v.inflight === controller) v.inflight = null;
      if (key !== this.#key) return;
      v.readAt = this.now(); this.#version++; this.changed();
    });
  }
}
