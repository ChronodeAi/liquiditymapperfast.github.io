import test from 'node:test';
import assert from 'node:assert/strict';
import { mayReload, onStale } from '../src/app/lazy.ts';

test('a stale page reloads itself once, and not again within half a minute, so a file that is really missing cannot loop', () => {
  assert.equal(mayReload(1_000_000, 0), true, 'never reloaded');
  assert.equal(mayReload(1_000_000, 999_000), false, 'it did a second ago');
  assert.equal(mayReload(1_000_000, 970_001), false);
  assert.equal(mayReload(1_000_000, 969_999), true, 'half a minute later it may try again');
});

test('only the page\'s start reloads for a missing file: a running page says so, since a reload loses what it holds in memory', () => {
  assert.equal(onStale(true, 1_000_000, 0), 'reload', 'the start, holding nothing yet');
  assert.equal(onStale(true, 1_000_000, 999_000), 'say', 'and not twice in half a minute');
  assert.equal(onStale(false, 1_000_000, 0), 'say', 'Shift+S on a tab open since before a deploy: never a reload');
});
