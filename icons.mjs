// Draws the toolbar icons (a check mark in a circle) as PNGs: "on" (green, a shop with codes) and
// "off" (grey). Pure JS so the build needs no image tools.
import { zlibSync } from "./worker/node_modules/fflate/esm/index.mjs";

const COLORS = { on: [31, 122, 77], off: [138, 138, 132] };

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function png(size, rgba) {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size); dv.setUint32(4, size);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    chunk("IDAT", zlibSync(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const distToSegment = (px, py, ax, ay, bx, by) => {
  const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
};

/** Returns PNG bytes for one icon. Coordinates are in a 0..1 square, supersampled 4x4 per pixel. */
export function icon(state, size) {
  const [r, g, b] = COLORS[state];
  const rgba = new Uint8Array(size * size * 4);
  const S = 4;
  const stroke = 0.075;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let circle = 0, check = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const px = (x + (sx + 0.5) / S) / size, py = (y + (sy + 0.5) / S) / size;
      if (Math.hypot(px - 0.5, py - 0.5) <= 0.48) {
        circle++;
        const d = Math.min(distToSegment(px, py, 0.28, 0.52, 0.44, 0.68), distToSegment(px, py, 0.44, 0.68, 0.73, 0.36));
        if (d <= stroke) check++;
      }
    }
    const a = circle / (S * S), w = circle ? check / circle : 0;
    const i = (y * size + x) * 4;
    rgba[i] = Math.round(r + (255 - r) * w);
    rgba[i + 1] = Math.round(g + (255 - g) * w);
    rgba[i + 2] = Math.round(b + (255 - b) * w);
    rgba[i + 3] = Math.round(a * 255);
  }
  return png(size, rgba);
}
