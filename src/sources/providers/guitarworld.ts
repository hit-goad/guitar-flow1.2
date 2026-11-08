import type { ImportResult, ScoreDoc } from '../../core/types';
import { hashString } from '../../core/id';
import { TUNING_STANDARD } from '../../core/types';
import {
  absoluteUrl,
  extractAnchors,
  getBinary,
  getHtml,
  getJson,
  providerConfig,
  registerProvider,
  safely,
  stripTags,
  type Provider,
  type SearchHit,
} from '../base';
import { looksLikeAsciiTab } from '../../import/asciiTab';
import { importFromText } from '../../import';

/**
 * 吉他世界（guitarworld.com.cn）
 * 已知接口（来自之前对 App/网页的逆向，详见 guitpu/ 目录）：
 *   - 搜索页：/pu/search/result?_self=1&keyword=关键字
 *   - 谱面详情：/pu/q<ID>，图片域名 s2.guitarworld.com.cn/upload/pu_qupupic/<creatorId>/view/<md5>.png
 *   - H5 接口：https://api.guitarworld.com.cn/ （返回 {code,data} 包装）
 * 未购买账号服务端只下发 1 张预览图，因此这里分为：
 *   1) 正常路径（有 cookie / 已购）
 *   2) 破解路径：尝试去掉 view/ 层级、按页号枚举、以及接口直取
 */
const WEB = 'https://www.guitarworld.com.cn';
const API = 'https://api.guitarworld.com.cn';

const API_CANDIDATES = [
  `${API}/api/pu/qupu/view`,
  `${API}/api/pu/view`,
  `${WEB}/api/pu/qupu/view`,
  `${WEB}/pu/view`,
];

interface GwDetail {
  id: number;
  name: string;
  singer?: string;
  pageCount?: number;
  qupuView?: string;
  creatorId?: number;
  difficultyScore?: number;
  price?: number;
  qupuInfo?: Array<{ name: string; value: string }>;
}

function cookie(): string | undefined {
  return providerConfig.guitarworld?.cookie || undefined;
}

function apiBase(): string {
  return providerConfig.guitarworld?.baseUrl || API;
}

/** 搜索：优先 H5 接口，失败回退网页搜索页 */
async function search(query: string): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  const tryApi = async () => {
    const urls = [
      `${apiBase()}/api/pu/search?keyword=${encodeURIComponent(query)}&page=1&size=20`,
      `${apiBase()}/api/pu/search/result?keyword=${encodeURIComponent(query)}&page=1&size=20`,
    ];
    for (const url of urls) {
      const json = await safely(() => getJson<{ data?: { list?: GwDetail[] } | GwDetail[] }>(url), {}, 'gw-api');
      const raw = (json as { data?: unknown }).data;
      const list: GwDetail[] = Array.isArray(raw) ? raw : ((raw as { list?: GwDetail[] })?.list ?? []);
      if (!list.length) continue;
      for (const item of list) {
        hits.push({
          providerId: 'guitarworld',
          sourceId: 'guitarworld',
          sourceName: '吉他世界',
          id: String(item.id),
          title: item.name || '未命名',
          artist: item.singer || '',
          quality: 78,
          gated: (item.price ?? 0) > 0,
          meta: { difficulty: item.difficultyScore },
        });
      }
      return;
    }
  };

  await tryApi();
  if (hits.length) return hits;

  const html = await getHtml(`${WEB}/pu/search/result?_self=1&keyword=${encodeURIComponent(query)}`);
  const anchors = extractAnchors(html, /\/pu\/q\d+/);
  const seen = new Set<string>();
  for (const a of anchors) {
    const m = /\/pu\/q(\d+)/.exec(a.href);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const text = a.text.trim();
    const artistMatch = /[-–—]\s*(.+)$/.exec(text);
    hits.push({
      providerId: 'guitarworld',
      sourceId: 'guitarworld',
      sourceName: '吉他世界',
      id,
      title: artistMatch ? text.replace(artistMatch[0], '').trim() : text,
      artist: artistMatch ? artistMatch[1].trim() : '',
      url: `${WEB}/pu/q${id}`,
      quality: 75,
      gated: true,
    });
  }
  return hits.slice(0, 30);
}

async function detail(id: string): Promise<GwDetail | null> {
  for (const base of API_CANDIDATES) {
    const url = `${base}?id=${encodeURIComponent(id)}`;
    const json = await safely(
      () => getJson<{ data?: GwDetail; code?: number }>(url, { headers: cookie() ? { Cookie: cookie()! } : {} }),
      {} as { data?: GwDetail },
      'gw-detail',
    );
    if (json && json.data && json.data.name) return json.data;
  }
  return null;
}

/** 从预览图 URL 推导「去 view 层级 / 按页枚举」的直链 */
function buildUnlockCandidates(previewUrl: string, pageCount: number): string[] {
  const urls = new Set<string>();
  try {
    const u = new URL(previewUrl);
    const parts = u.pathname.split('/').filter(Boolean); // upload, pu_qupupic, <creator>, view|w, <file>
    const fileIdx = parts.length - 1;
    const file = parts[fileIdx];
    const ext = file.slice(file.lastIndexOf('.'));
    const creator = parts[2] ?? '';
    const origin = u.origin;

    // 1) 去掉 view/ 层级：/upload/pu_qupupic/<creator>/<n>.png
    for (let p = 1; p <= Math.max(1, pageCount); p++) {
      urls.add(`${origin}/upload/pu_qupupic/${creator}/${p}${ext}`);
      urls.add(`${origin}/upload/pu_qupupic/${creator}/${file.replace(/\.[^.]+$/, `_${p}`)}${ext}`);
    }
    // 2) 保留 view 目录但换页号
    for (let p = 1; p <= Math.max(1, pageCount); p++) {
      urls.add(`${origin}/upload/pu_qupupic/${creator}/view/${p}${ext}`);
    }
    // 3) 原图路径（部分老谱没有 view 层）
    urls.add(previewUrl.replace('/view/', '/'));
    urls.add(previewUrl.replace('/view/', '/view/full/'));
  } catch {
    /* ignore */
  }
  return [...urls];
}

async function downloadPages(urls: string[]): Promise<Blob[]> {
  const out: Blob[] = [];
  for (const url of urls) {
    const bytes = await safely(() => getBinary(url), new Uint8Array(), 'gw-img');
    // 太小基本是 404 页 / 占位图
    if (bytes.length < 12_000) continue;
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
    if (!isPng && !isJpg) continue;
    out.push(new Blob([bytes as unknown as BlobPart], { type: isPng ? 'image/png' : 'image/jpeg' }));
  }
  return out;
}

async function load(hit: SearchHit): Promise<ImportResult> {
  const warnings: string[] = [];
  const info = await detail(hit.id);

  // 1) 先看详情接口有没有可播放的文字谱（部分谱带 tab 文本）
  const textFromDetail = (info as unknown as { qupuContent?: string; tabContent?: string })?.qupuContent
    ?? (info as unknown as { tabContent?: string })?.tabContent;
  if (textFromDetail && looksLikeAsciiTab(textFromDetail)) {
    const res = importFromText(textFromDetail, {
      title: info?.name ?? hit.title,
      artist: info?.singer ?? hit.artist,
      sourceId: 'guitarworld',
      sourceName: '吉他世界',
      url: `${WEB}/pu/q${hit.id}`,
    });
    return res;
  }

  const pageCount = info?.pageCount ?? 1;
  const previewUrl = info?.qupuView ?? '';

  // 2) 正常路径：带 cookie 抓详情页，正文里可能直接给出全部页图
  const html = await safely(
    () => getHtml(`${WEB}/pu/q${hit.id}`, { headers: cookie() ? { Cookie: cookie()! } : {} }),
    '',
    'gw-page',
  );
  const pageUrls = [...html.matchAll(/https:\/\/s2?\.guitarworld\.com\.cn\/upload\/pu_qupupic\/[^"'\s<>]+?\.(?:png|jpg|jpeg|webp)/g)]
    .map((m) => m[0])
    .filter((v, i, arr) => arr.indexOf(v) === i);

  let images: Blob[] = [];
  if (pageUrls.length >= Math.max(1, pageCount)) {
    images = await downloadPages(pageUrls);
  }

  // 3) 破解路径：预览图 → 去 view 层 / 按页枚举
  if (images.length <= 1 && previewUrl) {
    const candidates = buildUnlockCandidates(previewUrl, pageCount);
    const unlocked = await downloadPages(candidates);
    if (unlocked.length > images.length) {
      images = unlocked;
      warnings.push(`已通过直链推导拿到 ${unlocked.length} 页（原预览 ${pageUrls.length || 1} 页）`);
    }
  }

  if (!images.length && previewUrl) {
    images = await downloadPages([previewUrl]);
  }

  if (!images.length) {
    throw new Error('该曲谱需要登录/购买，且直链推导未拿到图片。可在设置里填入账号 Cookie 后重试。');
  }

  if (images.length < pageCount) {
    warnings.push(`只拿到 ${images.length}/${pageCount} 页，可能是会员限制。`);
  }

  const title = info?.name ?? hit.title;
  const artist = info?.singer ?? hit.artist;
  const tuningText = info?.qupuInfo?.find((x) => x.name === '调弦法')?.value;
  if (tuningText && !/标准/.test(tuningText)) warnings.push(`该谱使用特殊调弦：${tuningText}`);

  const doc: ScoreDoc = {
    id: `gw_${hit.id}`,
    title,
    artist,
    format: 'image',
    pages: images,
    sourceId: 'guitarworld',
    sourceName: '吉他世界',
    sourceUrl: `${WEB}/pu/q${hit.id}`,
    meta: {
      tuning: TUNING_STANDARD,
      pageStarts: images.map((_, i) => i * 20),
      difficulty: info?.difficultyScore,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hash: hashString(`gw:${hit.id}:${images.length}`),
  };
  return { doc, warnings };
}

export const guitarWorldProvider: Provider = {
  id: 'guitarworld',
  name: '吉他世界',
  note: '图片谱源；支持 Cookie，直链推导可绕过预览限制',
  gated: true,
  search,
  load,
};

registerProvider(guitarWorldProvider);

export { buildUnlockCandidates };