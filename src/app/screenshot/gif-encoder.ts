/**
 * A GIF encoder for the screenshot tool's moving pictures, written for speed: frames are fed as they are captured and written as they
 * come, so the file is ready a frame after the last one. Nothing here touches the page, so it runs in a worker and in the tests.
 *
 * - One palette for the whole file, of up to 255 colours, drawn by median cut from the first frames (the commonest colours split where
 *   splitting them costs least), with places kept for blends of the commonest colours toward the colours the frames will gain later
 *   (`tints`: the buy and sell colours the waves' light is made of), since the first frames have none of that light in them.
 * - A colour is looked up in a table of 65536 entries (5 bits of red, 6 of green, 5 of blue), each filled the first time it is needed.
 * - The 256th index means "unchanged": a frame is cut to the box of pixels that changed since the one before, the others inside it are
 *   that index, and each frame is laid over the one before (disposal 1). The chart's chrome and most of its data stand still between
 *   frames, so a frame is mostly that one index, which LZW folds into very few codes. A frame with nothing changed is not written; the
 *   one before it is shown longer.
 * - LZW of up to 12 bits, with a table of 4096 × 256 entries told apart by a generation number, so a clear costs nothing.
 * - Optional ordered dithering (a 4 × 4 Bayer pattern), fixed to the pixel's place so a still pixel stays the same from frame to frame.
 * - A file never grows past `limit`: a frame that would take it there is not written, and the encoder reports that it is full.
 */

export type Rgb = readonly [number, number, number];

export interface GifOptions {
  width: number;
  height: number;
  /** Colours in the palette, 2 to 255 (one more index is kept for "unchanged"). */
  colors?: number;
  /** Ordered dithering (smoother gradients, a larger file). */
  dither?: boolean;
  /**
   * How far (levels of 255, on every channel) a pixel may move from what it was drawn from and still count as unchanged. The waves'
   * faint light moves much of the chart by a few levels, which a palette turns into colours flickering between neighbours: a few levels
   * of tolerance keep those pixels still (and the file a fraction of the size) and let the crests through.
   */
  tolerance?: number;
  /** The file is never larger than this many bytes. */
  limit?: number;
  /** Colours the frames will gain as they go: blends of the commonest colours toward them get places of their own. */
  tints?: readonly Rgb[];
  /** Whether the page is dark (light is added to it) or light (the same light shows as a shade). */
  dark?: boolean;
  /** How many frames the palette is drawn from before the first is written. */
  paletteFrames?: number;
}

/** What became of a frame: written (`kept`), the same as the one before (`same`), too soon after it (`thinned`), or not written because the file is full. */
export type Added = 'kept' | 'same' | 'thinned' | 'full';

/** A growing byte buffer. */
export class Bytes {
  buf: Uint8Array;
  n = 0;
  constructor(size = 1 << 16) { this.buf = new Uint8Array(size); }
  ensure(more: number): void {
    if (this.n + more <= this.buf.length) return;
    let size = this.buf.length * 2; while (size < this.n + more) size *= 2;
    const next = new Uint8Array(size); next.set(this.buf.subarray(0, this.n)); this.buf = next;
  }
  byte(v: number): void { if (this.n >= this.buf.length) this.ensure(1); this.buf[this.n++] = v; }
  short(v: number): void { this.ensure(2); this.buf[this.n++] = v & 255; this.buf[this.n++] = (v >> 8) & 255; }
  bytes(src: Uint8Array): void { this.ensure(src.length); this.buf.set(src, this.n); this.n += src.length; }
  ascii(text: string): void { for (let i = 0; i < text.length; i++) this.byte(text.charCodeAt(i)); }
  take(): Uint8Array { return this.buf.slice(0, this.n); }
}

const MAX_CODE = 4096, HSIZE = 5003, HSHIFT = 4;

/**
 * The LZW coder: the strings met so far in an open-addressed table of 5003 entries (small enough to stay in the processor's cache, which
 * a direct table of 4096 × 256 does not), the codes packed straight into the output's sub-blocks. `encode` writes the minimum code size
 * and the data sub-blocks of one image.
 */
export class Lzw {
  #keys = new Int32Array(HSIZE);
  #codes = new Int32Array(HSIZE);

  encode(indices: Uint8Array, length: number, minCodeSize: number, out: Bytes): void {
    const keys = this.#keys, codes = this.#codes;
    const clear = 1 << minCodeSize, eoi = clear + 1, first = minCodeSize + 1;
    out.byte(minCodeSize);
    // At most 12 bits a pixel, and a length byte every 255.
    out.ensure(Math.ceil(length * 1.51) + 512);
    const buf = out.buf;
    let n = out.n, block = n++, fill = 0;
    let bits = first, maxcode = (1 << bits) - 1, free = clear + 2, acc = 0, accBits = 0;
    keys.fill(-1);
    // Each code goes out the same way (written out in place, as a call per code costs a third of the time): into the bit accumulator,
    // whole bytes into the block, a new block after 255; then the code size grows when the next code would not fit.
    acc |= clear << accBits; accBits += bits;
    while (accBits >= 8) { buf[n++] = acc & 255; acc >>>= 8; accBits -= 8; if (++fill === 255) { buf[block] = 255; block = n++; fill = 0; } }
    if (length > 0) {
      let ent = indices[0]!;
      outer: for (let i = 1; i < length; i++) {
        const c = indices[i]!, key = (c << 12) + ent;
        let h = (c << HSHIFT) ^ ent, k = keys[h]!;
        if (k === key) { ent = codes[h]!; continue; }
        if (k >= 0) {
          const step = h === 0 ? 1 : HSIZE - h;
          do { h -= step; if (h < 0) h += HSIZE; k = keys[h]!; if (k === key) { ent = codes[h]!; continue outer; } } while (k >= 0);
        }
        acc |= ent << accBits; accBits += bits;
        while (accBits >= 8) { buf[n++] = acc & 255; acc >>>= 8; accBits -= 8; if (++fill === 255) { buf[block] = 255; block = n++; fill = 0; } }
        if (free > maxcode) { bits++; maxcode = bits === 12 ? MAX_CODE : (1 << bits) - 1; }
        ent = c;
        if (free < MAX_CODE) { codes[h] = free++; keys[h] = key; }
        else {
          // The table is full: a clear code, in the current size, and start again.
          keys.fill(-1); free = clear + 2;
          acc |= clear << accBits; accBits += bits;
          while (accBits >= 8) { buf[n++] = acc & 255; acc >>>= 8; accBits -= 8; if (++fill === 255) { buf[block] = 255; block = n++; fill = 0; } }
          bits = first; maxcode = (1 << bits) - 1;
        }
      }
      acc |= ent << accBits; accBits += bits;
      while (accBits >= 8) { buf[n++] = acc & 255; acc >>>= 8; accBits -= 8; if (++fill === 255) { buf[block] = 255; block = n++; fill = 0; } }
      if (free > maxcode) { bits++; maxcode = bits === 12 ? MAX_CODE : (1 << bits) - 1; }
    }
    acc |= eoi << accBits; accBits += bits;
    while (accBits >= 8) { buf[n++] = acc & 255; acc >>>= 8; accBits -= 8; if (++fill === 255) { buf[block] = 255; block = n++; fill = 0; } }
    if (accBits > 0) { buf[n++] = acc & 255; if (++fill === 255) { buf[block] = 255; block = n++; fill = 0; } }
    // The last block's length, then the terminator (a block that never got a byte is the terminator itself).
    if (fill > 0) { buf[block] = fill; buf[n++] = 0; } else buf[block] = 0;
    out.n = n;
  }
}

/** The 5-6-5 key of a colour. */
export const keyOf = (r: number, g: number, b: number): number => ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);

/** A colour histogram over the 5-6-5 keys, with each key's sums so a colour stands for what it holds, not the middle of its bin. */
export class Histogram {
  count = new Float64Array(65536);
  r = new Float64Array(65536); g = new Float64Array(65536); b = new Float64Array(65536);
  total = 0;
  /** Count every `step`th pixel of every `step`th row. */
  add(rgba: ArrayLike<number>, width: number, height: number, step = 1, weight = 1): void {
    for (let y = 0; y < height; y += step) {
      for (let x = 0, i = y * width * 4; x < width; x += step, i += step * 4) {
        const r = rgba[i]!, g = rgba[i + 1]!, b = rgba[i + 2]!, k = keyOf(r, g, b);
        this.count[k] += weight; this.r[k] += r * weight; this.g[k] += g * weight; this.b[k] += b * weight; this.total += weight;
      }
    }
  }
  /** The `n` commonest colours, commonest first. */
  top(n: number): Rgb[] {
    const keys: number[] = [];
    for (let k = 0; k < 65536; k++) if (this.count[k]! > 0) keys.push(k);
    keys.sort((a, b) => this.count[b]! - this.count[a]!);
    return keys.slice(0, n).map(k => { const c = this.count[k]!; return [Math.round(this.r[k]! / c), Math.round(this.g[k]! / c), Math.round(this.b[k]! / c)] as const; });
  }
}

/**
 * Median cut: the colours in boxes, the box whose colours are furthest from its mean split in two along its widest channel, at the
 * place that leaves the two halves closest to their own means, until there are `n` boxes. Each box gives its weighted mean.
 */
export function medianCut(hist: Histogram, n: number): Rgb[] {
  const keys: number[] = [];
  for (let k = 0; k < 65536; k++) if (hist.count[k]! > 0) keys.push(k);
  if (!keys.length) return [[0, 0, 0]];
  const m = keys.length, w = new Float64Array(m), ch = [new Float64Array(m), new Float64Array(m), new Float64Array(m)] as const;
  keys.forEach((k, i) => { const c = hist.count[k]!; w[i] = c; ch[0][i] = hist.r[k]! / c; ch[1][i] = hist.g[k]! / c; ch[2][i] = hist.b[k]! / c; });
  const order = new Int32Array(m); for (let i = 0; i < m; i++) order[i] = i;
  interface Box { lo: number; hi: number; sse: number; axis: number }
  const measure = (lo: number, hi: number): Box => {
    let sw = 0; const s = [0, 0, 0], q = [0, 0, 0];
    for (let j = lo; j < hi; j++) { const i = order[j]!, wi = w[i]!; sw += wi; for (let c = 0; c < 3; c++) { const v = ch[c]![i]!; s[c]! += wi * v; q[c]! += wi * v * v; } }
    const e = [0, 1, 2].map(c => Math.max(0, q[c]! - s[c]! * s[c]! / Math.max(sw, 1e-9)));
    // Green is seen most sharply and blue least: weigh the spread that way when choosing what to split.
    const weighted = [e[0]! * 2, e[1]! * 4, e[2]! * 3];
    const axis = weighted[0]! >= weighted[1]! && weighted[0]! >= weighted[2]! ? 0 : weighted[1]! >= weighted[2]! ? 1 : 2;
    return { lo, hi, sse: hi - lo > 1 ? weighted[0]! + weighted[1]! + weighted[2]! : 0, axis };
  };
  const boxes: Box[] = [measure(0, m)];
  while (boxes.length < n) {
    let best = -1, bestSse = 0;
    for (let i = 0; i < boxes.length; i++) if (boxes[i]!.sse > bestSse) { bestSse = boxes[i]!.sse; best = i; }
    if (best < 0) break;
    const box = boxes[best]!, values = ch[box.axis]!;
    const part = order.subarray(box.lo, box.hi);
    part.sort((a, b) => values[a]! - values[b]!);
    // The split along the axis that leaves the least spread on both sides.
    let tw = 0, ts = 0, tq = 0;
    for (let j = 0; j < part.length; j++) { const i = part[j]!, v = values[i]!, wi = w[i]!; tw += wi; ts += wi * v; tq += wi * v * v; }
    let lw = 0, ls = 0, lq = 0, cut = 1, cutCost = Infinity;
    for (let j = 0; j < part.length - 1; j++) {
      const i = part[j]!, v = values[i]!, wi = w[i]!; lw += wi; ls += wi * v; lq += wi * v * v;
      const rw = tw - lw, rs = ts - ls, rq = tq - lq;
      const cost = (lq - ls * ls / lw) + (rq - rs * rs / Math.max(rw, 1e-9));
      if (cost < cutCost) { cutCost = cost; cut = j + 1; }
    }
    boxes.splice(best, 1, measure(box.lo, box.lo + cut), measure(box.lo + cut, box.hi));
  }
  return boxes.map(box => {
    let sw = 0, r = 0, g = 0, b = 0;
    for (let j = box.lo; j < box.hi; j++) { const i = order[j]!, wi = w[i]!; sw += wi; r += wi * ch[0][i]!; g += wi * ch[1][i]!; b += wi * ch[2][i]!; }
    return [Math.round(r / sw), Math.round(g / sw), Math.round(b / sw)] as const;
  });
}

/**
 * Blends of the commonest colours toward each tint, as the waves' light lays them over the page: on a dark page the light is added
 * (toward the tint), on a light one it shows as a shade of it.
 */
export function tintBlends(bases: readonly Rgb[], tints: readonly Rgb[], dark: boolean, steps: readonly number[]): Rgb[] {
  const out: Rgb[] = [];
  for (const tint of tints) {
    out.push(tint);
    const toward: Rgb = dark ? tint : [tint[0] * 0.45, tint[1] * 0.45, tint[2] * 0.45];
    for (const base of bases) for (const k of steps) out.push([Math.round(base[0] + (toward[0] - base[0]) * k), Math.round(base[1] + (toward[1] - base[1]) * k), Math.round(base[2] + (toward[2] - base[2]) * k)]);
  }
  return out;
}

/** A palette and its lookup table from 5-6-5 keys to the nearest colour, filled as keys are met. */
export class Palette {
  readonly colors: Rgb[];
  /** The colours as `0xRRGGBB`, for comparing what a pixel shows. */
  readonly packed: Int32Array;
  /** The index for each 5-6-5 key, -1 until the key is first met (`nearest` fills it). */
  readonly lut = new Int16Array(65536).fill(-1);
  #r: Int32Array; #g: Int32Array; #b: Int32Array;
  constructor(colors: readonly Rgb[]) {
    this.colors = colors.slice(0, 255);
    const n = this.colors.length;
    this.packed = new Int32Array(n); this.#r = new Int32Array(n); this.#g = new Int32Array(n); this.#b = new Int32Array(n);
    this.colors.forEach(([r, g, b], i) => { this.packed[i] = (r << 16) | (g << 8) | b; this.#r[i] = r; this.#g[i] = g; this.#b[i] = b; });
  }
  get size(): number { return this.colors.length; }
  /** The index of the colour nearest the key's (looked up once per key). */
  index(key: number): number { const hit = this.lut[key]!; return hit >= 0 ? hit : this.nearest(key); }
  /** Find the colour nearest the key's and keep it in the table. */
  nearest(key: number): number {
    const r = ((key >> 11) << 3) | 4, g = (((key >> 5) & 63) << 2) | 2, b = ((key & 31) << 3) | 4;
    let best = 0, bestD = Infinity;
    const R = this.#r, G = this.#g, B = this.#b;
    for (let i = 0; i < R.length; i++) {
      const dr = R[i]! - r, dg = G[i]! - g, db = B[i]! - b, d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (d < bestD) { bestD = d; best = i; if (d === 0) break; }
    }
    this.lut[key] = best;
    return best;
  }
}

/** Build the palette: `n` colours, of which blends toward the tints take a share when there are tints. */
export function buildPalette(hist: Histogram, n: number, tints: readonly Rgb[] = [], dark = true): Palette {
  const bases = tints.length ? hist.top(n >= 128 ? 4 : 2) : [];
  const reserved = tints.length ? tintBlends(bases, tints, dark, n >= 128 ? [0.15, 0.3, 0.5, 0.75] : [0.25, 0.6]) : [];
  const cut = medianCut(hist, Math.max(2, n - reserved.length));
  // A reserved colour the cut already has, or one very near it, gives its place back.
  const seen = new Set(cut.map(c => (c[0] << 16) | (c[1] << 8) | c[2]));
  const extra: Rgb[] = [];
  for (const c of reserved) { const p = (c[0] << 16) | (c[1] << 8) | c[2]; if (!seen.has(p)) { seen.add(p); extra.push(c); } }
  return new Palette([...cut, ...extra].slice(0, Math.min(255, n)));
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => v - 8);

/** The bits a colour table of `n` entries takes (its size is 2 to that power). */
const tableBits = (n: number): number => { let bits = 1; while (1 << bits < n) bits++; return bits; };

/** Pixels: RGBA bytes, read four at a time (every browser this runs in is little-endian, so a pixel reads as `0xAABBGGRR`). */
export type Pixels = Uint8ClampedArray | Uint8Array;

/** The 5-6-5 key of a pixel read as `0xAABBGGRR`. */
const keyOfPixel = (v: number): number => ((v & 0xf8) << 8) | ((v >>> 5) & 0x7e0) | ((v >>> 19) & 0x1f);

/** One pixel in this many on each axis is looked at to judge how well the palette still fits. */
const PROBE = 7;

export class GifEncoder {
  readonly width: number; readonly height: number;
  readonly limit: number;
  #colors: number; #dither: boolean; #tints: readonly Rgb[]; #dark: boolean; #paletteFrames: number;
  #out = new Bytes(1 << 20);
  #body = new Bytes(1 << 18);
  #lzw = new Lzw();
  #hist = new Histogram();
  #waiting: { rgba: Pixels; t: number }[] = [];
  /** The palette in use, and whether it is the file's own (the first) or one written with each frame since the picture changed. */
  #palette: Palette | null = null; #local = false;
  /** How far the palette was from the picture when it was made (the mean weighted square error at the probe points), and when. */
  #fit = 0; #fitAt = 0; #refits = 0;
  /** What each pixel shows now (`0xRRGGBB`, or -1 before the first frame), and the source pixel it was made from (24 bits; none at first). */
  #shown: Int32Array; #source: Uint32Array;
  #indices: Uint8Array;
  #pending: { body: Uint8Array; t: number; transparent: number } | null = null;
  #written = 0; #full = false; #startCs = 0; #lastCs = 0; #firstBytes = 0;
  /** Frames closer together than this are not written (the frame rate thinned to keep the file small). */
  minInterval = 0;
  /** See `GifOptions.tolerance`; it can be raised while recording. */
  tolerance: number;

  constructor(options: GifOptions) {
    this.width = Math.max(1, Math.round(options.width)); this.height = Math.max(1, Math.round(options.height));
    this.limit = options.limit ?? Infinity;
    this.#colors = Math.max(2, Math.min(255, Math.round(options.colors ?? 255)));
    this.#dither = options.dither ?? false;
    this.tolerance = Math.max(0, Math.round(options.tolerance ?? 0));
    this.#tints = options.tints ?? []; this.#dark = options.dark ?? true;
    this.#paletteFrames = Math.max(1, options.paletteFrames ?? 4);
    const n = this.width * this.height;
    this.#shown = new Int32Array(n).fill(-1); this.#source = new Uint32Array(n).fill(0xffffffff); this.#indices = new Uint8Array(n);
  }

  /** The file's size if it were finished now. */
  get size(): number { return (this.#palette ? this.#out.n : 800 + 3 * 256) + (this.#pending ? this.#pending.body.length + 8 : 0) + 1; }
  /** Frames written or waiting to be. */
  get frames(): number { return this.#written + (this.#pending ? 1 : 0) + this.#waiting.length; }
  get full(): boolean { return this.#full; }
  /** The head of the file and its first frame (bytes), for telling what each later frame costs. */
  get firstBytes(): number { return this.#firstBytes; }
  /** How long the frames written so far are shown (ms). */
  get duration(): number { return (this.#lastCs - this.#startCs) * 10; }
  get palette(): Palette | null { return this.#palette; }
  /** How many times the picture changed so much that the palette was made again (each frame since carries its own). */
  get refits(): number { return this.#refits; }

  /** Add a frame shown from `t` ms. The array is kept until the frame is written, so it must not be reused by the caller. */
  add(rgba: Pixels, t: number): Added {
    if (this.#full) return 'full';
    if (!this.#palette) {
      this.#hist.add(rgba, this.width, this.height, this.#step());
      this.#waiting.push({ rgba, t });
      if (this.#waiting.length >= this.#paletteFrames) return this.#begin();
      return 'kept';
    }
    return this.#frame(rgba, t);
  }

  /** End the file: the last frame is shown until `t` ms. */
  finish(t: number): Uint8Array {
    if (!this.#palette) { if (!this.#waiting.length) return new Uint8Array(0); this.#begin(); }
    if (this.#pending && !this.#full) this.#commit(t);
    this.#pending = null;
    this.#out.byte(0x3b);
    return this.#out.take();
  }

  /** The histogram's sampling step: about 60,000 pixels a frame. */
  #step(): number { return Math.max(1, Math.floor(Math.sqrt(this.width * this.height / 60_000))); }

  #begin(): Added {
    this.#palette = buildPalette(this.#hist, this.#colors, this.#tints, this.#dark);
    const out = this.#out, bits = tableBits(this.#palette.size + 1);
    out.ascii('GIF89a'); out.short(this.width); out.short(this.height);
    out.byte(0x80 | (7 << 4) | (bits - 1)); out.byte(0); out.byte(0);
    this.#table(out, this.#palette, bits);
    // Loop for ever.
    out.byte(0x21); out.byte(0xff); out.byte(11); out.ascii('NETSCAPE2.0'); out.byte(3); out.byte(1); out.short(0); out.byte(0);
    const waiting = this.#waiting; this.#waiting = [];
    this.#fit = this.#misfit(waiting[0]!.rgba); this.#fitAt = waiting[0]!.t;
    let result: Added = 'kept';
    for (const f of waiting) { const r = this.#frame(f.rgba, f.t); if (r === 'full') { result = 'full'; break; } }
    return result;
  }

  #table(out: Bytes, palette: Palette, bits: number): void {
    out.ensure(3 << bits);
    for (let i = 0; i < 1 << bits; i++) { const c = palette.colors[i] ?? [0, 0, 0]; out.buf[out.n++] = c[0]; out.buf[out.n++] = c[1]; out.buf[out.n++] = c[2]; }
  }

  /** How far the palette is from a picture: the mean weighted square error at the probe points. */
  #misfit(rgba: Pixels): number {
    const palette = this.#palette!, src = new Uint32Array(rgba.buffer, rgba.byteOffset, this.width * this.height), packed = palette.packed;
    let sum = 0, n = 0;
    for (let y = PROBE >> 1; y < this.height; y += PROBE) for (let x = PROBE >> 1, p = y * this.width + x; x < this.width; x += PROBE, p += PROBE) {
      const v = src[p]!, c = packed[palette.index(keyOfPixel(v))]!;
      const dr = (v & 255) - (c >>> 16), dg = ((v >>> 8) & 255) - ((c >>> 8) & 255), db = ((v >>> 16) & 255) - (c & 255);
      sum += 2 * dr * dr + 4 * dg * dg + 3 * db * db; n++;
    }
    return n ? sum / n : 0;
  }

  /**
   * When the picture has drifted far from the palette (the heatmap arriving after the first frame, a theme changed), a palette is
   * made from the frame now and written with every frame from here (a local table: 768 bytes a frame). At most once a second.
   */
  #refit(rgba: Pixels, t: number): void {
    if (t - this.#fitAt < 1000) return;
    const misfit = this.#misfit(rgba);
    if (misfit <= this.#fit * 2.5 + 40) return;
    const hist = new Histogram(); hist.add(rgba, this.width, this.height, this.#step());
    this.#palette = buildPalette(hist, this.#colors, this.#tints, this.#dark);
    this.#local = true; this.#refits++;
    this.#fit = this.#misfit(rgba); this.#fitAt = t;
  }

  #frame(rgba: Pixels, t: number): Added {
    if (this.#pending && t - this.#pending.t < this.minInterval) return 'thinned';
    const W = this.width, H = this.height, src = new Uint32Array(rgba.buffer, rgba.byteOffset, W * H);
    if (this.#written || this.#pending) this.#refit(rgba, t);
    const palette = this.#palette!, lut = palette.lut, packed = palette.packed, transparent = palette.size;
    const shown = this.#shown, source = this.#source, idx = this.#indices, dither = this.#dither, tol = this.tolerance;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    // One pass: the index of every pixel whose source changed, and the box of those whose colour on screen changes.
    for (let y = 0, p = 0; y < H; y++) {
      let rx0 = -1, rx1 = -1;
      for (let x = 0; x < W; x++, p++) {
        const v = src[p]! & 0xffffff, was = source[p]!;
        if (v === was) { idx[p] = transparent; continue; }
        if (tol > 0 && shown[p] !== -1) {
          const dr = (v & 255) - (was & 255), dg = ((v >>> 8) & 255) - ((was >>> 8) & 255), db = (v >>> 16) - ((was >>> 16) & 255);
          if (dr <= tol && dr >= -tol && dg <= tol && dg >= -tol && db <= tol && db >= -tol) { idx[p] = transparent; continue; }
        }
        source[p] = v;
        let key: number;
        if (dither) {
          const d = BAYER[((y & 3) << 2) | (x & 3)]!, h = d >> 1;
          let r = (v & 255) + d, g = ((v >>> 8) & 255) + h, b = ((v >>> 16) & 255) + d;
          r = r < 0 ? 0 : r > 255 ? 255 : r; g = g < 0 ? 0 : g > 255 ? 255 : g; b = b < 0 ? 0 : b > 255 ? 255 : b;
          key = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
        } else key = keyOfPixel(v);
        let j = lut[key]!; if (j < 0) j = palette.nearest(key);
        const c = packed[j]!;
        if (c === shown[p]) { idx[p] = transparent; continue; }
        shown[p] = c; idx[p] = j;
        if (rx0 < 0) rx0 = x;
        rx1 = x;
      }
      if (rx0 >= 0) { if (y < y0) y0 = y; y1 = y; if (rx0 < x0) x0 = rx0; if (rx1 > x1) x1 = rx1; }
    }
    if (x1 < 0) return 'same';
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    // Gather the changed box row by row (in place at the start of the index array, whose rows above are no longer needed).
    let n = 0;
    for (let y = y0; y <= y1; y++) { const row = y * W + x0; if (row !== n) idx.copyWithin(n, row, row + bw); n += bw; }
    const body = this.#body, bits = tableBits(palette.size + 1); body.n = 0;
    body.byte(0x2c); body.short(x0); body.short(y0); body.short(bw); body.short(bh);
    if (this.#local) { body.byte(0x80 | (bits - 1)); this.#table(body, palette, bits); } else body.byte(0);
    this.#lzw.encode(idx, n, Math.max(2, bits), body);
    if (this.#pending && !this.#commit(t)) return 'full';
    this.#pending = { body: body.take(), t, transparent };
    if (!this.#firstBytes) this.#firstBytes = this.#out.n + 8 + body.n;
    return 'kept';
  }

  /** Write the frame waiting, shown until `until`, unless it would take the file past its limit. */
  #commit(until: number): boolean {
    const f = this.#pending!, out = this.#out;
    if (out.n + 8 + f.body.length + 1 > this.limit) { this.#full = true; this.#pending = null; return false; }
    // Delays are in hundredths of a second, rounded on the whole time line so they do not drift; browsers show less than 2 as 10.
    const start = this.#written === 0 ? Math.round(f.t / 10) : this.#lastCs, end = Math.max(start + 2, Math.round(until / 10));
    if (this.#written === 0) this.#startCs = start;
    out.byte(0x21); out.byte(0xf9); out.byte(4); out.byte((1 << 2) | 1); out.short(Math.min(65535, end - start)); out.byte(f.transparent); out.byte(0);
    out.bytes(f.body);
    this.#lastCs = end; this.#written++; this.#pending = null;
    return true;
  }
}
