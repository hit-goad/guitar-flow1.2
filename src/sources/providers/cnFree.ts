import type { ImportResult, ScoreDoc } from '../../core/types';
import { TUNING_STANDARD } from '../../core/types';
import { hashString } from '../../core/id';
import {
  absoluteUrl,
  autoConvertOnlineImageScores,
  extractAnchors,
  getBinary,
  registerProvider,
  safely,
  type Provider,
  type SearchHit,
} from '../base';
import { looksLikeAsciiTab } from '../../import/asciiTab';
import { importFromText } from '../../import';
import { recognizeImagePages } from '../../import/omr/omr';

/**
 * 国内免费吉他谱站聚合适配：
 *  1. 吉他屋 / 吉他谱 (https://www.jita5.cn/ & https://www.jita5.cc/)
 *  2. 吉他之家 / 吉他之友 (http://www.798com.com/)
 *  3. 17吉他网 (https://www.17jita.com/ & https://m.17jita.com/)
 *  4. 虫虫吉他 (https://www.ccguitar.cn/)
 *  5. 吉他社 (https://www.jitashe.org/)
 *  6. 爱曲谱网 (https://www.2qupu.com/jita/)
 *  7. 吉他网免费谱专区 (https://www.jita.com/wenku/list/2?feeType=free)
 *
 * 特性：
 *  - 自动探测 UTF-8 / GBK 网页编码
 *  - 若页面内含文本六线谱则直接解析为 alphaTex
 *  - 若为图片谱，抓取全部高清谱图后自动调用高精度 OMR 识谱引擎转换为可滚动、可发声的六线谱（同时保留原谱页图供随时切换对照）
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function decodeSmart(raw: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(raw);
  // 若声明了 gb2312/gbk 或出现大量 UTF-8 替换字符 ，则按 GBK 解码
  const replacementCount = (utf8.match(/\uFFFD/g) ?? []).length;
  if (/charset\s*=\s*["']?(?:gbk|gb2312|gb18030)/i.test(utf8.slice(0, 2000)) || replacementCount > 8) {
    try {
      return new TextDecoder('gbk').decode(raw);
    } catch {
      return utf8;
    }
  }
  return utf8;
}

async function getRaw(url: string, referer?: string): Promise<{ text: string; bytes: Uint8Array }> {
  const headers: Record<string, string> = { 'User-Agent': UA };
  if (referer) headers.Referer = referer;
  const bytes = await getBinary(url, { headers });
  return { text: decodeSmart(bytes), bytes };
}

function parseTitleFromHtml(text: string): string {
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(text)?.[1]?.replace(/<[^>]+>/g, ' ').trim();
  if (h1 && h1.length >= 2) return cleanTabTitle(h1);
  const m = /<title>([^<]+)<\/title>/i.exec(text);
  if (!m) return '';
  return cleanTabTitle(m[1].split(/[-_|—]/)[0].trim());
}

function cleanTabTitle(raw: string): string {
  return raw
    .replace(/《|》/g, ' ')
    .replace(/吉他谱|六线谱|指弹谱|弹唱谱|高清图片谱|原版编配|简单版|独奏谱/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从详情页抽取全部曲谱图片（自动过滤头像、二维码、Logo、广告横幅） */
export function extractScoreImages(html: string, base: string, allowHosts: string[] = []): string[] {
  const urls = new Set<string>();
  const push = (u: string) => {
    if (!u) return;
    const cleaned = u.replace(/&amp;/g, '&').trim();
    const abs = absoluteUrl(base, cleaned);
    if (!/\.(?:png|jpe?g|webp|gif)(?:\?|$)/i.test(abs)) return;
    if (/logo|qrcode|avatar|icon|banner|ad|weixin|微信|static\/images|avatar_|btn_|smilies|common\/|favicon|poster\/images/i.test(abs)) {
      return;
    }
    if (allowHosts.length && !allowHosts.some((h) => abs.includes(h))) return;
    urls.add(abs);
  };
  for (const m of html.matchAll(/<img\b[^>]*?\b(?:src|data-src|data-original|zoomfile|file)=["']([^"']+)["']/gi)) {
    push(m[1]);
  }
  for (const m of html.matchAll(/\b(?:zoomfile|litpic|pic|imgUrl|image_url)\s*[:=]\s*["']([^"']+)["']/gi)) {
    push(m[1]);
  }
  return [...urls];
}

async function downloadImageBlobs(urls: string[], referer: string, label: string, maxPages = 14): Promise<Blob[]> {
  const blobs: Blob[] = [];
  for (const img of urls.slice(0, maxPages)) {
    const bytes = await safely(
      () => getBinary(img, { headers: { 'User-Agent': UA, Referer: referer } }),
      new Uint8Array(),
      label,
    );
    if (bytes.length < 4500) continue;
    const mime = /\.png(?:\?|$)/i.test(img)
      ? 'image/png'
      : /\.webp(?:\?|$)/i.test(img)
        ? 'image/webp'
        : 'image/jpeg';
    blobs.push(new Blob([bytes as unknown as BlobPart], { type: mime }));
  }
  return blobs;
}

/**
 * 将抓取到的多张谱图构建为 ScoreDoc：
 * 若开启了自动识谱转换（默认开启），立即运行高精度六线谱 OMR 转换为可滚动 alphaTex 曲谱，
 * 同时保留原谱页图 pages 供用户在阅读器顶部一键切换「可滚动六线谱 / 原谱图对照」。
 */
async function toSmartScoreDoc(
  opts: { id: string; sourceId: string; sourceName: string; title: string; artist: string; url: string },
  images: Blob[],
): Promise<ImportResult> {
  const cleanId = opts.id.replace(/[^a-zA-Z0-9_-]/g, '_');

  if (autoConvertOnlineImageScores && typeof document !== 'undefined' && images.length > 0) {
    try {
      const omr = await recognizeImagePages(images, {
        title: opts.title || '未命名曲谱',
        artist: opts.artist,
        tempo: 100,
        resolveChordX: true,
      });
      if (omr.glyphs > 0 && omr.alphaTex.trim()) {
        const doc: ScoreDoc = {
          id: `${opts.sourceId}_${cleanId}`,
          title: opts.title || '未命名曲谱',
          artist: opts.artist,
          format: 'alphatex',
          text: omr.alphaTex,
          pages: images,
          sourceId: opts.sourceId,
          sourceName: opts.sourceName,
          sourceUrl: opts.url,
          meta: {
            bpm: 100,
            tuning: TUNING_STANDARD,
            noteCount: omr.glyphs,
            omrAscii: omr.ascii,
            chords: omr.chords,
            omrConfidence: omr.confidence,
            pageStarts: images.map((_, i) => i * 20),
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
          hash: hashString(`${opts.sourceId}:${cleanId}:${omr.alphaTex.length}`),
        };
        return {
          doc,
          warnings: [
            `已从「${opts.sourceName}」抓取 ${images.length} 页谱图并精准转换为可滚动六线谱（${omr.measures} 小节 / ${omr.glyphs} 音符，顶部可切换原谱图）`,
          ],
        };
      }
    } catch {
      /* 若自动 OMR 未命中则平滑回退页图模式 */
    }
  }

  const doc: ScoreDoc = {
    id: `${opts.sourceId}_${cleanId}`,
    title: opts.title || '未命名曲谱',
    artist: opts.artist,
    format: 'image',
    pages: images,
    sourceId: opts.sourceId,
    sourceName: opts.sourceName,
    sourceUrl: opts.url,
    meta: { tuning: TUNING_STANDARD, pageStarts: images.map((_, i) => i * 20) },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hash: hashString(`${opts.sourceId}:${cleanId}:${images.length}`),
  };
  return {
    doc,
    warnings: ['已抓取高清图片谱，可在阅读器顶部点「⚡ 转为可滚动谱」或使用「打点同步」跟随滚动'],
  };
}

/* ------------------------------------------------------------------ */
/* 1. 吉他屋 www.jita5.cn / www.jita5.cc                               */
/* ------------------------------------------------------------------ */

async function jita5Search(query: string): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();

  const candidates = [
    { url: `https://www.jita5.cn/search?search=${encodeURIComponent(query)}`, origin: 'https://www.jita5.cn' },
    { url: `https://m.jita5.cn/search?search=${encodeURIComponent(query)}`, origin: 'https://m.jita5.cn' },
    { url: `https://www.jita5.cc/search.php?q=${encodeURIComponent(query)}`, origin: 'https://www.jita5.cc' },
  ];

  for (const cand of candidates) {
    const { text } = await safely(() => getRaw(cand.url, cand.origin + '/'), { text: '', bytes: new Uint8Array() }, 'jita5-search');
    if (!text) continue;

    // 匹配 /qupu/xxx/123.html 或 /jitapu/123.html
    const re = /href=["']((?:https?:\/\/[^"']*?)?\/(?:qupu\/[a-z0-9_-]+\/\d+|jitapu\/\d+)\.html)["'][^>]*>([\s\S]{0,260}?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const [, rawHref, inner] = m;
      const abs = absoluteUrl(cand.origin, rawHref);
      const idMatch = /\/((?:qupu\/[a-z0-9_-]+\/\d+|jitapu\/\d+))\.html/i.exec(abs);
      const id = idMatch ? idMatch[1] : abs;
      if (seen.has(id)) continue;
      const clean = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const alt = /alt=["']([^"']+)["']/i.exec(inner)?.[1] ?? '';
      const rawTitle = clean || alt;
      if (!rawTitle || rawTitle.length < 2) continue;
      seen.add(id);

      const parts = rawTitle.split('_').map((s) => s.trim()).filter(Boolean);
      const title = cleanTabTitle(parts[0] || rawTitle);
      const artist = parts.length > 1 && !/调|谱|教学/.test(parts[1]) ? parts[1] : '';

      hits.push({
        providerId: 'jita5',
        sourceId: 'jita5',
        sourceName: '吉他屋 jita5',
        id,
        title: title || rawTitle,
        artist,
        url: abs,
        quality: 82,
        gated: false,
        preview: '免费高清六线谱（自动转可滚动谱）',
      });
      if (hits.length >= 20) return hits;
    }
  }
  return hits;
}

async function jita5Load(hit: SearchHit): Promise<ImportResult> {
  const url = hit.url ?? `https://www.jita5.cn/${hit.id}.html`;
  const origin = new URL(url).origin;
  const { text: html } = await getRaw(url, origin + '/');
  const images = extractScoreImages(html, url, ['jita5.cn', 'jita5.cc']);
  if (!images.length) throw new Error('页面里没有找到谱图（可能链接已失效）');
  const blobs = await downloadImageBlobs(images, url, 'jita5');
  if (!blobs.length) throw new Error('吉他屋谱图下载失败');
  return toSmartScoreDoc(
    {
      id: hit.id,
      sourceId: 'jita5',
      sourceName: '吉他屋 jita5',
      title: hit.title || parseTitleFromHtml(html),
      artist: hit.artist,
      url,
    },
    blobs,
  );
}

/* ------------------------------------------------------------------ */
/* 2. 吉他之家 www.798com.com                                          */
/* ------------------------------------------------------------------ */

let cachedFormhash = '';
let formhashAt = 0;

async function formhash(): Promise<string> {
  if (cachedFormhash && Date.now() - formhashAt < 30 * 60 * 1000) return cachedFormhash;
  const { text } = await safely(() => getRaw('http://www.798com.com/', 'http://www.798com.com/'), { text: '', bytes: new Uint8Array() }, '798-fh');
  const m = /formhash=([0-9a-f]{6,})/i.exec(text);
  cachedFormhash = m?.[1] ?? '';
  formhashAt = Date.now();
  return cachedFormhash;
}

async function c798Search(query: string): Promise<SearchHit[]> {
  const fh = await formhash();
  const urls = [
    `http://www.798com.com/search.php?mod=portal&srchtxt=${encodeURIComponent(query)}&searchsubmit=yes${fh ? `&formhash=${fh}` : ''}`,
    `http://www.798com.com/search.php?mod=forum&srchtxt=${encodeURIComponent(query)}&searchsubmit=true&source=hotsearch${fh ? `&formhash=${fh}` : ''}`,
  ];
  const hits: SearchHit[] = [];
  const seen = new Set<string>();

  for (const searchUrl of urls) {
    const { text } = await safely(() => getRaw(searchUrl, 'http://www.798com.com/'), { text: '', bytes: new Uint8Array() }, '798-search');
    if (!text) continue;
    for (const m of text.matchAll(/href=["'](?:https?:\/\/[^"']*)?(?:article-|thread-)(\d+)-\d+(?:-\d+)?\.html["'][^>]*>([\s\S]{0,180}?)<\/a>/gi)) {
      const id = m[1];
      if (seen.has(id)) continue;
      const rawTitle = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!rawTitle || rawTitle.length < 2) continue;
      seen.add(id);
      hits.push({
        providerId: 'c798',
        sourceId: 'c798',
        sourceName: '吉他之家 798',
        id,
        title: cleanTabTitle(rawTitle) || rawTitle,
        artist: '',
        url: `http://www.798com.com/article-${id}-1.html`,
        quality: 78,
        gated: false,
        preview: '免费六线谱（自动转可滚动谱）',
      });
      if (hits.length >= 20) return hits;
    }
  }
  return hits;
}

async function c798Load(hit: SearchHit): Promise<ImportResult> {
  const candidates = [
    hit.url ?? `http://www.798com.com/article-${hit.id}-1.html`,
    `http://m.798com.com/article-${hit.id}-1.html`,
    `http://www.798com.com/thread-${hit.id}-1-1.html`,
  ];
  for (const url of candidates) {
    const { text: html } = await safely(() => getRaw(url, 'http://www.798com.com/'), { text: '', bytes: new Uint8Array() }, 'c798-load');
    if (!html) continue;
    const textish = html.replace(/<[^>]+>/g, '\n');
    if (looksLikeAsciiTab(textish)) {
      return importFromText(textish, {
        title: hit.title || parseTitleFromHtml(html),
        artist: hit.artist,
        sourceId: 'c798',
        sourceName: '吉他之家 798',
        url,
      });
    }
    const images = extractScoreImages(html, url, ['798com.com']);
    if (!images.length) continue;
    const blobs = await downloadImageBlobs(images, url, 'c798');
    if (blobs.length) {
      return toSmartScoreDoc(
        { id: hit.id, sourceId: 'c798', sourceName: '吉他之家 798', title: hit.title || parseTitleFromHtml(html), artist: hit.artist, url },
        blobs,
      );
    }
  }
  throw new Error('吉他之家帖子中未找到可用谱图');
}

/* ------------------------------------------------------------------ */
/* 3. 17吉他网 www.17jita.com / m.17jita.com                           */
/* ------------------------------------------------------------------ */

async function jita17Search(query: string): Promise<SearchHit[]> {
  const urls = [
    `https://www.17jita.com/search.php?keyword=${encodeURIComponent(query)}`,
    `https://m.17jita.com/search.php?keyword=${encodeURIComponent(query)}`,
  ];
  const hits: SearchHit[] = [];
  const seen = new Set<string>();

  for (const u of urls) {
    const { text } = await safely(() => getRaw(u, 'https://www.17jita.com/'), { text: '', bytes: new Uint8Array() }, '17jita-search');
    if (!text) continue;
    const anchors = extractAnchors(text, /\/(?:tab\/img|tab|article|jitapu)\/\d+/i);
    for (const a of anchors) {
      const m = /\/((?:tab\/img|tab|article|jitapu)\/\d+)/i.exec(a.href);
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      const abs = absoluteUrl('https://m.17jita.com/', a.href);
      hits.push({
        providerId: 'jita17',
        sourceId: 'jita17',
        sourceName: '17吉他网',
        id,
        title: cleanTabTitle(a.text) || a.text,
        artist: '',
        url: abs,
        quality: 80,
        gated: false,
        preview: '免费高清六线谱（自动转可滚动谱）',
      });
      if (hits.length >= 20) return hits;
    }
  }
  return hits;
}

async function jita17Load(hit: SearchHit): Promise<ImportResult> {
  const url = hit.url ?? `https://m.17jita.com/${hit.id}.html`;
  const { text: html } = await getRaw(url, 'https://www.17jita.com/');
  const allImgUrls = extractScoreImages(html, url, ['17jita.com']);

  // 17吉他网多页图片谱常常带 _2.html, _3.html 分页
  const baseNoExt = url.replace(/\.html$/i, '');
  for (let p = 2; p <= 4; p++) {
    const pageUrl = `${baseNoExt}_${p}.html`;
    if (!html.includes(`_${p}.html`)) break;
    const { text: subHtml } = await safely(() => getRaw(pageUrl, url), { text: '', bytes: new Uint8Array() }, '17jita-page');
    if (subHtml) {
      for (const u of extractScoreImages(subHtml, pageUrl, ['17jita.com'])) {
        if (!allImgUrls.includes(u)) allImgUrls.push(u);
      }
    }
  }

  const textish = html.replace(/<[^>]+>/g, '\n');
  if (looksLikeAsciiTab(textish) && textish.length > 200) {
    return importFromText(textish, {
      title: hit.title || parseTitleFromHtml(html),
      artist: hit.artist,
      sourceId: 'jita17',
      sourceName: '17吉他网',
      url,
    });
  }

  if (!allImgUrls.length) throw new Error('17吉他网页面未找到谱图');
  const blobs = await downloadImageBlobs(allImgUrls, url, 'jita17');
  if (!blobs.length) throw new Error('17吉他网谱图下载失败');
  return toSmartScoreDoc(
    { id: hit.id, sourceId: 'jita17', sourceName: '17吉他网', title: hit.title || parseTitleFromHtml(html), artist: hit.artist, url },
    blobs,
  );
}

/* ------------------------------------------------------------------ */
/* 4. 虫虫吉他 www.ccguitar.cn                                         */
/* ------------------------------------------------------------------ */

async function ccguitarSearch(query: string): Promise<SearchHit[]> {
  const urls = [
    `https://www.ccguitar.cn/pu_search.htm?keyword=${encodeURIComponent(query)}`,
    `https://www.ccguitar.cn/search.htm?keyword=${encodeURIComponent(query)}`,
  ];
  const hits: SearchHit[] = [];
  const seen = new Set<string>();

  for (const u of urls) {
    const { text } = await safely(() => getRaw(u, 'https://www.ccguitar.cn/'), { text: '', bytes: new Uint8Array() }, 'ccguitar-search');
    if (!text) continue;
    const anchors = extractAnchors(text, /\/(?:cchtml|wy_html)\/\d+\.htm/i);
    for (const a of anchors) {
      const m = /\/((?:cchtml|wy_html)\/\d+)\.htm/i.exec(a.href);
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      hits.push({
        providerId: 'ccguitar',
        sourceId: 'ccguitar',
        sourceName: '虫虫吉他',
        id,
        title: cleanTabTitle(a.text) || a.text,
        artist: '',
        url: absoluteUrl('https://www.ccguitar.cn/', a.href),
        quality: 80,
        gated: false,
        preview: '免费六线谱（自动转可滚动谱）',
      });
      if (hits.length >= 20) return hits;
    }
  }
  return hits;
}

async function ccguitarLoad(hit: SearchHit): Promise<ImportResult> {
  const url = hit.url ?? `https://www.ccguitar.cn/${hit.id}.htm`;
  const { text: html } = await getRaw(url, 'https://www.ccguitar.cn/');
  const images = extractScoreImages(html, url, ['lzjoy.com', 'ccguitar.cn']);
  if (!images.length) throw new Error('虫虫吉他详情页未找到可下载谱图');
  const blobs = await downloadImageBlobs(images, url, 'ccguitar');
  if (!blobs.length) throw new Error('虫虫吉他谱图下载失败');
  return toSmartScoreDoc(
    { id: hit.id, sourceId: 'ccguitar', sourceName: '虫虫吉他', title: hit.title || parseTitleFromHtml(html), artist: hit.artist, url },
    blobs,
  );
}

/* ------------------------------------------------------------------ */
/* 5. 吉他社 www.jitashe.org                                           */
/* ------------------------------------------------------------------ */

async function jitasheSearch(query: string): Promise<SearchHit[]> {
  const urls = [
    `https://www.jitashe.org/search/tab/?kw=${encodeURIComponent(query)}`,
    `https://www.jitashe.org/search.php?mod=tab&srchtxt=${encodeURIComponent(query)}`,
  ];
  const hits: SearchHit[] = [];
  const seen = new Set<string>();

  for (const u of urls) {
    const { text } = await safely(() => getRaw(u, 'https://www.jitashe.org/'), { text: '', bytes: new Uint8Array() }, 'jitashe-search');
    if (!text) continue;
    const anchors = extractAnchors(text, /\/tab\/\d+/i);
    for (const a of anchors) {
      const m = /\/tab\/(\d+)/i.exec(a.href);
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      hits.push({
        providerId: 'jitashe',
        sourceId: 'jitashe',
        sourceName: '吉他社',
        id,
        title: cleanTabTitle(a.text) || a.text,
        artist: '',
        url: absoluteUrl('https://www.jitashe.org/', a.href),
        quality: 78,
        gated: false,
        preview: '免费社区吉他谱（自动转可滚动谱）',
      });
      if (hits.length >= 20) return hits;
    }
  }
  return hits;
}

async function jitasheLoad(hit: SearchHit): Promise<ImportResult> {
  const url = hit.url ?? `https://www.jitashe.org/tab/${hit.id}/`;
  const { text: html } = await getRaw(url, 'https://www.jitashe.org/');
  const images = extractScoreImages(html, url, ['jitashe']);
  if (!images.length) throw new Error('吉他社详情页未找到谱图');
  const blobs = await downloadImageBlobs(images, url, 'jitashe');
  if (!blobs.length) throw new Error('吉他社谱图下载失败');
  return toSmartScoreDoc(
    { id: hit.id, sourceId: 'jitashe', sourceName: '吉他社', title: hit.title || parseTitleFromHtml(html), artist: hit.artist, url },
    blobs,
  );
}

/* ------------------------------------------------------------------ */
/* 6. 爱曲谱网 www.2qupu.com/jita/                                     */
/* ------------------------------------------------------------------ */

async function qupu2Search(query: string): Promise<SearchHit[]> {
  const urls = [
    `https://www.2qupu.com/search.php?q=${encodeURIComponent(query)}`,
    `https://m.2qupu.com/search.php?q=${encodeURIComponent(query)}`,
  ];
  const hits: SearchHit[] = [];
  const seen = new Set<string>();

  for (const u of urls) {
    const { text } = await safely(() => getRaw(u, 'https://www.2qupu.com/jita/'), { text: '', bytes: new Uint8Array() }, '2qupu-search');
    if (!text) continue;
    const anchors = extractAnchors(text, /\/(?:jita|qupu)\/\d+\.html/i);
    for (const a of anchors) {
      const m = /\/((?:jita|qupu)\/\d+)\.html/i.exec(a.href);
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      hits.push({
        providerId: 'qupu2',
        sourceId: 'qupu2',
        sourceName: '爱曲谱网',
        id,
        title: cleanTabTitle(a.text) || a.text,
        artist: '',
        url: absoluteUrl('https://www.2qupu.com/', a.href),
        quality: 74,
        gated: false,
        preview: '免费吉他曲谱',
      });
      if (hits.length >= 20) return hits;
    }
  }
  return hits;
}

async function qupu2Load(hit: SearchHit): Promise<ImportResult> {
  const url = hit.url ?? `https://www.2qupu.com/${hit.id}.html`;
  const { text: html } = await getRaw(url, 'https://www.2qupu.com/jita/');
  const images = extractScoreImages(html, url);
  if (!images.length) throw new Error('爱曲谱网页面未找到谱图');
  const blobs = await downloadImageBlobs(images, url, 'qupu2');
  if (!blobs.length) throw new Error('爱曲谱网谱图下载失败');
  return toSmartScoreDoc(
    { id: hit.id, sourceId: 'qupu2', sourceName: '爱曲谱网', title: hit.title || parseTitleFromHtml(html), artist: hit.artist, url },
    blobs,
  );
}

/* ------------------------------------------------------------------ */
/* 7. 吉他网免费专区 www.jita.com/wenku/list/2?feeType=free            */
/* ------------------------------------------------------------------ */

async function jitaComSearch(query: string): Promise<SearchHit[]> {
  const u = `https://www.jita.com/wenku/list/2?feeType=free&keyword=${encodeURIComponent(query)}`;
  const { text } = await safely(() => getRaw(u, 'https://www.jita.com/'), { text: '', bytes: new Uint8Array() }, 'jitacom-search');
  if (!text) return [];
  const anchors = extractAnchors(text, /\/(?:wenku|pu|tab)\/[^\s"']*?\d+/i);
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const a of anchors) {
    const m = /(\d{3,})/.exec(a.href);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    hits.push({
      providerId: 'jitaCom',
      sourceId: 'jitaCom',
      sourceName: '吉他网免费谱',
      id,
      title: cleanTabTitle(a.text) || a.text,
      artist: '',
      url: absoluteUrl('https://www.jita.com/', a.href),
      quality: 75,
      gated: false,
      preview: '免费专区六线谱',
    });
    if (hits.length >= 20) break;
  }
  return hits;
}

async function jitaComLoad(hit: SearchHit): Promise<ImportResult> {
  const url = hit.url ?? `https://www.jita.com/wenku/detail/${hit.id}`;
  const { text: html } = await getRaw(url, 'https://www.jita.com/');
  const images = extractScoreImages(html, url, ['jita.com']);
  if (!images.length) throw new Error('吉他网页面未找到免费谱图');
  const blobs = await downloadImageBlobs(images, url, 'jitaCom');
  if (!blobs.length) throw new Error('吉他网谱图下载失败');
  return toSmartScoreDoc(
    { id: hit.id, sourceId: 'jitaCom', sourceName: '吉他网免费谱', title: hit.title || parseTitleFromHtml(html), artist: hit.artist, url },
    blobs,
  );
}

export const jita5Provider: Provider = {
  id: 'jita5',
  name: '吉他屋 jita5 (jita5.cn)',
  note: '免费高清弹唱/指弹谱，支持整页抓取与自动转可滚动谱',
  gated: false,
  search: jita5Search,
  load: jita5Load,
};

export const c798Provider: Provider = {
  id: 'c798',
  name: '吉他之家 798 (798com.com)',
  note: '免费论坛吉他谱/TXT谱，自动转可滚动谱',
  gated: false,
  search: c798Search,
  load: c798Load,
};

export const jita17Provider: Provider = {
  id: 'jita17',
  name: '17吉他网 (17jita.com)',
  note: '免费C/G调新手弹唱与指弹六线谱，支持多页合并识谱',
  gated: false,
  search: jita17Search,
  load: jita17Load,
};

export const ccguitarProvider: Provider = {
  id: 'ccguitar',
  name: '虫虫吉他 (ccguitar.cn)',
  note: '免费民谣吉他六线谱与指弹谱，高清图自动转可滚动谱',
  gated: false,
  search: ccguitarSearch,
  load: ccguitarLoad,
};

export const jitasheProvider: Provider = {
  id: 'jitashe',
  name: '吉他社 (jitashe.org)',
  note: '免费吉他社区曲谱，自动转可滚动谱',
  gated: false,
  search: jitasheSearch,
  load: jitasheLoad,
};

export const qupu2Provider: Provider = {
  id: 'qupu2',
  name: '爱曲谱网 (2qupu.com)',
  note: '免费吉他弹唱谱与曲谱大全',
  gated: false,
  search: qupu2Search,
  load: qupu2Load,
};

export const jitaComProvider: Provider = {
  id: 'jitaCom',
  name: '吉他网免费区 (jita.com)',
  note: '吉他网免费弹唱谱与指弹谱文库',
  gated: false,
  search: jitaComSearch,
  load: jitaComLoad,
};

[
  jita5Provider,
  c798Provider,
  jita17Provider,
  ccguitarProvider,
  jitasheProvider,
  qupu2Provider,
  jitaComProvider,
].forEach(registerProvider);

export { extractAnchors };