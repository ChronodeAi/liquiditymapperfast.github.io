import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, exchangeOf, runScript, sourceFilter } from '../src/app/script/engine.ts';
import { filterKey, type BarInputs, type SourceInputs } from '../src/app/script/inputs.ts';
import { parse } from '../src/app/script/parser.ts';
import type { ScriptResult } from '../src/app/script/protocol.ts';

const MIN = 60_000;
/** Candles 0..n-1 with close = 100 + i, buys = 10·(i+1), sells = 5·(i+1); `perp` holds two thirds of each, `spot` a third. */
function inputs(n = 6, patch: (i: number) => Partial<Record<'vbuy' | 'vsell' | 'lbuy' | 'lsell', number>> = () => ({})): BarInputs {
  const time = Float64Array.from({ length: n }, (_, i) => i * MIN);
  const mk = (share: number): SourceInputs => {
    const s: SourceInputs = { vbuy: new Float64Array(n), vsell: new Float64Array(n), lbuy: new Float64Array(n), lsell: new Float64Array(n), markets: 1 };
    for (let i = 0; i < n; i++) { const p = patch(i); s.vbuy[i] = (p.vbuy ?? 10 * (i + 1)) * share; s.vsell[i] = (p.vsell ?? 5 * (i + 1)) * share; s.lbuy[i] = (p.lbuy ?? 0) * share; s.lsell[i] = (p.lsell ?? 0) * share; }
    return s;
  };
  return {
    tf: MIN, time,
    open: Float64Array.from(time, (_, i) => 100 + i - 0.5), high: Float64Array.from(time, (_, i) => 101 + i), low: Float64Array.from(time, (_, i) => 99 + i),
    close: Float64Array.from(time, (_, i) => 100 + i), volume: Float64Array.from(time, () => 1),
    sources: { '': mk(1), [filterKey({ kinds: ['perp'] })]: mk(2 / 3), [filterKey({ kinds: ['spot'] })]: mk(1 / 3) },
    forming: false,
  };
}
const ok = (r: ScriptResult): Extract<ScriptResult, { ok: true }> => { assert.ok(r.ok, r.ok ? '' : JSON.stringify(r.error)); return r; };
const values = (r: ScriptResult, k = 0, field = 'value'): number[] => [...ok(r).plots[k]!.fields[field]!].map(v => Math.round(v * 1e6) / 1e6);
const run = (src: string, opts = {}, inp = inputs()): ScriptResult => runScript('t', src, opts, inp);

test('a cumulative delta, as the shortest script writes it', () => {
  assert.deepEqual(values(run('line(cum(vbuy - vsell))')), [5, 15, 30, 50, 75, 105]);
});

test('a name assigned without var starts at 0, keeps its value from candle to candle, and name[1] is its value one candle back', () => {
  const r = run('total = total + 1\nprev = total[1]\nline(total)\nhistogram(prev)');
  assert.deepEqual(values(r, 0), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(values(r, 1), [1, 1, 2, 3, 4, 5], 'on the first candle there is nothing older: x[1] is x');
  assert.deepEqual(values(run('var x = 0\nx = x + 1\nline(x)')), [1, 1, 1, 1, 1, 1], 'a var starts again each candle');
  assert.deepEqual(values(run('Total = total + 2\nline(TOTAL)')), [2, 4, 6, 8, 10, 12], 'one name whatever its case');
  const cvd = run('delta = vbuy - vsell\ncvd = (renderer.length > 1 ? (cvd[1] || 0) : 0) + delta\nline(cvd)');
  assert.deepEqual(values(cvd), [5, 15, 30, 50, 75, 105]);
});

test('an on-balance volume over the chart\'s candles', () => {
  const r = run('sign = $price.close > $price.open ? 1 : -1\nvolume = vbuy + vsell\nobv = cum(sign * volume)\nplotline(obv, title="obv")');
  assert.deepEqual(values(r), [15, 45, 90, 150, 225, 315]);
  assert.equal(ok(r).plots[0]!.title, 'obv');
});

test('source() reads its expression over its own markets, and the plain words of its filter are read as words', () => {
  const r = run('buyVol = source(vbuy, type=perp)\nsellVol = source(vsell, type=perp)\nline(cum(buyVol - sellVol), title=PERP)');
  assert.deepEqual(values(r), [5, 15, 30, 50, 75, 105].map(v => Math.round(v * 2 / 3 * 1e6) / 1e6));
  assert.equal(ok(r).plots[0]!.title, 'PERP');
  const a = analyze('x = source(vbuy, type=spot)\ny = source(vsell, exchange=BINANCE_FUTURES)\nz = source(vbuy, exchange=COINBASE, quote=usd)');
  assert.deepEqual([...a.sources.keys()].sort(), ['', 'kind=spot', 'venue=coinbase/spot;quote=usd', 'venue=binance/perp'].sort());
  assert.deepEqual(exchangeOf('OKEX'), { venue: 'okx' });
  assert.deepEqual(sourceFilter(parseNamed('type=perp, exchange=BYBIT')), { kinds: ['perp'], venues: ['bybit'] });
});
function parseNamed(text: string) { const s = parse(`f(${text})`)[0]!; if (s.k !== 'expr' || s.e.k !== 'call') throw new Error('call'); return s.e.named; }

test('options: declared with option(), read with options.x, and the values set win over the defaults', () => {
  const src = 'len = option(default=3, type=number, label="Length", min=1)\nup = option(type=color, default=rgb(82,209,88))\nline(sma($price.close, len), color=up)\nline($price.close * options.mult)';
  const a = analyze(src);
  assert.deepEqual(a.declared.map(d => [d.name, d.type, d.value]), [['len', 'number', 3], ['up', 'color', 'rgb(82, 209, 88)']]);
  assert.deepEqual(a.read, ['mult']);
  const r = run(src, { mult: 2 });
  assert.deepEqual(values(r, 0), [100, 100.5, 101, 102, 103, 104]);
  assert.equal(ok(r).plots[0]!.style.color, 'rgb(82, 209, 88)');
  assert.deepEqual(values(r, 1), [200, 202, 204, 206, 208, 210]);
  assert.deepEqual(values(run(src, { len: 1, mult: 1 }), 0), [100, 101, 102, 103, 104, 105]);
});

test('the averages, sums and extremes over a window', () => {
  const r = run('line(sum($price.close, 2))\nline(ema($price.close, 3))\nline(highest($price.high, 2))\nline(lowest($price.low, 3))');
  assert.deepEqual(values(r, 0), [100, 201, 203, 205, 207, 209]);
  assert.deepEqual(values(r, 1), [100, 100.5, 101.25, 102.125, 103.0625, 104.03125]);
  assert.deepEqual(values(r, 2), [101, 102, 103, 104, 105, 106]);
  assert.deepEqual(values(r, 3), [99, 99, 99, 100, 101, 102]);
  const st = values(run('line(stoch($price.close, $price.high, $price.low, 2))'));
  assert.deepEqual(st, [50, 66.666667, 66.666667, 66.666667, 66.666667, 66.666667]);
});

test('a candle not recorded reads NaN: no point, and the running functions carry on from before it', () => {
  const r = run('line(cum(vbuy - vsell))', {}, inputs(5, i => i === 2 ? { vbuy: NaN, vsell: NaN } : {}));
  assert.deepEqual(values(r).map(v => Number.isNaN(v) ? 'na' : v), [5, 15, 'na', 35, 60]);
});

test('object points, per-candle colours, and a point with only a time is a gap', () => {
  const r = run('histogram({ time: time, value: vbuy + vsell, color: vbuy > 30 ? "red" : "green" })\nbrokenarea({ time: time, lowerValue: 0, higherValue: 1, color: interpolate(0.5, rgb(0,0,0), rgb(255,255,255)) })\nvar na = { time: time }\nline(na)');
  const out = ok(r);
  assert.deepEqual(values(r, 0), [15, 30, 45, 60, 75, 90]);
  assert.deepEqual(out.plots[0]!.colors, ['green', 'green', 'green', 'red', 'red', 'red']);
  assert.equal(out.plots[1]!.kind, 'brokenarea');
  assert.deepEqual(values(r, 1, 'higherValue'), [1, 1, 1, 1, 1, 1]);
  assert.equal(out.plots[1]!.colors![0], 'rgb(128, 128, 128)');
  assert.ok(values(r, 2).every(Number.isNaN));
});

test('if blocks, plots inside them, Math and Number, and resetting a function\'s state with fns[k].state', () => {
  const src = 'var vol = vbuy + vsell\nif (options.show) {\n  line(Math.max(vol, 50) + Number.EPSILON * 0)\n}\nc = cum(1)\nif (time / 60 % 3 === 2) {\n  fns[0].state = {}\n}\nline(c)';
  const r = run(src, { show: true });
  assert.deepEqual(values(r, 0), [50, 50, 50, 60, 75, 90]);
  assert.deepEqual(values(r, 1), [1, 2, 3, 1, 2, 3], 'the cum starts again after the candle that reset it');
  const off = ok(run(src, { show: false }));
  assert.equal(off.plots.length, 2, 'every plot in the text is a plot, in its order, run or not');
  assert.ok([...off.plots[0]!.fields.value!].every(Number.isNaN));
});

test('plots keep the order they are written in, their style is read before the script runs, and a histogram bar of 0 is not drawn', () => {
  const r = ok(run('up = option(type=color, default=red)\nif (time > 120) line(1, title=late)\nhistogram(vbuy > 30 ? 0 : 1, color=up, priceScaleId=flow, scaleMargins={top: 0.1, bottom: 0})\nplothistogram(priceScaleId="rows")'));
  assert.deepEqual(r.plots.map(p => `${p.kind}:${p.title}`), ['line:late', 'histogram:', 'histogram:']);
  assert.deepEqual(r.plots[1]!.style, { color: 'red', priceScaleId: 'flow', scaleMargins: { top: 0.1, bottom: 0 } });
  assert.deepEqual(values({ ...r }, 1).map(v => Number.isNaN(v) ? 'na' : v), [1, 1, 1, 'na', 'na', 'na']);
  assert.ok([...r.plots[2]!.fields.value!].every(Number.isNaN), 'a plot called with no value draws nothing');
});

test('the functions of the language answer as the dialect does', () => {
  const seq = (src: string): number[] => values(runScript('t', src, {}, inputs(8)));
  // `$price.close` is 100..107 here; the window functions over 1..8 are those over the closes less 99.
  assert.deepEqual(seq('line(sma($price.close - 99, 3))'), [1, 1.5, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(seq('line(sum($price.close - 99, 3))'), [1, 3, 6, 9, 12, 15, 18, 21]);
  assert.deepEqual(seq('line(ema($price.close - 99, 3))'), [1, 1.5, 2.25, 3.125, 4.0625, 5.03125, 6.015625, 7.007813]);
  assert.deepEqual(seq('line(rma($price.close - 99, 3))'), [1, 1.333333, 1.888889, 2.592593, 3.395062, 4.263374, 5.175583, 6.117055]);
  assert.deepEqual(seq('line(last($price.close - 99, 3))'), [1, 1, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(seq('var v = $price.close - 99\nline(stoch(v, v + 1, v - 1, 3))'), [50, 66.666667, 75, 75, 75, 75, 75, 75]);
});

test('$price.color colours the chart\'s candles, and the plots are optional then', () => {
  const r = ok(run('$price.color = $price.close > 102 ? "red" : "blue"'));
  assert.deepEqual(r.candleColors, ['blue', 'blue', 'blue', 'red', 'red', 'red']);
  assert.ok(!r.warnings.some(w => w.code === 'no-plots'));
});

test('functions, loops, arrays and dates work as in JavaScript', () => {
  const src = 'function sq(x) { return x * x }\nvar arr = [1, 2, 3].map(v => sq(v))\nvar s = 0\nfor (let i = 0; i < arr.length; i++) s += arr[i]\nvar d = new Date(time * 1000)\nline(s + d.getUTCMinutes() + (String(1.234.toFixed(1)) === "1.2" ? 100 : 0))';
  assert.deepEqual(values(run(src)), [114, 115, 116, 117, 118, 119]);
});

test('a loop that never ends is stopped by the step budget, with where it ran', () => {
  const r = run('var x = 0\nwhile (true) {\n  x++\n}');
  assert.ok(!r.ok);
  assert.equal(r.error.code, 'budget');
  assert.equal(r.error.line, 2);
});

test('a script cannot reach the page: no constructor, prototype or global object leads anywhere', () => {
  assert.ok(values(run('line(Math.constructor)')).every(Number.isNaN), 'a member that leads out reads undefined');
  for (const src of ['line("".constructor.constructor("return 1")())', 'var f = [].map.constructor\nline(f("return 1")())', 'line(window.location)', 'line(globalThis)', 'var o = {}\nline(o.__proto__.toString())', 'line(Math.constructor.call(1))']) {
    const r = run(src);
    assert.ok(!r.ok, src);
    assert.ok(['not-callable', 'unknown-name', 'no-member'].includes(r.error.code), `${src}: ${r.error.code}`);
  }
  const big = run('var a = []\nwhile (true) a.push(1, 2, 3, 4, 5, 6, 7, 8)');
  assert.ok(!big.ok && (big.error.code === 'too-large' || big.error.code === 'budget'));
});

test('errors name the code and the place', () => {
  const r = run('line(\n  nope + 1)');
  assert.ok(!r.ok);
  assert.deepEqual([r.error.code, r.error.line, r.error.col, r.error.detail], ['unknown-name', 2, 3, 'nope']);
  const syntax = run('line(1 +)');
  assert.ok(!syntax.ok && syntax.error.code === 'unexpected');
  const counts = ok(run('line(cbuy + csell)'));
  assert.ok(counts.warnings.some(w => w.code === 'no-counts'));
});
