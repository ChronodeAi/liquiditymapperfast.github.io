import { t } from '../i18n.ts';
import { ROW_DEFAULT, SCRIPT_API, type ScriptRecord } from './records.ts';

/**
 * A rolling VWAP with bands: the volume-weighted mean of the candles' typical price over the last candles, moving with them (not anchored to a
 * session or to the first candle), and bands some deviations of that price wide. Written to be read: it shows a setting, a name kept from candle
 * to candle and one worked out again, a moving average and three plots on the price scale.
 */
export const VWAP_SOURCE = `// VWAP with bands: the volume-weighted average of the typical price, (high + low + close) / 3, over the last candles.
// It rolls with the candles (it is not anchored to a session), and its bands are that price's deviation around it.

// option(...) is a setting: change it under the text, no need to edit the script.
len = option(type=number, default=48, min=4, step=1, label="Window (candles)")
mult = option(type=number, default=1.8, min=0.2, step=0.1, label="Band width (deviations)")
midColor = option(type=color, default="rgba(255,64,255,0.95)", label="VWAP")
bandColor = option(type=color, default="rgba(255,64,255,0.6)", label="Bands")

// A var is worked out again on every candle. vbuy and vsell are the dollars bought and sold at market in the candle.
var typical = ($price.high + $price.low + $price.close) / 3
var vol = vbuy + vsell
var num = sma(typical * vol, len)
var den = sma(vol, len)
var num2 = sma(typical * typical * vol, len)

// A name set without var keeps its value from candle to candle: mid[1] would be the VWAP one candle back.
// Where the flow was not recorded, vbuy reads NaN: with no volume to weigh by, the lines leave a gap there.
mid = den > 0 ? num / den : NaN
var sd = Math.sqrt(Math.max(0, num2 / den - mid * mid))
upper = mid + mult * sd
lower = mid - mult * sd

line(mid, title="VWAP", color=midColor, lineWidth=2)
line(upper, title="+SD", color=bandColor)
line(lower, title="-SD", color=bandColor)
`;

/** The id of the script a page starts with. */
export const STARTER_ID = 'vwap-with-bands';

/**
 * The scripts a page starts with before it has kept any: the rolling VWAP, on and on the map, so the Scripts panel opens on one to read, change
 * and learn from. Deleting it keeps the empty list; Add example brings it back.
 */
export function starterScripts(): ScriptRecord[] {
  return [{ id: STARTER_ID, name: t('VWAP with bands'), source: VWAP_SOURCE, options: {}, on: true, api: SCRIPT_API, height: ROW_DEFAULT, place: 'map' }];
}
