/**
 * Colour quantisation for the moving pictures: a palette of up to 256 colours for one frame, chosen for what the viewer sees, and the
 * mapping of the frame's pixels onto it (with error diffusion where asked). Pure typed-array code, no DOM, so it runs in a worker and in
 * the tests.
 *
 * - The frame's colours are counted in a histogram of 65536 bins (5 bits of red, 6 of green, 5 of blue), each bin keeping the true sum of
 *   its pixels so a colour stands for what it holds, not for the middle of its bin.
 * - Distances are measured in CIELAB, where an equal step is about an equal change to the eye, not in RGB (where dark blues crowd
 *   together and greens are spread out).
 * - A palette begins as the previous frame's (so colours stay put from frame to frame) or, for the first frame and when the picture has
 *   changed too much for the old colours, as a median cut that splits along the axis the colours spread most in. Then a few rounds of
 *   k-means over the histogram's bins move each colour to the mean of the bins nearest it, and a colour nobody uses goes to where the
 *   error is worst. A frame with few enough colours is not quantised at all: its palette is its colours.
 * - Finding the nearest colour looks along the colours sorted by lightness and stops as soon as lightness alone says nothing further
 *   can be nearer, which is a handful of comparisons instead of 255.
 * - Pixels go onto the palette through a table of the same 65536 bins, filled the first time a bin is met. Error diffusion (Floyd and
 *   Steinberg's weights, serpentine, the error capped so one missing colour does not smear across the picture) carries what each pixel
 *   could not show to its neighbours that are drawn in this frame; pixels the frame leaves as they are neither take nor give any.
 */

const SRGB = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; SRGB[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }

/** Lightness and its inverse, with the straight stretch near black that CIELAB has (so differences between near-black shades, which no screen shows, are small). */
const FWD = (t: number): number => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
const INV = (t: number): number => t > 6 / 29 ? t * t * t : 3 * (6 / 29) * (6 / 29) * (t - 4 / 29);

/** CIELAB (D65) of an sRGB colour (bytes), written to `out` at `o`, every axis divided by 100 so that distances are about the size of a percent. */
export function toLab(r: number, g: number, b: number, out: Float32Array, o: number): void {
  const R = SRGB[r]!, G = SRGB[g]!, B = SRGB[b]!;
  const x = FWD((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047), y = FWD(0.2126729 * R + 0.7151522 * G + 0.072175 * B), z = FWD((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883);
  out[o] = (1.16 * y - 0.16); out[o + 1] = 5 * (x - y); out[o + 2] = 2 * (y - z);
}

const encode = (c: number): number => { const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255); };

/** The sRGB byte colour of a colour in `toLab`'s units (clamped into the gamut), as `0xBBGGRR`. */
export function fromLab(L: number, a: number, b: number): number {
  const fy = (L + 0.16) / 1.16, fx = fy + a / 5, fz = fy - b / 2;
  const X = 0.95047 * INV(fx), Y = INV(fy), Z = 1.08883 * INV(fz);
  const r = encode(3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z), g = encode(-0.969266 * X + 1.8760108 * Y + 0.041556 * Z), bl = encode(0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z);
  return (bl << 16) | (g << 8) | r;
}

/** A palette: its colours as bytes (r, g, b) and in CIELAB, and the lightness order the nearest search runs along. */
export class Colors {
  readonly size: number;
  readonly rgb: Uint8Array;
  readonly lab: Float32Array;
  /** Colour indices from the darkest to the lightest, and their lightness in that order. */
  readonly order: Uint16Array; readonly sortedL: Float32Array;
  constructor(rgb: Uint8Array) {
    this.size = rgb.length / 3; this.rgb = rgb;
    this.lab = new Float32Array(this.size * 3);
    for (let i = 0; i < this.size; i++) toLab(rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!, this.lab, i * 3);
    const idx = Array.from({ length: this.size }, (_, i) => i).sort((p, q) => this.lab[p * 3]! - this.lab[q * 3]!);
    this.order = Uint16Array.from(idx); this.sortedL = new Float32Array(this.size);
    for (let i = 0; i < this.size; i++) this.sortedL[i] = this.lab[idx[i]! * 3]!;
  }
  /**
   * The index of the colour nearest (L, a, b). `hint` is a colour likely to be near (the one the neighbouring pixel got): its distance is
   * the first bound, so the search along the lightness order starts with a short stretch to look through.
   */
  nearest(L: number, a: number, b: number, hint = -1): number {
    const n = this.size, sl = this.sortedL, lab = this.lab, order = this.order;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sl[mid]! < L) lo = mid + 1; else hi = mid; }
    let best = -1, bestD = Infinity, up = lo, down = lo - 1;
    if (hint >= 0) { const o = hint * 3, dL = lab[o]! - L, da = lab[o + 1]! - a, db = lab[o + 2]! - b; bestD = dL * dL + da * da + db * db; best = hint; }
    while (up < n || down >= 0) {
      const dUp = up < n ? sl[up]! - L : Infinity, dDown = down >= 0 ? L - sl[down]! : Infinity;
      if (Math.min(dUp, dDown) ** 2 >= bestD) break;
      let i: number;
      if (dUp <= dDown) i = order[up++]!; else i = order[down--]!;
      const o = i * 3, dL = lab[o]! - L, da = lab[o + 1]! - a, db = lab[o + 2]! - b, d = dL * dL + da * da + db * db;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
}

const SCRATCH_LAB = new Float32Array(3);

/**
 * A frame's colours counted. `add` takes the pixels of a frame (read as `0xAABBGGRR`, a pixel of 0 being one the frame leaves as it is);
 * `bins` then lists what was found. Reused from frame to frame: `clear` costs what the last frame touched, not 65536.
 */
export class Histogram {
  readonly count = new Uint32Array(65536);
  readonly sr = new Uint32Array(65536); readonly sg = new Uint32Array(65536); readonly sb = new Uint32Array(65536);
  /** The first colour a bin saw, and whether another colour has come to it since (a bin with one colour is exact). */
  readonly first = new Uint32Array(65536); readonly mixed = new Uint8Array(65536);
  /** The bins touched, in the order they were met. */
  readonly keys = new Uint16Array(65536);
  n = 0; total = 0;
  clear(): void {
    for (let i = 0; i < this.n; i++) { const k = this.keys[i]!; this.count[k] = 0; this.sr[k] = 0; this.sg[k] = 0; this.sb[k] = 0; this.mixed[k] = 0; }
    this.n = 0; this.total = 0;
  }
  /** Count the pixels in rows `y0` to `y1` and columns `x0` to `x1` of a frame `width` wide, taking every `step`th row and column. */
  add(src: Uint32Array, width: number, x0: number, y0: number, x1: number, y1: number, step = 1): void {
    const count = this.count, sr = this.sr, sg = this.sg, sb = this.sb, first = this.first, mixed = this.mixed, keys = this.keys;
    let n = this.n, total = 0;
    for (let y = y0; y <= y1; y += step) {
      for (let x = x0, p = y * width + x0; x <= x1; x += step, p += step) {
        const v = src[p]!;
        if (v === 0) continue;
        const k = ((v & 0xf8) << 8) | ((v >>> 5) & 0x7e0) | ((v >>> 19) & 0x1f);
        if (count[k] === 0) { keys[n++] = k; first[k] = v; } else if (first[k] !== v) mixed[k] = 1;
        count[k]!++; sr[k]! += v & 255; sg[k]! += (v >>> 8) & 255; sb[k]! += (v >>> 16) & 255; total++;
      }
    }
    this.n = n; this.total += total;
  }
}

/** The bins of a histogram as arrays the clustering runs over: weight, CIELAB and byte colour of what each bin holds. */
class Bins {
  n = 0;
  cap = 0;
  w = new Float32Array(0); lab = new Float32Array(0); rgb = new Float32Array(0); key = new Uint16Array(0);
  // For merging bins when a frame has more than the clustering needs: 4-5-4 bit super-bins.
  #cc = new Uint32Array(8192); #cr = new Float64Array(8192); #cg = new Float64Array(8192); #cb = new Float64Array(8192); #ck = new Uint16Array(8192);
  #grow(n: number): void {
    if (n <= this.cap) return;
    this.cap = Math.max(n, this.cap * 2, 1024);
    this.w = new Float32Array(this.cap); this.lab = new Float32Array(this.cap * 3); this.rgb = new Float32Array(this.cap * 3); this.key = new Uint16Array(this.cap);
  }
  /** Fill from the histogram; more than `maxBins` bins are merged into coarser ones first (the palette's colours are means, so little is lost). */
  fill(h: Histogram, weightExp: number, maxBins: number): void {
    const hn = h.n;
    if (hn > maxBins) { this.#fillCoarse(h, weightExp); return; }
    this.#grow(hn);
    for (let i = 0; i < hn; i++) {
      const k = h.keys[i]!, c = h.count[k]!;
      this.#set(i, k, c, h.sr[k]! / c, h.sg[k]! / c, h.sb[k]! / c, weightExp);
    }
    this.n = hn;
  }
  #set(i: number, key: number, count: number, r: number, g: number, b: number, weightExp: number): void {
    this.w[i] = weightExp === 1 ? count : Math.pow(count, weightExp); this.key[i] = key;
    this.rgb[i * 3] = r; this.rgb[i * 3 + 1] = g; this.rgb[i * 3 + 2] = b;
    toLab(Math.round(r), Math.round(g), Math.round(b), SCRATCH_LAB, 0);
    this.lab[i * 3] = SCRATCH_LAB[0]!; this.lab[i * 3 + 1] = SCRATCH_LAB[1]!; this.lab[i * 3 + 2] = SCRATCH_LAB[2]!;
  }
  #fillCoarse(h: Histogram, weightExp: number): void {
    const cc = this.#cc, cr = this.#cr, cg = this.#cg, cb = this.#cb, ck = this.#ck;
    let m = 0;
    for (let i = 0; i < h.n; i++) {
      const k = h.keys[i]!, ckey = ((k >> 12) << 9) | (((k >> 6) & 31) << 4) | ((k >> 1) & 15), c = h.count[k]!;
      if (cc[ckey] === 0) ck[m++] = ckey;
      cc[ckey]! += c; cr[ckey]! += h.sr[k]!; cg[ckey]! += h.sg[k]!; cb[ckey]! += h.sb[k]!;
    }
    this.#grow(m);
    for (let i = 0; i < m; i++) {
      const ckey = ck[i]!, c = cc[ckey]!;
      this.#set(i, ckey, c, cr[ckey]! / c, cg[ckey]! / c, cb[ckey]! / c, weightExp);
      cc[ckey] = 0; cr[ckey] = 0; cg[ckey] = 0; cb[ckey] = 0;
    }
    this.n = m;
  }
}

export interface PaletteOptions {
  /** Colours wanted, 2 to 256. */
  colors: number;
  /** Rounds of k-means after the colours are placed. */
  iterations?: number;
  /** Pixel counts are raised to this power for weights (below 1 gives rare colours, such as text, a larger share). */
  weightExp?: number;
  /** A frame with more distinct colours than this has them merged into coarser bins for the clustering. */
  maxBins?: number;
}

export interface PaletteResult {
  colors: Colors;
  /** The colours are the frame's own (nothing to quantise): no error, no need to dither. */
  exact: boolean;
  /** The mean CIELAB distance of the frame's pixels from the palette, by the bins (a measure of how well it fits). */
  error: number;
  /** Whether the previous palette was the start (true) or the colours were placed afresh. */
  seeded: boolean;
  /** How many distinct colours (5-6-5 bins, of the pixels counted) the frame has: few means a page of flat colours and text. */
  bins: number;
}

/** Builds palettes frame after frame, remembering the last one to start the next from. */
export class PaletteMaker {
  readonly bins = new Bins();
  #hist: Histogram;
  /** The last palette made and how well it fitted. */
  previous: Colors | null = null; #prevError = 0;
  // Working arrays of the clustering, kept between frames.
  #assign = new Int32Array(0); #dist = new Float32Array(0); #order = new Int32Array(0);
  constructor(hist: Histogram) { this.#hist = hist; }

  forget(): void { this.previous = null; }

  make(options: PaletteOptions): PaletteResult {
    const h = this.#hist, K = Math.max(2, Math.min(256, options.colors)), iterations = options.iterations ?? 2, weightExp = options.weightExp ?? 0.85;
    const bins = this.bins; bins.fill(h, weightExp, options.maxBins ?? 6000);
    const n = bins.n;
    if (n === 0) { const colors = new Colors(new Uint8Array([0, 0, 0])); return { colors, exact: true, error: 0, seeded: false, bins: 0 }; }
    // Few colours, each one exact: the palette is the colours themselves.
    if (n <= K) {
      let exact = true;
      for (let i = 0; i < n; i++) if (h.mixed[bins.key[i]!]) { exact = false; break; }
      if (exact) {
        const rgb = new Uint8Array(n * 3);
        for (let i = 0; i < n; i++) { const v = h.first[bins.key[i]!]!; rgb[i * 3] = v & 255; rgb[i * 3 + 1] = (v >>> 8) & 255; rgb[i * 3 + 2] = (v >>> 16) & 255; }
        const colors = new Colors(rgb); this.previous = colors; this.#prevError = 0;
        return { colors, exact: true, error: 0, seeded: false, bins: n };
      }
    }
    if (this.#assign.length < n) { this.#assign = new Int32Array(Math.max(n, this.#assign.length * 2)); this.#dist = new Float32Array(this.#assign.length); this.#order = new Int32Array(this.#assign.length); }
    const k = Math.min(K, n);
    // The start: the colours of the last frame, if they still fit this one; otherwise a median cut.
    let centers: Float32Array | null = null, seeded = false;
    const prev = this.previous;
    if (prev && prev.size >= Math.min(k, n) * 0.75 && prev.size <= 256) {
      const c = new Float32Array(k * 3);
      for (let i = 0; i < k; i++) { const s = i < prev.size ? i : i % prev.size; c[i * 3] = prev.lab[s * 3]!; c[i * 3 + 1] = prev.lab[s * 3 + 1]!; c[i * 3 + 2] = prev.lab[s * 3 + 2]!; }
      const fit = this.#fitError(c, k);
      if (fit <= this.#prevError * 2 + 0.012) { centers = c; seeded = true; }
    }
    if (!centers) centers = this.#medianCut(k);
    let error = 0;
    for (let it = 0; it < iterations; it++) {
      error = this.#assignAll(centers, k);
      const moved = this.#update(centers, k);
      if (moved < 1e-5) break;
    }
    error = this.#assignAll(centers, k);
    // The colours as bytes: the mean of what each holds, back in sRGB.
    const rgb = new Uint8Array(k * 3);
    const sw = new Float64Array(k), sl = new Float64Array(k), sa = new Float64Array(k), sb = new Float64Array(k), assign = this.#assign;
    for (let i = 0; i < n; i++) { const c = assign[i]!, w = bins.w[i]!; sw[c]! += w; sl[c]! += w * bins.lab[i * 3]!; sa[c]! += w * bins.lab[i * 3 + 1]!; sb[c]! += w * bins.lab[i * 3 + 2]!; }
    let used = 0;
    for (let c = 0; c < k; c++) if (sw[c]! > 0) {
      const v = fromLab(sl[c]! / sw[c]!, sa[c]! / sw[c]!, sb[c]! / sw[c]!);
      rgb[used * 3] = v & 255; rgb[used * 3 + 1] = (v >> 8) & 255; rgb[used * 3 + 2] = (v >> 16) & 255; used++;
    }
    const colors = new Colors(used === k ? rgb : rgb.slice(0, used * 3));
    this.previous = colors; this.#prevError = error;
    return { colors, exact: false, error, seeded, bins: n };
  }

  /** The weighted mean distance of the bins from their nearest centres (no change to the centres). */
  #fitError(centers: Float32Array, k: number): number { return this.#assignAll(centers, k); }

  /** Assign every bin to its nearest centre; the weighted mean distance (CIELAB) of the bins from them. */
  #assignAll(centers: Float32Array, k: number): number {
    const bins = this.bins, n = bins.n, assign = this.#assign, dist = this.#dist;
    // The centres in lightness order, for the search that stops early.
    const order = this.#order, ls = new Float32Array(k);
    for (let i = 0; i < k; i++) order[i] = i;
    const ord = order.subarray(0, k); ord.sort((p, q) => centers[p * 3]! - centers[q * 3]!);
    for (let i = 0; i < k; i++) ls[i] = centers[ord[i]! * 3]!;
    let sum = 0, wsum = 0, last = 0;
    const lab = bins.lab, w = bins.w;
    for (let i = 0; i < n; i++) {
      const L = lab[i * 3]!, a = lab[i * 3 + 1]!, b = lab[i * 3 + 2]!;
      let lo = 0, hi = k - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (ls[mid]! < L) lo = mid + 1; else hi = mid; }
      // The previous bin's centre is likely near: its distance is the first bound.
      let best = last, bestD = (centers[last * 3]! - L) ** 2 + (centers[last * 3 + 1]! - a) ** 2 + (centers[last * 3 + 2]! - b) ** 2, up = lo, down = lo - 1;
      while (up < k || down >= 0) {
        const dUp = up < k ? ls[up]! - L : Infinity, dDown = down >= 0 ? L - ls[down]! : Infinity;
        const m = dUp < dDown ? dUp : dDown;
        if (m * m >= bestD) break;
        const c = dUp <= dDown ? ord[up++]! : ord[down--]!, o = c * 3;
        const dL = centers[o]! - L, da = centers[o + 1]! - a, db = centers[o + 2]! - b, d = dL * dL + da * da + db * db;
        if (d < bestD) { bestD = d; best = c; }
      }
      assign[i] = best; dist[i] = bestD; last = best;
      const e = Math.sqrt(bestD); sum += w[i]! * e; wsum += w[i]!;
    }
    return sum / Math.max(wsum, 1e-9);
  }

  /** Move each centre to the mean of its bins; a centre without any goes to the bin that is worst off. Returns how far the centres moved. */
  #update(centers: Float32Array, k: number): number {
    const bins = this.bins, n = bins.n, assign = this.#assign, dist = this.#dist, lab = bins.lab, w = bins.w;
    const sw = new Float64Array(k), sl = new Float64Array(k), sa = new Float64Array(k), sb = new Float64Array(k);
    for (let i = 0; i < n; i++) { const c = assign[i]!, wi = w[i]!; sw[c]! += wi; sl[c]! += wi * lab[i * 3]!; sa[c]! += wi * lab[i * 3 + 1]!; sb[c]! += wi * lab[i * 3 + 2]!; }
    let moved = 0, dead = 0;
    for (let c = 0; c < k; c++) {
      if (sw[c]! > 0) {
        const L = sl[c]! / sw[c]!, a = sa[c]! / sw[c]!, b = sb[c]! / sw[c]!;
        moved += Math.abs(L - centers[c * 3]!) + Math.abs(a - centers[c * 3 + 1]!) + Math.abs(b - centers[c * 3 + 2]!);
        centers[c * 3] = L; centers[c * 3 + 1] = a; centers[c * 3 + 2] = b;
      } else dead++;
    }
    if (dead > 0) {
      // The worst off bins (distance times weight), one for each centre that has none; each taken bin is then no longer worst off.
      const taken: number[] = [];
      for (let c = 0; c < k && taken.length < dead; c++) {
        if (sw[c]! > 0) continue;
        let best = -1, bestV = 0;
        for (let i = 0; i < n; i++) { const v = dist[i]! * w[i]!; if (v > bestV) { bestV = v; best = i; } }
        if (best < 0) break;
        centers[c * 3] = lab[best * 3]!; centers[c * 3 + 1] = lab[best * 3 + 1]!; centers[c * 3 + 2] = lab[best * 3 + 2]!;
        dist[best] = 0; taken.push(best); moved += 1;
      }
    }
    return moved / Math.max(k, 1);
  }

  /** Median cut over the bins in CIELAB: the box with the most spread is split at the weighted middle of its widest axis, until there are `k`. */
  #medianCut(k: number): Float32Array {
    const bins = this.bins, n = bins.n, lab = bins.lab, w = bins.w;
    const idx = new Int32Array(n); for (let i = 0; i < n; i++) idx[i] = i;
    interface Box { lo: number; hi: number; spread: number; axis: number; min: number; max: number }
    const measure = (lo: number, hi: number): Box => {
      let sw = 0, s0 = 0, s1 = 0, s2 = 0, q0 = 0, q1 = 0, q2 = 0, mn0 = Infinity, mn1 = Infinity, mn2 = Infinity, mx0 = -Infinity, mx1 = -Infinity, mx2 = -Infinity;
      for (let j = lo; j < hi; j++) {
        const i = idx[j]!, wi = w[i]!, o = i * 3, v0 = lab[o]!, v1 = lab[o + 1]!, v2 = lab[o + 2]!;
        sw += wi; s0 += wi * v0; s1 += wi * v1; s2 += wi * v2; q0 += wi * v0 * v0; q1 += wi * v1 * v1; q2 += wi * v2 * v2;
        if (v0 < mn0) mn0 = v0; if (v0 > mx0) mx0 = v0; if (v1 < mn1) mn1 = v1; if (v1 > mx1) mx1 = v1; if (v2 < mn2) mn2 = v2; if (v2 > mx2) mx2 = v2;
      }
      const inv = 1 / Math.max(sw, 1e-12), e0 = Math.max(0, q0 - s0 * s0 * inv), e1 = Math.max(0, q1 - s1 * s1 * inv), e2 = Math.max(0, q2 - s2 * s2 * inv);
      const axis = e0 >= e1 && e0 >= e2 ? 0 : e1 >= e2 ? 1 : 2;
      return { lo, hi, spread: hi - lo > 1 ? e0 + e1 + e2 : 0, axis, min: axis === 0 ? mn0 : axis === 1 ? mn1 : mn2, max: axis === 0 ? mx0 : axis === 1 ? mx1 : mx2 };
    };
    const boxes: Box[] = [measure(0, n)];
    const buckets = new Float64Array(64);
    while (boxes.length < k) {
      let best = -1, bestS = 1e-12;
      for (let i = 0; i < boxes.length; i++) if (boxes[i]!.spread > bestS) { bestS = boxes[i]!.spread; best = i; }
      if (best < 0) break;
      const box = boxes[best]!, span = box.max - box.min, ax = box.axis;
      // The weighted middle along the axis, found in 64 buckets; the box is partitioned about it.
      buckets.fill(0); let total = 0;
      for (let j = box.lo; j < box.hi; j++) { const i = idx[j]!; const b = Math.min(63, Math.floor((lab[i * 3 + ax]! - box.min) / span * 64)); buckets[b]! += w[i]!; total += w[i]!; }
      let acc = 0, cut = 0;
      for (let b = 0; b < 63; b++) { acc += buckets[b]!; cut = b; if (acc >= total / 2) break; }
      // Both sides must hold something.
      const edge = box.min + span * (cut + 1) / 64;
      let i0 = box.lo, i1 = box.hi - 1;
      while (i0 <= i1) { if (lab[idx[i0]! * 3 + ax]! < edge) i0++; else { const t = idx[i0]!; idx[i0] = idx[i1]!; idx[i1] = t; i1--; } }
      let mid = i0;
      if (mid === box.lo || mid === box.hi) mid = (box.lo + box.hi) >> 1;
      boxes.splice(best, 1, measure(box.lo, mid), measure(mid, box.hi));
    }
    const centers = new Float32Array(k * 3);
    boxes.forEach((box, c) => {
      let sw = 0, sl = 0, sa = 0, sb = 0;
      for (let j = box.lo; j < box.hi; j++) { const i = idx[j]!, wi = w[i]!; sw += wi; sl += wi * lab[i * 3]!; sa += wi * lab[i * 3 + 1]!; sb += wi * lab[i * 3 + 2]!; }
      centers[c * 3] = sl / sw; centers[c * 3 + 1] = sa / sw; centers[c * 3 + 2] = sb / sw;
    });
    // Fewer boxes than colours wanted (colours that cannot be told apart): the rest repeat the first, and fall away as unused.
    for (let c = boxes.length; c < k; c++) { centers[c * 3] = centers[0]!; centers[c * 3 + 1] = centers[1]!; centers[c * 3 + 2] = centers[2]!; }
    return centers;
  }
}

/** How a frame's pixels are put on its palette. */
export interface RemapOptions {
  /** 0: each pixel to its nearest colour; above 0: error diffusion, this share of each pixel's error passed on. */
  dither: number;
  /** Look colours up by 4-5-4 bit bins (8192) instead of 5-6-5 (65536) while diffusing: fewer to find, the diffusion makes up for the coarser choice. */
  coarse?: boolean;
  /**
   * Find each pixel's nearest colour from its exact colour, not from the bin it is in: a frame of few colours (flat fills and text) has
   * many colours in one bin that a single answer for the bin would give the wrong palette colour. Slower for a frame of many colours, so
   * for frames of few. Only without diffusion.
   */
  exact?: boolean;
  /**
   * An ordered pattern instead of diffusion: each pixel is nudged by a fixed 8 x 8 pattern (this many levels from lightest to darkest nudge)
   * before it is put on its nearest colour. The pattern is fixed to the picture, so a pixel that barely moves keeps its colour from frame to
   * frame, which diffusion, passing every change on to its neighbours, does not.
   */
  pattern?: number;
  /** The largest error passed on in any channel (levels of 255). */
  errorCap?: number;
}

/** An 8 x 8 Bayer pattern, from -32 to 31 (each value once). */
const BAYER8 = (() => {
  const m = new Int8Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    // Interleave the bits of x and x xor y, reversed: the standard construction.
    let v = 0; const a = x, b = x ^ y;
    for (let bit = 0; bit < 3; bit++) v |= (((b >> bit) & 1) << (2 * (2 - bit))) | (((a >> bit) & 1) << (2 * (2 - bit) + 1));
    m[y * 8 + x] = v - 32;
  }
  return m;
})();

/**
 * Puts a frame's pixels on a palette. A table finds the colour for each bin of a pixel the first time that bin is met (the colour of the
 * first pixel to come to it stands for the bin). Reused from frame to frame.
 */
export class Remapper {
  #lut = new Int16Array(65536);
  #rows = new Int32Array(0);
  #tmp = new Float32Array(3);
  /** Colours found since the table was cleared (a measure of the work). */
  misses = 0;
  #exactKeys = new Int32Array(0); #exactIdx = new Uint8Array(0);

  /**
   * Fill `out` (a box `bw` × `bh` of the frame at `x0`, `y0`, row after row) with palette indices; a pixel of 0 gets `transparent`.
   */
  map(src: Uint32Array, width: number, x0: number, y0: number, bw: number, bh: number, colors: Colors, transparent: number, options: RemapOptions, out: Uint8Array): void {
    const strength = options.dither, patterned = (options.pattern ?? 0) > 0 && strength <= 0 && colors.size > 1, diffuse = strength > 0 && colors.size > 1, coarse = diffuse && options.coarse === true;
    const lut = this.#lut; lut.fill(-1, 0, coarse ? 8192 : 65536); this.misses = 0;
    const rgb = colors.rgb, tmp = this.#tmp;
    let hint = -1, misses = 0;
    const find = (key: number, r: number, g: number, b: number): number => {
      misses++;
      toLab(r, g, b, tmp, 0);
      const i = colors.nearest(tmp[0]!, tmp[1]!, tmp[2]!, hint); if (key >= 0) lut[key] = i; hint = i; return i;
    };
    let o = 0;
    if (patterned) {
      const amp = options.pattern!;
      for (let y = 0; y < bh; y++) {
        const row = ((y0 + y) & 7) << 3;
        for (let x = 0, p = (y0 + y) * width + x0; x < bw; x++, p++, o++) {
          const v = src[p]!;
          if (v === 0) { out[o] = transparent; continue; }
          const off = (BAYER8[row | ((x0 + x) & 7)]! * amp) >> 6;
          let r = (v & 255) + off, g = ((v >>> 8) & 255) + off, b = ((v >>> 16) & 255) + off;
          r = r < 0 ? 0 : r > 255 ? 255 : r; g = g < 0 ? 0 : g > 255 ? 255 : g; b = b < 0 ? 0 : b > 255 ? 255 : b;
          const key = ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
          const i = lut[key]!; out[o] = i >= 0 ? i : find(key, r, g, b);
        }
      }
      this.misses = misses;
      return;
    }
    if (!diffuse && options.exact) {
      // The answers are kept by exact colour in a table of 65536 places (a colour goes where its hash does; a place taken by another colour is simply used again).
      if (this.#exactKeys.length === 0) { this.#exactKeys = new Int32Array(65536); this.#exactIdx = new Uint8Array(65536); }
      const keys = this.#exactKeys, idx = this.#exactIdx; keys.fill(-1);
      for (let y = 0; y < bh; y++) {
        for (let x = 0, p = (y0 + y) * width + x0; x < bw; x++, p++, o++) {
          const v = src[p]!;
          if (v === 0) { out[o] = transparent; continue; }
          const key = v & 0xffffff, h = Math.imul(key, 0x9e3779b1) >>> 16;
          if (keys[h] === key) { out[o] = idx[h]!; continue; }
          const i = find(-1, v & 255, (v >>> 8) & 255, (v >>> 16) & 255);
          keys[h] = key; idx[h] = i; out[o] = i;
        }
      }
      this.misses = misses;
      return;
    }
    if (!diffuse) {
      for (let y = 0; y < bh; y++) {
        for (let x = 0, p = (y0 + y) * width + x0; x < bw; x++, p++, o++) {
          const v = src[p]!;
          if (v === 0) { out[o] = transparent; continue; }
          const key = ((v & 0xf8) << 8) | ((v >>> 5) & 0x7e0) | ((v >>> 19) & 0x1f);
          const i = lut[key]!; out[o] = i >= 0 ? i : find(key, v & 255, (v >>> 8) & 255, (v >>> 16) & 255);
        }
      }
      this.misses = misses;
      return;
    }
    // Error diffusion: two rows of error (8 bits of fraction), for this row and the next, a pixel's worth of padding either side.
    const stride = (bw + 2) * 3;
    if (this.#rows.length < stride * 2) this.#rows = new Int32Array(stride * 2);
    let cur = this.#rows.subarray(0, stride), next = this.#rows.subarray(stride, stride * 2);
    cur.fill(0); next.fill(0);
    const cap = options.errorCap ?? 24, w7 = Math.round(strength * 7 * 16), w3 = Math.round(strength * 3 * 16), w5 = Math.round(strength * 5 * 16), w1 = Math.round(strength * 16);
    for (let y = 0; y < bh; y++) {
      const rowStart = y * bw, base = (y0 + y) * width + x0, forward = (y & 1) === 0;
      const xs = forward ? 0 : bw - 1, dx = forward ? 1 : -1, d3 = dx * 3;
      // What the pixel before passes along the row to this one, kept in registers (a pixel left alone passes nothing).
      let cr = 0, cg = 0, cb = 0;
      for (let step = 0, x = xs; step < bw; step++, x += dx) {
        const v = src[base + x]!;
        if (v === 0) { out[rowStart + x] = transparent; cr = 0; cg = 0; cb = 0; continue; }
        const c = (x + 1) * 3;
        let r = (v & 255) + ((cur[c]! + cr + 128) >> 8), g = ((v >>> 8) & 255) + ((cur[c + 1]! + cg + 128) >> 8), b = ((v >>> 16) & 255) + ((cur[c + 2]! + cb + 128) >> 8);
        r = r < 0 ? 0 : r > 255 ? 255 : r; g = g < 0 ? 0 : g > 255 ? 255 : g; b = b < 0 ? 0 : b > 255 ? 255 : b;
        let key: number;
        if (coarse) key = ((r >> 4) << 9) | ((g >> 3) << 4) | (b >> 4); else key = ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
        let i = lut[key]!; if (i < 0) i = find(key, r, g, b);
        out[rowStart + x] = i;
        const o = i * 3;
        let er = r - rgb[o]!, eg = g - rgb[o + 1]!, eb = b - rgb[o + 2]!;
        if ((er | eg | eb) === 0) { cr = 0; cg = 0; cb = 0; continue; }
        er = er > cap ? cap : er < -cap ? -cap : er; eg = eg > cap ? cap : eg < -cap ? -cap : eg; eb = eb > cap ? cap : eb < -cap ? -cap : eb;
        // To the next pixel along the row (in the registers), and to the three below (the weights face the way the row runs).
        cr = er * w7; cg = eg * w7; cb = eb * w7;
        const bl = c - d3, br = c + d3;
        next[bl] += er * w3; next[bl + 1] += eg * w3; next[bl + 2] += eb * w3;
        next[c] += er * w5; next[c + 1] += eg * w5; next[c + 2] += eb * w5;
        next[br] += er * w1; next[br + 1] += eg * w1; next[br + 2] += eb * w1;
      }
      const t = cur; cur = next; next = t; next.fill(0);
    }
    this.misses = misses;
  }
}
