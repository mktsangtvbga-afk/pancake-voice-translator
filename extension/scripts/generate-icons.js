/**
 * One-off generator for extension/icons/icon{16,48,128}.png — no image
 * libraries available in this environment, so this builds valid PNGs by
 * hand (raw RGBA -> zlib-deflated scanlines -> PNG chunks with real CRC32).
 * Run once: `node scripts/generate-icons.js`. Safe to delete afterwards;
 * re-run it any time you want to regenerate the icons from scratch.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'icons');
const BG = [9, 105, 218]; // #0969da — same accent used in popup styles.css
const BAR = [255, 255, 255];

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgbaPixels) {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Raw scanlines, each prefixed with filter-type byte 0 (none).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgbaPixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idatData = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Rounded-square background + a simple 3-bar "sound wave" glyph. */
function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const radius = Math.round(size * 0.22);

  const insideRoundedSquare = (x, y) => {
    const cornerBoxes = [
      [radius, radius],
      [size - radius, radius],
      [radius, size - radius],
      [size - radius, size - radius],
    ];
    const inCornerZone = (x < radius || x >= size - radius) && (y < radius || y >= size - radius);
    if (!inCornerZone) return true;
    const [cx, cy] = cornerBoxes.reduce((closest, box) => {
      const d = (x - box[0]) ** 2 + (y - box[1]) ** 2;
      const dc = (x - closest[0]) ** 2 + (y - closest[1]) ** 2;
      return d < dc ? box : closest;
    });
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  };

  // 3 bars of a sound wave, centered, varying height (short-tall-short).
  const barCount = 3;
  const barWidth = Math.max(1, Math.round(size * 0.12));
  const gap = Math.max(1, Math.round(size * 0.08));
  const totalWidth = barCount * barWidth + (barCount - 1) * gap;
  const startX = Math.round((size - totalWidth) / 2);
  const heights = [0.38, 0.62, 0.38].map((h) => Math.round(size * h));
  const bars = heights.map((h, i) => ({
    x0: startX + i * (barWidth + gap),
    x1: startX + i * (barWidth + gap) + barWidth,
    y0: Math.round((size - h) / 2),
    y1: Math.round((size - h) / 2) + h,
  }));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      if (!insideRoundedSquare(x, y)) {
        buf[idx] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
        buf[idx + 3] = 0; // transparent outside the rounded square
        continue;
      }
      const inBar = bars.some((b) => x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1);
      const [r, g, b] = inBar ? BAR : BG;
      buf[idx] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
      buf[idx + 3] = 255;
    }
  }
  return buf;
}

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

for (const size of [16, 48, 128]) {
  const pixels = drawIcon(size);
  const png = encodePng(size, size, pixels);
  const outPath = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(outPath, png);
  console.log(`wrote ${outPath} (${png.length} bytes)`);
}
