import { STRIDE, type TapeRing } from '../tape/ring.ts';
import type { TrailStyle } from './model.ts';

/**
 * The Candle view's trade trail and its arrival flashes, on a canvas of their own behind the book and the candle.
 *
 * The trail: every market order of the last `windowMs` (the tape ring the trade dust reads, tape/ring.ts), at its exchange time across the
 * screen (now at `x1`, the window ago at `x0`) and its price on the candle's price axis, sized by its USD on a log scale, buys filled and
 * sells hollow (the shape says the side as well as the colour, so it reads in grey and in the colour-blind palette), dimmer as it ages.
 * Nothing is accumulated or cached: the orders in the window are copied from the ring into a small buffer and drawn as point sprites in
 * one call, a few thousand at BTC's busiest, so the trail can move every frame without a picture to keep in step.
 *
 * The flashes: the rows of the arrival rail that just received a large order (worked out by the pane, candle/model.ts `flashes`), each a
 * short, monotonic fade: a bright core cooling to its side's colour. They are timed by arrival, the trail by exchange time: a batch that
 * arrives late lights the rail now and lands in the trail where it traded.
 *
 * The glass: with `glass` set, the trail is drawn off screen first and the candle's column shows it through frosted glass: a copy a sixth
 * the size, smoothed (a tent filter) and half snapped to coarse blocks (between a blur and a pixelation), bent a little toward the edges as
 * a thick pane bends what is behind it, and dimmed. Everywhere else the trail is copied to the screen as drawn. Done here rather than with
 * CSS `backdrop-filter`, which is costly over canvases (AGENTS.md "Words and look").
 *
 * Three looks over the same encoding: Phosphor (light emitted: added up where orders crowd on a dark page, a soft halo, a camera-flash star
 * on arrivals), Etched (crisp dots and rings, no glow, as if engraved), Beads (small lit spheres and rings with a fixed highlight). On a light
 * page nothing is added: light on white cannot be seen, so every look is drawn over.
 */
export interface FlashSprite { x: number; y: number; r: number; /** Bought USD over bought and sold. */ share: number; /** How lit, 1 to 0. */ k: number }

export interface TrailFrame {
  style: TrailStyle; dark: boolean;
  bid: [number, number, number]; ask: [number, number, number]; mid: [number, number, number];
  /** The exchange time at the trail's right edge (absolute ms) and how far back its left edge is. */
  now: number; windowMs: number;
  /** CSS px: the trail's left (oldest) and right (now) edges, and the plot's top and bottom with the prices there (`p1` at the top). */
  x0: number; x1: number; y0: number; y1: number; p0: number; p1: number;
  /** Orders this size (USD) and smaller are the smallest dot, `ceilUsd` and larger the largest. */
  floorUsd: number; ceilUsd: number;
  opacity: number;
  flashes: readonly FlashSprite[];
  /** The frosted candle's rectangle in CSS px, or null for none. */
  glass: { x0: number; y0: number; x1: number; y1: number } | null;
}

const STYLE_ID: Record<TrailStyle, number> = { phosphor: 0, etched: 1, beads: 2 };
/** The most orders drawn: the newest are kept when a window holds more (about 10 minutes of BTC's quietest hour, seconds of its busiest). */
const MAX_TRAIL = 1 << 16;
const MAX_FLASH = 64, FLASH_STRIDE = 5;
/** The frosted copy's scale (a sixth of the screen) and the pixelation's block (device px). */
const GLASS_DOWN = 6, GLASS_BLOCK = 7;

const FULL_VERT = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

/** The small copy: a 5 x 5 tent over the drawn trail around each of its pixels. */
const DOWN_FRAG = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D src; uniform vec2 small, texel; out vec4 color;
void main() {
  vec2 uv = gl_FragCoord.xy / small;
  vec4 acc = vec4(0.0); float sum = 0.0;
  for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
    float w = (3.0 - abs(float(x))) * (3.0 - abs(float(y)));
    acc += texture(src, uv + vec2(float(x), float(y)) * texel * 1.7) * w; sum += w;
  }
  color = acc / sum;
}`;

/** The screen: the trail as drawn, and inside the glass the frosted copy, bent toward the edges and a little dimmer. */
const COMP_FRAG = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D scene, small; uniform vec4 glass; uniform vec2 px; uniform float block, gain; out vec4 color;
void main() {
  vec2 f = gl_FragCoord.xy;
  if (f.x < glass.x || f.x > glass.z || f.y < glass.y || f.y > glass.w) { color = texelFetch(scene, ivec2(f), 0); return; }
  float w = glass.z - glass.x, q = (f.x - glass.x) / w - 0.5;
  // A thick pane: what is behind its edges is seen from a little further in, the middle almost straight.
  vec2 src = vec2(f.x - q * abs(q) * 0.28 * w, f.y);
  vec4 soft = texture(small, src / px);
  vec4 blocky = texture(small, (floor(src / block) + 0.5) * block / px);
  // Blurring spreads a dot's light over many pixels; the gain gives some of it back, so the trail glows through rather than vanishing.
  color = min(mix(soft, blocky, 0.38) * gain, vec4(1.0));
}`;

const TRAIL_VERT = `#version 300 es
layout(location = 0) in vec3 rec0; layout(location = 1) in vec3 rec1;
uniform float now, win; uniform vec2 xr, yr, pr, px; uniform vec4 size; uniform int style; uniform sampler2D mask;
out vec3 centre; out float usd, fade, fresh, reach; out vec2 span;
void main() {
  float age = now - rec0.x;
  bool hidden = texelFetch(mask, ivec2(int(rec1.x), 0), 0).r > 0.5;
  float x = xr.y - clamp(age / win, 0.0, 1.0) * (xr.y - xr.x);
  float y = yr.x + (pr.y - rec0.y) / (pr.y - pr.x) * (yr.y - yr.x);
  float ylo = yr.x + (pr.y - rec1.y) / (pr.y - pr.x) * (yr.y - yr.x), yhi = yr.x + (pr.y - rec1.z) / (pr.y - pr.x) * (yr.y - yr.x);
  float a = abs(rec0.z);
  float r = mix(size.x, size.y, clamp(log(max(a, 1.0) / size.z) / log(size.w / size.z), 0.0, 1.0));
  // A comet's tail: the last seconds bright, the rest of the window a quiet record that thins out to the left.
  float rel = clamp(age / win, 0.0, 1.0);
  fresh = exp(-max(age, 0.0) / 900.0);
  fade = mix(pow(1.0 - rel, 2.2) * 0.62, 1.0, fresh * 0.75);
  // A walk across the book is a hairline as far as a sprite reaches (48 device px either side), as the dust draws it.
  float walk = min(max(abs(ylo - y), abs(yhi - y)), 48.0);
  reach = max(style == 0 ? r * 3.2 : r + 1.5, walk + 1.0);
  centre = vec3(x, y, r); usd = rec0.z; span = vec2(min(ylo, yhi), max(ylo, yhi));
  bool off = hidden || age < -1500.0 || age > win || y < -reach || y > px.y + reach;
  gl_PointSize = 2.0 * reach;
  gl_Position = off ? vec4(2.0, 2.0, 2.0, 1.0) : vec4(x / px.x * 2.0 - 1.0, 1.0 - y / px.y * 2.0, 0.0, 1.0);
}`;

/** The shading both programs share: a disc, a ring and a lit sphere, at distance `d` from the centre of a sprite of radius `r`. */
const SHAPES = `
float disc(float d, float r) { return clamp(r + 0.5 - d, 0.0, 1.0); }
float ring(float d, float r, float w) { return clamp(1.0 - abs(d - r + w * 0.5) / (w * 0.5 + 0.5), 0.0, 1.0); }
// A lit bead: a sphere for a buy, a torus seen from above for a sell. Returns light (rgb factor) and coverage.
vec2 bead(vec2 q, float r, bool hollow, out float spec) {
  vec2 n = q / max(r, 0.6); float l = length(n); spec = 0.0;
  vec3 N; float cover;
  if (hollow) {
    float t = (l - 0.64) / 0.36; cover = clamp((1.0 - abs(t)) * r * 0.36 + 0.5, 0.0, 1.0);
    if (cover <= 0.0) return vec2(0.0);
    vec2 dir = l > 0.0 ? n / l : vec2(0.0); N = normalize(vec3(dir * t, sqrt(max(0.0, 1.0 - t * t))));
  } else {
    cover = clamp((1.0 - l) * r + 0.5, 0.0, 1.0);
    if (cover <= 0.0) return vec2(0.0);
    N = normalize(vec3(n, sqrt(max(0.0, 1.0 - l * l))));
  }
  vec3 L = normalize(vec3(-0.45, -0.62, 0.65));
  float diffuse = 0.38 + 0.62 * max(dot(N, L), 0.0);
  spec = pow(max(dot(reflect(-L, N), vec3(0.0, 0.0, 1.0)), 0.0), 22.0);
  return vec2(diffuse, cover);
}`;

const TRAIL_FRAG = `#version 300 es
precision highp float; precision highp int;
in vec3 centre; in float usd, fade, fresh, reach; in vec2 span; out vec4 color;
uniform int style; uniform bool dark; uniform vec3 bidC, askC; uniform float opacity;
${SHAPES}
void main() {
  vec2 pix = centre.xy + (gl_PointCoord - 0.5) * 2.0 * reach;
  vec2 q = pix - centre.xy; float d = length(q), r = centre.z;
  bool sell = usd < 0.0; vec3 c = sell ? askC : bidC;
  float stalk = (span.y - span.x > 1.5 && abs(q.x) < 0.6 && pix.y >= span.x && pix.y <= span.y) ? 0.45 : 0.0;
  float a; vec3 rgb;
  if (style == 0) {
    float core = disc(d, r);
    if (sell) core *= clamp(d - r * 0.45 + 0.5, 0.0, 1.0);
    // On a light page there is no light to add: a crisp core with a darker rim, and only a breath of halo.
    float halo = dark ? exp(-(d * d) / (r * r * 2.8)) * 0.42 : exp(-(d * d) / (r * r * 1.6)) * 0.05;
    float rim = dark ? 0.0 : ring(d, r + 0.4, 1.0) * 0.55;
    a = max(max(core * 0.95, rim) + halo, stalk) * fade * opacity;
    rgb = dark ? mix(c, vec3(1.0), 0.5 * fresh * core) : mix(c, vec3(0.0), 0.12 * core + 0.35 * rim);
  } else if (style == 1) {
    float shape = sell ? ring(d, r + 0.4, 1.1) : disc(d, r);
    a = max(shape, stalk) * fade * opacity;
    rgb = c;
  } else {
    float spec; vec2 lit = bead(q, r + 0.3, sell, spec);
    a = max(lit.y, stalk) * fade * opacity;
    rgb = lit.y > 0.0 ? c * lit.x + vec3(spec * (0.45 + 0.55 * fresh)) : c;
  }
  if (a <= 0.003) discard;
  color = vec4(rgb * a, a);
}`;

const FLASH_VERT = `#version 300 es
layout(location = 0) in vec3 f0; layout(location = 1) in vec2 f1;
uniform vec2 px; uniform int style;
out vec3 centre; out float share, k, reach;
void main() {
  float r = f0.z; k = f1.y; share = f1.x;
  reach = style == 0 ? r * 5.0 : r + 3.0;
  centre = f0;
  gl_PointSize = 2.0 * reach;
  gl_Position = vec4(f0.x / px.x * 2.0 - 1.0, 1.0 - f0.y / px.y * 2.0, 0.0, 1.0);
}`;

const FLASH_FRAG = `#version 300 es
precision highp float; precision highp int;
in vec3 centre; in float share, k, reach; out vec4 color;
uniform int style; uniform bool dark; uniform vec3 bidC, askC, mid;
${SHAPES}
void main() {
  vec2 pix = centre.xy + (gl_PointCoord - 0.5) * 2.0 * reach;
  vec2 q = pix - centre.xy; float d = length(q), r = centre.z;
  float lean = abs(2.0 * share - 1.0); bool sell = share < 0.5;
  vec3 c = mix(mid, sell ? askC : bidC, 0.35 + 0.65 * lean);
  float a; vec3 rgb;
  if (style == 0) {
    // A flashbulb: a white-hot core cooling to the side's colour, a bloom, a faint lens ring and a four-point star, all fading together.
    float core = disc(d, r); if (sell) core *= clamp(d - r * 0.4 + 0.5, 0.0, 1.0);
    float bloom = exp(-(d * d) / (r * r * 5.0));
    float lens = exp(-pow((d - r * 2.7) / 1.1, 2.0)) * 0.22;
    float star = (exp(-abs(q.x) / 0.9) * exp(-abs(q.y) / (r * 1.9)) + exp(-abs(q.y) / 0.9) * exp(-abs(q.x) / (r * 1.9))) * 0.5;
    float light = core + (bloom * 0.7 + lens + star) * (dark ? 1.0 : 0.45);
    a = clamp(light * k, 0.0, 1.0);
    rgb = dark ? mix(c, vec3(1.0), clamp(0.85 * k * core + 0.25 * bloom * k, 0.0, 1.0)) : mix(c, vec3(0.0), 0.15 * core);
  } else if (style == 1) {
    // An engraved mark: a crisp ring, the dominant side's dot inside it for a buy, both fading; no glow.
    float shape = max(ring(d, r + 1.2, 1.3), sell ? 0.0 : disc(d, r * 0.62));
    a = shape * k;
    rgb = c;
  } else {
    // A bead catching the light: its highlight and a rim light fade back to the trail's bead.
    float spec; vec2 lit = bead(q, r, sell, spec);
    float rim = ring(d, r + 1.6, 1.0) * 0.6;
    a = max(lit.y, rim) * k;
    rgb = lit.y > 0.0 ? c * lit.x + vec3(spec * (0.6 + 0.4 * k)) : mix(c, vec3(1.0), dark ? 0.4 : 0.0);
  }
  if (a <= 0.003) discard;
  color = vec4(rgb * a, a);
}`;

export class TrailGL {
  readonly gl: WebGL2RenderingContext;
  #trail: WebGLProgram; #flash: WebGLProgram;
  #trailVao: WebGLVertexArrayObject; #trailBuf: WebGLBuffer;
  #flashVao: WebGLVertexArrayObject; #flashBuf: WebGLBuffer;
  #mask: WebGLTexture; #maskKey = '';
  #down: WebGLProgram; #comp: WebGLProgram;
  /** The trail drawn off screen, and its small copy, for the glass. */
  #scene: WebGLTexture; #sceneFbo: WebGLFramebuffer; #small: WebGLTexture; #smallFbo: WebGLFramebuffer; #smallSize: [number, number] = [1, 1];
  #loc = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  readonly #scratch = new Float32Array(MAX_TRAIL * STRIDE);
  readonly #flashData = new Float32Array(MAX_FLASH * FLASH_STRIDE);
  #dpr = 1;

  constructor(readonly canvas: HTMLCanvasElement, readonly ring: TapeRing) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    const compile = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type)!; gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader');
      return shader;
    };
    const program = (vert: string, frag: string, names: string[]): WebGLProgram => {
      const p = gl.createProgram()!; gl.attachShader(p, compile(gl.VERTEX_SHADER, vert)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, frag)); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'program');
      this.#loc.set(p, new Map(names.map(n => [n, gl.getUniformLocation(p, n)])));
      return p;
    };
    this.#trail = program(TRAIL_VERT, TRAIL_FRAG, ['now', 'win', 'xr', 'yr', 'pr', 'px', 'size', 'style', 'mask', 'dark', 'bidC', 'askC', 'opacity']);
    this.#flash = program(FLASH_VERT, FLASH_FRAG, ['px', 'style', 'dark', 'bidC', 'askC', 'mid']);
    this.#down = program(FULL_VERT, DOWN_FRAG, ['src', 'small', 'texel']);
    this.#comp = program(FULL_VERT, COMP_FRAG, ['scene', 'small', 'glass', 'px', 'block', 'gain']);
    const texture = (): WebGLTexture => {
      const tex = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      return tex;
    };
    this.#scene = texture(); this.#small = texture();
    const fbo = (tex: WebGLTexture): WebGLFramebuffer => { const f = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0); gl.bindFramebuffer(gl.FRAMEBUFFER, null); return f; };
    this.#sceneFbo = fbo(this.#scene); this.#smallFbo = fbo(this.#small);
    this.#trailBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#trailBuf); gl.bufferData(gl.ARRAY_BUFFER, this.#scratch.byteLength, gl.DYNAMIC_DRAW);
    this.#trailVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.#trailVao);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE * 4, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, STRIDE * 4, 12);
    this.#flashBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#flashBuf); gl.bufferData(gl.ARRAY_BUFFER, this.#flashData.byteLength, gl.DYNAMIC_DRAW);
    this.#flashVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.#flashVao);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, FLASH_STRIDE * 4, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, FLASH_STRIDE * 4, 12);
    gl.bindVertexArray(null);
    this.#mask = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.#mask);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.setMask([]);
  }

  /** Size the canvas: CSS px times the pixel ratio (the pane caps it, a glow gains nothing from a phone's third device pixel). */
  resize(width: number, height: number, dpr: number): void {
    const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr));
    this.#dpr = dpr;
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w; this.canvas.height = h; this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`;
    const gl = this.gl, sw = Math.max(1, Math.ceil(w / GLASS_DOWN)), sh = Math.max(1, Math.ceil(h / GLASS_DOWN));
    gl.bindTexture(gl.TEXTURE_2D, this.#scene); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, this.#small); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, sw, sh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.#smallSize = [sw, sh];
  }

  /** The ring's markets not drawn (outside the view's markets), by the ring's index. */
  setMask(hidden: readonly number[]): void {
    const key = hidden.join(',') || '-'; if (key === this.#maskKey) return;
    this.#maskKey = key;
    const gl = this.gl, row = new Uint8Array(1024); for (const k of hidden) if (k >= 0 && k < 1024) row[k] = 255;
    gl.bindTexture(gl.TEXTURE_2D, this.#mask); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1024, 1, 0, gl.RED, gl.UNSIGNED_BYTE, row);
  }

  /** Copy the orders timed in [from, to] (absolute ms) into the buffer, the newest kept when there are more than it holds. Returns how many. */
  #gather(from: number, to: number): number {
    const ring = this.ring, runs = ring.runs(from, to);
    let room = MAX_TRAIL, n = 0;
    const pieces: [number, number][] = [];
    for (let i = runs.length - 1; i >= 0 && room > 0; i--) { const [a, b] = runs[i]!, start = Math.max(a, b - room); pieces.unshift([start, b]); room -= b - start; }
    for (const [a, b] of pieces) {
      let k = a;
      while (k < b) {
        const slot = k % ring.capacity, len = Math.min(b - k, ring.capacity - slot);
        this.#scratch.set(ring.data.subarray(slot * STRIDE, (slot + len) * STRIDE), n * STRIDE);
        n += len; k += len;
      }
    }
    return n;
  }

  draw(f: TrailFrame): void {
    const gl = this.gl, ring = this.ring, dpr = this.#dpr, W = this.canvas.width, H = this.canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    if (!(f.p1 > f.p0) || !(f.windowMs > 0)) return;
    // With glass the trail is drawn off screen, then copied out with the glass's part frosted (`#composite`).
    if (f.glass) { gl.bindFramebuffer(gl.FRAMEBUFFER, this.#sceneFbo); gl.clear(gl.COLOR_BUFFER_BIT); }
    const style = STYLE_ID[f.style], additive = f.dark && f.style === 'phosphor';
    gl.enable(gl.BLEND);
    // Premultiplied colour throughout: light added up where orders crowd (Phosphor on a dark page), otherwise drawn over.
    if (additive) gl.blendFunc(gl.ONE, gl.ONE); else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const n = ring.written > 0 ? this.#gather(f.now - f.windowMs - 1_000, f.now + 2_000) : 0;
    if (n > 0) {
      const l = this.#loc.get(this.#trail)!;
      gl.useProgram(this.#trail);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.#trailBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.#scratch, 0, n * STRIDE);
      // Relative to the ring's bases, in float64 here, so the card never sees an epoch millisecond or a full price.
      gl.uniform1f(l.get('now')!, f.now - ring.t0); gl.uniform1f(l.get('win')!, f.windowMs);
      gl.uniform2f(l.get('xr')!, f.x0 * dpr, f.x1 * dpr); gl.uniform2f(l.get('yr')!, f.y0 * dpr, f.y1 * dpr);
      gl.uniform2f(l.get('pr')!, f.p0 - ring.p0, f.p1 - ring.p0); gl.uniform2f(l.get('px')!, W, H);
      gl.uniform4f(l.get('size')!, 0.9 * dpr, 4 * dpr, f.floorUsd, f.ceilUsd);
      gl.uniform1i(l.get('style')!, style); gl.uniform1i(l.get('dark')!, f.dark ? 1 : 0);
      gl.uniform3fv(l.get('bidC')!, f.bid); gl.uniform3fv(l.get('askC')!, f.ask); gl.uniform1f(l.get('opacity')!, f.opacity);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.#mask); gl.uniform1i(l.get('mask')!, 0);
      gl.bindVertexArray(this.#trailVao); gl.drawArrays(gl.POINTS, 0, n); gl.bindVertexArray(null);
    }
    const flashes = f.flashes.slice(0, MAX_FLASH);
    if (flashes.length) {
      flashes.forEach((s, i) => { const at = i * FLASH_STRIDE; this.#flashData[at] = s.x * dpr; this.#flashData[at + 1] = s.y * dpr; this.#flashData[at + 2] = s.r * dpr; this.#flashData[at + 3] = s.share; this.#flashData[at + 4] = s.k; });
      const l = this.#loc.get(this.#flash)!;
      gl.useProgram(this.#flash);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.#flashBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.#flashData, 0, flashes.length * FLASH_STRIDE);
      gl.uniform2f(l.get('px')!, W, H); gl.uniform1i(l.get('style')!, style); gl.uniform1i(l.get('dark')!, f.dark ? 1 : 0);
      gl.uniform3fv(l.get('bidC')!, f.bid); gl.uniform3fv(l.get('askC')!, f.ask); gl.uniform3fv(l.get('mid')!, f.mid);
      gl.bindVertexArray(this.#flashVao); gl.drawArrays(gl.POINTS, 0, flashes.length); gl.bindVertexArray(null);
    }
    if (f.glass) this.#composite(f.glass, f.dark);
  }

  /** Copy the off-screen trail to the screen, the glass's rectangle (CSS px, top-down) frosted from the small copy. */
  #composite(glass: NonNullable<TrailFrame['glass']>, dark: boolean): void {
    const gl = this.gl, dpr = this.#dpr, W = this.canvas.width, H = this.canvas.height, [sw, sh] = this.#smallSize;
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#smallFbo); gl.viewport(0, 0, sw, sh);
    const d = this.#loc.get(this.#down)!;
    gl.useProgram(this.#down);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.#scene); gl.uniform1i(d.get('src')!, 0);
    gl.uniform2f(d.get('small')!, sw, sh); gl.uniform2f(d.get('texel')!, 1 / W, 1 / H);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
    const c = this.#loc.get(this.#comp)!;
    gl.useProgram(this.#comp);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.#scene); gl.uniform1i(c.get('scene')!, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.#small); gl.uniform1i(c.get('small')!, 1);
    // The card's rows run bottom-up: the rectangle's top is the larger y there.
    gl.uniform4f(c.get('glass')!, glass.x0 * dpr, H - glass.y1 * dpr, glass.x1 * dpr, H - glass.y0 * dpr);
    gl.uniform2f(c.get('px')!, W, H); gl.uniform1f(c.get('block')!, GLASS_BLOCK); gl.uniform1f(c.get('gain')!, dark ? 3.2 : 2.4);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }

  clear(): void { const gl = this.gl; gl.viewport(0, 0, this.canvas.width, this.canvas.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
}
