'use strict';

// GIF → RGBA, first frame only.
//
// A profile picture is a still, so an animation is read down to the image it
// opens on. The pixels are LZW-coded with a code width that grows as the
// dictionary fills — about forty lines of it, and the rest is walking the block
// structure to find where the frame starts.

function isGif(buf) {
  return Buffer.isBuffer(buf) && buf.length > 13 &&
         buf.slice(0, 3).toString('latin1') === 'GIF';
}

function decodeGif(buf) {
  if (!isGif(buf)) return null;

  const screenWidth  = buf.readUInt16LE(6);
  const screenHeight = buf.readUInt16LE(8);
  const packed       = buf[10];
  const hasGlobal    = !!(packed & 0x80);
  const globalSize   = 2 << (packed & 7);

  let pos = 13;
  let globalPalette = null;
  if (hasGlobal) {
    globalPalette = buf.slice(pos, pos + globalSize * 3);
    pos += globalSize * 3;
  }

  let transparentIndex = -1;

  while (pos < buf.length) {
    const block = buf[pos];

    if (block === 0x21) {                       // extension
      const label = buf[pos + 1];
      pos += 2;
      if (label === 0xf9 && buf[pos] >= 4) {    // graphic control
        if (buf[pos + 1] & 1) transparentIndex = buf[pos + 4];
      }
      pos = skipBlocks(buf, pos);
      continue;
    }

    if (block === 0x2c) {                       // image descriptor
      const left   = buf.readUInt16LE(pos + 1);
      const top    = buf.readUInt16LE(pos + 3);
      const width  = buf.readUInt16LE(pos + 5);
      const height = buf.readUInt16LE(pos + 7);
      const flags  = buf[pos + 9];
      pos += 10;

      let palette = globalPalette;
      if (flags & 0x80) {
        const localSize = 2 << (flags & 7);
        palette = buf.slice(pos, pos + localSize * 3);
        pos += localSize * 3;
      }
      if (!palette) return null;
      const interlaced = !!(flags & 0x40);

      const minCodeSize = buf[pos];
      pos++;
      const data = gatherBlocks(buf, pos);
      if (!data) return null;

      const indices = lzw(data, minCodeSize, width * height);
      if (!indices) return null;

      return paint(indices, width, height, left, top,
        screenWidth || width, screenHeight || height,
        palette, transparentIndex, interlaced);
    }

    if (block === 0x3b) break;                  // trailer
    pos++;                                      // anything unexpected: step on
  }

  return null;
}

// Sub-blocks are length-prefixed and end with a zero length.
function skipBlocks(buf, pos) {
  while (pos < buf.length && buf[pos] !== 0) pos += buf[pos] + 1;
  return pos + 1;
}

function gatherBlocks(buf, pos) {
  const parts = [];
  while (pos < buf.length && buf[pos] !== 0) {
    const len = buf[pos];
    if (pos + 1 + len > buf.length) return null;
    parts.push(buf.slice(pos + 1, pos + 1 + len));
    pos += len + 1;
  }
  return Buffer.concat(parts);
}

// Variable-width LZW. The dictionary starts with one entry per colour plus a
// clear code and an end code, and every new entry is a previous one with one
// more pixel on the end.
function lzw(data, minCodeSize, expected) {
  if (minCodeSize < 2 || minCodeSize > 8) return null;

  const clearCode = 1 << minCodeSize;
  const endCode   = clearCode + 1;
  const out       = new Uint8Array(expected);

  let dict = [], codeSize = 0, next = 0;
  const reset = () => {
    dict = new Array(clearCode + 2);
    for (let i = 0; i < clearCode; i++) dict[i] = [i];
    codeSize = minCodeSize + 1;
    next     = clearCode + 2;
  };
  reset();

  let bitPos = 0, written = 0, prev = null;
  const totalBits = data.length * 8;

  while (written < expected && bitPos + codeSize <= totalBits) {
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const b = bitPos + i;
      code |= ((data[b >> 3] >> (b & 7)) & 1) << i;   // codes are little-endian
    }
    bitPos += codeSize;

    if (code === clearCode) { reset(); prev = null; continue; }
    if (code === endCode) break;

    let entry;
    if (code < next && dict[code]) entry = dict[code];
    else if (prev) entry = prev.concat(prev[0]);       // the KwKwK case
    else break;

    for (let i = 0; i < entry.length && written < expected; i++) out[written++] = entry[i];

    if (prev) {
      dict[next++] = prev.concat(entry[0]);
      if (next === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    prev = entry;
  }

  return out;
}

function paint(indices, width, height, left, top, canvasW, canvasH,
               palette, transparentIndex, interlaced) {
  const out = Buffer.alloc(canvasW * canvasH * 4, 0);

  // An interlaced frame arrives in four passes over every eighth, fourth and
  // second row in turn.
  const rowOf = interlaced ? interlacedRows(height) : null;

  for (let y = 0; y < height; y++) {
    const dy = (rowOf ? rowOf[y] : y) + top;
    if (dy < 0 || dy >= canvasH) continue;
    for (let x = 0; x < width; x++) {
      const dx = x + left;
      if (dx < 0 || dx >= canvasW) continue;
      const idx = indices[y * width + x];
      const o   = (dy * canvasW + dx) * 4;
      if (idx === transparentIndex) { out[o + 3] = 0; continue; }
      const p = idx * 3;
      out[o]     = palette[p]     || 0;
      out[o + 1] = palette[p + 1] || 0;
      out[o + 2] = palette[p + 2] || 0;
      out[o + 3] = 255;
    }
  }

  return { width: canvasW, height: canvasH, data: out };
}

function interlacedRows(height) {
  const rows = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < height; y += step) rows.push(y);
  }
  return rows;
}

module.exports = { isGif, decodeGif };
