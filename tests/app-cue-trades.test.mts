import test from 'node:test';
import assert from 'node:assert/strict';
import { TapeRing } from '../src/app/tape/ring.ts';
import type { TapeBatch } from '../src/shared/tape.ts';
import { MEANWHILE_AFTER_MS, MEANWHILE_BEFORE_MS, meanwhile, tradedInRow } from '../src/app/panes/ladder-cues.ts';

const T0 = 1_760_000_000_000;
interface Order { id: string; t: number; price: number; usd: number; lo?: number; hi?: number }
function tapeOf(orders: Order[], seq = 1, ring = new TapeRing(4096)): TapeRing {
  const ids = [...new Set(orders.map(o => o.id))];
  const batch: TapeBatch = { seq, dropped: 0, ids, inst: Int32Array.from(orders.map(o => ids.indexOf(o.id))), t: Float64Array.from(orders.map(o => o.t)), price: Float64Array.from(orders.map(o => o.price)),
    usd: Float32Array.from(orders.map(o => o.usd)), lo: Float64Array.from(orders.map(o => o.lo ?? o.price)), hi: Float64Array.from(orders.map(o => o.hi ?? o.price)) };
  ring.add(batch, 1, 0);
  return ring;
}
/** The window a change's "meanwhile" looks in: [T0, T0 + 5,000] widened. */
const win = { from: T0 - MEANWHILE_BEFORE_MS, to: T0 + 5_000 + MEANWHILE_AFTER_MS };
const row = { lo: 81_000, hi: 81_050 };
/** An order well before every interval below (another venue, another row): the tape's stretch begins before they do. */
const early: Order = { id: 'c:BTC', t: T0 - 10_000, price: 82_500, usd: 1_000 };
/** And one after them: a tape that went quiet long before an interval ended does not cover it. */
const late: Order = { id: 'c:BTC', t: T0 + 20_000, price: 82_500, usd: 1_000 };

test('what traded at a row between two snapshots: the orders that reached it on that venue, on the side that takes from it', () => {
  const ring = tapeOf([early,
    { id: 'a:BTC', t: T0 + 1_000, price: 81_010, usd: 300_000 },                          // a buyer at the row: takes the asks
    { id: 'a:BTC', t: T0 + 2_000, price: 81_030, usd: 200_000, lo: 80_990, hi: 81_070 },   // a buyer that walked through the row
    { id: 'a:BTC', t: T0 + 3_000, price: 81_020, usd: -150_000 },                          // a seller at the row: takes the bids
    { id: 'b:BTC', t: T0 + 3_500, price: 81_020, usd: 900_000 },                           // another venue
    { id: 'a:BTC', t: T0 + 4_000, price: 81_200, usd: 700_000 },                           // another row
    { id: 'a:BTC', t: T0 + 20_000, price: 81_020, usd: 800_000 },                          // after the interval
  ]);
  assert.equal(tradedInRow(ring, { id: 'a:BTC', ask: true, ...row, ...win }), 500_000, 'asks: the two buyers, whole orders');
  assert.equal(tradedInRow(ring, { id: 'a:BTC', ask: false, ...row, ...win }), 150_000, 'bids: the seller');
  assert.equal(tradedInRow(ring, { id: 'b:BTC', ask: true, ...row, ...win }), 900_000);
  assert.equal(tradedInRow(ring, { id: 'c:BTC', ask: true, ...row, ...win }), 0, 'a venue that is on the tape (it traded a few seconds before) and had no order there: nothing traded');
  assert.equal(tradedInRow(ring, { id: 'zz:BTC', ask: true, ...row, ...win }), null, 'a venue that is not on the tape at all: its silence says nothing');
});

test('an order at the edge of a row: a price at the row\'s upper edge belongs to the next row; one that walked up to the lower edge reached the row', () => {
  const ring = tapeOf([early, { id: 'a:BTC', t: T0 + 100, price: 81_050, usd: 100_000 }, { id: 'a:BTC', t: T0 + 200, price: 80_990, usd: 50_000, lo: 80_990, hi: 81_000 }, late]);
  assert.equal(tradedInRow(ring, { id: 'a:BTC', ask: true, ...row, ...win }), 50_000);
});

test('the interval is looked at a little widely (two clocks, a snapshot that lags its book) and no wider', () => {
  const ring = tapeOf([{ id: 'a:BTC', t: T0 - MEANWHILE_BEFORE_MS - 1, price: 82_000, usd: 1 }, { id: 'a:BTC', t: T0 - MEANWHILE_BEFORE_MS + 1, price: 81_010, usd: 10_000 }, { id: 'a:BTC', t: T0 - MEANWHILE_BEFORE_MS - 1, price: 81_010, usd: 20_000 },
    { id: 'a:BTC', t: T0 + 5_000 + MEANWHILE_AFTER_MS - 1, price: 81_010, usd: 40_000 }, { id: 'a:BTC', t: T0 + 5_000 + MEANWHILE_AFTER_MS + 1, price: 81_010, usd: 80_000 }]);
  assert.equal(tradedInRow(ring, { id: 'a:BTC', ask: true, ...row, ...win }), 50_000);
  assert.deepEqual(meanwhile(T0, T0 + 5_000), win);
});

test('unknown is not zero: an interval the tape does not cover (before it began, after a gap in it) says nothing', () => {
  const ring = tapeOf([{ id: 'a:BTC', t: T0 + 1_000, price: 81_010, usd: 300_000 }, { id: 'a:BTC', t: T0 + 2_000, price: 81_010, usd: 300_000 }]);
  assert.equal(tradedInRow(ring, { id: 'a:BTC', ask: true, ...row, from: T0 - 60_000, to: T0 + 1_500 }), null, 'it began later than the interval did');
  assert.equal(tradedInRow(ring, { id: 'a:BTC', ask: true, ...row, from: T0 + 500_000, to: T0 + 501_000 }), null, 'the interval is long after its last order');
  tapeOf([{ id: 'a:BTC', t: T0 + 100_000, price: 81_010, usd: 100_000 }], 9, ring); // a batch after a gap in the sequence: a new stretch
  assert.equal(tradedInRow(ring, { id: 'a:BTC', ask: true, ...row, from: T0 + 1_500, to: T0 + 100_500 }), null, 'a gap lies inside it');
  assert.equal(tradedInRow(ring, { id: 'a:BTC', ask: true, ...row, from: T0 + 100_000, to: T0 + 100_500 }), 100_000, 'inside the stretch after the gap it is known');
  assert.equal(tradedInRow(new TapeRing(4096), { id: 'a:BTC', ask: true, ...row, ...win }), null, 'an empty tape');
  assert.equal(tradedInRow(ring, { id: 'a:BTC', ask: true, ...row, from: 5, to: 1 }), null, 'a backwards interval');
});
