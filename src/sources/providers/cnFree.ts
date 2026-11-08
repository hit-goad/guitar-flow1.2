import type { ImportResult, ScoreDoc } from '../../core/types';
import { TUNING_STANDARD } from '../../core/types';
import { hashString } from '../../core/id';
import {
  absoluteUrl,
  extractAnchors,
  getBinary,
  getHtml,
  registerProvider,
  safely,
  type Provider,
  type SearchHit,
} from '../base';
import { looksLikeAsciiTab } from '../../import/asciiTab';
import { importFromText } from '../../import';

/**
 * 国内免费谱站适配：吉他谱(www.jita5.cn) 与 吉他之友(www.798com.com)。
 * 两者都是「图片谱」，抓下来后进入页图模式；页面若含文本六线谱则直接转换。
 * 注意：两个站点都是 GBK 编码，标题要用 GBK 解码，链接部分是 ASCII 不受影响。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function decodeGb(raw: Uint8Array): string {
  try {
    return new TextDecoder('gbk').decode(raw);
  } catch {
    return new TextDecoder('utf-8').decode(raw);
  }
}

async function getRaw(url: string, referer?: string): Promise<{ text: string; bytes: Uint8Array }> {
  const headers: Record<string, string> = { 'User-Agent': UA };
  if (referer) headers.Referer = referer;
  // base.httpGet 返回文本时按 utf-8 解，这里需要原始字节，因此走 binary 通道
  const bytes = await getBinary(url, { headers });
  return { text: decodeGb(bytes), bytes };
}

function parseTitleFromHtml(text: string): string {
  const m = /<title>([^<]+)<\/title>/i.exec(text);
  if (!m) return '';
  return m[1].split(/[_-]/)[0].trim();
}

/** 从详情页里抽取谱图（排除 logo / 二维码 / 广告） */
function extractScoreImages(html: string, base: string, allowHosts: string[]): string[] {
  const urls = new Set<string>();
  const push = (u: string) => {
    if (!u) return;
    const abs = absoluteUrl(base, u.trim());
    if (!/\.(?:png|jpe?g|webp)(?:\?|$)/i.test(abs)) return;
    if (/logo|qrcode|avatar|icon|banner|ad|gif|weixin|微信/i.test(abs)) return;
    if (allowHosts.length && !allowHosts.some((h) => abs.includes(h))) return;
    urls.add(abs);
  };
  for (const m of html.matchAll(/<img\b[^>]*\b(?:src|data-src|data-original)=["']([^"']+)["']/gi)) push(m[1]);
  for (const m of html.matchAll(/\b(?:file|zoomfile|litpic|pic)=["']([^"']+)["']/gi)) push(m[1]);
  return [...urls];
}

function toImageDoc(
  opts: { id: string; sourceId: string; sourceName: string; title: string; artist: string; url: string },
  images: Blob[],
): ImportResult {
  const doc: ScoreDoc = {
    id: `${opts.sourceId}_${opts.id}`,
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
    hash: hashString(`${opts.sourceId}:${opts.id}:${images.length}`),
  };
  return { doc, warnings: ['这是图片谱，可用「打点同步」让页面跟随；也可在导入页尝试图片识谱'] };
}

/* ------------------------------------------------------------------ */
/* 吉他谱 www.jita5.cn                                                 */
/* ------------------------------------------------------------------ */

async function jita5Search(query: string): Promise<SearchHit[]> {
  const { text } = await getRaw(`https://www.jita5.cn/search?search=${encodeURIComponent(query)}`, 'https://www.jita5.cn/');
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const re = /href="(\/qupu\/([a-z0-9]+)\/(\d+)\.html)"[^>]*>([\s\S]{0,220}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const [, path, slug, id, inner] = m;
    if (seen.has(id)) continue;
    seen.add(id);
    const clean = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const alt = /alt="([^"]+)"/i.exec(inner)?.[1] ?? '';
    const raw = clean || alt;
    if (!raw) continue;
    const title = raw.replace(/_/g, ' ').replace(/吉他谱|六线谱|指弹谱|弹唱谱/g, '').trim();
    hits.push({
      providerId: 'jita5',
      sourceId: 'jita5',
      sourceName: '吉他谱 jita5',
      id: `${slug}/${id}`,
      title: title || '未命名',
      artist: slug,
      url: `https://www.jita5.cn${path}`,
      quality: 68,
      gated: false,
      preview: '图片谱',
    });
    if (hits.length >= 20) break;
  }
  return hits;
}

async function jita5Load(hit: SearchHit): Promise<ImportResult> {
  const url = hit.url ?? `https://www.jita5.cn/qupu/${hit.id}.html`;
  const { text: html } = await getRaw(url, 'https://www.jita5.cn/');
  const images = extractScoreImages(html, url, ['img.jita5.cn']);
  if (!images.length) throw new Error('页面里没有找到谱图（可能需要登录或该谱已下架）');
  const blobs: Blob[] = [];
  for (const img of images.slice(0, 12)) {
    const bytes = await safely(() => getBinary(img, { headers: { 'User-Agent': UA, Referer: url } }), new Uint8Array(), 'jita5');
    if (bytes.length < 5000) continue;
    blobs.push(new Blob([bytes as unknown as BlobPart], { type: img.endsWith('.png') ? 'image/png' : 'image/jpeg' }));
  }
  if (!blobs.length) throw new Error('谱图下载失败');
  return toImageDoc(
    { id: hit.id.replace('/', '_'), sourceId: 'jita5', sourceName: '吉他谱 jita5', title: hit.title, artist: hit.artist, url },
    blobs,
  );
}

/* ------------------------------------------------------------------ */
/* 吉他之友 www.798com.com                                             */
/* ------------------------------------------------------------------ */

let cachedFormhash = '';
let formhashAt = 0;

async function formhash(): Promise<string> {
  if (cachedFormhash && Date.now() - formhashAt < 30 * 60 * 1000) return cachedFormhash;
  const { text } = await getRaw('http://www.798com.com/', 'http://www.798com.com/');
  const m = /formhash=([0-9a-f]{6,})/i.exec(text);
  cachedFormhash = m?.[1] ?? '';
  formhashAt = Date.now();
  return cachedFormhash;
}

async function c798Search(query: string): Promise<SearchHit[]> {
  const fh = await formhash();
  const url =
    `http://www.798com.com/search.php?mod=forum&srchtxt=${encodeURIComponent(query)}` +
    `&searchsubmit=true&source=hotsearch${fh ? `&formhash=${fh}` : ''}`;
  const { text } = await getRaw(url, 'http://www.798com.com/');
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/href="(?:https?:\/\/[^"]*)?(?:article-|thread-)(\d+)-\d+-\d+\.html"[^>]*>([\s\S]{0,160}?)<\/a>/gi)) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const title = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 2) continue;
    hits.push({
      providerId: 'c798',
      sourceId: 'c798',
      sourceName: '吉他之友 798',
      id,
      title,
      artist: '',
      url: `http://www.798com.com/article-${id}-1.html`,
      quality: 60,
      gated: false,
      preview: '论坛谱帖',
    });
    if (hits.length >= 20) break;
  }
  return hits;
}

async function c798Load(hit: SearchHit): Promise<ImportResult> {
  const url = hit.url ?? `http://www.798com.com/article-${hit.id}-1.html`;
  const { text: html } = await getRaw(url, 'http://www.798com.com/');
  const images = extractScoreImages(html, url, ['798com.com']);
  const textish = html.replace(/<[^>]+>/g, '\n');
  if (looksLikeAsciiTab(textish)) {
    return importFromText(textish, {
      title: hit.title || parseTitleFromHtml(html),
      artist: hit.artist,
      sourceId: 'c798',
      sourceName: '吉他之友 798',
      url,
    });
  }
  if (!images.length) throw new Error('帖子里没有可用的谱图');
  const blobs: Blob[] = [];
  for (const img of images.slice(0, 12)) {
    const bytes = await safely(() => getBinary(img, { headers: { 'User-Agent': UA, Referer: url } }), new Uint8Array(), 'c798');
    if (bytes.length < 5000) continue;
    blobs.push(new Blob([bytes as unknown as BlobPart], { type: img.endsWith('.png') ? 'image/png' : 'image/jpeg' }));
  }
  if (!blobs.length) throw new Error('谱图下载失败');
  return toImageDoc(
    { id: hit.id, sourceId: 'c798', sourceName: '吉他之友 798', title: hit.title || parseTitleFromHtml(html), artist: hit.artist, url },
    blobs,
  );
}

export const jita5Provider: Provider = {
  id: 'jita5',
  name: '吉他谱 jita5',
  note: '免费图片谱，支持搜索与整页抓取',
  gated: false,
  search: jita5Search,
  load: jita5Load,
};

export const c798Provider: Provider = {
  id: 'c798',
  name: '吉他之友 798',
  note: '免费论坛谱帖，图片谱',
  gated: false,
  search: c798Search,
  load: c798Load,
};

registerProvider(jita5Provider);
registerProvider(c798Provider);

export { extractAnchors };