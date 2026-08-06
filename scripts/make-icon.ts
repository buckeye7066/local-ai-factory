/**
 * make-icon.ts — generate a blue "Ford-oval"-style Factory Deck icon as a real
 * .ico file, with ZERO image dependencies.
 *
 * Approach: rasterize the oval badge into an RGBA buffer, hand-encode a PNG
 * (using Node's built-in zlib for the pixel data), then wrap that PNG in the
 * ICO container format (modern .ico entries may embed a PNG directly).
 *
 * Output: assets/factory-deck.ico
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 256;
const buf = new Uint8Array(SIZE * SIZE * 4); // RGBA

function setPx(x: number, y: number, r: number, g: number, b: number, a: number) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  // simple source-over alpha blend onto existing pixel
  const sa = a / 255;
  const da = buf[i + 3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) return;
  buf[i] = Math.round((r * sa + buf[i] * da * (1 - sa)) / outA);
  buf[i + 1] = Math.round((g * sa + buf[i + 1] * da * (1 - sa)) / outA);
  buf[i + 2] = Math.round((b * sa + buf[i + 2] * da * (1 - sa)) / outA);
  buf[i + 3] = Math.round(outA * 255);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/* ---- Draw the badge ------------------------------------------------ */

const cx = 128;
const cy = 128;
const rx = 120;
const ry = 80;
const rim = 9; // chrome rim thickness

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const nx = (x - cx) / rx;
    const ny = (y - cy) / ry;
    const d = nx * nx + ny * ny;
    if (d > 1) continue; // outside oval

    const innerRx = rx - rim;
    const innerRy = ry - rim;
    const dInner =
      ((x - cx) / innerRx) ** 2 + ((y - cy) / innerRy) ** 2;

    const ty = (y - (cy - ry)) / (2 * ry); // 0 top → 1 bottom
    if (dInner > 1) {
      // Chrome rim — silver vertical gradient with a soft top highlight.
      const shade = lerp(235, 150, ty);
      const hi = ty < 0.45 ? 20 : 0;
      setPx(x, y, Math.min(255, shade + hi), Math.min(255, shade + hi), Math.min(255, shade + 12), 255);
    } else {
      // Blue field — Ford-deep-blue vertical gradient (#2f6fe0 → #002a73).
      const r = Math.round(lerp(47, 0, ty));
      const g = Math.round(lerp(111, 42, ty));
      const b = Math.round(lerp(224, 115, ty));
      setPx(x, y, r, g, b, 255);
    }
  }
}

// Glossy top highlight inside the blue field.
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dInner = ((x - cx) / (rx - rim)) ** 2 + ((y - cy) / (ry - rim)) ** 2;
    if (dInner > 1) continue;
    const hy = (y - (cy - ry + rim)) / (ry * 0.9);
    if (hy < 0.5) {
      const a = Math.round(lerp(60, 0, hy / 0.5));
      setPx(x, y, 255, 255, 255, a);
    }
  }
}

/* ---- Tiny 5x7 bitmap font (uppercase subset) ----------------------- */

const FONT: Record<string, string[]> = {
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
};

const GLYPH_W = 5;
const GLYPH_H = 7;

function textWidth(text: string, scale: number): number {
  return text.length * (GLYPH_W + 1) * scale - scale;
}

/** Draw text centered horizontally at vertical top `topY`, with a slight italic shear. */
function drawText(text: string, topY: number, scale: number, shear: number) {
  const w = textWidth(text, scale);
  let penX = Math.round(cx - w / 2);
  for (const ch of text) {
    const glyph = FONT[ch];
    if (glyph) {
      for (let gy = 0; gy < GLYPH_H; gy++) {
        for (let gx = 0; gx < GLYPH_W; gx++) {
          if (glyph[gy][gx] !== "1") continue;
          const slant = Math.round(shear * (GLYPH_H - gy) * scale);
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              const px = penX + gx * scale + sx + slant;
              const py = topY + gy * scale + sy;
              // soft shadow then white fill
              setPx(px + 1, py + 1, 0, 16, 48, 120);
              setPx(px, py, 255, 255, 255, 255);
            }
          }
        }
      }
    }
    penX += (GLYPH_W + 1) * scale;
  }
}

drawText("FACTORY", cy - 40, 4, 0.18);
drawText("DECK", cy + 6, 5, 0.18);

/* ---- PNG encoder (RGBA, no filtering) ------------------------------ */

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([...type].map((c) => c.charCodeAt(0)));
  const len = data.length;
  const out = new Uint8Array(12 + len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcInput = new Uint8Array(4 + len);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  dv.setUint32(8 + len, crc32(crcInput));
  return out;
}

function encodePng(): Uint8Array {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = new Uint8Array(13);
  const idv = new DataView(ihdr.buffer);
  idv.setUint32(0, SIZE);
  idv.setUint32(4, SIZE);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Filtered scanlines: filter byte 0 + RGBA row.
  const raw = new Uint8Array(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0;
    raw.set(buf.subarray(y * SIZE * 4, (y + 1) * SIZE * 4), y * (SIZE * 4 + 1) + 1);
  }
  const idat = deflateSync(Buffer.from(raw), { level: 9 });

  const parts = [
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(idat)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/* ---- ICO container (single embedded PNG) --------------------------- */

function encodeIco(png: Uint8Array): Uint8Array {
  const out = new Uint8Array(6 + 16 + png.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0, true); // reserved
  dv.setUint16(2, 1, true); // type: icon
  dv.setUint16(4, 1, true); // count
  out[6] = 0; // width 256 → 0
  out[7] = 0; // height 256 → 0
  out[8] = 0; // colors
  out[9] = 0; // reserved
  dv.setUint16(10, 1, true); // planes
  dv.setUint16(12, 32, true); // bit count
  dv.setUint32(14, png.length, true); // bytes in resource
  dv.setUint32(18, 22, true); // offset (6 + 16)
  out.set(png, 22);
  return out;
}

const png = encodePng();
const ico = encodeIco(png);

const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = resolve(here, "..", "assets");
mkdirSync(assetsDir, { recursive: true });
const icoPath = resolve(assetsDir, "factory-deck.ico");
const pngPath = resolve(assetsDir, "factory-deck.png");
writeFileSync(icoPath, ico);
writeFileSync(pngPath, png);

console.log(`Wrote ${icoPath} (${ico.length} bytes)`);
console.log(`Wrote ${pngPath} (${png.length} bytes)`);
