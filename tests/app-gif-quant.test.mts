import test from 'node:test';
import assert from 'node:assert/strict';
import { Colors, Histogram, PaletteMaker, Remapper, fromLab, toLab } from '../src/app/screenshot/gif-quant.ts';

/** A pseudo-random sequence that is the same on every run. */
function random(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

/** Pixels as the encoder reads them: `0xAABBGGRR`, opaque. */
const pixel = (r: number, g: number, b: number): number => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;

/** A smooth picture of thousands of colours: a hue ramp across, lightness down. */
function ramp(w: number, h: number): Uint32Array {
  const px = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const hue = x / w * 6, f = hue - Math.floor(hue), l = 0.25 + 0.6 * y / h;
    const [r, g, b] = [[1, f, 0], [1 - f, 1, 0], [0, 1, f], [0, 1 - f, 1], [f, 0, 1], [1, 0, 1 - f]][Math.floor(hue) % 6]!;
    px[y * w + x] = pixel(Math.round(r * l * 255), Math.round(g * l * 255), Math.round(b * l * 255));
  }
  return px;
}

/** The mean CIELAB distance (times 100) of a picture from what a palette and its indices show. */
function meanError(src: Uint32Array, indices: Uint8Array, colors: Colors): number {
  const a = new Float32Array(3), b = new Float32Array(3);
  let sum = 0;
  for (let p = 0; p < src.length; p++) {
    const v = src[p]!, i = indices[p]!;
    toLab(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, a, 0); toLab(colors.rgb[i * 3]!, colors.rgb[i * 3 + 1]!, colors.rgb[i * 3 + 2]!, b, 0);
    sum += Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
  }
  return sum / src.length * 100;
}

/** A maker and its histogram, filled from a picture, and the palette it makes. */
function palette(px: Uint32Array, w: number, h: number, colors: number, keep?: { hist: Histogram; maker: PaletteMaker }) {
  const hist = keep?.hist ?? new Histogram(), maker = keep?.maker ?? new PaletteMaker(hist);
  hist.clear(); hist.add(px, w, 0, 0, w - 1, h - 1, 1);
  return { result: maker.make({ colors, iterations: 2, weightExp: 1 }), hist, maker };
}

test('CIELAB and back gives the colour again, and lightness runs from black to white', () => {
  const out = new Float32Array(3), rnd = random(5);
  for (let i = 0; i < 200; i++) {
    const r = Math.floor(rnd() * 256), g = Math.floor(rnd() * 256), b = Math.floor(rnd() * 256);
    toLab(r, g, b, out, 0);
    const back = fromLab(out[0]!, out[1]!, out[2]!);
    assert.ok(Math.abs((back & 255) - r) <= 1 && Math.abs(((back >> 8) & 255) - g) <= 1 && Math.abs(((back >> 16) & 255) - b) <= 1, `${r},${g},${b}`);
  }
  toLab(0, 0, 0, out, 0); assert.ok(out[0]! < 0.001);
  toLab(255, 255, 255, out, 0); assert.ok(Math.abs(out[0]! - 1) < 0.001);
});

test('the nearest colour found along the lightness order is the nearest there is', () => {
  const rnd = random(11), rgb = new Uint8Array(150 * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = Math.floor(rnd() * 256);
  const colors = new Colors(rgb), q = new Float32Array(3);
  let hint = -1;
  for (let n = 0; n < 400; n++) {
    toLab(Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256), q, 0);
    let best = -1, bestD = Infinity;
    for (let i = 0; i < colors.size; i++) { const d = (colors.lab[i * 3]! - q[0]!) ** 2 + (colors.lab[i * 3 + 1]! - q[1]!) ** 2 + (colors.lab[i * 3 + 2]! - q[2]!) ** 2; if (d < bestD) { bestD = d; best = i; } }
    const got = colors.nearest(q[0]!, q[1]!, q[2]!, n % 2 ? hint : -1);
    assert.equal(got, best);
    hint = got;
  }
});

test('a frame with few colours, each exact, gets exactly those colours, and needs no dithering', () => {
  const w = 40, h = 30, px = new Uint32Array(w * h), colours = [pixel(10, 20, 30), pixel(200, 40, 40), pixel(40, 200, 90), pixel(255, 255, 255), pixel(0, 0, 0)];
  for (let i = 0; i < px.length; i++) px[i] = colours[(i * 7 + (i >> 3)) % colours.length]!;
  const { result } = palette(px, w, h, 255);
  assert.ok(result.exact);
  assert.equal(result.error, 0);
  assert.equal(result.colors.size, colours.length);
  const got = new Set<number>(); for (let i = 0; i < result.colors.size; i++) got.add(pixel(result.colors.rgb[i * 3]!, result.colors.rgb[i * 3 + 1]!, result.colors.rgb[i * 3 + 2]!));
  assert.deepEqual([...got].sort(), [...colours].sort());
});

test('a palette is no larger than asked, the same input gives the same palette, and more colours fit better', () => {
  const w = 96, h = 64, px = ramp(w, h);
  const a = palette(px, w, h, 64).result, b = palette(px, w, h, 64).result, big = palette(px, w, h, 255).result;
  assert.ok(a.colors.size <= 64 && big.colors.size <= 255);
  assert.deepEqual(a.colors.rgb, b.colors.rgb, 'deterministic');
  assert.ok(!a.exact);
  assert.ok(big.error < a.error, `${big.error} against ${a.error}`);
  // Through the remapper, the picture's error is small for 255 colours and larger for 64.
  const remap = new Remapper(), out = new Uint8Array(w * h);
  remap.map(px, w, 0, 0, w, h, big.colors, big.colors.size, { dither: 0 }, out);
  const e255 = meanError(px, out, big.colors);
  remap.map(px, w, 0, 0, w, h, a.colors, a.colors.size, { dither: 0 }, out);
  const e64 = meanError(px, out, a.colors);
  assert.ok(e255 < 5, `255 colours: ${e255}`);
  assert.ok(e64 > e255 * 1.5, `64 colours: ${e64}`);
});

test('colours stay put from frame to frame: a similar frame starts from the last palette, a different one does not', () => {
  const w = 96, h = 64, first = ramp(w, h), keep = { hist: new Histogram(), maker: undefined as unknown as PaletteMaker };
  keep.maker = new PaletteMaker(keep.hist);
  const one = palette(first, w, h, 200, keep).result;
  assert.ok(!one.seeded);
  // The same picture a little lighter.
  const lighter = first.map(v => pixel(Math.min(255, (v & 255) + 3), Math.min(255, ((v >>> 8) & 255) + 3), Math.min(255, ((v >>> 16) & 255) + 3)));
  const two = palette(lighter, w, h, 200, keep).result;
  assert.ok(two.seeded, 'a nearly identical frame starts from the last palette');
  assert.ok(two.error < one.error * 1.3 + 0.01);
  // Something else altogether: greys only.
  const greys = new Uint32Array(w * h); const rnd = random(2);
  for (let i = 0; i < greys.length; i++) { const g = Math.floor(rnd() * 256); greys[i] = pixel(g, g, g); }
  const three = palette(greys, w, h, 200, keep).result;
  assert.ok(!three.seeded, 'a picture the old colours do not fit gets new ones');
  assert.ok(three.error < 0.02, `${three.error}`);
});

test('without diffusion a pixel goes to its nearest colour, and a pixel the frame leaves alone gets the transparent index', () => {
  const rnd = random(21), w = 32, h = 20, px = new Uint32Array(w * h);
  for (let i = 0; i < px.length; i++) px[i] = rnd() < 0.25 ? 0 : pixel(Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256));
  const colors = new Colors(Uint8Array.from({ length: 40 * 3 }, () => Math.floor(rnd() * 256))), out = new Uint8Array(w * h);
  new Remapper().map(px, w, 0, 0, w, h, colors, colors.size, { dither: 0 }, out);
  const q = new Float32Array(3);
  for (let p = 0; p < px.length; p++) {
    if (px[p] === 0) { assert.equal(out[p], colors.size); continue; }
    // The table finds the nearest to the middle of the pixel's bin: within one palette step of the nearest to the pixel itself.
    toLab(px[p]! & 255, (px[p]! >>> 8) & 255, (px[p]! >>> 16) & 255, q, 0);
    const i = out[p]!, d = Math.hypot(colors.lab[i * 3]! - q[0]!, colors.lab[i * 3 + 1]! - q[1]!, colors.lab[i * 3 + 2]! - q[2]!);
    let best = Infinity; for (let j = 0; j < colors.size; j++) best = Math.min(best, Math.hypot(colors.lab[j * 3]! - q[0]!, colors.lab[j * 3 + 1]! - q[1]!, colors.lab[j * 3 + 2]! - q[2]!));
    assert.ok(d <= best + 0.08, `pixel ${p}: ${d} against ${best}`);
  }
});

test('error diffusion shows a colour between two palette colours as a mix of them, and leaves other pixels out of it', () => {
  // A flat patch of mid grey, a palette of black and white only: the nearest colour is one of them for every pixel, diffusion mixes both.
  const w = 48, h = 32, px = new Uint32Array(w * h).fill(pixel(120, 120, 120));
  for (let y = 0; y < h; y++) for (let x = 20; x < 28; x++) px[y * w + x] = 0;
  const colors = new Colors(new Uint8Array([0, 0, 0, 255, 255, 255])), out = new Uint8Array(w * h), remap = new Remapper();
  remap.map(px, w, 0, 0, w, h, colors, colors.size, { dither: 1, errorCap: 255 }, out);
  let whites = 0, drawn = 0;
  for (let p = 0; p < px.length; p++) { if (px[p] === 0) { assert.equal(out[p], 2, 'left alone'); continue; } drawn++; if (out[p] === 1) whites++; }
  // Mid grey (120/255 = 47 %, in gamma) is about half white pixels.
  assert.ok(Math.abs(whites / drawn - 120 / 255) < 0.05, `${whites / drawn}`);
  // Without it all of the patch is one colour.
  remap.map(px, w, 0, 0, w, h, colors, colors.size, { dither: 0 }, out);
  const ones = new Set<number>(); for (let p = 0; p < px.length; p++) if (px[p] !== 0) ones.add(out[p]!);
  assert.equal(ones.size, 1);
});

test('an ordered pattern is fixed to the picture: the same colour at the same place gets the same index whatever box it is drawn in', () => {
  const w = 40, h = 24, px = new Uint32Array(w * h).fill(pixel(128, 128, 128));
  const colors = new Colors(new Uint8Array([100, 100, 100, 156, 156, 156])), whole = new Uint8Array(w * h), part = new Uint8Array(16 * 8);
  const remap = new Remapper();
  remap.map(px, w, 0, 0, w, h, colors, 9, { dither: 0, pattern: 40 }, whole);
  remap.map(px, w, 11, 5, 16, 8, colors, 9, { dither: 0, pattern: 40 }, part);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) assert.equal(part[y * 16 + x], whole[(5 + y) * w + 11 + x]);
  const ones = whole.reduce((n, i) => n + (i === 1 ? 1 : 0), 0);
  assert.ok(ones > w * h * 0.3 && ones < w * h * 0.7, 'the pattern mixes both colours');
});

test('a frame of few colours is mapped from the colour of each pixel: two colours that share a bin keep their own palette colours', () => {
  // 100,100,100 and 103,100,103 fall in one 5-6-5 bin: a table finds one answer for both, the exact search two.
  const colors = new Colors(new Uint8Array([100, 100, 100, 103, 100, 103, 200, 40, 40])), w = 16, h = 4, px = new Uint32Array(w * h);
  for (let i = 0; i < px.length; i++) px[i] = i % 2 ? pixel(103, 100, 103) : pixel(100, 100, 100);
  const table = new Uint8Array(w * h), exact = new Uint8Array(w * h), remap = new Remapper();
  remap.map(px, w, 0, 0, w, h, colors, 9, { dither: 0 }, table);
  remap.map(px, w, 0, 0, w, h, colors, 9, { dither: 0, exact: true }, exact);
  assert.equal(new Set(table).size, 1, 'the table gives the pixels of a bin one colour');
  for (let i = 0; i < px.length; i++) assert.equal(exact[i], i % 2 ? 1 : 0);
  // And a pixel the frame leaves alone is still the transparent index.
  px[5] = 0; remap.map(px, w, 0, 0, w, h, colors, 9, { dither: 0, exact: true }, exact);
  assert.equal(exact[5], 9);
});
