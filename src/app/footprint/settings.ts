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
   * (the venues switched on, inside the Spot / Perp filter: `flowIds`) added together on the chart market's candles.
   */
  markets: 'chart' | 'all';
}

/** Diagonal imbalances outlined, the numbers as before; zones and naked points of control off until chosen. */
export const FOOTPRINT_DEFAULTS: Readonly<FootprintSettings> = { text: 'split', diagonal: true, zones: false, nakedPoc: false, markets: 'chart' };

const flag = (value: unknown, fallback: boolean): boolean => typeof value === 'boolean' ? value : fallback;

export function readFootprint(saved: unknown): FootprintSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<Record<keyof FootprintSettings, unknown>>, d = FOOTPRINT_DEFAULTS;
  return {
    text: s.text === 'delta' || s.text === 'total' || s.text === 'none' ? s.text : 'split',
    diagonal: flag(s.diagonal, d.diagonal), zones: flag(s.zones, d.zones), nakedPoc: flag(s.nakedPoc, d.nakedPoc),
    markets: s.markets === 'all' ? 'all' : 'chart',
  };
}
