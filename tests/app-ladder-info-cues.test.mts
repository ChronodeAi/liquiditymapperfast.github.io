import test from 'node:test';
import assert from 'node:assert/strict';
import { agoText, cueLines, gutterLines, levelLines, smallerVenuesLines, venueCellLines, type ChangeFact, type LevelFacts } from '../src/app/panes/ladder-info.ts';

const facts = (extra: Partial<LevelFacts> = {}): LevelFacts => ({ low: 81_000, step: 50, mark: 81_040, ask: false, size: 12e6, cumulative: 30e6, venues: [{ name: 'Binance BTCUSDT', usd: 8e6, id: 'binance:BTCUSDT' }, { name: 'OKX BTC-USDT', usd: 4e6, id: 'okx:BTC-USDT' }], ...extra });
const change = (extra: Partial<ChangeFact> = {}): ChangeFact => ({ name: 'Binance BTCUSDT', id: 'binance:BTCUSDT', usd: 2.4e6, ageMs: 1_200, removed: false, pair: false, ...extra });

test('how long ago reads as a person says it', () => {
  assert.equal(agoText(0), 'just now'); assert.equal(agoText(999), 'just now');
  assert.equal(agoText(1_000), '1 s ago'); assert.equal(agoText(4_400), '4 s ago'); assert.equal(agoText(59_000), '59 s ago');
  assert.equal(agoText(60_000), '1 min ago'); assert.equal(agoText(125_000), '2 min ago');
});

test('a change says its size with the sign, how long ago, and what it is not', () => {
  const lines = cueLines({ ask: false, changes: [change(), change({ usd: -1e6, ageMs: 9_000, name: 'OKX BTC-USDT', id: 'okx:BTC-USDT' })] });
  assert.equal(lines[0]!.label, 'Last change'); assert.equal(lines[0]!.text, '+$2.4M · 1 s ago'); assert.equal(lines[0]!.mark, 'binance:BTCUSDT'); assert.equal(lines[0]!.rule, true); assert.equal(lines[0]!.color, 'below');
  assert.equal(lines[1]!.label, ''); assert.equal(lines[1]!.text, '−$1M · 9 s ago'); assert.equal(lines[1]!.mark, 'okx:BTC-USDT'); assert.equal(lines[1]!.rule, false);
  const last = lines[lines.length - 1]!;
  assert.match(last.text, /not an order/); assert.equal(last.wrap, true); assert.equal(last.color, 'muted');
  assert.equal(cueLines({ ask: true, changes: [change()] })[0]!.color, 'above', 'an ask is in the asks\' colour');
});

test('a cell that emptied, a pair and a limit of lines are said', () => {
  const emptied = cueLines({ ask: true, changes: [change({ usd: -5e6, removed: true })] });
  assert.equal(emptied[0]!.text, '−$5M · emptied · 1 s ago');
  const paired = cueLines({ ask: true, changes: [change({ pair: true })] });
  assert.ok(paired.some(l => /went the other way, by about the same size/.test(l.text)));
  assert.ok(!paired.some(l => /re-quote|requote|probably/i.test(l.text)), 'it names no cause: the book does not say whether it is one order moving, a row\'s edge crossed, or two');
  const many = cueLines({ ask: false, changes: [1, 2, 3, 4, 5].map(i => change({ ageMs: i * 1_000 })) });
  assert.equal(many.filter(l => /\$/.test(l.text) && /ago/.test(l.text)).length, 3, 'three by default');
  assert.equal(cueLines({ ask: false, changes: [1, 2, 3, 4, 5].map(i => change({ ageMs: i * 1_000 })) }, 5).filter(l => /ago/.test(l.text)).length, 5);
});

test('nothing changed and no heat: no lines', () => {
  assert.deepEqual(cueLines({ ask: false }), []);
  assert.deepEqual(cueLines({ ask: false, changes: [] }), []);
  assert.deepEqual(cueLines({ ask: false, heat: { kind: 'added', fresh: 0, unknown: 0, activity: 0 } }), []);
});

test('the heat says what it is a share of, and that a cell without history is not known yet', () => {
  const added = cueLines({ ask: false, heat: { kind: 'added', fresh: 0.37, unknown: 0.1, activity: 0.9 } });
  assert.deepEqual([added[0]!.label, added[0]!.text, added[0]!.rule], ['Recent adds', '37%', true]);
  assert.equal(added.length, 1);
  const active = cueLines({ ask: false, heat: { kind: 'activity', fresh: 0.37, unknown: 0.1, activity: 0.9 } });
  assert.deepEqual([active[0]!.label, active[0]!.text], ['Recent change', '90%']);
  const unknown = cueLines({ ask: false, heat: { kind: 'added', fresh: 0, unknown: 0.9, activity: 0 } });
  assert.ok(unknown.some(l => /first snapshot/.test(l.text)));
  const both = cueLines({ ask: false, changes: [change()], heat: { kind: 'added', fresh: 0.5, unknown: 0, activity: 0 } });
  assert.equal(both.find(l => l.label === 'Recent adds')!.rule, false, 'the rule is above the first group only');
});

test('the popups for a level, a venue\'s part and the smaller venues carry the changes; the gutter\'s popup stands alone', () => {
  const f = facts({ changes: [change()] });
  assert.ok(levelLines(f).some(l => l.label === 'Last change'));
  assert.ok(venueCellLines(f, f.venues[0]!).some(l => l.label === 'Last change'));
  assert.ok(smallerVenuesLines(f, f.venues).some(l => l.label === 'Last change'));
  assert.ok(!levelLines(facts()).some(l => l.label === 'Last change'), 'no change, no line');
  const venueLast = venueCellLines(facts({ changes: [change()] }), f.venues[0]!);
  assert.equal(venueLast[venueLast.length - 1]!.label, 'All venues here', 'the level\'s total stays last');
  const gutter = gutterLines({ low: 81_000, step: 50, mark: 81_040, ask: false, changes: [change({ removed: true, usd: -3e6 })], title: 'Binance BTCUSDT' });
  assert.equal(gutter[0]!.text, 'Binance BTCUSDT'); assert.ok(gutter.some(l => l.label === 'Price') && gutter.some(l => l.label === 'Distance') && gutter.some(l => /emptied/.test(l.text)));
  assert.equal(gutterLines({ low: 1, step: 1, mark: 1, ask: true, changes: [] })[0]!.text, 'Order book level');
});
