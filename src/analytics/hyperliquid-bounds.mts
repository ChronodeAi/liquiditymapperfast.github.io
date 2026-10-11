export interface HyperliquidGroupingBounds {
  step: number; lower: number; upper: number; nSigFigs: number; mantissa?: number;
  boundaryPrecision: 'estimated'; boundarySemantics: 'lower-edge-grid'; source: 'official-contract';
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
 * The group a level of a grouped Hyperliquid book holds. Bids are named by the group's lower edge, [P, P + step); asks by its upper edge,
 * (P - step, P]: the finer groups add up to a coarser one exactly that way (BTC and ETH, measured 2026-10-11). An ask named on a power of
 * ten (100,000) holds the prices just below it, whose step is a tenth of its own.
 */
export function hyperliquidLevelBounds(price: number, side: 'bid' | 'ask', nSigFigs: number, mantissa?: number | null): HyperliquidGroupingBounds {
  const own = hyperliquidGroupingBoundsDecimal(price, nSigFigs, mantissa);
  if (side === 'bid') return own;
  // Counted down from the price on the grid of the prices just below it (never by shifting the price: 14.3 - 0.0001 is 14.299900000000001,
  // whose digits overflow the scale). That grid is the price's own except at a power of ten.
  const decade = powerOfTen(Math.round(Math.log10(price))) === price;
  return { ...own, ...group(price, stepOf(Math.floor(Math.log10(price)) - nSigFigs + 1 - (decade ? 1 : 0), mantissa), true) };
}
