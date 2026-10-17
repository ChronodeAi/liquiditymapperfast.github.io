/**
 * The GIF file for the screenshot tool's moving pictures, in four stages that each know only their own part, so the heavy ones can run
 * side by side in workers while the cheap ones, which hold what the viewer sees and the byte count, stay in order:
 *
 * 1. `FrameDiffer` compares a frame with what each pixel was last drawn from and marks the pixels that moved (past a tolerance); the rest
 *    are left alone by the frame, and the box around the moved ones is all that is written.
 * 2. `PaletteStage` chooses the frame's own palette from the pixels that moved (`gif-quant.ts`), as many colours as are asked for and
 *    no more than the frame has; the palette is the previous frame's, moved, so colours stay put from frame to frame.
 * 3. `FrameCoder` puts those pixels on the palette (diffusing the error where asked) and packs them with LZW. It needs nothing from any
 *    other frame, so any number of them can work at once.
 * 4. `GifWriter` writes frames in order, each shown until the next, with a delay that rounds on the whole time line so 30 frames a second
 *    play at 30, loops for ever, and never lets the file pass its limit.
 *
 * Each frame has a colour table of its own, as small as its palette needs, and is laid over the picture before it (disposal 1) with the
 * pixels it leaves alone as one transparent index, which LZW folds into very few codes. A frame in which nothing moved is not written;
 * the frame before it is shown longer. `GifEncoder` runs the four in one thread, for the tests and measurements.
 */

import { Colors, Histogram, PaletteMaker, Remapper } from './gif-quant.ts';

/** What a frame is made with: all of it can change from one frame to the next, which is how a recording gives quality back and takes it. */
export interface FrameSettings {
  /** How far (levels of 255, on any channel) a pixel may move from what it was drawn from and still be left as it is. */
  tolerance: number;
  /** Colours in the frame's palette, 2 to 256 (255 where the frame leaves pixels alone, one index being kept for them). */
  colors: number;
  /** Error diffusion: 0 for none, up to 1 for all of each pixel's error passed on. */
  dither: number;
  /**
   * How far the palette is from the frame (mean CIELAB distance, times 100) for diffusion to be at `dither`: where the palette fits the frame
   * better, in proportion less. A frame whose colours the palette nearly has (a page of flat colours and text) gains little from diffusion,
   * which costs bytes in noise; one it does not (a heatmap) gains most. Without it `dither` is used as it is.
   */
  ditherAt?: number;
  /** An ordered pattern in place of diffusion (when `dither` is 0): its size in levels, 0 for none. */
  pattern?: number;
  /** Rounds of k-means refining the palette. */
  iterations?: number;
  /** Look colours up in a coarser table while diffusing (faster, a little noisier). */
  coarse?: boolean;
  /** Pixel counts are raised to this power for the palette's weights. */
  weightExp?: number;
  /** Put each pixel on its exactly nearest colour (set for a frame of few colours and no diffusion; see `mappedWith`). */
  exact?: boolean;
  /** A frame with more distinct colours than this has them merged into coarser bins before the palette is chosen (faster, a little less exact). */
  maxBins?: number;
}

/** The strength of diffusion for a frame whose palette is `error` (CIELAB, as the palette maker reports it) from it. */
export const ditherFor = (settings: FrameSettings, error: number): number => {
  const d = settings.ditherAt && settings.ditherAt > 0 ? Math.min(settings.dither, error * 100 / settings.ditherAt) : settings.dither;
  // Diffusion of a tenth passes on so little that it only costs the exact search for each pixel's colour (below).
  return d < MIN_DITHER ? 0 : d;
};
/** The least diffusion worth having, and the most distinct colours (5-6-5 bins) a frame can have for each of its pixels to be put on its exactly nearest colour. */
export const MIN_DITHER = 0.1, EXACT_BINS = 5000;

/** What a frame is put on its palette with: the diffusion that its palette's fit asks for, and an exact search where there is no diffusion and few colours. */
export const mappedWith = (settings: FrameSettings, made: { error: number; bins: number }): FrameSettings => {
  const dither = ditherFor(settings, made.error);
  return { ...settings, dither, exact: dither === 0 && made.bins > 0 && made.bins <= EXACT_BINS };
};

/** The settings of the best a frame can be. */
export const BEST: FrameSettings = { tolerance: 0, colors: 256, dither: 1, ditherAt: 0.3, iterations: 2, weightExp: 1 };

/** What became of a frame: written (`kept`), the same as the one before (`same`), or not written because the file is full. */
export type Added = 'kept' | 'same' | 'full';

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

/** The bits a colour table of `n` entries takes (its size is 2 to that power). */
export const tableBits = (n: number): number => { let bits = 1; while (1 << bits < n) bits++; return bits; };

/** The box of pixels a frame moved, and how many there are (none: `changed` is 0). */
export interface Moved { changed: number; x0: number; y0: number; x1: number; y1: number }

/** Whether a frame leaves pixels inside its box alone (an index must then be kept for them). */
export const leavesAlone = (moved: Moved): boolean => moved.changed < (moved.x1 - moved.x0 + 1) * (moved.y1 - moved.y0 + 1);

/** Stage 1: what each pixel was last drawn from, and which pixels of a new frame have moved past the tolerance. */
export class FrameDiffer {
  readonly width: number; readonly height: number;
  #drawn: Uint32Array;
  constructor(width: number, height: number) { this.width = width; this.height = height; this.#drawn = new Uint32Array(width * height); }

  /**
   * Compare `px` (a frame read as `0xAABBGGRR`, opaque) with what was drawn. A pixel that has not moved past `tolerance` is set to 0 (the
   * frame leaves it as it is); one that has is kept and counts as drawn from now. Pixels never drawn always move.
   */
  diff(px: Uint32Array, tolerance: number): Moved {
    const W = this.width, H = this.height, drawn = this.#drawn;
    let changed = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0, p = 0; y < H; y++) {
      let rx0 = -1, rx1 = -1;
      for (let x = 0; x < W; x++, p++) {
        const v = px[p]!, was = drawn[p]!;
        if (v === was) { px[p] = 0; continue; }
        if (tolerance > 0 && was !== 0) {
          const dr = (v & 255) - (was & 255), dg = ((v >>> 8) & 255) - ((was >>> 8) & 255), db = ((v >>> 16) & 255) - ((was >>> 16) & 255);
          if (dr <= tolerance && dr >= -tolerance && dg <= tolerance && dg >= -tolerance && db <= tolerance && db >= -tolerance) { px[p] = 0; continue; }
        }
        drawn[p] = v; changed++;
        if (rx0 < 0) rx0 = x;
        rx1 = x;
      }
      if (rx0 >= 0) { if (y < y0) y0 = y; y1 = y; if (rx0 < x0) x0 = rx0; if (rx1 > x1) x1 = rx1; }
    }
    return { changed, x0, y0, x1, y1 };
  }
}

/** Stage 2: a palette for each frame from the pixels it draws. */
export class PaletteStage {
  readonly hist = new Histogram();
  readonly maker: PaletteMaker;
  constructor() { this.maker = new PaletteMaker(this.hist); }
  make(px: Uint32Array, width: number, moved: Moved, settings: FrameSettings): { colors: Colors; exact: boolean; seeded: boolean; error: number; bins: number } {
    const colors = Math.max(2, Math.min(settings.colors, leavesAlone(moved) ? 255 : 256));
    // Large frames are sampled (every second or third pixel of every second or third row): the palette is no worse for it, and the work is a fraction.
    const step = moved.changed <= 300_000 ? 1 : moved.changed <= 1_200_000 ? 2 : 3;
    this.hist.clear();
    this.hist.add(px, width, moved.x0, moved.y0, moved.x1, moved.y1, step);
    return this.maker.make({ colors, iterations: settings.iterations ?? 2, weightExp: settings.weightExp ?? 1, maxBins: settings.maxBins });
  }
  forget(): void { this.maker.forget(); }
}

/** A frame ready to be written: everything from its image descriptor on, and the index it leaves transparent (-1 for none). */
export interface FrameBody { body: Uint8Array; transparent: number }

/** Stage 3: a frame's pixels onto its palette, and packed. Independent of every other frame. */
export class FrameCoder {
  #indices = new Uint8Array(0);
  #bytes = new Bytes(1 << 18);
  #lzw = new Lzw();
  readonly remap = new Remapper();
  /** The palette indices of the last frame coded (its box, row after row). */
  get indices(): Uint8Array { return this.#indices; }
  encode(px: Uint32Array, width: number, moved: Moved, colors: Colors, settings: FrameSettings): FrameBody {
    const bw = moved.x1 - moved.x0 + 1, bh = moved.y1 - moved.y0 + 1, alone = leavesAlone(moved);
    if (this.#indices.length < bw * bh) this.#indices = new Uint8Array(Math.max(bw * bh, this.#indices.length * 2));
    const transparent = alone ? colors.size : -1, bits = tableBits(colors.size + (alone ? 1 : 0)), minCode = Math.max(2, bits);
    this.remap.map(px, width, moved.x0, moved.y0, bw, bh, colors, alone ? colors.size : 0, { dither: colors.size > 1 ? settings.dither : 0, coarse: settings.coarse, pattern: settings.pattern, exact: settings.exact }, this.#indices);
    const out = this.#bytes; out.n = 0;
    out.ensure((3 << bits) + 16);
    out.byte(0x2c); out.short(moved.x0); out.short(moved.y0); out.short(bw); out.short(bh); out.byte(0x80 | (bits - 1));
    // The colour table is 2 to the power `bits` long; what the palette does not fill (and the transparent index) is zero.
    const rgb = colors.rgb;
    for (let i = 0; i < 3 << bits; i++) out.buf[out.n + i] = i < rgb.length ? rgb[i]! : 0;
    out.n += 3 << bits;
    this.#lzw.encode(this.#indices, bw * bh, minCode, out);
    return { body: out.take(), transparent };
  }
}

/** Stage 4: the file. Frames come in order; each is written when the next one shows how long it is shown. */
export class GifWriter {
  readonly width: number; readonly height: number; readonly limit: number;
  #out = new Bytes(1 << 20);
  #pending: (FrameBody & { t: number }) | null = null;
  #written = 0; #full = false; #startCs = 0; #lastCs = 0; #firstBytes = 0;
  constructor(width: number, height: number, limit = Infinity) {
    this.width = width; this.height = height; this.limit = limit;
    const out = this.#out;
    // No global colour table: every frame brings its own. Colour resolution 8 bits.
    out.ascii('GIF89a'); out.short(width); out.short(height); out.byte(0x70); out.byte(0); out.byte(0);
    // Loop for ever.
    out.byte(0x21); out.byte(0xff); out.byte(11); out.ascii('NETSCAPE2.0'); out.byte(3); out.byte(1); out.short(0); out.byte(0);
  }
  /** The file's size if it ended now. */
  get size(): number { return this.#out.n + (this.#pending ? this.#pending.body.length + 8 : 0) + 1; }
  /** Frames written, and the one waiting. */
  get frames(): number { return this.#written + (this.#pending ? 1 : 0); }
  get full(): boolean { return this.#full; }
  /** The head of the file and its first frame (bytes). */
  get firstBytes(): number { return this.#firstBytes; }
  /** How long the frames written so far are shown (ms). */
  get duration(): number { return (this.#lastCs - this.#startCs) * 10; }

  /** Add a frame shown from `t` ms. False when the file has no room for it (and none after it). */
  add(frame: FrameBody, t: number): boolean {
    if (this.#full) return false;
    if (this.#pending && !this.#commit(t)) return false;
    // The frame waiting counts at once: a frame that would take the file past its limit is not accepted.
    if (this.#out.n + frame.body.length + 8 + 1 > this.limit) { this.#full = true; this.#pending = null; return false; }
    this.#pending = { ...frame, t };
    if (!this.#firstBytes) this.#firstBytes = this.#out.n + 8 + frame.body.length;
    return true;
  }

  /** End the file: the last frame is shown until `t` ms. */
  finish(t: number): Uint8Array {
    if (this.#pending && !this.#full) this.#commit(t);
    this.#pending = null;
    this.#out.byte(0x3b);
    return this.#out.take();
  }

  #commit(until: number): boolean {
    const f = this.#pending!, out = this.#out;
    if (out.n + 8 + f.body.length + 1 > this.limit) { this.#full = true; this.#pending = null; return false; }
    // Delays are in hundredths of a second, rounded on the whole time line so they do not drift (30 frames a second come out as 3, 3 and 4);
    // browsers show less than 2 as 10, so no frame is shown for less.
    const start = this.#written === 0 ? Math.round(f.t / 10) : this.#lastCs, end = Math.max(start + 2, Math.round(until / 10));
    if (this.#written === 0) this.#startCs = start;
    out.byte(0x21); out.byte(0xf9); out.byte(4); out.byte((1 << 2) | (f.transparent >= 0 ? 1 : 0)); out.short(Math.min(65535, end - start)); out.byte(Math.max(0, f.transparent)); out.byte(0);
    out.bytes(f.body);
    this.#lastCs = end; this.#written++; this.#pending = null;
    return true;
  }
}

export interface GifOptions {
  width: number;
  height: number;
  /** The file is never larger than this many bytes. */
  limit?: number;
  /** The settings frames are made with unless a call says otherwise. */
  settings?: FrameSettings;
}

/** The four stages in one thread. */
export class GifEncoder {
  readonly width: number; readonly height: number;
  readonly differ: FrameDiffer; readonly palette = new PaletteStage(); readonly coder = new FrameCoder(); readonly writer: GifWriter;
  settings: FrameSettings;
  constructor(options: GifOptions) {
    this.width = Math.max(1, Math.round(options.width)); this.height = Math.max(1, Math.round(options.height));
    this.differ = new FrameDiffer(this.width, this.height); this.writer = new GifWriter(this.width, this.height, options.limit ?? Infinity);
    this.settings = options.settings ?? BEST;
  }
  get size(): number { return this.writer.size; }
  get frames(): number { return this.writer.frames; }
  get full(): boolean { return this.writer.full; }
  get firstBytes(): number { return this.writer.firstBytes; }
  get duration(): number { return this.writer.duration; }

  /** Add a frame (RGBA, opaque) shown from `t` ms. The pixels are changed in place (those it leaves alone are zeroed). */
  add(rgba: Uint8ClampedArray | Uint8Array, t: number, settings: FrameSettings = this.settings): Added {
    if (this.writer.full) return 'full';
    const px = new Uint32Array(rgba.buffer, rgba.byteOffset, this.width * this.height);
    const moved = this.differ.diff(px, settings.tolerance);
    if (moved.changed === 0) return 'same';
    const made = this.palette.make(px, this.width, moved, settings);
    const frame = this.coder.encode(px, this.width, moved, made.colors, mappedWith(settings, made));
    return this.writer.add(frame, t) ? 'kept' : 'full';
  }
  finish(t: number): Uint8Array { return this.writer.finish(t); }
}
