import { TIMEFRAMES } from '../../shared/series.ts';
import { PRICE_QUERY_BARS, priceInstrument, priceTarget, type PriceHistoryAnswer, type PriceTarget } from '../../shared/price-history.ts';
import { currentCoin } from '../coin.ts';
import { kindOf } from '../scope.ts';
import type { AppState } from '../store.ts';
import { swingRows, type SwingCandle, type SwingRow } from './model.ts';

export type SwingReader = (id: string, tf: string, from: number, to: number, signal: AbortSignal) => Promise<PriceHistoryAnswer>;
export interface SwingModel {
  rows: SwingRow[]; tfMs: number; target: PriceTarget;
  /** `loading` before the first answer, `failed` when there is still nothing after one, `empty` when the history has no candles. */
  status: 'ok' | 'loading' | 'failed' | 'empty';
}

/** Read the newest stretch again this often; it is all a reading of the candle under way needs from the history. */
const REFRESH_MS = 60_000;
/** The newest stretch read again: enough to replace the candles that may have closed since the last read. */
const TAIL_BARS = 50;

/**
 * The Swing pane's candles and readings. The readings need a few hundred candles before the ones in view, more than the chart holds and
 * older than the server records, so the candles are the public price history's at the chart's timeframe (`priceTarget`: Binance's market of
 * the coin and the chart's kind): the most one read gives (`PRICE_QUERY_BARS`, up to now) once per market and timeframe, then its newest
 * stretch every minute while the pane draws. Where the chart shows that very market, its own newest candle is laid over the history's, so
 * the candle under way moves with the trades. Replay cuts every candle not closed at its moment (one under way would carry its future).
 * The readings are worked out once per change.
 */
export class SwingBook {
  #key = '';
  #candles = new Map<number, SwingCandle>();
  /** The newest candle's start in `#candles` (-Infinity while empty). */
  #lastT = -Infinity;
  #status: SwingModel['status'] = 'loading';
  #readAt = 0;
  #inflight: AbortController | null = null;
  #version = 0;
  #cache: { key: string; model: SwingModel } | null = null;

  constructor(private read: SwingReader | null, private changed: () => void, private now: () => number = Date.now) {}

  /** The readings for the chart's market and timeframe, as of `at` (cut there when `replay`); null without a market to read. */
  model(state: AppState, at: number, replay: boolean): SwingModel | null {
    const tf = state.timeframe, tfMs = TIMEFRAMES[tf];
    const target = tfMs ? priceTarget(currentCoin(), state.marketId, kindOf(state.markets, state.marketId) ?? 'perp') : null;
    if (!tfMs || !target || !this.read) return null;
    const key = `${target.id}|${tfMs}`;
    if (key !== this.#key) {
      this.#inflight?.abort(); this.#inflight = null;
      this.#key = key; this.#candles.clear(); this.#lastT = -Infinity; this.#status = 'loading'; this.#readAt = 0; this.#version++;
    }
    this.#refresh(target, tf, tfMs);
    // The chart's own newest candle, where it is the same market: the candle under way as trades come.
    const own = priceInstrument(state.seriesInstrument || state.marketId) === target.id ? state.candles[state.candles.length - 1] : undefined;
    const live = own && own[0] >= this.#lastT ? { t: own[0], o: own[1], h: own[2], l: own[3], c: own[4] } : null;
    const cacheKey = `${key}|${this.#version}|${live ? `${live.t},${live.o},${live.h},${live.l},${live.c}` : ''}|${replay ? Math.floor(at / tfMs) : ''}`;
    if (this.#cache?.key === cacheKey) return this.#cache.model;
    const merged = new Map(this.#candles);
    if (live) merged.set(live.t, live);
    const candles = [...merged.values()].filter(c => !replay || c.t + tfMs <= at).sort((a, b) => a.t - b.t);
    const model: SwingModel = { rows: swingRows(candles), tfMs, target, status: candles.length ? 'ok' : this.#status };
    this.#cache = { key: cacheKey, model };
    return model;
  }

  #refresh(target: PriceTarget, tf: string, tfMs: number): void {
    const now = this.now();
    if (this.#inflight || now - this.#readAt < REFRESH_MS) return;
    const to = Math.ceil((now + 1) / tfMs) * tfMs, bars = this.#candles.size ? TAIL_BARS : PRICE_QUERY_BARS;
    const controller = this.#inflight = new AbortController(), key = this.#key;
    this.read!(target.id, tf, to - bars * tfMs, to, controller.signal).then(answer => {
      if (key !== this.#key) return;
      for (const c of answer.candles) { this.#candles.set(c[0], { t: c[0], o: c[1], h: c[2], l: c[3], c: c[4] }); if (c[0] > this.#lastT) this.#lastT = c[0]; }
      this.#status = this.#candles.size ? 'ok' : answer.status === 'failed' || answer.status === 'stale' ? 'failed' : 'empty';
    }, () => {
      if (key === this.#key && !this.#candles.size) this.#status = 'failed';
    }).finally(() => {
      if (this.#inflight === controller) this.#inflight = null;
      if (key !== this.#key) return;
      this.#readAt = this.now(); this.#version++; this.changed();
    });
  }
}
