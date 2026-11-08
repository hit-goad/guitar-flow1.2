#!/usr/bin/env node
/**
 * 扫描本地谱图文件夹，生成「曲库索引」打进应用：
 *   node scripts/build-library.mjs --src "G:\\吉他谱1" --out src/data/library-index.json
 *
 * 只写索引（歌名/歌手/页数/文件名），不复制图片——图片体积太大，
 * 由用户在应用里选一次文件夹，即可把对应页图存进本地曲库。
 */
import { readdir, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, extname, basename } from 'node:path';
import { argv, exit } from 'node:process';

const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const srcDir = resolve(arg('src', process.env.LIBRARY_SRC || ''));
const outFile = resolve(arg('out', 'src/data/library-index.json'));

const PAGE_SUFFIX = /(?:[-_\s]*(?:吉他谱|指弹吉他谱|指弹谱|弹唱谱|六线谱|独奏谱)?[-_\s]*)(\d{1,2})$/;
const LEAD_PAGE = /^(\d{1,2})(?=[一-龥A-Za-z])/;
const NOISE = /(吉他谱|指弹吉他谱|指弹谱|弹唱谱|六线谱|独奏谱|原版|高清|完整|图片谱|谱)/g;
const QUOTES = /[《》「」“”\"']/g;

function parseName(file) {
  let base = basename(file, extname(file)).replace(/[（(].*?[)）]/g, ' ').replace(QUOTES, '');
  let page = 0;
  const tail = PAGE_SUFFIX.exec(base);
  if (tail) {
    page = parseInt(tail[1], 10);
    base = base.slice(0, tail.index);
  }
  const head = LEAD_PAGE.exec(base.trim());
  if (head && base.trim().length - head[1].length >= 2) {
    if (!page) page = parseInt(head[1], 10);
    base = base.trim().slice(head[1].length);
  }
  let title = base.replace(NOISE, ' ').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  // 形如 "歌手 - 曲名" 才拆分艺人，避免把 "500 miles" 误拆
  let artist = '';
  const sep = /\s+-\s+|\s+–\s+|\s+—\s+/.exec(title);
  if (sep) {
    artist = title.slice(0, sep.index).trim();
    title = title.slice(sep.index + sep[0].length).trim();
  }
  return { title: title || base.trim(), artist, page };
}

async function main() {
  if (!srcDir) {
    console.error('用法: node scripts/build-library.mjs --src "G:\\吉他谱1" [--out src/data/library-index.json]');
    exit(2);
  }
  const files = (await readdir(srcDir)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  const groups = new Map();
  for (const f of files) {
    const { title, artist, page } = parseName(f);
    const key = `${artist}|${title}`.toLowerCase();
    const g = groups.get(key) ?? { title, artist, files: [], pages: 0 };
    g.files.push({ file: f, page });
    g.pages = Math.max(g.pages, page || 0);
    groups.set(key, g);
  }

  const entries = [...groups.entries()]
    .map(([key, g]) => {
      const ordered = g.files.sort((a, b) => a.page - b.page);
      return {
        id: key.replace(/[^\w\u4e00-\u9fa5]+/g, '_').slice(0, 80),
        title: g.title,
        artist: g.artist,
        note: '',
        pages: Math.max(ordered.length, g.pages),
        files: ordered.map((x) => x.file),
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceDir: srcDir,
    totalFiles: files.length,
    totalSongs: entries.length,
    entries,
  };

  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, JSON.stringify(payload), 'utf8');
  console.log(`索引已生成：${outFile}`);
  console.log(`  谱图 ${files.length} 张 → 曲目 ${entries.length} 首`);
  console.log(`  示例：${entries.slice(0, 3).map((e) => `${e.artist ? e.artist + ' · ' : ''}${e.title} (${e.pages}页)`).join(' | ')}`);
}

await main();