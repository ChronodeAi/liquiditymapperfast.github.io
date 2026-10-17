import test from 'node:test';
import assert from 'node:assert/strict';
import { intersect } from '../src/app/screenshot/capture.ts';
import { fileName } from '../src/app/screenshot/shapes.ts';

test('a GIF is named as the picture is, with its own extension', () => {
  const when = new Date(2026, 9, 17, 9, 5, 3);
  assert.equal(fileName(when, false, 'gif'), 'liquiditymapperfast-2026-10-17-0905-03.gif');
  assert.equal(fileName(when), 'liquiditymapperfast-2026-10-17-0905-03.png', 'a picture keeps its name');
});

test('a canvas is copied only where it, the area and its clip overlap', () => {
  const area = { x: 100, y: 100, w: 400, h: 300 };
  assert.deepEqual(intersect({ x: 0, y: 0, w: 200, h: 150 }, area), { x: 100, y: 100, w: 100, h: 50 });
  assert.deepEqual(intersect(area, null), area, 'no clip is no limit');
  assert.equal(intersect({ x: 600, y: 0, w: 50, h: 50 }, area), null, 'outside');
  assert.equal(intersect({ x: 500, y: 100, w: 50, h: 50 }, area), null, 'touching an edge is not overlapping');
  const clip = intersect(area, { x: 300, y: 50, w: 100, h: 100 });
  assert.deepEqual(intersect({ x: 0, y: 0, w: 1000, h: 1000 }, clip), { x: 300, y: 100, w: 100, h: 50 });
});
