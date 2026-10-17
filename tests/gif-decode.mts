/**
 * A small GIF decoder for the tests: it reads what `screenshot/gif-encoder.ts` writes (and any ordinary GIF) back into whole frames, so
 * a test can compare them with what went in.
 */

export interface DecodedFrame {
  /** The whole picture after this frame is laid down, as RGBA. */
  rgba: Uint8ClampedArray;
  x: number; y: number; w: number; h: number;
  /** The frame's own indices, as LZW gave them back. */
  indices: Uint8Array;
  delayCs: number; disposal: number; transparent: number | null;
  local: boolean;
  /** How many entries the colour table the frame is drawn with has. */
  tableSize: number;
}
export interface DecodedGif { width: number; height: number; globalColors: number; loops: number | null; frames: DecodedFrame[] }

/** LZW-decode one image's indices from its sub-blocks. */
export function lzwDecode(data: Uint8Array, minCodeSize: number, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels);
  const clear = 1 << minCodeSize, eoi = clear + 1;
  const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096), length = new Int32Array(4096);
  for (let i = 0; i < clear; i++) { prefix[i] = -1; suffix[i] = i; first[i] = i; length[i] = 1; }
  let size = minCodeSize + 1, mask = (1 << size) - 1, avail = clear + 2, old = -1, n = 0;
  let acc = 0, bits = 0, pos = 0;
  const write = (code: number): void => {
    const len = length[code]!; let at = n + len - 1, c = code;
    while (c >= 0) { if (at < pixels) out[at] = suffix[c]!; at--; c = prefix[c]!; }
    n += len;
  };
  while (pos < data.length || bits >= size) {
    while (bits < size && pos < data.length) { acc |= data[pos++]! << bits; bits += 8; }
    if (bits < size) break;
    const code = acc & mask; acc >>>= size; bits -= size;
    if (code === clear) { size = minCodeSize + 1; mask = (1 << size) - 1; avail = clear + 2; old = -1; continue; }
    if (code === eoi) break;
    if (old === -1) { if (code >= clear) throw new Error(`bad first LZW code ${code}`); write(code); old = code; continue; }
    if (code > avail || (code === avail && avail >= 4096)) throw new Error(`bad LZW code ${code} (next free ${avail})`);
    // A code not made yet (the string before it plus its own first byte) is made first, then written.
    const known = code < avail;
    if (known) write(code);
    if (avail < 4096) {
      prefix[avail] = old; suffix[avail] = known ? first[code]! : first[old]!; first[avail] = first[old]!; length[avail] = length[old]! + 1;
      avail++;
      if (avail === mask + 1 && size < 12) { size++; mask = (1 << size) - 1; }
    }
    if (!known) write(code);
    old = code;
  }
  if (n < pixels) throw new Error(`LZW ended after ${n} of ${pixels} pixels`);
  return out;
}

export function decodeGif(bytes: Uint8Array): DecodedGif {
  let p = 0;
  const u8 = (): number => bytes[p++]!;
  const u16 = (): number => { const v = bytes[p]! | (bytes[p + 1]! << 8); p += 2; return v; };
  const sig = String.fromCharCode(...bytes.subarray(0, 6)); p = 6;
  if (sig !== 'GIF89a' && sig !== 'GIF87a') throw new Error(`not a GIF: ${sig}`);
  const width = u16(), height = u16(), packed = u8(); u8(); u8();
  let global: Uint8Array | null = null, globalColors = 0;
  if (packed & 0x80) { globalColors = 1 << ((packed & 7) + 1); global = bytes.subarray(p, p + globalColors * 3); p += globalColors * 3; }
  const canvas = new Uint8ClampedArray(width * height * 4);
  const frames: DecodedFrame[] = [];
  let loops: number | null = null, delayCs = 0, disposal = 0, transparent: number | null = null;
  const subBlocks = (): Uint8Array => {
    const parts: Uint8Array[] = []; let total = 0;
    for (let len = u8(); len > 0; len = u8()) { parts.push(bytes.subarray(p, p + len)); total += len; p += len; }
    const all = new Uint8Array(total); let at = 0; for (const part of parts) { all.set(part, at); at += part.length; }
    return all;
  };
  for (;;) {
    if (p >= bytes.length) throw new Error('the file ends without a trailer');
    const block = u8();
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = u8();
      if (label === 0xf9) { u8(); const f = u8(); delayCs = u16(); const t = u8(); u8(); disposal = (f >> 2) & 7; transparent = f & 1 ? t : null; }
      else if (label === 0xff) { const len = u8(); const id = String.fromCharCode(...bytes.subarray(p, p + len)); p += len; const data = subBlocks(); if (id === 'NETSCAPE2.0' && data[0] === 1) loops = data[1]! | (data[2]! << 8); }
      else subBlocks();
      continue;
    }
    if (block !== 0x2c) throw new Error(`unknown block 0x${block.toString(16)} at ${p - 1}`);
    const x = u16(), y = u16(), w = u16(), h = u16(), ip = u8();
    let table = global, local = false, tableSize = globalColors;
    if (ip & 0x80) { const n = 1 << ((ip & 7) + 1); table = bytes.subarray(p, p + n * 3); p += n * 3; local = true; tableSize = n; }
    if (ip & 0x40) throw new Error('interlaced frames are not written by the encoder');
    if (!table) throw new Error('a frame without colours');
    const min = u8();
    const indices = lzwDecode(subBlocks(), min, w * h);
    const before = disposal === 3 ? canvas.slice() : null;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const k = indices[j * w + i]!; if (k === transparent) continue;
      const px = x + i, py = y + j; if (px >= width || py >= height) continue;
      const o = (py * width + px) * 4; canvas[o] = table[k * 3]!; canvas[o + 1] = table[k * 3 + 1]!; canvas[o + 2] = table[k * 3 + 2]!; canvas[o + 3] = 255;
    }
    frames.push({ rgba: canvas.slice(), x, y, w, h, indices, delayCs, disposal, transparent, local, tableSize });
    if (disposal === 2) for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const o = ((y + j) * width + x + i) * 4; canvas[o] = canvas[o + 1] = canvas[o + 2] = canvas[o + 3] = 0; }
    else if (disposal === 3 && before) canvas.set(before);
    delayCs = 0; disposal = 0; transparent = null;
  }
  return { width, height, globalColors, loops, frames };
}
