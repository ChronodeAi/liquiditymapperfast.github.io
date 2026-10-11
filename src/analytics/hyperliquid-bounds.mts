export interface HyperliquidGroupingBounds {
  step: number; lower: number; upper: number; nSigFigs: number; mantissa?: number;
  boundaryPrecision: 'estimated'; boundarySemantics: 'lower-edge-grid' | 'upper-edge-grid'; source: 'official-contract';
}

const MAX_DECIMAL_PRECISION = 15;

function positive(value: number, name: string) {
  if (!Number.isFinite(value) || !(value > 0)) throw new RangeError(`${name} must be a finite positive number`);
  return value;
}

function decimalPlaces(value: number) {
  positive(value, 'value');
  const [coefficient, exponentText] = String(value).toLowerCase().split('e');
  const exponent = exponentText == null ? 0 : Number(exponentText);
  return Math.max(0, Math.min(MAX_DECIMAL_PRECISION, (coefficient.split('.')[1] ?? '').length - exponent));
}

function scaled(value: number, scale: number, name: string) {
  const result = Math.round(value * scale);
  if (!Number.isSafeInteger(result)) throw new RangeError(`${name} exceeds safe integer range at the requested precision`);
  return result;
}

function unscaled(value: number, scale: number) {
  const result = value / scale;
  return Object.is(result, -0) ? 0 : result;
}

/** mantissa x 10^exponent, exact for a negative exponent too: 10 ** -4 is 0.00009999999999999999 (whose digits overflow the scale), 1 / 10 ** 4 is 0.0001. */
function stepOf(exponent: number, mantissa: number | null | undefined): number {
  const m = mantissa ?? 1;
  return exponent < 0 ? m / 10 ** -exponent : m * 10 ** exponent;
}

/** 10^k for a whole k, exact for a negative k too. */
const powerOfTen = (k: number): number => stepOf(k, 1);

/**
 * The group of width `rawStep` holding `price`, in whole units of the finest decimal either number has: [lower, upper) counted up from
 * the price, or (lower, upper] counted down from it (`fromAbove`).
 */
function group(price: number, rawStep: number, fromAbove: boolean): { step: number; lower: number; upper: number } {
  const digits = Math.max(0, Math.min(MAX_DECIMAL_PRECISION, Math.max(decimalPlaces(rawStep), decimalPlaces(price))));
  const scale = 10 ** digits;
  if (!Number.isSafeInteger(scale)) throw new RangeError('Hyperliquid source precision exceeds safe integer range');
  const priceInt = scaled(price, scale, 'price');
  const stepInt = scaled(rawStep, scale, 'step');
  if (!(stepInt > 0)) throw new RangeError('Hyperliquid source step is below supported precision');
  const lowerInt = fromAbove ? Math.ceil(priceInt / stepInt) * stepInt - stepInt : Math.floor(priceInt / stepInt) * stepInt;
  return { step: unscaled(stepInt, scale), lower: unscaled(lowerInt, scale), upper: unscaled(lowerInt + stepInt, scale) };
}

/** Shared decimal-safe implementation of Hyperliquid's documented coarse grid. */
export function hyperliquidGroupingBoundsDecimal(price: number, nSigFigs: number, mantissa?: number | null): HyperliquidGroupingBounds {
  positive(price, 'price');
  if (!Number.isInteger(nSigFigs) || nSigFigs < 2 || nSigFigs > 5) throw new RangeError('nSigFigs must be an integer from 2 to 5');
  if (mantissa != null && (!Number.isInteger(mantissa) || ![1, 2, 5].includes(mantissa) || nSigFigs !== 5)) throw new RangeError('mantissa is only valid for nSigFigs 5 and must be 1, 2, or 5');
  const { step, lower, upper } = group(price, stepOf(Math.floor(Math.log10(price)) - nSigFigs + 1, mantissa), false);
  return {
    step,
    lower,
    upper,
    nSigFigs,
    boundaryPrecision: 'estimated',
    boundarySemantics: 'lower-edge-grid',
    source: 'official-contract',
    ...(mantissa == null ? {} : { mantissa }),
  };
}

/**
 * The step a grouped Hyperliquid side has when `best` is its best level: one step for the whole side. SOL's bids at three significant
 * figures run 109, 108, ..., 100, 99, ..., 90, a dollar apart, and at two the bid named 90 holds [90, 100) (measured 2026-10-11), so a
 * level past a power of ten keeps the step of the best one. A best ask named on a power of ten (100,000) holds the prices just below it,
 * whose step is a tenth of its own. A whole book takes its best bid's (`hyperliquidBookStep`).
 */
export function hyperliquidSideStep(best: number, side: 'bid' | 'ask', nSigFigs: number, mantissa?: number | null): number {
  const own = hyperliquidGroupingBoundsDecimal(best, nSigFigs, mantissa);
  if (side === 'bid') return own.step;
  const decade = powerOfTen(Math.round(Math.log10(best))) === best;
  return decade ? stepOf(Math.floor(Math.log10(best)) - nSigFigs, mantissa) : own.step;
}

/**
 * The step of a grouped Hyperliquid book: one for both sides, the best bid's. The asks follow the bids even past a power of ten (a book
 * at 0.999 / 1.0009 lists asks 1.001, 1.003, 1.004 at three significant figures, a thousandth apart, measured 2026-10-11). A book with
 * no bids takes its best ask's (`hyperliquidSideStep`).
 */
export function hyperliquidBookStep(bestBid: number, bestAsk: number, nSigFigs: number, mantissa?: number | null): number {
  return bestBid > 0 && Number.isFinite(bestBid) ? hyperliquidSideStep(bestBid, 'bid', nSigFigs, mantissa) : hyperliquidSideStep(bestAsk, 'ask', nSigFigs, mantissa);
}

/**
 * The group a level of a grouped Hyperliquid book holds, given the book's step (`hyperliquidBookStep`; a level alone is the best of its
 * side). Bids are named by the group's lower edge, [P, P + step); asks by its upper edge, (P - step, P]: the finer groups add up to a
 * coarser one exactly that way (BTC, ETH, SOL, measured 2026-10-11). Counted in whole units of the finest decimal, never by shifting the
 * price (14.3 - 0.0001 is 14.299900000000001, whose digits overflow the scale).
 */
export function hyperliquidLevelBounds(price: number, side: 'bid' | 'ask', nSigFigs: number, mantissa?: number | null, step = hyperliquidSideStep(price, side, nSigFigs, mantissa)): HyperliquidGroupingBounds {
  const own = hyperliquidGroupingBoundsDecimal(price, nSigFigs, mantissa);
  return { ...own, ...group(price, step, side === 'ask'), boundarySemantics: side === 'bid' ? 'lower-edge-grid' : 'upper-edge-grid' };
}
