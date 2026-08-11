'use strict';

// BMP → RGBA.
//
// Uncompressed only, which is all but every BMP in the wild: 1/4/8-bit through
// the palette, and 16/24/32-bit direct. Rows are padded to four bytes and are
// stored bottom-up unless the height is negative.

function isBmp(buf) {
  return Buffer.isBuffer(buf) && buf.length > 26 && buf[0] === 0x42 && buf[1] === 0x4d;
}

// One channel out of a packed pixel. A mask says where the channel sits and how
// wide it is, and the width varies — 5-6-5 and 5-5-5 are both ordinary — so the
// value is scaled by its own maximum rather than shifted by a fixed amount.
//
// Both scans below stop at 32 on their own, because a shift count in JS is
// taken mod 32: `bits >>> 32` is `bits >>> 0`, so a mask of all ones sends an
// unbounded scan back to bit 0 and it never comes out. Nothing upstream could
// catch that — decodeImage's try/catch cannot interrupt a loop that does not
// end, and a thumbnail is built on the way to sending an ordinary image, so
// one crafted BMP would take the whole process down with it.
function maskChannel(v, mask) {
  if (!mask) return 0;
  let shift = 0;
  while (shift < 32 && !((mask >>> shift) & 1)) shift++;
  if (shift === 32) return 0;                    // no bit set — nothing to read
  const bits = (mask >>> shift) >>> 0;
  let width = 0;
  while (width < 32 && ((bits >>> width) & 1)) width++;
  // The obvious `(1 << width) - 1` is wrong at both ends of that range: `1 <<
  // 32` is 1, and `1 << 31` is negative, so a 31- or 32-bit channel would be
  // scaled by zero or by a negative maximum. Build the maximum unsigned, and
  // read the value back unsigned too — `& 0xffffffff` alone yields an int32.
  const max = width >= 32 ? 0xffffffff : ((1 << width) >>> 0) - 1;
  return Math.round((((v >>> shift) & max) >>> 0) * 255 / max);
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

  // BITFIELDS gives up the fixed channel layout and states the masks instead.
  // They follow a 40-byte header, and a V4/V5 header holds them at that same
  // place, so one offset covers both; the fourth mask is only there from V4 on.
  let masks = null;
  if (compression === 3 && (bpp === 16 || bpp === 32)) {
    const m = 14 + 40;
    if (m + 12 > buf.length) return null;
    masks = {
      r: buf.readUInt32LE(m),
      g: buf.readUInt32LE(m + 4),
      b: buf.readUInt32LE(m + 8),
      a: (headerSize >= 56 && m + 16 <= buf.length) ? buf.readUInt32LE(m + 12) : 0
    };
    if (!masks.r && !masks.g && !masks.b) masks = null;   // nothing usable stated
  }

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
        const v = buf.readUInt16LE(srcRow + x * 2);
        if (masks) {
          r = maskChannel(v, masks.r);
          g = maskChannel(v, masks.g);
          b = maskChannel(v, masks.b);
          if (masks.a) a = maskChannel(v, masks.a);
        } else {
          // 5-5-5 with the top bit unused, widened back out to eight bits each.
          r = ((v >> 10) & 31) * 255 / 31;
          g = ((v >> 5)  & 31) * 255 / 31;
          b = (v & 31)         * 255 / 31;
          r = Math.round(r); g = Math.round(g); b = Math.round(b);
        }
      } else {
        const p = srcRow + x * (bpp / 8);
        if (bpp === 32 && masks) {
          const v = buf.readUInt32LE(p);
          r = maskChannel(v, masks.r);
          g = maskChannel(v, masks.g);
          b = maskChannel(v, masks.b);
          // With no fourth mask the last byte is whatever the writer left
          // there, which is the same position the plain layout reads.
          a = masks.a ? maskChannel(v, masks.a) : buf[p + 3];
        } else {
          b = buf[p]; g = buf[p + 1]; r = buf[p + 2];
          if (bpp === 32) {
            const alpha = buf[p + 3];
            // A 32-bit BMP often leaves the fourth byte at zero rather than
            // meaning fully transparent; treat an all-zero channel as opaque.
            a = alpha;
          }
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
