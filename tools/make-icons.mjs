// Generates the desktop app icons (PNG + ICO) procedurally: a flame on a
// rounded dark tile. Run: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const OUT = new URL('../crates/hearth-desktop/icons/', import.meta.url);

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Shapes in normalised coords: x,y in [-1, 1], y down.
function tile(x, y) { // rounded square
  const r = 0.36, e = 0.94;
  const dx = Math.max(Math.abs(x) - (e - r), 0), dy = Math.max(Math.abs(y) - (e - r), 0);
  return dx * dx + dy * dy <= r * r;
}
function flame(x, y, s, cy) { // teardrop: round base, pointed top
  x /= s; y = (y - cy) / s;
  if (y >= 0.2) return x * x + (y - 0.2) ** 2 <= 0.36;
  if (y < -0.85) return false;
  const t = (y + 0.85) / 1.05;            // 0 at tip, 1 at widest
  const wobble = 0.08 * Math.sin((y + 0.85) * 5);
  return Math.abs(x - wobble * (1 - t)) <= 0.6 * Math.pow(t, 0.8);
}
const mix = (a, b, t) => { t = Math.min(1, Math.max(0, t)); return a.map((v, i) => v + (b[i] - v) * t); };

function render(size) {
  const ss = 4, buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const x = ((px + (sx + 0.5) / ss) / size) * 2 - 1;
      const y = ((py + (sy + 0.5) / ss) / size) * 2 - 1;
      let c = [0, 0, 0, 0];
      if (tile(x, y)) {
        c = [...mix([42, 33, 22], [21, 22, 26], (y + 1) / 2), 255];
        if (flame(x, y, 0.78, 0.12)) c = [...mix([255, 196, 92], [214, 84, 40], (y + 0.7) / 1.4 * -1 + 1), 255];
        if (flame(x, y, 0.42, 0.3)) c = [255, 226, 150, 255];
      }
      acc = acc.map((v, i) => v + c[i]);
    }
    const n = ss * ss, o = (py * size + px) * 4;
    const a = acc[3] / n;
    buf[o] = a ? acc[0] / (acc[3] / 255) : 0; buf[o + 1] = a ? acc[1] / (acc[3] / 255) : 0;
    buf[o + 2] = a ? acc[2] / (acc[3] / 255) : 0; buf[o + 3] = a;
  }
  return png(size, buf);
}

const files = { '32x32.png': 32, '128x128.png': 128, '128x128@2x.png': 256, 'icon.png': 512 };
for (const [name, size] of Object.entries(files)) writeFileSync(new URL(name, OUT), render(size));

// ICO with embedded PNGs (supported since Windows Vista).
const icoSizes = [16, 24, 32, 48, 64, 256];
const images = icoSizes.map(render);
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach((img, i) => {
  const e = 6 + i * 16, s = icoSizes[i];
  header[e] = s >= 256 ? 0 : s; header[e + 1] = s >= 256 ? 0 : s;
  header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(img.length, e + 8); header.writeUInt32LE(offset, e + 12);
  offset += img.length;
});
writeFileSync(new URL('icon.ico', OUT), Buffer.concat([header, ...images]));
console.log('icons written');
