'use strict';

// Baseline JPEG → RGBA, with nothing installed.
//
// A JPEG is a chain of marker segments: quantisation tables, huffman tables, a
// frame header giving the size and how each component is sampled, then one scan
// of entropy-coded blocks. Decoding is the same chain in reverse — huffman
// decode to coefficients, multiply by the quantisation table, inverse DCT back
// to pixels, upsample the half-resolution colour planes and convert out of
// YCbCr.
//
// Baseline and extended sequential (SOF0/SOF1) are covered, which is what
// cameras and phones produce. Progressive files (SOF2) and the CMYK variants
// are refused rather than half-decoded; the caller falls back to another
// converter for those.

const dctZigZag = new Int32Array([
   0,  1,  8, 16,  9,  2,  3, 10,
  17, 24, 32, 25, 18, 11,  4,  5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13,  6,  7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63
]);

// cos((2x+1) u π / 16) · (u ? 1 : 1/√2) / 2 — the whole IDCT as one 8x8 matrix,
// applied to rows and then to columns.
const COS = (() => {
  const m = new Float32Array(64);
  for (let x = 0; x < 8; x++) {
    for (let u = 0; u < 8; u++) {
      m[x * 8 + u] = Math.cos((2 * x + 1) * u * Math.PI / 16) *
                     (u === 0 ? Math.SQRT1_2 : 1) / 2;
    }
  }
  return m;
})();

function isJpeg(buf) {
  return Buffer.isBuffer(buf) && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
}

// ─── Huffman ─────────────────────────────────────────────────────────────────
//
// Codes are canonical: shortest first, each one the previous plus one, shifted
// left whenever the length grows. That means a table needs only, per length,
// the smallest and largest code and where its values start.

function buildHuffman(counts, values) {
  const min = new Int32Array(17);
  const max = new Int32Array(17).fill(-1);
  const ptr = new Int32Array(17);

  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    if (counts[len - 1] === 0) { max[len] = -1; code <<= 1; continue; }
    ptr[len] = k;
    min[len] = code;
    code += counts[len - 1];
    k    += counts[len - 1];
    max[len] = code - 1;
    code <<= 1;
  }
  return { min, max, ptr, values };
}

// The entropy-coded stream, read one bit at a time. A 0xff byte inside it is
// written as ff 00 so it cannot be mistaken for a marker; restart markers are
// skipped by the caller, which knows where they are meant to fall.
class BitReader {
  constructor(buf, pos) {
    this.buf = buf;
    this.pos = pos;
    this.cur = 0;
    this.left = 0;
    this.marker = 0;      // set when the stream ran into one
  }
  bit() {
    if (this.left === 0) {
      // The entropy-coded data ends at the marker. Anything asked for past it
      // is padding: reading on would take the marker byte itself for pixels,
      // and a truncated file would finish its last unit on noise.
      if (this.marker) return 0;
      if (this.pos >= this.buf.length) { this.marker = 0xd9; return 0; }
      let b = this.buf[this.pos++];
      if (b === 0xff) {
        const next = this.buf[this.pos];
        if (next === 0x00) this.pos++;              // stuffed byte
        else { this.marker = next; return 0; }      // a real marker: stop here
      }
      this.cur  = b;
      this.left = 8;
    }
    this.left--;
    return (this.cur >> this.left) & 1;
  }
  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v;
  }
  align() { this.left = 0; }
  decode(table) {
    let code = this.bit();
    for (let len = 1; len <= 16; len++) {
      if (table.max[len] >= 0 && code <= table.max[len]) {
        return table.values[table.ptr[len] + code - table.min[len]];
      }
      code = (code << 1) | this.bit();
    }
    return 0;
  }
}

// A coefficient is stored as its magnitude category plus that many bits; the
// low half of each range stands for the negative values.
function extend(v, n) {
  return v < (1 << (n - 1)) ? v - (1 << n) + 1 : v;
}

// ─── Decode ──────────────────────────────────────────────────────────────────

/**
 * Decode a baseline JPEG.
 *
 * Returns { width, height, data } with data as RGBA bytes, or null when the
 * file is not one this can read.
 */
function decodeJpeg(buf) {
  if (!isJpeg(buf)) return null;
  try { return decode(buf); }
  catch (_) { return null; }
}

function decode(buf) {
  const quant   = [];                 // by table id
  const huffDC  = [];
  const huffAC  = [];
  let frame     = null;
  let restartInterval = 0;
  let adobe     = false;

  let off = 2;
  while (off + 1 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    off += 2;

    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) break;
    if (off + 2 > buf.length) break;

    const len  = buf.readUInt16BE(off);
    const end  = off + len;
    if (len < 2 || end > buf.length) break;
    let p = off + 2;

    switch (marker) {
      case 0xdb:                                        // DQT
        while (p < end) {
          const pq = buf[p] >> 4, tq = buf[p] & 15;
          p++;
          const table = new Int32Array(64);
          for (let i = 0; i < 64; i++) {
            table[dctZigZag[i]] = pq ? buf.readUInt16BE(p + i * 2) : buf[p + i];
          }
          p += pq ? 128 : 64;
          quant[tq] = table;
        }
        break;

      case 0xc4:                                        // DHT
        while (p < end) {
          const tc = buf[p] >> 4, th = buf[p] & 15;
          p++;
          const counts = buf.slice(p, p + 16);
          p += 16;
          let total = 0;
          for (let i = 0; i < 16; i++) total += counts[i];
          const values = buf.slice(p, p + total);
          p += total;
          const table = buildHuffman(counts, values);
          if (tc === 0) huffDC[th] = table; else huffAC[th] = table;
        }
        break;

      case 0xc0:                                        // SOF0  baseline
      case 0xc1: {                                      // SOF1  extended
        const height = buf.readUInt16BE(p + 1);
        const width  = buf.readUInt16BE(p + 3);
        const n      = buf[p + 5];
        p += 6;
        const components = [];
        let maxH = 1, maxV = 1;
        for (let i = 0; i < n; i++) {
          const id = buf[p], h = buf[p + 1] >> 4, v = buf[p + 1] & 15, tq = buf[p + 2];
          p += 3;
          if (!h || !v) return null;
          maxH = Math.max(maxH, h); maxV = Math.max(maxV, v);
          components.push({ id, h, v, tq });
        }
        frame = { width, height, components, maxH, maxV };
        break;
      }

      // Progressive, arithmetic-coded and the lossless modes: not this decoder's.
      case 0xc2: case 0xc3: case 0xc5: case 0xc6: case 0xc7:
      case 0xc9: case 0xca: case 0xcb: case 0xcd: case 0xce: case 0xcf:
        return null;

      case 0xdd:                                        // DRI
        restartInterval = buf.readUInt16BE(p);
        break;

      case 0xee:                                        // APP14 "Adobe"
        if (buf.slice(p, p + 5).toString('latin1') === 'Adobe') adobe = true;
        break;

      case 0xda: {                                      // SOS
        if (!frame) return null;
        const n = buf[p];
        p++;
        const scan = [];
        for (let i = 0; i < n; i++) {
          const id = buf[p], td = buf[p + 1] >> 4, ta = buf[p + 1] & 15;
          p += 2;
          const c = frame.components.find(x => x.id === id);
          if (!c) return null;
          c.dc = huffDC[td]; c.ac = huffAC[ta];
          scan.push(c);
        }
        p += 3;                                         // Ss, Se, Ah/Al
        const consumed = decodeScan(buf, p, frame, scan, quant, restartInterval);
        if (consumed < 0) return null;
        return assemble(frame, adobe);
      }

      default:
        break;                                          // APPn, COM, anything else
    }

    off = end;
  }

  return null;
}

// One sequential scan: minimum coded units left to right, top to bottom, each
// holding h×v blocks of every component.
function decodeScan(buf, pos, frame, scan, quant, restartInterval) {
  const { maxH, maxV, width, height } = frame;
  const mcusPerLine   = Math.ceil(width  / (maxH * 8));
  const mcusPerColumn = Math.ceil(height / (maxV * 8));

  for (const c of frame.components) {
    c.blocksPerLine   = mcusPerLine   * c.h;
    c.blocksPerColumn = mcusPerColumn * c.v;
    c.lineWidth       = c.blocksPerLine * 8;
    c.pixels          = new Uint8ClampedArray(c.lineWidth * c.blocksPerColumn * 8);
    c.pred            = 0;
    c.quant           = quant[c.tq];
    if (!c.quant) return -1;
  }

  const reader = new BitReader(buf, pos);
  const coeffs = new Int32Array(64);
  const total  = mcusPerLine * mcusPerColumn;
  let sinceRestart = 0;

  for (let mcu = 0; mcu < total; mcu++) {
    if (restartInterval && sinceRestart === restartInterval) {
      // Byte-align, step over the RSTn marker, and reset the DC predictors.
      reader.align();
      let q = reader.pos;
      while (q + 1 < buf.length && !(buf[q] === 0xff && buf[q + 1] >= 0xd0 && buf[q + 1] <= 0xd7)) q++;
      if (q + 1 < buf.length) reader.pos = q + 2;
      reader.marker = 0;
      for (const c of scan) c.pred = 0;
      sinceRestart = 0;
    }
    sinceRestart++;

    const row = Math.floor(mcu / mcusPerLine);
    const col = mcu % mcusPerLine;

    for (const c of scan) {
      for (let v = 0; v < c.v; v++) {
        for (let h = 0; h < c.h; h++) {
          decodeBlock(reader, c, coeffs);
          idctInto(coeffs, c.quant, c.pixels, c.lineWidth,
            (row * c.v + v) * 8, (col * c.h + h) * 8);
        }
      }
    }

    if (reader.marker && !(reader.marker >= 0xd0 && reader.marker <= 0xd7)) break;
  }

  return reader.pos;
}

function decodeBlock(reader, c, coeffs) {
  coeffs.fill(0);

  const t = reader.decode(c.dc);
  coeffs[0] = c.pred += t ? extend(reader.bits(t), t) : 0;

  let k = 1;
  while (k < 64) {
    const rs = reader.decode(c.ac);
    const s  = rs & 15, r = rs >> 4;
    if (s === 0) {
      if (r < 15) break;                    // end of block
      k += 16;                              // ZRL: sixteen zeroes
      continue;
    }
    k += r;
    if (k > 63) break;
    coeffs[dctZigZag[k]] = extend(reader.bits(s), s);
    k++;
  }
}

// Dequantise and invert the DCT straight into the component plane.
const _row = new Float32Array(64);

function idctInto(coeffs, quant, out, stride, y0, x0) {
  // A block that kept only its average is flat — most of a smooth photo is
  // like this, and skipping the transform there is most of the speed.
  let onlyDC = true;
  for (let i = 1; i < 64; i++) if (coeffs[i]) { onlyDC = false; break; }
  if (onlyDC) {
    const v = (coeffs[0] * quant[0]) / 8 + 128;
    for (let y = 0; y < 8; y++) {
      const o = (y0 + y) * stride + x0;
      for (let x = 0; x < 8; x++) out[o + x] = v;
    }
    return;
  }

  // Rows first, then columns — the 2D transform separates into two 1D passes.
  for (let u = 0; u < 8; u++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) sum += COS[x * 8 + v] * (coeffs[u * 8 + v] * quant[u * 8 + v]);
      _row[u * 8 + x] = sum;
    }
  }
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let sum = 0;
      for (let u = 0; u < 8; u++) sum += COS[y * 8 + u] * _row[u * 8 + x];
      out[(y0 + y) * stride + x0 + x] = sum + 128;
    }
  }
}

// Upsample the components back to full size and convert to RGBA.
function assemble(frame, adobe) {
  const { width, height, components, maxH, maxV } = frame;
  if (!width || !height || !components.length) return null;
  if (components.length === 2 || components.length > 3) return null;   // CMYK/YCCK
  if (!components[0].pixels) return null;

  const out = Buffer.alloc(width * height * 4, 0xff);

  // Nearest neighbour is enough here: the picture is about to be scaled down.
  const scaleX = components.map(c => c.h / maxH);
  const scaleY = components.map(c => c.v / maxV);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;

      if (components.length === 1) {
        const c = components[0];
        const v = c.pixels[Math.min(y, c.blocksPerColumn * 8 - 1) * c.lineWidth +
                           Math.min(x, c.lineWidth - 1)];
        out[o] = out[o + 1] = out[o + 2] = v;
        continue;
      }

      const s = [];
      for (let i = 0; i < 3; i++) {
        const c  = components[i];
        const cy = Math.min((y * scaleY[i]) | 0, c.blocksPerColumn * 8 - 1);
        const cx = Math.min((x * scaleX[i]) | 0, c.lineWidth - 1);
        s.push(c.pixels[cy * c.lineWidth + cx]);
      }

      // An Adobe segment with three components still means YCbCr in practice;
      // the transform byte only matters for four.
      const [Y, Cb, Cr] = s;
      out[o]     = clamp(Y + 1.402   * (Cr - 128));
      out[o + 1] = clamp(Y - 0.344136 * (Cb - 128) - 0.714136 * (Cr - 128));
      out[o + 2] = clamp(Y + 1.772   * (Cb - 128));
    }
  }

  void adobe;
  return { width, height, data: out };
}

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

module.exports = { isJpeg, decodeJpeg };
