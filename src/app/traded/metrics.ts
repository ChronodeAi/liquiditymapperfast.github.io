import { binOf, type FootprintRow, type ProfileAnswer } from '../../shared/footprint.ts';
import { markedPart, type AbsorptionGroup } from '../../shared/absorption.ts';
import type { Liquidation } from '../../shared/liquidations.ts';
import { usd } from '../format.ts';
import { t } from '../i18n.ts';
import { VOLUME_WORDS, type ColumnWords, type TradedRows } from '../traded.ts';

/**
 * What the volume profile column adds up by price. Traded volume is the footprint's; the others put another record on the same rows, two
 * sides each in the same places (bid colour, then ask colour), so the bars, the point of control, the value area and the lines read them
 * the same way:
 * - absorption: the marked part of each absorption group (shared/absorption.ts `markedPart`, counted once a group) at the threshold the
 *   Absorption settings judge it at: market sells that met resting buyers, then market buys that met resting sellers;
 * - liquidations: reported liquidations at the price the market was at (shared/liquidations.ts): shorts liquidated (forced buys), then longs
 *   liquidated (forced sells). Only the venues that publish them count, Binance at most one a market a second.
 * Each is what was recorded, not all there was: the column's header says where a record is cut.
 */
export type ProfileMetric = 'volume' | 'absorption' | 'liquidations';
export const PROFILE_METRICS: readonly ProfileMetric[] = ['volume', 'absorption', 'liquidations'];

/** The words of each measure: what its rows' two sides are called, and its header. */
export function metricWords(metric: ProfileMetric): ColumnWords {
  switch (metric) {
    case 'absorption': return { buy: t('Resting buyers took'), sell: t('Resting sellers took'), net: t('Difference'), share: t('Share of the absorbed'), none: t('Nothing absorbed at these prices in this window.') };
    case 'liquidations': return { buy: t('Shorts liquidated'), sell: t('Longs liquidated'), net: t('Difference'), share: t('Share of the liquidations'), none: t('No liquidation reported at these prices in this window.') };
    default: return VOLUME_WORDS;
  }
}

/** What a measure's answer leaves out: `cut`, its record was cut at a limit (the smallest left out); `incomplete`, some minutes keep only their largest groups. */
export interface MetricFlags { cut: boolean; incomplete: boolean }

/** The two header lines of a measure other than traded volume: its total, then where its record is cut, or the largest row. */
export function metricHeader(metric: ProfileMetric, rows: TradedRows | null, flags: MetricFlags): [string, string] {
  const head = metric === 'absorption' ? t('ABSORBED') : t('LIQUIDATED');
  if (!rows) return [head, ''];
  const total = metric === 'absorption' ? t('ABSORBED {value}', { value: usd(rows.total) }) : t('LIQUIDATED {value}', { value: usd(rows.total) });
  if (flags.cut) return [total, metric === 'liquidations' ? t('the largest 5,000') : t('the largest only')];
  if (flags.incomplete) return [total, t('some minutes in part')];
  return [total, t('ROW MAX {value}', { value: usd(rows.max) })];
}

/** Rows of `step` from amounts at prices, by instrument: [side a, side b] at each row, as a profile answer. */
function answerOf(by: Map<string, Map<number, [number, number]>>, step: number, from: number, to: number): ProfileAnswer {
  return {
    from, to,
    instruments: [...by].map(([id, bins]) => ({
      id, step, minutes: 0, first: null, earliest: null,
      rows: [...bins].sort((a, b) => a[0] - b[0]).map(([bin, [a, b]]): FootprintRow => [bin * step, a, b]),
    })),
  };
}

function add(by: Map<string, Map<number, [number, number]>>, id: string, bin: number, side: 0 | 1, amount: number): void {
  let bins = by.get(id); if (!bins) { bins = new Map(); by.set(id, bins); }
  const cell = bins.get(bin) ?? [0, 0]; cell[side] += amount; bins.set(bin, cell);
}

/** Liquidations of `ids` in [from, to) by price on rows of `step`: shorts liquidated, then longs liquidated, in USD. */
export function liquidationAnswer(rows: readonly Liquidation[], ids: readonly string[], from: number, to: number, step: number): ProfileAnswer {
  const wanted = new Set(ids), by = new Map<string, Map<number, [number, number]>>();
  for (const l of rows) if (wanted.has(l.id) && l.t >= from && l.t < to && l.price > 0) add(by, l.id, binOf(l.price, step), l.side === 'short' ? 0 : 1, l.usd);
  return answerOf(by, step, from, to);
}

/**
 * The marked part of each absorption group that began in [from, to), at its instrument's threshold (none: nothing of it is marked), by
 * price on rows of `step`: market sells taken by resting buyers, then market buys taken by resting sellers, in USD.
 */
export function absorptionAnswer(groups: readonly AbsorptionGroup[], thresholds: ReadonlyMap<string, number | null>, from: number, to: number, step: number): ProfileAnswer {
  const by = new Map<string, Map<number, [number, number]>>();
  for (const g of groups) {
    const threshold = thresholds.get(g.id);
    if (g.t0 < from || g.t0 >= to || threshold === null || threshold === undefined) continue;
    const part = markedPart(g, threshold);
    if (part) add(by, g.id, binOf(g.price, step), g.side === 'sell' ? 0 : 1, part.usd);
  }
  return answerOf(by, step, from, to);
}
