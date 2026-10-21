/** The TOF pane's settings: what it also draws on the main chart. */
export interface TofSettings {
  /** The levels the candles leave (a dot at a candle's open until price trades through it) on the main chart. */
  levels: boolean;
  /** Which candles leave one: every candle (sized by its reading), from elevated (z 1), or toxic bursts only (z above 2). */
  from: 'all' | 'elevated' | 'toxic';
  /** The levels price has since traded through, faint, so what the untapped ones leave out can be seen. */
  taken: boolean;
  /** The untapped levels' reading added up by price, along the right edge of the main chart. */
  histogram: boolean;
}

export const TOF_DEFAULTS: Readonly<TofSettings> = { levels: true, from: 'all', taken: false, histogram: true };

/** The lowest z a candle needs to leave a level. */
export const minZOf = (from: TofSettings['from']): number => from === 'toxic' ? 2 : from === 'elevated' ? 1 : -Infinity;

export function readTof(saved: unknown): TofSettings {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<Record<keyof TofSettings, unknown>>, d = TOF_DEFAULTS;
  const flag = (v: unknown, fallback: boolean): boolean => typeof v === 'boolean' ? v : fallback;
  return {
    levels: flag(s.levels, d.levels),
    from: s.from === 'elevated' || s.from === 'toxic' ? s.from : 'all',
    taken: flag(s.taken, d.taken),
    histogram: flag(s.histogram, d.histogram),
  };
}
