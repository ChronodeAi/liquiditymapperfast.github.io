import test from 'node:test';
import assert from 'node:assert/strict';
import { CREST_MS, CUE_LIFE_MS, CellMap, CueBoard, MARK_LIFE_MS, MIN_CUE_STRENGTH, bodyLight, crestAt, crestLight, markLight, type CueRow, type Geometry } from '../src/app/panes/ladder-cues.ts';
import { pulseEnvelope } from '../src/app/candle/model.ts';

let seq = 0;
const row = (id: string, side: 'bid' | 'ask', rowIx: number, usd: number, strength: number, extra: Partial<CueRow> = {}): CueRow =>
  ({ id, side, row: rowIx, usd, strength, wall: 1_000, seq: ++seq, removed: false, added: false, pair: false, band: false, ...extra });
/** Every cell 100 x 10 px and every row on screen, unless said. */
const flat = (visible: (row: number) => boolean = () => true, cell: (id: string, side: 'bid' | 'ask', row: number) => boolean = () => true): Geometry =>
  ({ rowVisible: visible, cell: (id, side, r) => cell(id, side, r) ? { x: 0, y: 0, w: 100, h: 10, usd: 5e6 } : null });

test('the crest runs out through the cell for an addition and back in for a decrease, over the same time', () => {
  assert.equal(crestAt(1, 0), 0); assert.equal(crestAt(1, CREST_MS), 1); assert.equal(crestAt(1, 5 * CREST_MS), 1);
  assert.equal(crestAt(-1, 0), 1); assert.equal(crestAt(-1, CREST_MS), 0); assert.equal(crestAt(-1, -50), 1);
  for (const age of [0, 50, 190, 380]) assert.ok(Math.abs(crestAt(1, age) + crestAt(-1, age) - 1) < 1e-12, 'mirror images');
});

test('the light is as strong as the change, the same for both signs, and gone with the cue', () => {
  for (const age of [0, 40, 80, 200, 600, 1_400]) assert.equal(bodyLight(0.5, age), 0.5 * pulseEnvelope(age));
  assert.equal(bodyLight(0.8, 0), 0); assert.ok(bodyLight(0.8, 80) > 0.79);
  assert.equal(crestLight(0.7, -1), 0); assert.equal(crestLight(0.7, CUE_LIFE_MS + 1), 0); assert.ok(crestLight(0.7, 0) === 0.7 && crestLight(0.7, 520) < 0.26);
  assert.ok(bodyLight(0.4, 300) < bodyLight(0.9, 300), 'a larger change is brighter at the same moment');
  assert.equal(markLight(-1), 0); assert.equal(markLight(0), 1); assert.equal(markLight(MARK_LIFE_MS + 1), 0); assert.ok(markLight(MARK_LIFE_MS / 2) > 0 && markLight(MARK_LIFE_MS * 0.9) < markLight(MARK_LIFE_MS * 0.2));
});

test('the cell map answers for the cells of the last draw, by venue, side and row, and forgets them at the next', () => {
  const map = new CellMap();
  map.begin(100, 4); // rows 100, 99, 98, 97
  map.set('a:BTC', 0, 1, 10, 20, 50, 13, 7e6); map.set('a:BTC', 2, 0, 12, 60, 40, 13, 3e6); map.set('b:BTC', 1, 1, 5, 40, 90, 13, 9e6);
  assert.deepEqual(map.cell('a:BTC', 'ask', 100), { x: 10, y: 20, w: 50, h: 13, usd: 7e6 });
  assert.equal(map.cell('a:BTC', 'bid', 100), null, 'the row shows the other side');
  assert.deepEqual(map.cell('a:BTC', 'bid', 98), { x: 12, y: 60, w: 40, h: 13, usd: 3e6 });
  assert.equal(map.cell('b:BTC', 'ask', 99)!.w, 90); assert.equal(map.cell('b:BTC', 'ask', 100), null, 'the venue has no cell on that row');
  assert.equal(map.cell('zz:BTC', 'ask', 100), null);
  assert.equal(map.cell('a:BTC', 'ask', 101), null, 'above the first row'); assert.equal(map.cell('a:BTC', 'ask', 96), null, 'below the last');
  assert.ok(map.rowVisible(100) && map.rowVisible(97) && !map.rowVisible(101) && !map.rowVisible(96));
  assert.equal(map.rowOf(0), 100); assert.equal(map.rowOf(3), 97);
  map.set('a:BTC', 9, 0, 1, 1, 1, 1, 1); assert.equal(map.cell('a:BTC', 'bid', 91), null, 'a row past the draw is ignored');
  map.begin(110, 6);
  assert.equal(map.cell('a:BTC', 'ask', 100), null, 'a new draw starts empty'); assert.equal(map.rowVisible(110) && map.rowVisible(105), true);
  map.set('a:BTC', 5, 1, 1, 2, 3, 4, 5); assert.deepEqual(map.cell('a:BTC', 'ask', 105), { x: 1, y: 2, w: 3, h: 4, usd: 5 }, 'longer than before: the arrays grew');
  map.forget(new Set(['b:BTC'])); assert.equal(map.cell('a:BTC', 'ask', 105), null);
});

test('a change on a row that is on screen lights its cell and leaves its mark', () => {
  const board = new CueBoard();
  board.push([row('a:BTC', 'ask', 5, 2e6, 0.6)]);
  assert.equal(board.waiting, 1);
  board.admit(1_000, 'wash', flat());
  assert.equal(board.waiting, 0); assert.equal(board.active.length, 1);
  const cue = board.active[0]!;
  assert.deepEqual([cue.id, cue.side, cue.row, cue.sign, cue.strength, cue.t0], ['a:BTC', 'ask', 5, 1, 0.6, 1_000]);
  assert.ok(cue.cost > 0 && cue.cost <= 100 * 10);
  const mark = board.marks.get('ask|5')!;
  assert.deepEqual([mark.sign, mark.lit, mark.t0], [1, true, 1_000]);
  board.push([row('a:BTC', 'bid', 3, -4e6, 0.9, { removed: true })]); board.admit(1_100, 'wash', flat());
  assert.equal(board.active[1]!.sign, -1); assert.equal(board.active[1]!.removed, true);
});

test('a row off screen, a venue with no cell there and a change too small to see light nothing; only a visible row keeps a mark', () => {
  const board = new CueBoard();
  board.push([row('a:BTC', 'ask', 5, 2e6, 0.6), row('b:BTC', 'ask', 6, 2e6, 0.6), row('c:BTC', 'ask', 7, 2e6, MIN_CUE_STRENGTH / 2)]);
  board.admit(1_000, 'wash', flat(r => r !== 5, (id) => id !== 'b:BTC'));
  assert.equal(board.active.length, 0);
  assert.equal(board.marks.has('ask|5'), false, 'off screen: nothing');
  assert.equal(board.marks.get('ask|6')!.lit, false, 'on screen with no cell for that venue: a mark, no light');
  assert.equal(board.marks.get('ask|7')!.lit, false, 'too small');
  board.push([row('a:BTC', 'ask', 8, 0, 0.9), row('a:BTC', 'ask', 9, NaN, 0.9)]); board.admit(1_000, 'wash', flat());
  assert.equal(board.active.length, 0, 'no change, no light');
});

test('light is spent from a budget: the cell count and the area are capped and nothing bypasses them', () => {
  const caps = { maxCues: 3, maxArea: 1e9 }, board = new CueBoard(caps);
  board.push([1, 2, 3, 4, 5].map(i => row(`v${i}:BTC`, 'ask', i, 1e6, 0.5)));
  board.admit(1_000, 'wash', flat());
  assert.equal(board.active.length, 3); assert.equal(board.stats.turnedDown, 2);
  board.push([row('big:BTC', 'ask', 20, 5e9, 1)]); board.admit(1_100, 'wash', flat());
  assert.equal(board.active.length, 3, 'a huge change does not bypass the cap'); assert.ok(board.marks.has('ask|20'), 'but it leaves its mark');
  const area = new CueBoard({ maxCues: 100, maxArea: 2_500 });
  area.push([1, 2, 3, 4, 5, 6].map(i => row(`v${i}:BTC`, 'bid', i, -1e6, 1)));
  area.admit(1_000, 'wash', flat());
  assert.equal(area.active.length, 2, 'a 100 x 10 cell at full strength costs 1,000 px2: two fit under 2,500');
  assert.ok(area.used <= 2_500);
});

test('the largest changes are lit first, and every venue gets its largest before any venue its second', () => {
  const board = new CueBoard({ maxCues: 3, maxArea: 1e9 });
  board.push([row('busy:BTC', 'ask', 1, 1e6, 0.9), row('busy:BTC', 'ask', 2, 1e6, 0.85), row('busy:BTC', 'ask', 3, 1e6, 0.8), row('busy:BTC', 'ask', 4, 1e6, 0.75), row('quiet:BTC', 'ask', 5, 1e6, 0.1), row('mid:BTC', 'ask', 6, 1e6, 0.3)]);
  board.admit(1_000, 'wash', flat());
  assert.deepEqual(board.active.map(c => c.id).sort(), ['busy:BTC', 'mid:BTC', 'quiet:BTC'], 'one busy venue cannot take every place');
  assert.equal(board.active.find(c => c.id === 'busy:BTC')!.row, 1, 'its largest');
  const again = new CueBoard({ maxCues: 2, maxArea: 1e9 });
  again.push([row('a:BTC', 'bid', 1, -1, 0.2), row('b:BTC', 'bid', 2, -1, 0.9), row('c:BTC', 'bid', 3, -1, 0.5)]);
  again.admit(1_000, 'wash', flat());
  assert.deepEqual(again.active.map(c => c.id), ['b:BTC', 'c:BTC'], 'then the larger of the venues');
});

test('another change at a lit cell renews it when it has the same sign and replaces it when it has the other, without paying twice', () => {
  const board = new CueBoard({ maxCues: 10, maxArea: 1_500 });
  board.push([row('a:BTC', 'ask', 5, 1e6, 0.5)]); board.admit(1_000, 'wash', flat());
  const cost = board.used;
  board.push([row('a:BTC', 'ask', 5, 3e6, 0.8)]); board.admit(1_200, 'wash', flat());
  assert.equal(board.active.length, 1); assert.equal(board.active[0]!.strength, 0.8); assert.equal(board.active[0]!.usd, 4e6); assert.equal(board.active[0]!.t0, 1_200); assert.equal(board.stats.renewed, 1);
  assert.ok(board.used > cost && board.used <= 1_000 * 0.85 + 1e-6, 'the one cell is charged once, at its new strength');
  board.push([row('a:BTC', 'ask', 5, -2e6, 0.3)]); board.admit(1_300, 'wash', flat());
  assert.equal(board.active.length, 1); assert.equal(board.active[0]!.sign, -1); assert.equal(board.active[0]!.strength, 0.3); assert.equal(board.stats.reversed, 1);
  board.push([row('a:BTC', 'ask', 5, 1e6, 0.4), row('a:BTC', 'ask', 5, 1e6, 0.6)]); board.admit(1_400, 'wash', flat());
  assert.equal(board.active.length, 1, 'two in one batch are one cell');
});

test('a cue is over after its life, a mark after its own, and what is over frees its budget', () => {
  const board = new CueBoard({ maxCues: 1, maxArea: 1e9 });
  board.push([row('a:BTC', 'ask', 5, 1e6, 0.5)]); board.admit(1_000, 'wash', flat());
  assert.equal(board.prune(1_000 + CUE_LIFE_MS), true); assert.equal(board.prune(1_000 + CUE_LIFE_MS + 1), false);
  assert.equal(board.active.length, 0); assert.equal(board.marks.size, 1);
  board.prune(1_000 + MARK_LIFE_MS + 1); assert.equal(board.marks.size, 0);
  board.push([row('a:BTC', 'ask', 5, 1e6, 0.5)]); board.admit(1_000, 'wash', flat());
  board.push([row('b:BTC', 'ask', 6, 1e6, 0.5)]); board.admit(1_100, 'wash', flat());
  assert.equal(board.active.length, 1, 'full'); board.push([row('b:BTC', 'ask', 6, 1e6, 0.5)]); board.admit(1_000 + CUE_LIFE_MS + 10, 'wash', flat());
  assert.deepEqual(board.active.map(c => c.id), ['b:BTC'], 'the first cue ended and made room');
});

test('a row\'s mark is the strongest recent change on it, and the look of marks only lights nothing', () => {
  const board = new CueBoard();
  board.push([row('a:BTC', 'ask', 5, 1e6, 0.9)]); board.admit(1_000, 'wash', flat());
  board.push([row('b:BTC', 'ask', 5, 1e5, 0.05)]); board.admit(1_100, 'wash', flat());
  assert.equal(board.marks.get('ask|5')!.id, 'a:BTC', 'a weak change does not replace a strong one');
  board.push([row('c:BTC', 'ask', 5, -5e6, 0.8)]); board.admit(1_200, 'wash', flat());
  assert.equal(board.marks.get('ask|5')!.id, 'c:BTC', 'a comparable change of the other sign does');
  board.push([row('d:BTC', 'ask', 5, 2e5, 0.9)]); board.admit(1_000 + MARK_LIFE_MS - 50, 'wash', flat());
  assert.equal(board.marks.get('ask|5')!.id, 'd:BTC', 'a fading mark gives way to a fresh one of the same strength');
  const marks = new CueBoard();
  marks.push([row('a:BTC', 'ask', 5, 1e6, 0.9)]); marks.admit(1_000, 'marks', flat());
  assert.equal(marks.active.length, 0); assert.equal(marks.marks.get('ask|5')!.lit, false); assert.equal(marks.stats.off, 1);
});

test('a look pays for the area it lights: a rim costs a fifth of a wash', () => {
  const wash = new CueBoard(), rim = new CueBoard(), deposit = new CueBoard();
  for (const [b, look] of [[wash, 'wash'], [rim, 'rim'], [deposit, 'deposit']] as const) { b.push([row('a:BTC', 'ask', 5, 1e6, 1)]); b.admit(1_000, look, flat()); }
  assert.ok(Math.abs(rim.used / wash.used - 0.2) < 1e-9); assert.ok(Math.abs(deposit.used / wash.used - 0.6) < 1e-9);
});

test('the waiting changes are bounded, and clear() empties everything', () => {
  const board = new CueBoard();
  board.push(Array.from({ length: 1_000 }, (_, i) => row('a:BTC', 'ask', i, 1e6, 0.5)));
  assert.equal(board.waiting, 512);
  board.admit(1_000, 'wash', flat()); assert.ok(board.active.length > 0 && board.marks.size > 0);
  board.push([row('a:BTC', 'ask', 1, 1e6, 0.5)]); board.clear();
  assert.deepEqual([board.active.length, board.marks.size, board.waiting], [0, 0, 0]);
});
