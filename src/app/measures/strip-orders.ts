import type { InfoLine } from '../infobox.ts';
import type { Bar } from '../panes/footprint.ts';
import { t } from '../i18n.ts';
import { usd } from '../format.ts';
import { overFromBoxes } from '../sizes.ts';
import { sizeScale } from '../coin.ts';
import { venueLabel } from '../venues.ts';

/**
 * One candle's market orders, for the volume strip's box (Karl, 2026-10-21: "average order size and things like that"): the footprint's
 * statistics of the strip's markets for that candle, read when its bar is hovered (`StripOrderCache`), so nothing is loaded for a strip
 * nobody points at. Orders are counted where the recording counts them, each at the minute its first fill came, and their dollars are
 * the orders' own (the size boxes added up): never the bar's volume divided by a count, which would mix fills of one minute with orders
 * of another.
 */
export interface StripOrders {
  buyN: number; sellN: number;
  /** Dollars of the market buys and sells counted (the size boxes added up). */
  buyUsd: number; sellUsd: number;
  /** Bought and sold in orders from the whale size up: exact where the size was asked as a line, else from the size boxes. */
  whale: { buy: number; sell: number; exact: boolean };
  /** Minutes of the candle recorded with statistics (null where the source does not say), of its length in minutes. */
  minutes: number | null; of: number;
  /** The markets with the most volume in the candle (several markets only), their share of it, the most first. */
  venues: { id: string; share: number }[];
}

const boxes = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

/** The orders of one bar of the footprint answer; null for a bar recorded without statistics. `cut` is the whale size and its line's place in the answer (-1 where not asked). */
export function stripOrdersOf(bar: Bar, cut: { size: number; index: number }, tfMs: number): StripOrders | null {
  const stats = bar.stats; if (!stats) return null;
  const line = cut.index >= 0 && bar.over && bar.over.length >= 2 * cut.index + 2 ? { buy: bar.over[2 * cut.index]!, sell: bar.over[2 * cut.index + 1]!, exact: true } : null;
  const boxed = line ?? (() => { const o = overFromBoxes(stats.buy, stats.sell, cut.size, sizeScale()); return { buy: o.buy, sell: o.sell, exact: o.exact }; })();
  const sums = new Map<string, number>();
  for (const row of bar.parts ?? []) for (const [id, buy, sell] of row) sums.set(id, (sums.get(id) ?? 0) + buy + sell);
  const all = [...sums.values()].reduce((a, b) => a + b, 0);
  const venues = sums.size > 1 && all > 0 ? [...sums].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, v]) => ({ id, share: v / all })) : [];
  return { buyN: stats.buyN, sellN: stats.sellN, buyUsd: boxes(stats.buy), sellUsd: boxes(stats.sell), whale: boxed, minutes: bar.minutes ?? null, of: Math.round(tfMs / 60_000), venues };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)} %`;
const signedUsd = (x: number): string => `${x > 0 ? '+' : x < 0 ? '−' : ''}$${usd(Math.abs(x))}`;
const per = (dollars: number, n: number): string => n > 0 ? `$${usd(dollars / n)}` : '—';

/** What the box says of a candle's orders: read (the figures), being read, none counted, or not readable; nothing where they are not asked (`undefined`). */
export function orderLines(orders: StripOrders | 'loading' | 'failed' | null | undefined, whaleUsd: number): InfoLine[] {
  if (orders === undefined) return [];
  if (orders === 'loading') return [{ text: t('Reading the market orders of this candle…'), color: 'muted', wrap: true, rule: true }];
  if (orders === 'failed') return [{ text: t('The market orders of this candle could not be read.'), color: 'muted', wrap: true, rule: true }];
  if (orders === null || orders.buyN + orders.sellN === 0) return [{ text: t('No market orders counted in this candle: its minutes were recorded without order statistics.'), color: 'muted', wrap: true, rule: true }];
  const o = orders, n = o.buyN + o.sellN, whale = o.whale.buy + o.whale.sell, orderUsd = o.buyUsd + o.sellUsd;
  const lines: InfoLine[] = [
    { label: t('Market orders begun'), text: t('{n} · {buys} buys · {sells} sells', { n: n.toLocaleString('en-US'), buys: o.buyN.toLocaleString('en-US'), sells: o.sellN.toLocaleString('en-US') }), rule: true },
    { label: t('Average buy order'), text: per(o.buyUsd, o.buyN), color: 'buy' },
    { label: t('Average sell order'), text: per(o.sellUsd, o.sellN), color: 'sell' },
    { label: t('Average order'), text: per(orderUsd, n) },
  ];
  if (orderUsd > 0) lines.push({ label: t('Whale orders from {size}', { size: `$${usd(whaleUsd)}` }), text: `${o.whale.exact ? '' : '≈ '}${pct(whale / orderUsd)} · Δ ${signedUsd(o.whale.buy - o.whale.sell)}` });
  if (o.venues.length) lines.push({ label: t('Largest venues'), text: o.venues.map(v => `${venueLabel(v.id)} ${pct(v.share)}`).join(' · ') });
  if (o.minutes !== null && o.minutes < o.of) lines.push({ text: t('Orders are counted for {n} of the {total} minutes.', { n: o.minutes, total: o.of }), color: 'muted', wrap: true });
  lines.push({ text: t('Each order counts once, at the minute its first fill came, with its own dollars: they can differ a little from the bar\'s.'), color: 'muted', wrap: true });
  return lines;
}

/** The footprint's row size that puts a candle's whole range in one row: only its statistics are wanted, not its rows. */
export const WHOLE_RANGE_STEP = 1e9;
/** How long the pointer rests on a bar before its orders are asked for; how long the orders of a candle that can still change are kept. */
export const ORDERS_REST_MS = 150, ORDERS_OPEN_TTL_MS = 15_000;
/** How long an answer that failed is kept before asking again, and how many candles' orders are kept (the least recently read go first). */
export const ORDERS_RETRY_MS = 30_000, ORDERS_HELD_MAX = 256;

/**
 * The orders of the candles pointed at: asked for once the pointer rests on a bar (`ORDERS_REST_MS`), one request at a time a candle, kept
 * (a candle that can still change for `ORDERS_OPEN_TTL_MS`, shown meanwhile as it was), and a bar left before its time asks nothing.
 */
export class StripOrderCache {
  #held = new Map<string, { at: number; value: StripOrders | null; failed: boolean }>();
  #wanted: { key: string; timer: ReturnType<typeof setTimeout> } | null = null;
  #busy = new Set<string>();

  /** The orders of `key` as held, or 'loading' until they are read; `open`: the candle can still change. `onLoad` runs when an answer lands. */
  want(key: string, open: boolean, load: () => Promise<StripOrders | null>, onLoad: () => void, now = Date.now()): StripOrders | 'loading' | 'failed' | null {
    const held = this.#held.get(key);
    if (held && (held.failed ? now - held.at < ORDERS_RETRY_MS : !open || now - held.at < ORDERS_OPEN_TTL_MS)) return held.failed ? 'failed' : held.value;
    if (!this.#busy.has(key) && this.#wanted?.key !== key) {
      this.rest();
      const timer = setTimeout(() => {
        if (this.#wanted?.key !== key) return;
        this.#wanted = null; this.#busy.add(key);
        load().then(value => this.#keep(key, { at: Date.now(), value, failed: false }), () => this.#keep(key, { at: Date.now(), value: null, failed: true }))
          .finally(() => { this.#busy.delete(key); onLoad(); });
      }, ORDERS_REST_MS);
      this.#wanted = { key, timer };
    }
    // Shown as it was while read again; never read: being read.
    return held && !held.failed ? held.value : 'loading';
  }

  /** The pointer left the bars: a request not sent yet is not sent. */
  rest(): void { if (this.#wanted) { clearTimeout(this.#wanted.timer); this.#wanted = null; } }

  #keep(key: string, entry: { at: number; value: StripOrders | null; failed: boolean }): void {
    this.#held.delete(key); this.#held.set(key, entry);
    while (this.#held.size > ORDERS_HELD_MAX) this.#held.delete(this.#held.keys().next().value!);
  }
}
