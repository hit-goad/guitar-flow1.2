#!/usr/bin/env node
/** 生成应用图标（512×512 PNG），不依赖任何图像库。 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 512;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build');

const px = new Uint8Array(SIZE * SIZE * 4);

const set = (x, y, r, g, b, a = 255) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = a;
};

const mix = (c1, c2, t) => c1.map((v, i) => Math.round(v + (c2[i] - v) * t));

// 背景：深色圆角方块 + 轻微渐变
const bgTop = [16, 20, 28];
const bgBottom = [26, 33, 48];
const radius = 96;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = Math.min(x, SIZE - 1 - x);
    const dy = Math.min(y, SIZE - 1 - y);
    let inside = true;
    if (dx < radius && dy < radius) {
      const d = Math.hypot(radius - dx, radius - dy);
      inside = d <= radius;
    }
    if (!inside) continue;
    const c = mix(bgTop, bgBottom, y / SIZE);
    set(x, y, c[0], c[1], c[2]);
  }
}

// 拨片轮廓（金色圆 + 两条弦）
const cx = 256;
const cy = 236;
const R = 128;
const gold = [255, 196, 64];
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (Math.abs(d - R) < 3.2) set(x, y, gold[0], gold[1], gold[2]);
    else if (d < R && d > R - 2.2) set(x, y, gold[0], gold[1], gold[2], 120);
  }
}
// 琴弦
for (let i = 0; i < 6; i++) {
  const offset = -60 + i * 24;
  for (let x = cx - R + 10; x <= cx + R - 10; x++) {
    const t = (x - (cx - R)) / (2 * R);
    const y = cy + offset * 0.32 + Math.sin(t * Math.PI) * (offset > 0 ? 10 : -10) * 0;
    for (let w = -1; w <= 1; w++) set(x, Math.round(y + offset * 0.0) + w - 30 + offset, 108, 199, 255, 90);
  }
}

// 中心音孔
for (let y = cy - 26; y <= cy + 26; y++) {
  for (let x = cx - 26; x <= cx + 26; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (d < 22) set(x, y, 20, 24, 32);
    if (Math.abs(d - 23) < 2) set(x, y, 255, 236, 170);
  }
}

// 底部进度条
for (let x = 96; x < SIZE - 96; x++) {
  for (let y = 404; y < 420; y++) {
    const t = (x - 96) / (SIZE - 192);
    const c = mix([108, 199, 255], [82, 215, 160], t);
    if (y < 406 || y > 417) continue;
    set(x, y, c[0], c[1], c[2], 235);
  }
}

// 编码 PNG
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'icon.png'), png);
console.log('icon ->', join(out, 'icon.png'), png.length, 'bytes');