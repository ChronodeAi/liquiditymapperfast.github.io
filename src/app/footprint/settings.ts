/**
 * The footprint's own settings (whether it shows is `show.footprint`; the imbalance ratio, minimum and stacked rows are the bar statistics'
 * `barStatOptions`, shared so the strip and the cells agree): what each row prints, whether diagonal imbalances are outlined, and whether
 * stacked imbalances and each candle's point of control run on as zones and lines until price reaches them.
 */
export interface FootprintSettings {
  /** What a row prints: sold × bought, their difference, their sum, or nothing. */
  text: 'split' | 'delta' | 'total' | 'none';
  diagonal: boolean;
  zones: boolean;
  nakedPoc: boolean;
  /**
   * Whose trades the footprint (and the bar statistics, which read it) counts: the chart market's, or every market the flow views count
   * (the venues switched on, inside the Spot / Perp filter: `flowIds`) added together on the chart market's candles, or the markets picked
   * (`customMarkets.footprint`, market-choice.ts), whatever the chips and the filter say.
   */
  markets: 'chart' | 'all' | 'custom';
  /**
   * How a row's bar length follows its volume (every row has one, as long as its volume against the busiest row in view): in proportion, by
   * its square root, or by its logarithm (`barFraction`). The venue pieces of a bar keep their shares of it.
   */
  widths: 'linear' | 'sqrt' | 'log';
}

/** Diagonal imbalances outlined, the numbers as before; zones and naked points of control off until chosen; every venue added together (2026-10-13). */
export const FOOTPRINT_DEFAULTS: Readonly<FootprintSettings> = { text: 'split', diagonal: true, zones: false, nakedPoc: false, markets: 'all', widths: 'sqrt' };

const flag = (value: unknown, fallback: boolean): boolean => typeof value === 'boolean' ? value : fallback;

export function readFootprint(saved: unknown): FootprintSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<Record<keyof FootprintSettings, unknown>>, d = FOOTPRINT_DEFAULTS;
  return {
    text: s.text === 'delta' || s.text === 'total' || s.text === 'none' ? s.text : 'split',
    diagonal: flag(s.diagonal, d.diagonal), zones: flag(s.zones, d.zones), nakedPoc: flag(s.nakedPoc, d.nakedPoc),
    markets: s.markets === 'chart' || s.markets === 'custom' ? s.markets : 'all',
    widths: s.widths === 'linear' || s.widths === 'log' ? s.widths : d.widths,
  };
}
