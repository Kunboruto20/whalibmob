'use strict';

// BMP → RGBA.
//
// Uncompressed only, which is all but every BMP in the wild: 1/4/8-bit through
// the palette, and 16/24/32-bit direct. Rows are padded to four bytes and are
// stored bottom-up unless the height is negative.

function isBmp(buf) {
  return Buffer.isBuffer(buf) && buf.length > 26 && buf[0] === 0x42 && buf[1] === 0x4d;
}

function decodeBmp(buf) {
  if (!isBmp(buf)) return null;

  const dataOffset = buf.readUInt32LE(10);
  const headerSize = buf.readUInt32LE(14);
  if (headerSize < 12) return null;

  let width, height, bpp, compression = 0, paletteCount = 0;
  if (headerSize === 12) {                       // BITMAPCOREHEADER
    width  = buf.readInt16LE(18);
    height = buf.readInt16LE(20);
    bpp    = buf.readUInt16LE(24);
  } else {
    width  = buf.readInt32LE(18);
    height = buf.readInt32LE(22);
    bpp    = buf.readUInt16LE(28);
    compression  = buf.readUInt32LE(30);
    paletteCount = buf.readUInt32LE(46);
  }

  const bottomUp = height > 0;
  height = Math.abs(height);
  if (!width || !height || width < 0) return null;
  if (compression !== 0 && compression !== 3) return null;   // RLE, JPEG, PNG
  if (![1, 4, 8, 16, 24, 32].includes(bpp)) return null;

  // The palette sits between the header and the pixel data.
  const paletteStart = 14 + headerSize;
  const entrySize    = headerSize === 12 ? 3 : 4;
  if (!paletteCount && bpp <= 8) paletteCount = 1 << bpp;

  const rowBytes = Math.floor((width * bpp + 31) / 32) * 4;
  if (dataOffset + rowBytes * height > buf.length) return null;

  const out = Buffer.alloc(width * height * 4, 0xff);

  for (let y = 0; y < height; y++) {
    const srcRow = dataOffset + (bottomUp ? (height - 1 - y) : y) * rowBytes;
    for (let x = 0; x < width; x++) {
      let r, g, b, a = 255;

      if (bpp <= 8) {
        const perByte = 8 / bpp;
        const byte    = buf[srcRow + Math.floor(x / perByte)];
        const shift   = 8 - bpp * ((x % perByte) + 1);
        const idx     = (byte >> shift) & ((1 << bpp) - 1);
        const p       = paletteStart + idx * entrySize;
        if (idx >= paletteCount || p + 2 >= buf.length) { r = g = b = 0; }
        else { b = buf[p]; g = buf[p + 1]; r = buf[p + 2]; }
      } else if (bpp === 16) {
        // 5-5-5 with the top bit unused, widened back out to eight bits each.
        const v = buf.readUInt16LE(srcRow + x * 2);
        r = ((v >> 10) & 31) * 255 / 31;
        g = ((v >> 5)  & 31) * 255 / 31;
        b = (v & 31)         * 255 / 31;
        r = Math.round(r); g = Math.round(g); b = Math.round(b);
      } else {
        const p = srcRow + x * (bpp / 8);
        b = buf[p]; g = buf[p + 1]; r = buf[p + 2];
        if (bpp === 32) {
          const alpha = buf[p + 3];
          // A 32-bit BMP often leaves the fourth byte at zero rather than
          // meaning fully transparent; treat an all-zero channel as opaque.
          a = alpha;
        }
      }

      const o = (y * width + x) * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
  }

  if (bpp === 32) {
    let anyAlpha = false;
    for (let i = 3; i < out.length; i += 4) if (out[i] !== 0) { anyAlpha = true; break; }
    if (!anyAlpha) for (let i = 3; i < out.length; i += 4) out[i] = 255;
  }

  return { width, height, data: out };
}

module.exports = { isBmp, decodeBmp };
