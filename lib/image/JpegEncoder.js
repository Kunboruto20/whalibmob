'use strict';

// RGBA → baseline JPEG, with nothing installed.
//
// The forward path of the decoder next door: convert to YCbCr, transform each
// 8x8 block, divide by the quantisation table and huffman-code what is left.
// The tables are the standard ones from the specification, which every decoder
// in existence already knows, and the output is plain baseline 4:4:4 — the most
// conservative thing a JPEG can be, which is the point when the reader on the
// far side is somebody else's server.

const ZIGZAG = new Int32Array([
   0,  1,  8, 16,  9,  2,  3, 10,
  17, 24, 32, 25, 18, 11,  4,  5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13,  6,  7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63
]);

const STD_LUMA_QUANT = new Int32Array([
  16, 11, 10, 16,  24,  40,  51,  61,
  12, 12, 14, 19,  26,  58,  60,  55,
  14, 13, 16, 24,  40,  57,  69,  56,
  14, 17, 22, 29,  51,  87,  80,  62,
  18, 22, 37, 56,  68, 109, 103,  77,
  24, 35, 55, 64,  81, 104, 113,  92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103,  99
]);

const STD_CHROMA_QUANT = new Int32Array([
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99
]);

const DC_LUMA_BITS   = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_VALUES      = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUMA_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
  0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
  0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
  0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
  0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3,
  0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
  0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
  0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa
];

const AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHROMA_VALUES = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41,
  0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
  0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1,
  0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44,
  0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
  0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74,
  0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a,
  0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
  0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
  0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4,
  0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa
];

// The same orthogonal 8x8 matrix the decoder uses, applied the other way round.
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

// Canonical codes, in the same order the bit counts and values give them.
function huffmanCodes(bits, values) {
  const table = new Map();
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) {
      table.set(values[k++], { code, length: len });
      code++;
    }
    code <<= 1;
  }
  return table;
}

class BitWriter {
  constructor() {
    this.bytes = [];
    this.acc   = 0;
    this.used  = 0;
  }
  write(code, length) {
    for (let i = length - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((code >> i) & 1);
      this.used++;
      if (this.used === 8) {
        this.bytes.push(this.acc & 0xff);
        // A 0xff in the entropy stream has to be followed by 0x00 so it cannot
        // be read as the start of a marker.
        if ((this.acc & 0xff) === 0xff) this.bytes.push(0x00);
        this.acc = 0; this.used = 0;
      }
    }
  }
  // Pad the last byte with ones, which no code can be mistaken for.
  flush() {
    while (this.used) this.write(1, 1);
  }
}

// Quality 1..100 as the usual scaling of the standard tables.
function scaleQuant(base, quality) {
  const q     = Math.max(1, Math.min(100, quality | 0));
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  const out   = new Int32Array(64);
  for (let i = 0; i < 64; i++) {
    out[i] = Math.max(1, Math.min(255, Math.floor((base[i] * scale + 50) / 100)));
  }
  return out;
}

// How many bits the value needs, and the value itself written in them —
// negatives as the one's complement, which is how JPEG stores them.
function magnitude(v) {
  const a = v < 0 ? -v : v;
  let size = 0;
  for (let t = a; t; t >>= 1) size++;
  return { size, bits: v < 0 ? v + (1 << size) - 1 : v };
}

const _block = new Float32Array(64);
const _tmp   = new Float32Array(64);
const _quant = new Int32Array(64);

// Forward DCT on _block, quantised into _quant in zigzag order.
function forward(quant) {
  for (let u = 0; u < 8; u++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) sum += COS[y * 8 + u] * _block[y * 8 + x];
      _tmp[u * 8 + x] = sum;
    }
  }
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let sum = 0;
      for (let x = 0; x < 8; x++) sum += COS[x * 8 + v] * _tmp[u * 8 + x];
      _quant[u * 8 + v] = Math.round(sum / quant[u * 8 + v]);
    }
  }
}

function encodeBlock(writer, quant, dcTable, acTable, prevDC) {
  forward(quant);

  const dc   = _quant[0];
  const diff = dc - prevDC;
  if (diff === 0) {
    writer.write(dcTable.get(0).code, dcTable.get(0).length);
  } else {
    const m = magnitude(diff);
    const c = dcTable.get(m.size);
    writer.write(c.code, c.length);
    writer.write(m.bits, m.size);
  }

  // Find the last non-zero coefficient so the block can end early.
  let last = 0;
  for (let k = 1; k < 64; k++) if (_quant[ZIGZAG[k]] !== 0) last = k;

  let run = 0;
  for (let k = 1; k <= last; k++) {
    const v = _quant[ZIGZAG[k]];
    if (v === 0) { run++; continue; }
    while (run > 15) {                        // ZRL, sixteen zeroes at a time
      const zrl = acTable.get(0xf0);
      writer.write(zrl.code, zrl.length);
      run -= 16;
    }
    const m = magnitude(v);
    const c = acTable.get((run << 4) | m.size);
    writer.write(c.code, c.length);
    writer.write(m.bits, m.size);
    run = 0;
  }
  if (last < 63) {
    const eob = acTable.get(0x00);
    writer.write(eob.code, eob.length);
  }

  return dc;
}

function segment(marker, body) {
  const head = Buffer.alloc(4);
  head[0] = 0xff; head[1] = marker;
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

function quantSegment(id, table) {
  const body = Buffer.alloc(65);
  body[0] = id;
  for (let i = 0; i < 64; i++) body[1 + i] = table[ZIGZAG[i]];
  return body;
}

function huffmanSegment(id, bits, values) {
  return Buffer.concat([
    Buffer.from([id]),
    Buffer.from(bits),
    Buffer.from(values)
  ]);
}

/**
 * Encode RGBA pixels as a baseline JPEG.
 *
 * `data` is width·height·4 bytes; alpha is ignored, since a JPEG has none —
 * transparent areas come out as whatever colour is underneath them.
 */
function encodeJpeg(data, width, height, quality) {
  if (!width || !height) throw new Error('jpeg: cannot encode a picture with no size');
  if (data.length < width * height * 4) throw new Error('jpeg: not enough pixel data');

  const q       = quality || 50;
  const lumaQ   = scaleQuant(STD_LUMA_QUANT, q);
  const chromaQ = scaleQuant(STD_CHROMA_QUANT, q);

  const dcLuma   = huffmanCodes(DC_LUMA_BITS,   DC_VALUES);
  const acLuma   = huffmanCodes(AC_LUMA_BITS,   AC_LUMA_VALUES);
  const dcChroma = huffmanCodes(DC_CHROMA_BITS, DC_VALUES);
  const acChroma = huffmanCodes(AC_CHROMA_BITS, AC_CHROMA_VALUES);

  const parts = [
    Buffer.from([0xff, 0xd8]),                                       // SOI
    segment(0xe0, Buffer.concat([                                    // APP0/JFIF
      Buffer.from('JFIF\0', 'latin1'),
      Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])
    ])),
    segment(0xdb, quantSegment(0, lumaQ)),
    segment(0xdb, quantSegment(1, chromaQ)),
    segment(0xc0, Buffer.from([                                      // SOF0
      8,
      (height >> 8) & 0xff, height & 0xff,
      (width  >> 8) & 0xff, width  & 0xff,
      3,
      1, 0x11, 0,        // Y  — 1x1 sampling, quantisation table 0
      2, 0x11, 1,        // Cb — 1x1, table 1
      3, 0x11, 1         // Cr — 1x1, table 1
    ])),
    segment(0xc4, huffmanSegment(0x00, DC_LUMA_BITS,   DC_VALUES)),
    segment(0xc4, huffmanSegment(0x10, AC_LUMA_BITS,   AC_LUMA_VALUES)),
    segment(0xc4, huffmanSegment(0x01, DC_CHROMA_BITS, DC_VALUES)),
    segment(0xc4, huffmanSegment(0x11, AC_CHROMA_BITS, AC_CHROMA_VALUES)),
    segment(0xda, Buffer.from([                                      // SOS
      3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0
    ]))
  ];

  // Colour-convert once; the block loop then only reads.
  const size = width * height;
  const Y  = new Float32Array(size);
  const Cb = new Float32Array(size);
  const Cr = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    Y[i]  =  0.299    * r + 0.587    * g + 0.114    * b - 128;
    Cb[i] = -0.168736 * r - 0.331264 * g + 0.5      * b;
    Cr[i] =  0.5      * r - 0.418688 * g - 0.081312 * b;
  }

  const writer  = new BitWriter();
  const planes  = [Y, Cb, Cr];
  const quants  = [lumaQ, chromaQ, chromaQ];
  const dcTabs  = [dcLuma, dcChroma, dcChroma];
  const acTabs  = [acLuma, acChroma, acChroma];
  const prev    = [0, 0, 0];

  const cols = Math.ceil(width / 8);
  const rows = Math.ceil(height / 8);

  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      for (let c = 0; c < 3; c++) {
        const plane = planes[c];
        // Blocks past the edge repeat the last row and column, which costs
        // fewer bits than padding with a hard edge would.
        for (let y = 0; y < 8; y++) {
          const sy = Math.min(by * 8 + y, height - 1);
          for (let x = 0; x < 8; x++) {
            const sx = Math.min(bx * 8 + x, width - 1);
            _block[y * 8 + x] = plane[sy * width + sx];
          }
        }
        prev[c] = encodeBlock(writer, quants[c], dcTabs[c], acTabs[c], prev[c]);
      }
    }
  }
  writer.flush();

  parts.push(Buffer.from(writer.bytes));
  parts.push(Buffer.from([0xff, 0xd9]));                             // EOI
  return Buffer.concat(parts);
}

module.exports = { encodeJpeg };
