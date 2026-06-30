/**
 * Generates a multi-resolution .ico + .png app icon.
 * Pure Node (CommonJS), no native deps.
 *
 *  - public/icon.ico  → electron-builder NSIS wizard + Windows shell
 *  - public/icon.png  → BrowserWindow window icon
 *
 * Run: node electron/icon.cjs
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 32, 48, 64, 128, 256];

// ─── Build RGBA pixel buffer for one size ───
function buildPixels(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2, r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const i = (y * size + x) * 4;

      if (dist > r) {
        pixels[i] = 0; pixels[i + 1] = 0; pixels[i + 2] = 0; pixels[i + 3] = 0;
        continue;
      }
      const t = (x + y) / (2 * size);
      pixels[i] = Math.round(99 + (168 - 99) * t);
      pixels[i + 1] = Math.round(102 + (85 - 102) * t);
      pixels[i + 2] = Math.round(241 + (247 - 241) * t);
      pixels[i + 3] = 255;
    }
  }

  // White "S" via rectangle stencils, scaled to size
  const drawRect = (x0, y0, w, h) => {
    for (let y = y0; y < y0 + h && y < size; y++) {
      for (let x = x0; x < x0 + w && x < size; x++) {
        if (x < 0 || y < 0) continue;
        const i = (y * size + x) * 4;
        pixels[i] = 255; pixels[i + 1] = 255; pixels[i + 2] = 255; pixels[i + 3] = 255;
      }
    }
  };
  const sc = size / 512;
  const bw = Math.round(60 * sc);
  const top = Math.round(150 * sc);
  const mid = Math.round((size - Math.round(60 * sc)) / 2);
  const bot = Math.round(302 * sc);
  const barH = Math.round(60 * sc);
  drawRect((size - bw) / 2, top, bw, barH);
  drawRect((size - bw) / 2, mid, bw, barH);
  drawRect((size - bw) / 2, bot, bw, barH);
  drawRect((size - bw) / 2 - Math.round(90 * sc), top, Math.round(90 * sc), barH);
  drawRect((size + bw) / 2, bot, Math.round(90 * sc), barH);
  return pixels;
}

// ─── PNG encoder (RGBA) ───
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePng(size, pixels) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// ─── ICO encoder (PNG-embedded entries — Windows Vista+) ───
function encodeIco(entries) {
  const count = entries.length;
  const headerSize = 6;
  const dirSize = 16 * count;
  const dir = Buffer.alloc(dirSize);
  const imageData = [];
  let imgOffset = headerSize + dirSize;

  entries.forEach((e, i) => {
    const w = e.size >= 256 ? 0 : e.size;
    dir.writeUInt8(w, i * 16);
    dir.writeUInt8(w, i * 16 + 1);
    dir.writeUInt8(0, i * 16 + 2);
    dir.writeUInt8(0, i * 16 + 3);
    dir.writeUInt16LE(1, i * 16 + 4);
    dir.writeUInt16LE(32, i * 16 + 6);
    dir.writeUInt32LE(e.pngBuf.length, i * 16 + 8);
    dir.writeUInt32LE(imgOffset, i * 16 + 12);
    imageData.push(e.pngBuf);
    imgOffset += e.pngBuf.length;
  });

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  return Buffer.concat([header, dir, ...imageData]);
}

// ─── Write files ───
const outDir = path.resolve(__dirname, '..', 'public');
fs.mkdirSync(outDir, { recursive: true });
const outIco = path.join(outDir, 'icon.ico');
const outPng = path.join(outDir, 'icon.png');

const entries = SIZES.map(size => ({ size, pngBuf: encodePng(size, buildPixels(size)) }));
fs.writeFileSync(outIco, encodeIco(entries));
fs.writeFileSync(outPng, entries[entries.length - 1].pngBuf);
console.log(`✓ Wrote ${outIco} (${SIZES.length} sizes)`);
console.log(`✓ Wrote ${outPng}`);
