/**
 * make-icon.ts — generate the Factory Deck desktop icon as a real .ico file,
 * with ZERO image dependencies.
 *
 * DESIGN (owner request 2026-08-15): the desktop icon now matches the app's
 * own brand tile exactly — the Sidebar logo: a rounded-xl square with the
 * aurora blue→violet diagonal gradient (#3b82f6 → #8b5cf6, tailwind.config.js
 * `aurora.blue`/`aurora.violet`) and the white lucide `Factory` glyph
 * (stroke-drawn, 24-unit viewBox, stroke width 2, round caps/joins).
 * The previous blue "Ford-oval" badge is retired.
 *
 * Approach: rasterize into an RGBA buffer with supersampled coverage,
 * hand-encode a PNG (Node's zlib), wrap it in the ICO container (modern .ico
 * entries may embed a PNG directly).
 *
 * Output: assets/factory-deck.ico
 * (assets/purpose-foundry.ico is NOT generated — it is the UAW wheel emblem,
 * an owner-supplied brand image, installed by Install-Purpose-Foundry-Icon.ps1.)
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 256;
const SS = 3; // supersample factor per axis
const buf = new Uint8Array(SIZE * SIZE * 4); // RGBA

/* ---- Geometry helpers ---------------------------------------------- */

/** Signed distance to a rounded rectangle centered box. */
function roundedRectSdf(
  px: number,
  py: number,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  r: number,
): number {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Distance from point to segment. */
function segDist(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/* ---- The lucide `Factory` glyph (24-unit viewBox) -------------------
 * Main outline (arcs flattened to their corner points — at icon scale the
 * 2-unit corner radii read identically through the round-join stroke):
 *   (2,20)(4,22)(20,22)(22,20)(22,8)(15,13)(15,8)(8,13)(8,4)(6,2)(4,2)(2,4) close
 * Window ticks: (7,18)-(8,18)  (12,18)-(13,18)  (17,18)-(18,18)
 */
const OUTLINE: Array<[number, number]> = [
  [2, 20], [4, 22], [20, 22], [22, 20], [22, 8], [15, 13], [15, 8],
  [8, 13], [8, 4], [6, 2], [4, 2], [2, 4],
];
const TICKS: Array<[number, number, number, number]> = [
  [7, 18, 8, 18],
  [12, 18, 13, 18],
  [17, 18, 18, 18],
];

const SEGMENTS: Array<[number, number, number, number]> = [];
for (let i = 0; i < OUTLINE.length; i++) {
  const [x1, y1] = OUTLINE[i]!;
  const [x2, y2] = OUTLINE[(i + 1) % OUTLINE.length]!;
  SEGMENTS.push([x1, y1, x2, y2]);
}
for (const t of TICKS) SEGMENTS.push(t);

/* ---- Tile parameters (matching the Sidebar brand tile) -------------- */

// rounded-xl on a 40px tile ≈ 12/40 → radius ratio 0.30 of the half-size.
const TILE_HALF = 118; // tile spans 20..236 → margin for the drop edge
const TILE_RADIUS = 34;
const CX = 128;
const CY = 128;

// Glyph box: h-5 w-5 inside h-10 w-10 → glyph spans 50% of the tile.
const GLYPH_SCALE = (TILE_HALF * 2 * 0.5) / 24; // 24-unit viewBox → px
const GLYPH_OFF = CX - 12 * GLYPH_SCALE; // centered
const STROKE_HALF = (2 / 2) * GLYPH_SCALE; // stroke width 2 in glyph units

// Gradient endpoints: to-br — top-left #3b82f6 → bottom-right #8b5cf6.
const C0 = { r: 0x3b, g: 0x82, b: 0xf6 };
const C1 = { r: 0x8b, g: 0x5c, b: 0xf6 };

function glyphDist(px: number, py: number): number {
  const gx = (px - GLYPH_OFF) / GLYPH_SCALE;
  const gy = (py - GLYPH_OFF) / GLYPH_SCALE;
  let d = Infinity;
  for (const [x1, y1, x2, y2] of SEGMENTS) {
    d = Math.min(d, segDist(gx, gy, x1, y1, x2, y2));
  }
  return d * GLYPH_SCALE;
}

/* ---- Rasterize ------------------------------------------------------ */

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let tileCov = 0;
    let glyphCov = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        if (roundedRectSdf(px, py, CX, CY, TILE_HALF, TILE_HALF, TILE_RADIUS) <= 0) {
          tileCov++;
          if (glyphDist(px, py) <= STROKE_HALF) glyphCov++;
        }
      }
    }
    const samples = SS * SS;
    if (tileCov === 0) continue;
    // Diagonal gradient position 0..1 along the to-br axis.
    const t = Math.max(0, Math.min(1, (x + y) / (2 * SIZE)));
    let r = Math.round(C0.r + (C1.r - C0.r) * t);
    let g = Math.round(C0.g + (C1.g - C0.g) * t);
    let b = Math.round(C0.b + (C1.b - C0.b) * t);
    // Composite the white glyph over the gradient by coverage.
    const gw = glyphCov / samples;
    r = Math.round(r + (255 - r) * gw);
    g = Math.round(g + (255 - g) * gw);
    b = Math.round(b + (255 - b) * gw);
    const i = (y * SIZE + x) * 4;
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = Math.round((tileCov / samples) * 255);
  }
}

/* ---- Encode PNG (hand-rolled, zlib only) ---------------------------- */

function crc32(data: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  dv.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

const ihdr = new Uint8Array(13);
{
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, SIZE);
  dv.setUint32(4, SIZE);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
}
const raw = new Uint8Array(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  raw.set(buf.subarray(y * SIZE * 4, (y + 1) * SIZE * 4), y * (SIZE * 4 + 1) + 1);
}
const png = new Uint8Array(
  [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ].reduce<number[]>((acc, part) => (acc.push(...part), acc), []),
);

/* ---- Wrap in ICO ---------------------------------------------------- */

const ico = new Uint8Array(6 + 16 + png.length);
{
  const dv = new DataView(ico.buffer);
  dv.setUint16(0, 0, true); // reserved
  dv.setUint16(2, 1, true); // type: icon
  dv.setUint16(4, 1, true); // count
  ico[6] = 0; // width 256 → 0
  ico[7] = 0; // height 256 → 0
  ico[8] = 0; // palette
  ico[9] = 0; // reserved
  dv.setUint16(10, 1, true); // planes
  dv.setUint16(12, 32, true); // bpp
  dv.setUint32(14, png.length, true);
  dv.setUint32(18, 22, true); // offset
  ico.set(png, 22);
}

const outPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "assets",
  "factory-deck.ico",
);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, ico);
console.log(`Wrote ${outPath} (${ico.length} bytes)`);
