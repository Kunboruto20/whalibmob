'use strict';

// A small image pipeline that needs nothing installed.
//
// WhatsApp will not take an arbitrary file as a profile picture: it wants a
// square JPEG of a particular size, and anything else comes back refused. That
// normally means depending on a native image library, which is exactly the
// thing that is missing on the machines where this matters — a phone, a small
// server, a container built without a compiler.
//
// So the formats a picture is actually likely to be in are decoded here:
// JPEG, PNG, GIF and BMP, each straight out of the file. Whatever comes out is
// cropped square, scaled and written back as a baseline JPEG.
//
// This is the floor, not the ceiling. When sharp, jimp or ffmpeg is installed
// the caller uses that instead — those read the formats left out here, WebP and
// HEIC and progressive JPEG among them, and scale better. What this guarantees
// is that the ordinary case works with no dependency at all.

const { isJpeg, decodeJpeg } = require('./Jpeg');
const { isPng,  decodePng  } = require('./Png');
const { isGif,  decodeGif  } = require('./Gif');
const { isBmp,  decodeBmp  } = require('./Bmp');
const { encodeJpeg }         = require('./JpegEncoder');

/**
 * Decode an image into RGBA.
 *
 * Returns { width, height, data } or null when the format is not one of the
 * four, or the file is damaged. Never throws.
 */
function decodeImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  try {
    if (isJpeg(buf)) return orient(decodeJpeg(buf), readExifOrientation(buf));
    if (isPng(buf))  return decodePng(buf);
    if (isGif(buf))  return decodeGif(buf);
    if (isBmp(buf))  return decodeBmp(buf);
  } catch (_) {}
  return null;
}

/** True when decodeImage stands a chance with this file. */
function canDecode(buf) {
  return isJpeg(buf) || isPng(buf) || isGif(buf) || isBmp(buf);
}

// ─── EXIF orientation ────────────────────────────────────────────────────────
//
// A phone writes the photo the way the sensor read it and records how the
// phone was being held in tag 0x0112. Every viewer honours that; a decoder
// working from the pixels alone does not, so a picture taken in portrait comes
// out on its side. Reading the one tag and turning the image back is cheaper
// than the confusion of not doing it.

function readExifOrientation(buf) {
  let off = 2;
  while (off + 4 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) break;

    if (marker === 0xe1 && off + 10 < buf.length &&
        buf.slice(off + 4, off + 10).toString('latin1') === 'Exif\0\0') {
      const tiff = off + 10;
      if (tiff + 8 > buf.length) return 1;
      const bom = buf.slice(tiff, tiff + 2).toString('latin1');
      if (bom !== 'II' && bom !== 'MM') return 1;
      const le  = bom === 'II';
      const u16 = (o) => le ? buf.readUInt16LE(o) : buf.readUInt16BE(o);
      const u32 = (o) => le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
      const ifd0 = tiff + u32(tiff + 4);
      if (ifd0 + 2 > buf.length) return 1;
      const count = u16(ifd0);
      for (let i = 0; i < count; i++) {
        const e = ifd0 + 2 + i * 12;
        if (e + 12 > buf.length) break;
        if (u16(e) === 0x0112) {
          const v = u16(e + 8);
          return v >= 1 && v <= 8 ? v : 1;
        }
      }
      return 1;
    }

    off += 2 + len;
  }
  return 1;
}

// The eight orientations are the four rotations, each optionally mirrored.
function orient(img, orientation) {
  if (!img || !orientation || orientation === 1) return img;

  const { width: w, height: h, data } = img;
  const swap = orientation >= 5;                 // 5..8 turn the picture on its side
  const outW = swap ? h : w;
  const outH = swap ? w : h;
  const out  = Buffer.alloc(outW * outH * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx, dy;
      switch (orientation) {
        case 2: dx = w - 1 - x; dy = y;         break;   // mirrored
        case 3: dx = w - 1 - x; dy = h - 1 - y; break;   // 180°
        case 4: dx = x;         dy = h - 1 - y; break;   // mirrored vertically
        case 5: dx = y;         dy = x;         break;   // transposed
        case 6: dx = h - 1 - y; dy = x;         break;   // 90° clockwise
        case 7: dx = h - 1 - y; dy = w - 1 - x; break;   // transverse
        case 8: dx = y;         dy = w - 1 - x; break;   // 90° anticlockwise
        default: dx = x;        dy = y;
      }
      const src = (y * w + x) * 4;
      const dst = (dy * outW + dx) * 4;
      out[dst]     = data[src];
      out[dst + 1] = data[src + 1];
      out[dst + 2] = data[src + 2];
      out[dst + 3] = data[src + 3];
    }
  }

  return { width: outW, height: outH, data: out };
}

// ─── Crop and scale ──────────────────────────────────────────────────────────

/**
 * Scale a rectangle out of an image to a given size.
 *
 * Every output pixel is the average of the source area it covers, rather than
 * one sample from the middle of it. That matters at the reductions this is used
 * for — a 4000-pixel photo taken down to 640 by sampling alone comes out
 * visibly speckled, and detail finer than the output grid turns into noise.
 */
function scaleRegion(img, sx0, sy0, srcW, srcH, outW, outH) {
  const stepX = srcW / outW;
  const stepY = srcH / outH;
  const out   = Buffer.alloc(outW * outH * 4);

  for (let y = 0; y < outH; y++) {
    const ya = sy0 + y * stepY;
    const yb = Math.min(sy0 + srcH, ya + stepY);
    const y0 = Math.floor(ya), y1 = Math.max(y0 + 1, Math.ceil(yb));

    for (let x = 0; x < outW; x++) {
      const xa = sx0 + x * stepX;
      const xb = Math.min(sx0 + srcW, xa + stepX);
      const x0 = Math.floor(xa), x1 = Math.max(x0 + 1, Math.ceil(xb));

      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1 && sy < img.height; sy++) {
        if (sy < 0) continue;
        for (let sx = x0; sx < x1 && sx < img.width; sx++) {
          if (sx < 0) continue;
          const o = (sy * img.width + sx) * 4;
          r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; a += img.data[o + 3];
          n++;
        }
      }
      if (!n) continue;

      const o = (y * outW + x) * 4;
      out[o]     = (r / n) | 0;
      out[o + 1] = (g / n) | 0;
      out[o + 2] = (b / n) | 0;
      out[o + 3] = (a / n) | 0;
    }
  }

  return { width: outW, height: outH, data: out };
}

/** Take the largest square from the middle of an image and scale it to `size`. */
function squareResize(img, size) {
  const side = Math.min(img.width, img.height);
  return scaleRegion(img,
    ((img.width  - side) / 2) | 0,
    ((img.height - side) / 2) | 0,
    side, side, size, size);
}

/** Scale the whole image to `width`, keeping its proportions. */
function resizeToWidth(img, width) {
  const w = Math.max(1, Math.min(width, img.width));
  const h = Math.max(1, Math.round(img.height * w / img.width));
  return scaleRegion(img, 0, 0, img.width, img.height, w, h);
}

// A JPEG has no alpha, so anything see-through has to be given a colour. White
// is what the apps use, and it is what a transparent PNG logo is drawn against
// nearly everywhere else.
function flatten(img, background) {
  const bg = background || { r: 255, g: 255, b: 255 };
  const d  = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 255) continue;
    const t = a / 255;
    d[i]     = (d[i]     * t + bg.r * (1 - t)) | 0;
    d[i + 1] = (d[i + 1] * t + bg.g * (1 - t)) | 0;
    d[i + 2] = (d[i + 2] * t + bg.b * (1 - t)) | 0;
    d[i + 3] = 255;
  }
  return img;
}

/**
 * Decode, crop square, scale and write out as a baseline JPEG.
 *
 * Returns null when the file cannot be decoded here, which is the caller's cue
 * to try something else rather than an error.
 */
function toSquareJpeg(buf, size, quality) {
  const img = decodeImage(buf);
  if (!img || !img.width || !img.height) return null;
  try {
    const square = squareResize(flatten(img), size || 640);
    return encodeJpeg(square.data, square.width, square.height, quality || 50);
  } catch (_) {
    return null;
  }
}

/**
 * Decode, scale to a width with the proportions kept, and write out a JPEG.
 *
 * This is the inline preview a message carries. Returns null when the file
 * cannot be decoded here.
 */
function toScaledJpeg(buf, width, quality) {
  const img = decodeImage(buf);
  if (!img || !img.width || !img.height) return null;
  try {
    const small = resizeToWidth(flatten(img), width || 32);
    return encodeJpeg(small.data, small.width, small.height, quality || 50);
  } catch (_) {
    return null;
  }
}

module.exports = {
  decodeImage,
  canDecode,
  scaleRegion,
  squareResize,
  resizeToWidth,
  flatten,
  toSquareJpeg,
  toScaledJpeg,
  encodeJpeg,
  readExifOrientation
};
