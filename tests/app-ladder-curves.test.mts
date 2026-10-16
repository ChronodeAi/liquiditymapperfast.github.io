import test from 'node:test';
import assert from 'node:assert/strict';
import { CURVE_HOLD_MS, CURVE_MIN_ROWS, CurveRanking, curveColors, curveLines, lineFraction, lineTicks, nearestCurve, rankCurveVenues, reachRows, reachText, venueCumulative } from '../src/app/panes/ladder-curves.ts';
import { beyondCover, cumulative, pastReach, type Grouped } from '../src/app/panes/levels-data.ts';
import { PALETTES, contrastRatio } from '../src/app/theme.ts';
import { nearDirection } from '../src/app/cvd/colors.ts';
import { LADDER_CURVES } from '../src/app/store.ts';

/** Three venues on ten bins of $10 from 1 000; the mark at 1 045 (bin 4). */
const book = (): Grouped => {
  const nBins = 10, rows = [[5, 4, 3, 2, 1, 1, 2, 3, 4, 5], [0, 0, 7, 0, 9, 9, 0, 7, 0, 0], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]];
  const bid = rows.map(r => Float32Array.from(r.map((v, i) => i <= 4 ? v : 0))), ask = rows.map(r => Float32Array.from(r.map((v, i) => i >= 4 ? v : 0)));
  const sum = (sides: Float32Array[]) => Float32Array.from({ length: nBins }, (_, i) => sides.reduce((s, side) => s + side[i]!, 0));
  return { ids: ['binance:BTCUSDT', 'okx:BTC-USDT-SWAP', 'kraken:XBTUSD'], step: 10, bin0: 100, nBins, bid, ask, totalBid: sum(bid), totalAsk: sum(ask) };
};

test('venue lines: each venue\'s running total follows the whole book\'s rule, and together they make the whole book\'s', () => {
  const g = book(), markBin = 4, whole = cumulative(g, 1_045);
  const each = g.ids.map((_, i) => venueCumulative(g, i, markBin));
  for (let bin = 0; bin < g.nBins; bin++) {
    assert.equal(each.reduce((s, c) => s + c.bid[bin]!, 0), whole.bid[bin]);
    assert.equal(each.reduce((s, c) => s + c.ask[bin]!, 0), whole.ask[bin]);
  }
  // OKX: 9 at the mark, then 7 two rows down: 9, 9, 16 walking down; up: 9, 9, 9, 16.
  assert.deepEqual([...each[1]!.bid.slice(0, 5)].reverse(), [9, 0 + 9, 16, 16, 16]);
  assert.deepEqual([...each[1]!.ask.slice(4)], [9, 18, 18, 25, 25, 25]);
});

test('venue lines: the venues with traded volume first, the most first, then those with none by their liquidity, and only as many as asked', () => {
  const volume: Record<string, number | null> = { a: 50, b: null, c: 900, d: 0, e: null, f: 50 };
  const liquidity: Record<string, number> = { a: 1, b: 300, c: 1, d: 0, e: 700, f: 1 };
  const ranked = rankCurveVenues(Object.keys(volume), id => volume[id]!, id => liquidity[id]!, 4);
  assert.deepEqual(ranked.map(r => [r.id, r.volume, r.rank]), [['c', 900, 1], ['a', 50, 2], ['f', 50, 3], ['e', null, 4]]);
  assert.equal(rankCurveVenues(['d'], () => 0, () => 0, 5).length, 0, 'a book with neither volume nor liquidity has no line');
  assert.deepEqual(rankCurveVenues(['a', 'b'], () => null, id => liquidity[id]!, 0), []);
  assert.deepEqual([...LADDER_CURVES], [0, 3, 5, 8]);
});

test('venue lines: a book that reaches under three rows keeps its place in the order but gives its line to the next one', () => {
  // At 82,000 with rows of $50: MEXC's best 20 levels reach about 1 bp, Bybit's 25 bp (4 rows), a one-sided book 3 rows up.
  assert.equal(reachRows({ lo: 81_992, hi: 82_008 }, 82_000, 50), 0);
  assert.equal(reachRows({ lo: 81_795, hi: 82_205 }, 82_000, 50), 4);
  assert.equal(reachRows({ lo: 82_000, hi: 82_150 }, 82_000, 50), 3, 'the longer side counts');
  assert.equal(reachRows(null, 82_000, 50), 0);
  assert.equal(CURVE_MIN_ROWS, 3);
  const volume: Record<string, number> = { binance: 9, okx: 8, bybit: 7, mexc: 6, bitget: 5, deribit: 4 };
  const ranked = rankCurveVenues(Object.keys(volume), id => volume[id]!, () => 1, 4, id => id !== 'mexc');
  assert.deepEqual(ranked.map(r => [r.id, r.rank, r.shallow ?? false]), [['binance', 1, false], ['okx', 2, false], ['bybit', 3, false], ['mexc', 4, true], ['bitget', 5, false]], 'four lines; MEXC named at its place');
  assert.deepEqual(rankCurveVenues(['mexc'], () => 1, () => 1, 3, () => false).map(r => r.shallow), [true]);
  assert.deepEqual(rankCurveVenues(['a'], () => 1, () => 1, 0, () => false), [], 'no lines asked, none named');
  assert.equal(reachText({ lo: 81_795, hi: 82_205 }, 82_000), '−0.25% … +0.25%');
});

test('venue lines: the ranking is held a minute while the same books are on, and made again when they change', () => {
  const held = new CurveRanking();
  let made = 0;
  const make = () => { made++; return [{ id: `x${made}`, volume: 1, rank: 1 }]; };
  assert.equal(held.apply(0, ['a', 'b'], 5, make)[0]!.id, 'x1');
  assert.equal(held.apply(CURVE_HOLD_MS - 1, ['b', 'a'], 5, make)[0]!.id, 'x1', 'the same books in another order');
  assert.equal(held.apply(CURVE_HOLD_MS, ['a', 'b'], 5, make)[0]!.id, 'x2', 'a minute later');
  assert.equal(held.apply(CURVE_HOLD_MS + 1, ['a', 'b', 'c'], 5, make)[0]!.id, 'x3', 'a book switched on');
  assert.equal(held.apply(CURVE_HOLD_MS + 2, ['a', 'b', 'c'], 3, make)[0]!.id, 'x4', 'another count');
  assert.equal(held.apply(CURVE_HOLD_MS + 3, ['a', 'b', 'c'], 3, make, '1h')[0]!.id, 'x5', 'another ranking window');
  assert.equal(held.apply(CURVE_HOLD_MS + 4, ['a', 'b', 'c'], 3, make, '1h')[0]!.id, 'x5');
});

test('venue lines: eight colours on every theme, all different, none near its buy or sell colour, each 3:1 clear of the panel', () => {
  for (const [name, p] of Object.entries(PALETTES)) {
    const colours = curveColors(p, 8);
    assert.equal(colours.length, 8, name);
    assert.equal(new Set(colours).size, 8, `${name}: ${colours.join(' ')}`);
    for (const c of colours) {
      assert.ok(contrastRatio(c, p.panel) >= 3, `${name}: ${c} on ${p.panel}`);
      assert.ok(!nearDirection(c, p), `${name}: ${c} reads as buy or sell`);
    }
    assert.deepEqual(curveColors(p, 3), colours.slice(0, 3), 'a line keeps its colour whatever the count');
  }
});

test('venue lines: the line the pointer is on is the nearest within reach, the higher ranked on a tie', () => {
  assert.equal(nearestCurve([100, 104, null, 98], 101), 0);
  assert.equal(nearestCurve([100, 102, null], 101), 0, 'a tie goes to the higher ranked line');
  assert.equal(nearestCurve([100, 120], 106), null, 'out of reach');
  assert.equal(nearestCurve([null, 120], 121), 1);
});

test('venue lines: the popup says the venue\'s running total, its share of everyone\'s, its size here and its volume', () => {
  const lines = curveLines({ id: 'okx:BTC-USDT-SWAP', name: 'OKX BTC-USDT-SWAP', rank: 2, low: 82_000, step: 10, ask: false, mark: 82_100, venueCum: 2_500_000, totalCum: 10_000_000, venueLevel: 400_000, volume: 1_200_000_000, window: '1 h', full: 9_000_000 });
  const text = lines.map(l => `${l.label ?? ''}|${l.text}`);
  assert.equal(lines[0]!.mark, 'okx:BTC-USDT-SWAP');
  assert.ok(text.includes('From the mark|$2.5M'), text.join('\n'));
  assert.ok(text.includes('Share of the depth shown|25%'));
  assert.ok(text.includes('At this price|$400K'));
  assert.ok(text.includes('Traded, last 1 h|$1.2B · #2'));
  assert.ok(text.includes('Lines, full width|$9M'), 'the lines\' own scale');
  const unranked = curveLines({ id: 'x:Y', name: 'X Y', rank: 4, low: 1, step: 1, ask: true, mark: 1, venueCum: 0, totalCum: 0, venueLevel: 0, volume: null, window: '1 h', full: 1 });
  assert.match(unranked.at(-1)!.text, /liquidity in view/);
  assert.ok(unranked.some(l => l.text === '0%'), 'no share when nothing rests');
});

test('venue lines: a linear axis up to the largest, with round values for gridlines', () => {
  assert.equal(lineFraction(300_000_000, 300_000_000), 1);
  assert.equal(lineFraction(75_000_000, 300_000_000), 0.25);
  assert.equal(lineFraction(400_000_000, 300_000_000), 1, 'never past the column');
  assert.equal(lineFraction(0, 1), 0);
  assert.equal(lineFraction(5, 0), 0);
  assert.deepEqual(lineTicks(9_000_000), [2_000_000, 4_000_000, 6_000_000, 8_000_000]);
  assert.deepEqual(lineTicks(1_000_000), [200_000, 400_000, 600_000, 800_000], 'none on the right wall itself');
  assert.deepEqual(lineTicks(300_000_000), [100_000_000, 200_000_000]);
  assert.deepEqual(lineTicks(0), []);
  for (const full of [1, 7, 13, 99, 1234, 55_555, 2.5e6, 3e9]) {
    const ticks = lineTicks(full);
    assert.ok(ticks.length >= 1 && ticks.length <= 4 && ticks.every(v => v > 0 && v < full), `${full}: ${ticks}`);
  }
});

test('venue lines: past a book\'s reach on its own side the line goes on at the total it reached; the popup says the book ends there', () => {
  // A book of single prices from 990 to 1 060 (its highest ask a level at exactly 1 060), rows of $10.
  const cover = { lo: 990, hi: 1_060, hiPoint: true };
  assert.equal(pastReach(cover, 1_060, 10, true), false, 'the row holding its highest ask is measured');
  assert.equal(pastReach(cover, 1_070, 10, true), true);
  assert.equal(pastReach(cover, 990, 10, false), false, 'the row holding its lowest bid is measured');
  assert.equal(pastReach(cover, 980, 10, false), true);
  assert.equal(pastReach({ lo: 990, hi: 1_060 }, 1_060, 10, true), true, 'a band ends short of its upper edge, as beyondCover has it');
  // Every row past the reach is beyond the cover, so the two rules never disagree there.
  for (const [row, ask] of [[1_070, true], [1_200, true], [980, false], [500, false]] as const) assert.ok(beyondCover(cover, row, 10) && pastReach(cover, row, 10, ask));
  // The running total is flat there: no level of the book lies past its reach.
  const g = book(), c = venueCumulative(g, 1, 4);
  assert.equal(c.ask[9], c.ask[7], 'OKX has nothing above bin 7');

  const past = curveLines({ id: 'bybit:BTCUSDT', name: 'Bybit BTCUSDT', rank: 3, low: 82_500, step: 50, ask: true, mark: 82_000, venueCum: 54_000_000, totalCum: 400_000_000, venueLevel: 0, volume: 2e9, window: '1 h', full: 4e8, reach: 82_205 });
  const text = past.map(l => `${l.label ?? ''}|${l.text}`);
  assert.ok(text.includes('From the mark|at least $54M'), text.join('\n'));
  assert.ok(text.some(s => s.includes('ends at 82,205') && s.includes('+0.25%')), text.join('\n'));
  assert.ok(!text.some(s => s.startsWith('Share of the depth shown') || s.startsWith('At this price')), 'not known past the book');
});
