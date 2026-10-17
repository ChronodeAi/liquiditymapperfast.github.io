import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS_REV, DEFAULT_SHOW, defaultShow, initialState } from '../src/app/store.ts';
import { COLUMN_SHARE, MIN_FLOW_W, MIN_SIDE_W, defaultColumns } from '../src/app/layouts/layouts.ts';

const saved = (blob: Record<string, unknown> | null, run: () => void): void => {
  const real = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { innerWidth: 1600, localStorage: { getItem: () => blob ? JSON.stringify(blob) : null, setItem: () => {} } };
  try { run(); } finally { if (real === undefined) delete (globalThis as { window?: unknown }).window; else (globalThis as { window?: unknown }).window = real; }
};

test('a first visit starts with no pane under the map, and the flow column and the book beside it', () => {
  for (const key of ['depth', 'oi', 'delta', 'ls', 'lt', 'footprint'] as const) assert.equal(DEFAULT_SHOW[key], false, key);
  assert.equal(defaultShow(1920).cvd, true);
  assert.equal(defaultShow(1920).book, true);
});

test('a save written under the old defaults (Depth and Open interest both on, no revision) has them off once; a choice is kept', () => {
  saved(null, () => assert.deepEqual([initialState().show.depth, initialState().show.oi], [false, false]));
  saved({ show: { ...DEFAULT_SHOW, depth: true, oi: true } }, () => {
    const s = initialState();
    assert.deepEqual([s.show.depth, s.show.oi, s.defaultsRev], [false, false, DEFAULTS_REV]);
  });
  // Only one of them on was a choice, and so is anything saved under the new revision.
  saved({ show: { ...DEFAULT_SHOW, depth: true, oi: false } }, () => assert.deepEqual([initialState().show.depth, initialState().show.oi], [true, false]));
  saved({ defaultsRev: DEFAULTS_REV, show: { ...DEFAULT_SHOW, depth: true, oi: true } }, () => assert.deepEqual([initialState().show.depth, initialState().show.oi], [true, true]));
});

test('the columns begin at the golden section of the window, as wide as before at the least', () => {
  assert.ok(Math.abs(1 - 2 * COLUMN_SHARE - 0.618) < 0.001, 'the map keeps 61.8 %');
  assert.deepEqual(defaultColumns(1366), { flowW: MIN_FLOW_W, sideW: MIN_SIDE_W });
  assert.deepEqual(defaultColumns(1920), { flowW: 367, sideW: MIN_SIDE_W });
  assert.deepEqual(defaultColumns(2560), { flowW: 489, sideW: 489 });
  assert.deepEqual(defaultColumns(3840), { flowW: 733, sideW: 733 });
  assert.deepEqual(defaultColumns(0), { flowW: MIN_FLOW_W, sideW: MIN_SIDE_W });
});

test('the stylesheet sets the columns the same way before the page has run', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'src', 'app', 'styles.css'), 'utf8');
  const vw = `${(COLUMN_SHARE * 100).toFixed(1)}vw`;
  assert.ok(css.includes(`--side-w: max(${MIN_SIDE_W}px, ${vw})`), 'the book');
  assert.ok(css.includes(`--flow-w: max(${MIN_FLOW_W}px, ${vw})`), 'the flow column');
});
