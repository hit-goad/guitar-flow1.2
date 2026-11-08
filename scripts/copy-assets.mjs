#!/usr/bin/env node
/**
 * 复制 alphaTab 的 Bravura 音乐字体到 public/font，供离线渲染使用。
 * 失败不影响安装（字体缺失时 alphaTab 会退回内置绘制，但排版会变差）。
 */
import { cp, mkdir, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const from = join(root, 'node_modules', '@coderline', 'alphatab', 'dist', 'font');
const to = join(root, 'public', 'font');

try {
  if (!existsSync(from)) {
    console.log('[assets] alphaTab 字体目录不存在，跳过');
    process.exit(0);
  }
  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true, force: true });
  console.log('[assets] 已复制 alphaTab 字体 ->', to);
} catch (err) {
  console.warn('[assets] 字体复制失败（可忽略）:', err?.message ?? err);
}