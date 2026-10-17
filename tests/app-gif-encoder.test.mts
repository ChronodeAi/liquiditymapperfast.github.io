import test from 'node:test';
import assert from 'node:assert/strict';
import { BEST, Bytes, EXACT_BINS, FrameDiffer, GifEncoder, GifWriter, Lzw, MIN_DITHER, ditherFor, leavesAlone, mappedWith, tableBits, type FrameSettings } from '../src/app/screenshot/gif-encoder.ts';
import { decodeGif, lzwDecode } from './gif-decode.mts';

/** The sub-blocks of an LZW image (after its minimum code size byte) joined, as the decoder reads them. */
function blocks(bytes: Uint8Array): { min: number; data: Uint8Array } {
  const min = bytes[0]!, parts: number[] = [];
  let p = 1;
  for (let len = bytes[p++]!; len > 0; len = bytes[p++]!) { for (let i = 0; i < len; i++) parts.push(bytes[p + i]!); p += len; }
  assert.equal(p, bytes.length, 'the image ends at its terminator');
  return { min, data: Uint8Array.from(parts) };
}

/** A pseudo-random sequence that is the same on every run. */
function random(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

test('LZW gives back what it was given, for every code size, across table clears and runs', () => {
  const lzw = new Lzw(), rnd = random(7);
  for (const min of [2, 3, 5, 8]) {
    for (const [length, kind] of [[1, 'noise'], [37, 'noise'], [5000, 'noise'], [70_000, 'noise'], [70_000, 'runs'], [9000, 'same']] as const) {
      const indices = new Uint8Array(length), top = 1 << min;
      let v = 0;
      for (let i = 0; i < length; i++) {
        if (kind === 'noise') v = Math.floor(rnd() * top);
        else if (kind === 'runs') { if (rnd() < 0.08) v = Math.floor(rnd() * top); }
        else v = top - 1;
        indices[i] = v;
      }
      const out = new Bytes(16);
      lzw.encode(indices, length, min, out);
      const { min: written, data } = blocks(out.take());
      assert.equal(written, min);
      assert.deepEqual(lzwDecode(data, min, length), indices, `${kind} of ${length} at ${min} bits`);
    }
  }
});

test('LZW folds a frame that is mostly one index into very few bytes', () => {
  const n = 400 * 300, indices = new Uint8Array(n).fill(255);
  for (let i = 0; i < 400; i++) indices[150 * 400 + i] = i % 7;
  const out = new Bytes(16);
  new Lzw().encode(indices, n, 8, out);
  assert.ok(out.n < 2500, `${out.n} bytes for 120,000 pixels`);
});

test('a colour table is as small as its colours: two to the power of the bits', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 8, 9, 129, 255, 256].map(tableBits), [1, 1, 2, 2, 3, 3, 4, 8, 8, 8]);
});

const W = 64, H = 40;
const BG = [12, 14, 20], SQUARE = [240, 60, 40], LINE = [40, 200, 120];
/** A dark background, a line that never moves and a square that moves `x` pixels right (three colours exactly). */
function scene(x: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let i = 0; i < W; i++) {
    const c = y === 30 ? LINE : i >= 5 + x && i < 15 + x && y >= 8 && y < 18 ? SQUARE : BG, o = (y * W + i) * 4;
    rgba[o] = c[0]!; rgba[o + 1] = c[1]!; rgba[o + 2] = c[2]!; rgba[o + 3] = 255;
  }
  return rgba;
}
const px = (rgba: ArrayLike<number>, x: number, y: number): number[] => { const o = (y * W + x) * 4; return [rgba[o]!, rgba[o + 1]!, rgba[o + 2]!]; };
const settings = (more: Partial<FrameSettings> = {}): FrameSettings => ({ ...BEST, tolerance: 0, ...more });

test('the first frame has every pixel moved, and a later one only those that changed, in the smallest box', () => {
  const d = new FrameDiffer(W, H);
  const a = new Uint32Array(scene(0).buffer), first = d.diff(a, 0);
  assert.deepEqual(first, { changed: W * H, x0: 0, y0: 0, x1: W - 1, y1: H - 1 });
  const b = new Uint32Array(scene(3).buffer), second = d.diff(b, 0);
  // The square moved 3 px right: three columns left behind and three reached, over its ten rows.
  assert.deepEqual(second, { changed: 60, x0: 5, y0: 8, x1: 17, y1: 17 });
  let zero = 0; for (const v of b) if (v === 0) zero++;
  assert.equal(zero, W * H - 60, 'the pixels the frame leaves alone are zeroed');
  assert.deepEqual(d.diff(new Uint32Array(scene(3).buffer), 0), { changed: 0, x0: W, y0: H, x1: -1, y1: -1 });
});

test('a pixel that moves no more than the tolerance is left alone, and slow drift is drawn once it adds up', () => {
  const d = new FrameDiffer(W, H);
  const base = (k: number): Uint32Array => { const rgba = scene(0); for (let x = 0; x < W; x++) { const o = (35 * W + x) * 4; rgba[o] = BG[0]! + k; rgba[o + 1] = BG[1]! + k; } return new Uint32Array(rgba.buffer); };
  d.diff(base(0), 3);
  assert.equal(d.diff(base(2), 3).changed, 0, 'two levels, within three');
  assert.equal(d.diff(base(3), 3).changed, 0, 'three, still within');
  assert.equal(d.diff(base(4), 3).changed, W, 'four from what was drawn: drawn again');
  assert.equal(d.diff(base(6), 3).changed, 0, 'and measured from that one now');
  assert.equal(d.diff(base(8), 3).changed, W);
  assert.ok(!leavesAlone({ changed: W * H, x0: 0, y0: 0, x1: W - 1, y1: H - 1 }) && leavesAlone({ changed: 60, x0: 5, y0: 8, x1: 17, y1: 17 }));
});

test('a GIF of a moving square decodes to the frames that went in, each after the first cut to the box that changed', () => {
  const enc = new GifEncoder({ width: W, height: H, settings: settings({ dither: 0 }) });
  const frames = [0, 3, 6, 9].map(scene);
  frames.forEach((f, i) => assert.equal(enc.add(f.slice(), i * 40), 'kept'));
  const gif = decodeGif(enc.finish(160));
  assert.equal(gif.width, W); assert.equal(gif.height, H);
  assert.equal(gif.loops, 0, 'loops for ever');
  assert.equal(gif.globalColors, 0, 'no global table: every frame has its own');
  assert.equal(gif.frames.length, 4);
  gif.frames.forEach((f, i) => {
    assert.deepEqual(f.rgba, new Uint8ClampedArray(frames[i]!), `frame ${i} is exact (the palette is the frame's own colours)`);
    assert.equal(f.disposal, 1, 'each frame stays under the next');
    assert.equal(f.delayCs, 4);
    assert.ok(f.local, 'a local colour table');
  });
  const second = gif.frames[1]!;
  assert.deepEqual([second.x, second.y, second.w, second.h], [5, 8, 13, 10]);
  // Inside the box only the 60 pixels that moved are drawn; the others are the transparent index.
  const drawn = second.indices.filter(i => i !== second.transparent).length;
  assert.equal(drawn, 60);
  assert.ok(second.transparent !== null);
});

test('each frame has the palette of what it draws, as small a table as that needs, and the first frame may use all 256 colours', () => {
  const enc = new GifEncoder({ width: W, height: H, settings: settings({ dither: 0 }) });
  enc.add(scene(0), 0);
  // The next frame draws a patch of two other colours (all of it but one corner pixel): two colours and the transparent index, a table of 4.
  const second = scene(0);
  for (let y = 20; y < 24; y++) for (let x = 40; x < 48; x++) { if (x === 47 && y === 23) continue; const o = (y * W + x) * 4; const c = x < 44 ? [250, 250, 10] : [10, 250, 250]; second[o] = c[0]!; second[o + 1] = c[1]!; second[o + 2] = c[2]!; }
  enc.add(second.slice(), 40);
  // And one that draws a patch with nothing left alone: two colours, a table of 2, no transparent index.
  const third = second.slice();
  for (let y = 5; y < 9; y++) for (let x = 5; x < 9; x++) { const o = (y * W + x) * 4; const c = x < 7 ? [1, 2, 3] : [4, 5, 6]; third[o] = c[0]!; third[o + 1] = c[1]!; third[o + 2] = c[2]!; }
  enc.add(third.slice(), 80);
  const gif = decodeGif(enc.finish(120));
  const f = gif.frames[1]!;
  assert.deepEqual([f.x, f.y, f.w, f.h], [40, 20, 8, 4]);
  assert.equal(f.tableSize, 4);
  assert.equal(f.transparent, 2, 'the index after the two colours');
  assert.deepEqual(f.rgba, new Uint8ClampedArray(second));
  assert.equal(gif.frames[0]!.transparent, null, 'the first frame leaves nothing alone, so keeps no index for it');
  assert.equal(gif.frames[0]!.tableSize, 4, 'three colours: a table of 4');
  assert.deepEqual([gif.frames[2]!.w, gif.frames[2]!.h, gif.frames[2]!.tableSize, gif.frames[2]!.transparent], [4, 4, 2, null]);
  assert.deepEqual(gif.frames[2]!.rgba, new Uint8ClampedArray(third));
});

test('delays add up to the length without drifting: 30 frames a second come out as 3, 3 and 4, and none is under two hundredths', () => {
  const enc = new GifEncoder({ width: W, height: H, settings: settings({ dither: 0 }) });
  for (let i = 0; i < 30; i++) enc.add(scene(i % 20), i * 1000 / 30);
  const gif = decodeGif(enc.finish(1000));
  assert.equal(gif.frames.reduce((s, f) => s + f.delayCs, 0), 100);
  // Rounded on the whole time line: after any number of frames the play time is within a hundredth of where it should be.
  let at = 0; gif.frames.forEach((f, i) => { at += f.delayCs; assert.ok(Math.abs(at - (i + 1) * 10 / 3) <= 1, `after ${i + 1} frames: ${at}`); });
  assert.ok(gif.frames.every(f => f.delayCs === 3 || f.delayCs === 4), gif.frames.map(f => f.delayCs).join(','));
  // Frames closer than 20 ms are shown for 2 hundredths at least (browsers show less as 10).
  const fast = new GifEncoder({ width: W, height: H, settings: settings({ dither: 0 }) });
  fast.add(scene(0), 0); fast.add(scene(5), 5); fast.add(scene(9), 30);
  assert.ok(decodeGif(fast.finish(60)).frames.every(f => f.delayCs >= 2));
});

test('a frame that did not change is not written: the one before is shown longer', () => {
  const enc = new GifEncoder({ width: W, height: H, settings: settings({ dither: 0 }) });
  assert.equal(enc.add(scene(0), 0), 'kept');
  assert.equal(enc.add(scene(0), 33), 'same');
  assert.equal(enc.add(scene(0), 66), 'same');
  assert.equal(enc.add(scene(4), 100), 'kept');
  const gif = decodeGif(enc.finish(200));
  assert.deepEqual(gif.frames.map(f => f.delayCs), [10, 10]);
});

test('the file never passes its limit: the frame that would take it there is not written', () => {
  const rnd = random(3), noise = (): Uint8ClampedArray => { const a = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < a.length; i++) a[i] = i % 4 === 3 ? 255 : Math.floor(rnd() * 256); return a; };
  const limit = 24_000, enc = new GifEncoder({ width: W, height: H, limit, settings: settings({ dither: 0 }) });
  let full = -1;
  for (let i = 0; i < 40; i++) if (enc.add(noise(), i * 50) === 'full') { full = i; break; }
  assert.ok(full > 0, 'it fills up');
  assert.ok(enc.full);
  assert.equal(enc.add(noise(), 9999), 'full', 'and stays full');
  const bytes = enc.finish(full * 50);
  assert.ok(bytes.length <= limit, `${bytes.length} bytes`);
  const gif = decodeGif(bytes);
  assert.equal(gif.frames.length, full, 'every frame before the one that did not fit is there');
});

test('the writer alone keeps to its limit to the byte, whatever the size of the frames', () => {
  for (const limit of [3_000, 10_007, 50_000]) {
    const w = new GifWriter(8, 8, limit), rnd = random(limit);
    let added = 0;
    for (let i = 0; i < 400; i++) {
      const body = new Uint8Array(100 + Math.floor(rnd() * 900)); body[0] = 0x2c;
      if (!w.add({ body, transparent: -1 }, i * 33)) break;
      added++;
    }
    assert.ok(w.full);
    assert.ok(w.finish(added * 33).length <= limit, `limit ${limit}`);
  }
});

test('a new local palette makes a later frame as true as the first: colours the first frame never had come out within a level or two', () => {
  const enc = new GifEncoder({ width: W, height: H, settings: settings({ dither: 0 }) });
  enc.add(scene(0), 0);
  const later = scene(0);
  // A smooth ramp of 60 greens over a band: more colours than the first frame had altogether.
  for (let y = 22; y < 28; y++) for (let x = 2; x < 62; x++) { const o = (y * W + x) * 4; later[o] = 20; later[o + 1] = 100 + x * 2; later[o + 2] = 60; }
  enc.add(later.slice(), 40);
  const got = decodeGif(enc.finish(80)).frames[1]!.rgba;
  let worst = 0; for (let i = 0; i < got.length; i++) worst = Math.max(worst, Math.abs(got[i]! - later[i]!));
  assert.ok(worst <= 3, `worst error ${worst} levels`);
});

/** The mean error of a picture against another after a 3 x 3 blur of both: what the eye averages. */
function blurredError(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const at = (img: ArrayLike<number>, x: number, y: number, c: number): number => img[(Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4 + c]!;
  let sum = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) {
    let pa = 0, pb = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { pa += at(a, x + dx, y + dy, c); pb += at(b, x + dx, y + dy, c); }
    sum += Math.abs(pa - pb) / 9;
  }
  return sum / (W * H * 3);
}

test('error diffusion makes a gradient look closer to the original than the nearest colours do, with a small palette', () => {
  const ramp = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4, v = Math.round(x / (W - 1) * 255); ramp[o] = v; ramp[o + 1] = v; ramp[o + 2] = Math.round(v * 0.6); ramp[o + 3] = 255; }
  const results: number[] = [];
  for (const dither of [0, 1]) {
    const enc = new GifEncoder({ width: W, height: H, settings: settings({ dither, colors: 12 }) });
    enc.add(ramp.slice(), 0);
    results.push(blurredError(ramp, decodeGif(enc.finish(40)).frames[0]!.rgba));
  }
  assert.ok(results[1]! < results[0]! * 0.7, `none ${results[0]}, diffusion ${results[1]}`);
});

test('a frame made with a smaller tolerance than the one before still counts what was drawn: nothing is lost between frames', () => {
  const enc = new GifEncoder({ width: W, height: H, settings: settings({ dither: 0, tolerance: 6 }) });
  const nudged = (k: number): Uint8ClampedArray => { const rgba = scene(0); for (let x = 0; x < W; x++) { const o = (35 * W + x) * 4; rgba[o] = BG[0]! + k; rgba[o + 1] = BG[1]! + k; } return rgba; };
  assert.equal(enc.add(nudged(0), 0), 'kept');
  assert.equal(enc.add(nudged(5), 40), 'same', 'five levels, within six');
  // The next frame is made with no tolerance at all: the five levels are drawn now.
  assert.equal(enc.add(nudged(5), 80, settings({ dither: 0, tolerance: 0 })), 'kept');
  const gif = decodeGif(enc.finish(120));
  assert.deepEqual(px(gif.frames[1]!.rgba, 30, 35), [BG[0]! + 5, BG[1]! + 5, BG[2]]);
});

test('diffusion follows how far the palette is from the frame, and is left out (for an exact search) below a tenth', () => {
  const set: FrameSettings = { ...BEST, dither: 1, ditherAt: 0.3 };
  assert.equal(ditherFor(set, 0.006), 1, 'at or past 0.3 percent: all of it');
  assert.ok(Math.abs(ditherFor(set, 0.0015) - 0.5) < 1e-9, 'half way: half of it');
  assert.equal(ditherFor(set, 0.0002), 0, 'a palette that nearly is the frame: none');
  assert.equal(ditherFor({ ...set, ditherAt: undefined }, 0), 1, 'without the rule it is as set');
  assert.ok(MIN_DITHER > 0 && MIN_DITHER <= 0.15);
  assert.deepEqual(mappedWith(set, { error: 0.0001, bins: 900 }), { ...set, dither: 0, exact: true }, 'few colours, no diffusion: the exact search');
  assert.equal(mappedWith(set, { error: 0.0001, bins: EXACT_BINS + 1 }).exact, false, 'many colours: the table');
  assert.equal(mappedWith(set, { error: 0.01, bins: 900 }).exact, false, 'with diffusion the table does');
});
