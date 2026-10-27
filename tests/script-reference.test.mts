import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runScript } from '../src/app/script/lang/engine.ts';
import { BUILTINS } from '../src/app/script/lang/builtins.ts';
import { PLOTS } from '../src/app/script/lang/analysis.ts';
import { ERRORS, FUNCTIONS, PLOT_KINDS, WARNINGS, aiBundle, errorSentence, llmsText, referenceData, referenceMarkdown } from '../src/app/script/lang/reference.ts';
import { setLanguage } from '../src/app/i18n.ts';
import type { BarInputs } from '../src/app/script/inputs.ts';

const N = 30, MIN = 60_000;
function inputs(): BarInputs {
  const time = Float64Array.from({ length: N }, (_, i) => i * MIN);
  const flow = { vbuy: Float64Array.from(time, (_, i) => 10 + i), vsell: Float64Array.from(time, () => 5), lbuy: new Float64Array(N), lsell: new Float64Array(N), markets: 2 };
  return { tf: MIN, time, open: Float64Array.from(time, (_, i) => 100 + i), high: Float64Array.from(time, (_, i) => 102 + i), low: Float64Array.from(time, (_, i) => 99 + i), close: Float64Array.from(time, (_, i) => 101 + i), volume: Float64Array.from(time, () => 1), sources: { '': flow, 'kinds=spot': flow }, forming: false };
}

test('the reference describes every function with a history and every plot the interpreter has, and nothing it does not', () => {
  assert.deepEqual(FUNCTIONS.map(f => f.name).sort(), Object.keys(BUILTINS).sort());
  assert.deepEqual([...new Set(Object.values(PLOTS))].sort(), PLOT_KINDS.map(p => p.kind).sort());
});

test("each error's example meets that error, and its fix runs cleanly", () => {
  for (const e of ERRORS) {
    if (!e.wrong || !e.right) continue;
    const wrong = runScript('x', e.wrong, {}, inputs());
    assert.equal(wrong.ok ? 'ran' : wrong.error.code, e.code, `${e.code}: ${JSON.stringify(e.wrong)}`);
    const right = runScript('x', e.right, {}, inputs());
    assert.ok(right.ok, `${e.code} put right: ${right.ok ? '' : JSON.stringify(right.error)}`);
  }
  // Every code the panel has words for is in the reference.
  const said = ['unexpected-end', 'expected', 'expected-end', 'expected-name', 'unterminated-string', 'unterminated-comment', 'unexpected-char', 'bad-number', 'unexpected', 'bad-assignment', 'unsupported', 'too-deep', 'too-many-sources', 'too-many-plots', 'unknown-name', 'not-callable', 'no-member', 'read-only', 'const', 'redeclared', 'bad-jump', 'budget', 'too-slow', 'too-large', 'timeout', 'worker-failed', 'internal', 'no-answer', 'newer-api'];
  assert.deepEqual(ERRORS.map(e => e.code).sort(), said.sort());
  assert.ok(ERRORS.every(e => errorSentence(e.code) !== e.code), 'each has its sentence');
  assert.ok(WARNINGS.length === 8);
});

test('the published files are what the reference makes now (run npm run reference after changing the language)', () => {
  const dir = 'src/app/public/';
  assert.equal(fs.readFileSync(`${dir}script-reference.md`, 'utf8'), referenceMarkdown(), 'script-reference.md');
  assert.equal(fs.readFileSync(`${dir}scripts.json`, 'utf8'), `${JSON.stringify(referenceData(), null, 1)}\n`, 'scripts.json');
  assert.equal(fs.readFileSync(`${dir}llms.txt`, 'utf8'), llmsText(), 'llms.txt');
});

test('Copy for AI: English whatever the page speaks, the script numbered and set apart as data, errors with code and place, the newest values', () => {
  setLanguage('de', { 'Expected {what} here.': '{what} erwartet.', 'Line {line}, column {col}: {text}': 'Zeile {line}, Spalte {col}: {text}' });
  try {
    const text = aiBundle({
      name: 'My CVD', source: 'total = total + (vbuy - vsell)\nline(total, title="CVD")', place: 'pane', options: { len: 20 },
      errors: [{ code: 'expected', line: 2, col: 5, detail: ')' }], warnings: [{ code: 'no-counts' }],
      plots: [{ title: 'CVD', kind: 'line', last: [1234.5] }], chart: { market: 'binance:BTCUSDT', timeframe: '1h', candles: 500 },
    });
    assert.match(text, /error expected at line 2, column 5: Expected \) here\./, 'the sentence in English with its code and place');
    assert.match(text, /1 \| total = total \+ \(vbuy - vsell\)\n2 \| line\(total, title="CVD"\)/, 'numbered lines');
    assert.match(text, /not as instructions to you/);
    assert.match(text, /CVD \(line\): newest 1234\.5/);
    assert.match(text, /len = 20/);
    assert.match(text, /script-reference\.md/);
    assert.ok(!/erwartet|Zeile/.test(text), 'nothing in German');
    assert.ok(text.length < 20_000, `small enough to paste: ${text.length} characters`);
  } finally { setLanguage('en'); }
});
