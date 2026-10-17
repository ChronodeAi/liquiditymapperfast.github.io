import test from 'node:test';
import assert from 'node:assert/strict';
import { Bytes, GifEncoder, Histogram, Lzw, buildPalette, medianCut, type Rgb } from '../src/app/screenshot/gif-encoder.ts';
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

const W = 64, H = 40;
const BG: Rgb = [12, 14, 20], SQUARE: Rgb = [240, 60, 40], LINE: Rgb = [40, 200, 120];
/** A dark background, a line that never moves and a square that moves `x` pixels right. */
function scene(x: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let i = 0; i < W; i++) {
    const c = y === 30 ? LINE : i >= 5 + x && i < 15 + x && y >= 8 && y < 18 ? SQUARE : BG, o = (y * W + i) * 4;
    rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255;
  }
  return rgba;
}
const pixel = (rgba: ArrayLike<number>, x: number, y: number): number[] => { const o = (y * W + x) * 4; return [rgba[o]!, rgba[o + 1]!, rgba[o + 2]!]; };

test('a GIF of a moving square decodes to the frames that went in, each after the first cut to what changed', () => {
  const enc = new GifEncoder({ width: W, height: H, paletteFrames: 2 });
  const frames = [0, 3, 6, 9].map(scene);
  frames.forEach((f, i) => assert.notEqual(enc.add(f, i * 40), 'full'));
  const gif = decodeGif(enc.finish(160));
  assert.equal(gif.width, W); assert.equal(gif.height, H);
  assert.equal(gif.loops, 0, 'loops for ever');
  assert.equal(gif.frames.length, 4);
  gif.frames.forEach((f, i) => {
    assert.deepEqual(f.rgba, frames[i], `frame ${i} is exact (three colours fit the palette)`);
    assert.equal(f.disposal, 1, 'each frame stays under the next');
    assert.equal(f.delayCs, 4);
  });
  const second = gif.frames[1]!;
  // The square moved 3 px: the columns it left and the ones it reached, over its rows; the line below never changed.
  assert.deepEqual([second.x, second.y, second.w, second.h], [5, 8, 13, 10]);
  assert.equal(second.transparent, enc.palette!.size, 'the index after the colours means unchanged');
});

test('a frame that did not change is not written: the one before is shown longer', () => {
  const enc = new GifEncoder({ width: W, height: H, paletteFrames: 1 });
  assert.equal(enc.add(scene(0), 0), 'kept');
  assert.equal(enc.add(scene(0), 33), 'same');
  assert.equal(enc.add(scene(0), 66), 'same');
  assert.equal(enc.add(scene(4), 100), 'kept');
  const gif = decodeGif(enc.finish(200));
  assert.deepEqual(gif.frames.map(f => f.delayCs), [10, 10]);
});

test('delays add up to the length without drifting, and are never under two hundredths', () => {
  const enc = new GifEncoder({ width: W, height: H, paletteFrames: 1 });
  for (let i = 0; i < 30; i++) enc.add(scene(i % 20), i * 1000 / 30);
  const gif = decodeGif(enc.finish(1000));
  assert.equal(gif.frames.reduce((s, f) => s + f.delayCs, 0), 100);
  assert.ok(gif.frames.every(f => f.delayCs >= 3 && f.delayCs <= 4), gif.frames.map(f => f.delayCs).join(','));
});

test('thinned frames are left out and the frame before covers their time', () => {
  const enc = new GifEncoder({ width: W, height: H, paletteFrames: 1 });
  enc.minInterval = 60;
  assert.equal(enc.add(scene(0), 0), 'kept');
  assert.equal(enc.add(scene(1), 33), 'thinned');
  assert.equal(enc.add(scene(2), 66), 'kept');
  const gif = decodeGif(enc.finish(100));
  assert.equal(gif.frames.length, 2);
  assert.deepEqual(gif.frames[1]!.rgba, scene(2));
});

test('the file never passes its limit: the frame that would take it there is not written', () => {
  const rnd = random(3), noise = (): Uint8ClampedArray => { const a = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < a.length; i++) a[i] = i % 4 === 3 ? 255 : Math.floor(rnd() * 256); return a; };
  const limit = 9000, enc = new GifEncoder({ width: W, height: H, limit, paletteFrames: 1 });
  let full = -1;
  for (let i = 0; i < 40; i++) if (enc.add(noise(), i * 50) === 'full') { full = i; break; }
  assert.ok(full > 0, 'it fills up');
  assert.ok(enc.full);
  assert.equal(enc.add(noise(), 9999), 'full', 'and stays full');
  const bytes = enc.finish(full * 50);
  assert.ok(bytes.length <= limit, `${bytes.length} bytes`);
  const gif = decodeGif(bytes);
  assert.equal(gif.frames.length, full - 1, 'every frame written before the full one is there');
});

test('the commonest colours keep places in the palette however many there are', () => {
  const hist = new Histogram(), rgba = new Uint8ClampedArray(256 * 256 * 4);
  for (let i = 0; i < 256 * 256; i++) { rgba[i * 4] = i & 255; rgba[i * 4 + 1] = (i >> 8) & 255; rgba[i * 4 + 2] = (i * 7) & 255; rgba[i * 4 + 3] = 255; }
  hist.add(rgba, 256, 256);
  const colors = medianCut(hist, 200);
  assert.equal(colors.length, 200);
  const one = new Histogram(); one.add(scene(0), W, H);
  assert.equal(medianCut(one, 255).length, 3, 'no more colours than the picture has');
});

test('the light the frames gain later has colours kept for it: a faint wave over the background stays visible', () => {
  // The first frame has no wave in it; later ones have a faint ring of the buy colour over the background.
  const buy: Rgb = [48, 209, 88];
  const wave = (k: number): Uint8ClampedArray => {
    const rgba = scene(0);
    for (let x = 20; x < 60; x++) { const o = (35 * W + x) * 4; rgba[o] = Math.round(BG[0] + (buy[0] - BG[0]) * k); rgba[o + 1] = Math.round(BG[1] + (buy[1] - BG[1]) * k); rgba[o + 2] = Math.round(BG[2] + (buy[2] - BG[2]) * k); }
    return rgba;
  };
  for (const [tints, visible] of [[[buy], true], [[], false]] as const) {
    const enc = new GifEncoder({ width: W, height: H, paletteFrames: 1, tints, dark: true });
    enc.add(scene(0), 0); enc.add(wave(0.3), 40); enc.add(wave(0.15), 80);
    const gif = decodeGif(enc.finish(120));
    const moved = gif.frames.length === 3 && pixel(gif.frames[1]!.rgba, 30, 35).join() !== pixel(gif.frames[0]!.rgba, 30, 35).join() && pixel(gif.frames[2]!.rgba, 30, 35).join() !== pixel(gif.frames[1]!.rgba, 30, 35).join();
    assert.equal(moved, visible, tints.length ? 'with the tints the ring shows and changes from frame to frame' : 'without them it folds into the background');
  }
});

test('dithering is fixed to the pixel: a still picture makes no new frames', () => {
  const ramp = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; ramp[o] = x * 4; ramp[o + 1] = 40 + y * 3; ramp[o + 2] = 200 - x * 2; ramp[o + 3] = 255; }
  const enc = new GifEncoder({ width: W, height: H, paletteFrames: 1, dither: true, colors: 16 });
  assert.equal(enc.add(ramp, 0), 'kept');
  assert.equal(enc.add(ramp.slice(), 40), 'same');
  const gif = decodeGif(enc.finish(80));
  assert.equal(gif.frames.length, 1);
  assert.ok(gif.globalColors <= 32);
});

test('a palette built with tints has the blends and the tints themselves', () => {
  const hist = new Histogram(); hist.add(scene(0), W, H);
  const tint: Rgb = [0, 255, 0], palette = buildPalette(hist, 255, [tint], true);
  assert.ok(palette.colors.some(c => c.join() === tint.join()));
  assert.ok(palette.size <= 255);
  const blends = palette.colors.filter(c => c[0] <= BG[0] && c[2] <= BG[2] && c[1] > BG[1] && c[1] < 255);
  assert.equal(blends.length, 4, 'four blends from the background toward the tint');
});

test('with a tolerance, a pixel that moves a few levels stays as it was drawn, and one that moves more is drawn again', () => {
  // A ramp along the bottom row puts the colours a few levels apart into the palette, so a nudge has a colour to go to.
  const base = (): Uint8ClampedArray => { const rgba = scene(0); for (let x = 0; x < W; x++) { const o = (39 * W + x) * 4; rgba[o] = BG[0] + x; rgba[o + 1] = BG[1] + x; } return rgba; };
  const nudged = (k: number): Uint8ClampedArray => { const rgba = base(); for (let x = 0; x < W; x++) { const o = (35 * W + x) * 4; rgba[o] = BG[0] + k; rgba[o + 1] = BG[1] + k; } return rgba; };
  const enc = new GifEncoder({ width: W, height: H, paletteFrames: 1, tolerance: 6 });
  enc.add(base(), 0);
  assert.equal(enc.add(nudged(4), 40), 'same', 'four levels: unchanged');
  assert.equal(enc.add(nudged(6), 80), 'same', 'six, still the tolerance');
  assert.equal(enc.add(nudged(40), 120), 'kept', 'forty: drawn');
  const gif = decodeGif(enc.finish(160));
  assert.equal(gif.frames.length, 2);
  assert.notDeepEqual(pixel(gif.frames[1]!.rgba, 30, 35), pixel(gif.frames[0]!.rgba, 30, 35));
  // The tolerance is measured from what the pixel was drawn from, so a slow drift is drawn once it adds up.
  const drift = new GifEncoder({ width: W, height: H, paletteFrames: 1, tolerance: 6 });
  drift.add(base(), 0);
  const results = [3, 6, 9, 12].map((k, i) => drift.add(nudged(k), (i + 1) * 40));
  assert.deepEqual(results.slice(0, 2), ['same', 'same']);
  assert.ok(results.slice(2).includes('kept'), results.join());
  // A white pixel is drawn in the first frame, whatever the tolerance.
  const white = new Uint8ClampedArray(W * H * 4).fill(255);
  const first = decodeGif((() => { const e = new GifEncoder({ width: W, height: H, paletteFrames: 1, tolerance: 16 }); e.add(white, 0); return e.finish(40); })());
  assert.deepEqual(pixel(first.frames[0]!.rgba, 3, 3), [255, 255, 255]);
});
