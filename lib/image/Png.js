'use strict';

// PNG → RGBA, with no dependency beyond node's own zlib.
//
// Everything a PNG needs is either in the standard library or a few lines of
// arithmetic: the pixel data is one zlib stream, and the only real work is
// undoing the per-row filter and widening whatever bit depth and colour type
// the file happens to use into plain 8-bit RGBA.
//
// Adam7 interlacing is the one thing left out; it is rare outside of the web
// and the caller has other ways to read the file.

const zlib = require('zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Colour type → samples per pixel.
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 8 && buf.slice(0, 8).equals(SIGNATURE);
}

/**
 * Decode a PNG.
 *
 * Returns { width, height, data } with data as RGBA bytes, or null when the
 * file is not a PNG this can read.
 */
function decodePng(buf) {
  if (!isPng(buf)) return null;

  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  let palette = null, transparency = null;
  const idat = [];

  let off = 8;
  while (off + 8 <= buf.length) {
    const len  = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('latin1');
    const body = off + 8;
    if (body + len + 4 > buf.length) break;

    if (type === 'IHDR') {
      if (len < 13) return null;
      width     = buf.readUInt32BE(body);
      height    = buf.readUInt32BE(body + 4);
      depth     = buf[body + 8];
      colorType = buf[body + 9];
      interlace = buf[body + 12];
    } else if (type === 'PLTE') {
      palette = buf.slice(body, body + len);
    } else if (type === 'tRNS') {
      transparency = buf.slice(body, body + len);
    } else if (type === 'IDAT') {
      idat.push(buf.slice(body, body + len));
    } else if (type === 'IEND') {
      break;
    }

    off = body + len + 4;   // skip the chunk's CRC too
  }

  if (!width || !height || !idat.length) return null;
  if (interlace !== 0) return null;                    // Adam7, not handled
  if (CHANNELS[colorType] === undefined) return null;
  if (![1, 2, 4, 8, 16].includes(depth)) return null;
  if (colorType === 3 && !palette) return null;
  // Only a palette may use a depth below 8 for colour; the spec limits the rest.
  if (depth < 8 && colorType !== 0 && colorType !== 3) return null;

  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); }
  catch (_) { return null; }

  const channels  = CHANNELS[colorType];
  const bitsPerPx = channels * depth;
  const rowBytes  = Math.ceil(width * bitsPerPx / 8);
  // Filters work on whole bytes, on the pixel one full pixel back — which is
  // one byte when a pixel is narrower than that.
  const step      = Math.max(1, Math.ceil(bitsPerPx / 8));

  if (raw.length < height * (rowBytes + 1)) return null;

  const lines = unfilter(raw, width, height, rowBytes, step);
  if (!lines) return null;

  return {
    width,
    height,
    data: toRgba(lines, width, height, depth, colorType, channels, palette, transparency)
  };
}

// Undo the five per-row filters, in place, one scanline at a time. Each row is
// prefixed with its filter number and predicted from the row above.
function unfilter(raw, width, height, rowBytes, step) {
  const out  = Buffer.allocUnsafe(height * rowBytes);
  let prev   = Buffer.alloc(rowBytes);      // the row above row 0 is all zero
  let src    = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const line   = out.slice(y * rowBytes, (y + 1) * rowBytes);
    raw.copy(line, 0, src, src + rowBytes);
    src += rowBytes;

    switch (filter) {
      case 0: break;                                            // none
      case 1:                                                   // sub
        for (let i = step; i < rowBytes; i++) line[i] = (line[i] + line[i - step]) & 0xff;
        break;
      case 2:                                                   // up
        for (let i = 0; i < rowBytes; i++) line[i] = (line[i] + prev[i]) & 0xff;
        break;
      case 3:                                                   // average
        for (let i = 0; i < rowBytes; i++) {
          const left = i >= step ? line[i - step] : 0;
          line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff;
        }
        break;
      case 4:                                                   // paeth
        for (let i = 0; i < rowBytes; i++) {
          const a = i >= step ? line[i - step] : 0;
          const b = prev[i];
          const c = i >= step ? prev[i - step] : 0;
          line[i] = (line[i] + paeth(a, b, c)) & 0xff;
        }
        break;
      default:
        return null;
    }
    prev = line;
  }
  return out;
}

// Of the three neighbours, the one closest to their linear prediction.
function paeth(a, b, c) {
  const p  = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function toRgba(lines, width, height, depth, colorType, channels, palette, transparency) {
  const out      = Buffer.alloc(width * height * 4, 0xff);
  const bitsPerPx = channels * depth;
  const rowBytes  = Math.ceil(width * bitsPerPx / 8);
  // 1/2/4-bit samples are scaled so that the largest value stays white.
  const scale     = depth < 8 ? 255 / ((1 << depth) - 1) : 1;

  for (let y = 0; y < height; y++) {
    const row = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const s = sampler(lines, row, x, channels, depth);
      let r, g, b, a = 255;

      if (colorType === 3) {
        const idx = s(0);
        const p   = idx * 3;
        if (palette && p + 2 < palette.length) {
          r = palette[p]; g = palette[p + 1]; b = palette[p + 2];
        } else {
          r = g = b = 0;
        }
        if (transparency && idx < transparency.length) a = transparency[idx];
      } else if (colorType === 0 || colorType === 4) {
        r = g = b = Math.round(s(0) * scale);
        if (colorType === 4) a = s(1);
      } else {
        r = s(0); g = s(1); b = s(2);
        if (colorType === 6) a = s(3);
      }

      const o = (y * width + x) * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
  }
  return out;
}

// Reads sample `c` of pixel `x`, whatever the bit depth, already narrowed to a
// byte. 16-bit samples keep only the high byte, which is all an 8-bit RGBA
// buffer can hold anyway.
function sampler(lines, row, x, channels, depth) {
  if (depth === 8) {
    const base = row + x * channels;
    return (c) => lines[base + c];
  }
  if (depth === 16) {
    const base = row + x * channels * 2;
    return (c) => lines[base + c * 2];
  }
  const perByte = 8 / depth;
  const mask    = (1 << depth) - 1;
  return (c) => {
    const i     = x * channels + c;
    const byte  = lines[row + Math.floor(i / perByte)];
    const shift = 8 - depth * ((i % perByte) + 1);
    return (byte >> shift) & mask;
  };
}

module.exports = { isPng, decodePng };
