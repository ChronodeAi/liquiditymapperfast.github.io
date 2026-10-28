import test from 'node:test';
import assert from 'node:assert/strict';
import { BAR_ZOOM_FLOOR, fitBar, rowsOf } from '../src/app/bar-fit.ts';

/** The decks of the full top bar as measured in Chrome (2026-10-25): Market, Time, Heatmap, Panels, Chart, Alerts and the page's own, with their gaps and padding. */
const DECKS = [238, 139, 298, 270, 384, 106, 117], GAP = 3, PAD = 12;
const NATURAL = DECKS.reduce((a, b) => a + b, 0) + GAP * (DECKS.length - 1) + PAD;
const rowWidth = (r: readonly number[]): number => r.reduce((a, b) => a + b, 0) + GAP * Math.max(0, r.length - 1) + PAD;

test('a window the decks fit in at their own size leaves the bar as it is', () => {
  assert.equal(NATURAL, 1582);
  for (const width of [NATURAL, 1600, 1920, 2560, 3840]) assert.deepEqual(fitBar(DECKS, GAP, PAD, width), { zoom: 1, breaks: [] }, `${width}`);
});

test('a window a little too narrow scales the bar to fit one row, by the hundredth below what fits, never over', () => {
  assert.deepEqual(fitBar(DECKS, GAP, PAD, 1536), { zoom: 0.97, breaks: [] });
  assert.deepEqual(fitBar(DECKS, GAP, PAD, 1500), { zoom: 0.94, breaks: [] }, 'Karl\'s screenshot: the Tools deck alone on a second row');
  assert.deepEqual(fitBar(DECKS, GAP, PAD, 1440), { zoom: 0.91, breaks: [] });
  assert.deepEqual(fitBar(DECKS, GAP, PAD, 1366), { zoom: 0.86, breaks: [] }, 'the commonest laptop width is one row');
  for (let width = 1346; width < NATURAL; width += 7) {
    const fit = fitBar(DECKS, GAP, PAD, width);
    if (!fit.breaks.length) assert.ok(NATURAL * fit.zoom <= width, `${width}: what is scaled fits`);
  }
});

test('the zoom never rises as the window narrows while the bar is one row, and stays at or over the floor', () => {
  let last = 1;
  for (let width = 1700; width >= 1300; width -= 3) {
    const fit = fitBar(DECKS, GAP, PAD, width);
    assert.ok(fit.zoom >= BAR_ZOOM_FLOOR && fit.zoom <= 1);
    if (fit.breaks.length) break;
    assert.ok(fit.zoom <= last + 1e-9, `${width}`);
    last = fit.zoom;
  }
});

test('under the floor the bar is two rows, broken where the longer row is shortest, at its own size', () => {
  const fit = fitBar(DECKS, GAP, PAD, 1280);
  assert.deepEqual(fit, { zoom: 1, breaks: [3] }, 'Market, Time, Heatmap over Panels, Chart, Alerts, Tools');
  const longest = Math.max(...rowsOf(DECKS, fit.breaks).map(rowWidth));
  assert.ok(longest <= 1280);
  // No other break gives a shorter longer row.
  for (let k = 1; k < DECKS.length; k++) assert.ok(Math.max(...rowsOf(DECKS, [k]).map(rowWidth)) >= longest, `break before ${k}`);
  assert.deepEqual(fitBar(DECKS, GAP, PAD, 1024), { zoom: 1, breaks: [3] });
  assert.deepEqual(fitBar(DECKS, GAP, PAD, 800), { zoom: 0.89, breaks: [3] }, 'two rows scaled, while they fit at the floor');
});

test('never a row that does not fit: a narrower window takes a third row, balanced, before any row overflows', () => {
  for (let width = 1600; width >= 520; width -= 5) {
    const fit = fitBar(DECKS, GAP, PAD, width);
    const rows = rowsOf(DECKS, fit.breaks);
    assert.ok(fit.zoom >= BAR_ZOOM_FLOOR && fit.zoom <= 1, `${width}`);
    for (const r of rows) assert.ok(rowWidth(r) * fit.zoom <= width + 1e-9, `${width}: a row of ${r.join('+')} at ${fit.zoom}`);
    assert.deepEqual([...fit.breaks].sort((a, b) => a - b), fit.breaks, 'whole decks in their order');
  }
  const three = fitBar(DECKS, GAP, PAD, 700);
  assert.equal(three.breaks.length, 2, 'at 700 px three rows');
  const widths = rowsOf(DECKS, three.breaks).map(rowWidth);
  assert.ok(Math.min(...widths) / Math.max(...widths) > 0.6, `rows of ${widths.join(', ')} px: none a small deck left over`);
  // The rows only ever grow in number as the window narrows.
  let last = 0;
  for (let width = 1600; width >= 520; width -= 5) { const n = fitBar(DECKS, GAP, PAD, width).breaks.length; assert.ok(n >= last, `${width}`); last = n; }
});

test('a floor of 1 (the bevel frame, whose pressed borders snap apart under a fractional zoom) never scales: rows at its own size', () => {
  for (const width of [1500, 1440, 1366, 1280]) assert.deepEqual(fitBar(DECKS, GAP, PAD, width, 1), { zoom: 1, breaks: [3] }, `${width}`);
  assert.deepEqual(fitBar(DECKS, GAP, PAD, 1600, 1), { zoom: 1, breaks: [] });
  assert.equal(fitBar(DECKS, GAP, PAD, 800, 1).breaks.length, 2, 'three rows where two would need scaling');
});

test('degenerate inputs leave the bar alone', () => {
  assert.deepEqual(fitBar([], GAP, PAD, 1000), { zoom: 1, breaks: [] });
  assert.deepEqual(fitBar([500], GAP, PAD, 100), { zoom: 1, breaks: [] });
  assert.deepEqual(fitBar(DECKS, GAP, PAD, 0), { zoom: 1, breaks: [] }, 'a bar not laid out yet');
  assert.deepEqual(fitBar(DECKS, GAP, PAD, NaN), { zoom: 1, breaks: [] });
  assert.equal(fitBar(DECKS, GAP, PAD, 300).breaks.length, DECKS.length - 1, 'narrower than any deck: a deck a row, at the floor');
});
