import test from 'node:test';
import assert from 'node:assert/strict';
import { paintWatermark } from '../src/app/watermark.ts';

// A canvas context that keeps the properties it is given and a stack for save and restore, and ignores every drawing call: enough to see what a
// paint leaves behind.
function fakeContext(): { ctx: CanvasRenderingContext2D; state: Record<string, unknown>; depth: () => number } {
  const state: Record<string, unknown> = { font: '10px sans-serif', globalAlpha: 1, fillStyle: '#000000', textAlign: 'start', textBaseline: 'alphabetic' };
  const stack: Record<string, unknown>[] = [];
  const ctx = new Proxy({}, {
    get: (_target, key: string) => {
      if (key === 'save') return () => { stack.push({ ...state }); };
      if (key === 'restore') return () => { Object.assign(state, stack.pop()); };
      if (key === 'measureText') return (text: string) => ({ width: text.length * (String(state.font).startsWith('700 100px') ? 60 : 6) });
      if (key === 'fillText') return () => undefined;
      return state[key];
    },
    set: (_target, key: string, value: unknown) => { state[key] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, state, depth: () => stack.length };
}

test('the first paint of the watermark leaves the context as it found it: the 100 px bold font it measures with used to stay, and the next thing drawn (the time-zone label) came out giant', () => {
  const { ctx, state, depth } = fakeContext();
  paintWatermark(ctx, { text: '#111111', dark: false }, 800, 600, 'BTC 1h');
  assert.equal(state.font, '10px sans-serif');
  assert.equal(state.globalAlpha, 1);
  assert.equal(state.fillStyle, '#000000');
  assert.equal(depth(), 0, 'every save has its restore');
  paintWatermark(ctx, { text: '#111111', dark: false }, 800, 600, 'BTC 1h');
  assert.equal(state.font, '10px sans-serif', 'and so does every later paint');
});
