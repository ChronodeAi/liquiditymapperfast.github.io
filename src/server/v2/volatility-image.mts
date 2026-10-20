/**
 * The image the SubQ image arm sends with each minute (docs/volatility-watch.md, "Side by side"): the last two hours of resting liquidity around
 * the price, drawn like the page's heatmap (bids green, asks red, brightness by size on a log scale) with the price as a white line. PNG,
 * encoded here with node:zlib so the server needs no image library.
 */
import zlib from 'node:zlib';
import { HEAT_MINUTES, HEAT_ROWS, type VolatilityInputs } from '../../shared/volatility/features.ts';

/** Pixels per minute column and per price row. */
const SCALE = 4;

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** RGB pixels, row-major from the top, to a PNG. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) { raw[y * (width * 3 + 1)] = 0; raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** The heatmap of `heat` as a PNG, or null when it holds no liquidity. */
export function heatPng(heat: NonNullable<VolatilityInputs['heat']>, rowBp: number): Buffer | null {
  let max = 0;
  for (let i = 0; i < heat.bid.length; i++) max = Math.max(max, heat.bid[i]!, heat.ask[i]!);
  if (!(max > 0)) return null;
  const width = HEAT_MINUTES * SCALE, height = HEAT_ROWS * SCALE, rgb = new Uint8Array(width * height * 3);
  // Brightness over three decades below the largest cell, so walls stand out from the ordinary book.
  const level = (usd: number): number => usd > 0 ? Math.round(255 * Math.max(0, 1 + Math.log10(usd / max) / 3)) : 0;
  for (let c = 0; c < HEAT_MINUTES; c++) for (let r = 0; r < HEAT_ROWS; r++) {
    const g = level(heat.bid[c * HEAT_ROWS + r]!), red = level(heat.ask[c * HEAT_ROWS + r]!);
    for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) {
      const y = (HEAT_ROWS - 1 - r) * SCALE + dy, x = c * SCALE + dx, o = (y * width + x) * 3;
      rgb[o] = red; rgb[o + 1] = g; rgb[o + 2] = Math.round(Math.min(red, g) / 2);
    }
  }
  let mid = 0; for (const p of heat.price) if (p > 0) mid = p;
  if (mid > 0) for (let c = 0; c < HEAT_MINUTES; c++) {
    const p = heat.price[c]!; if (!(p > 0)) continue;
    const rowF = (p / mid - 1) * 1e4 / rowBp + HEAT_ROWS / 2, y = Math.round((HEAT_ROWS - rowF) * SCALE);
    if (y < 1 || y >= height - 1) continue;
    for (let dx = 0; dx < SCALE; dx++) for (const yy of [y - 1, y]) { const o = (yy * width + c * SCALE + dx) * 3; rgb[o] = rgb[o + 1] = rgb[o + 2] = 255; }
  }
  return encodePng(width, height, rgb);
}
