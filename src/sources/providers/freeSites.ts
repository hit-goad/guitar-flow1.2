import type { ImportResult } from '../../core/types';
import { TUNING_STANDARD } from '../../core/types';
import { hashString } from '../../core/id';
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

/* ------------------------------------------------------------------ */
/* Ultimate Guitar                                                     */
/* ------------------------------------------------------------------ */

interface UgTab {
  id?: number | string;
  tab_id?: number | string;
  song_name?: string;
  songName?: string;
  artist_name?: string;
  artistName?: string;
  type?: string;
  rating?: number;
  version?: number;
}

function ugCleanTab(raw: string): string {
  return raw
    .replace(/\[tab\]/gi, '')
    .replace(/\[\/tab\]/gi, '')
    .replace(/\[ch\](.*?)\[\/ch\]/gi, '[$1]')
    .replace(/\[\/?(?:verse|chorus|bridge|intro|outro|solo|interlude|instrumental)(?:\s[^\]]*)?\]/gi, '\n')
    .replace(/\[\/?[a-z_]+\]/gi, '')
    .replace(/\r\n?/g, '\n');
}

async function ugSearch(query: string): Promise<SearchHit[]> {
  const urls = [
    `https://www.ultimate-guitar.com/api/v1/search?title=${encodeURIComponent(query)}&type=300&page=1`,
    `https://www.ultimate-guitar.com/api/v1/search?title=${encodeURIComponent(query)}&page=1`,
  ];
  for (const url of urls) {
    const json = await safely(
      () => getJson<{ tabs?: UgTab[]; data?: { tabs?: UgTab[] } }>(url),
      {} as { tabs?: UgTab[]; data?: { tabs?: UgTab[] } },
      'ug-search',
    );
    const list = json.tabs ?? json.data?.tabs ?? [];
    if (!list.length) continue;
    return list.slice(0, 25).map((t) => ({
      providerId: 'ultimateGuitar',
      sourceId: 'ultimateGuitar',
      sourceName: 'Ultimate Guitar',
      id: String(t.id ?? t.tab_id),
      title: t.song_name ?? t.songName ?? '未命名',
      artist: t.artist_name ?? t.artistName ?? '',
      quality: 85,
      meta: { difficulty: undefined },
      preview: t.type,
    }));
  }
  return [];
}

async function ugLoad(hit: SearchHit): Promise<ImportResult> {
  // 1) 官方 JSON 接口（多数情况可用）
  const apiCandidates = [
    `https://www.ultimate-guitar.com/api/v1/tab/${hit.id}`,
    `https://www.ultimate-guitar.com/api/v1/tab/info?tab_id=${hit.id}`,
  ];
  for (const url of apiCandidates) {
    const json = await safely(
      () =>
        getJson<{
          wiki_tab?: { content?: string };
          tab?: { content?: string };
          content?: string;
        }>(url),
      {},
      'ug-tab',
    );
    const content = json.wiki_tab?.content ?? json.tab?.content ?? json.content;
    if (content) {
      const text = ugCleanTab(content);
      return importFromText(text, {
        title: hit.title,
        artist: hit.artist,
        sourceId: 'ultimateGuitar',
        sourceName: 'Ultimate Guitar',
        url: `https://tabs.ultimate-guitar.com/tab/${hit.id}`,
      });
    }
  }

  // 2) 网页兜底：js-store 里的 data-content
  const guess = `https://tabs.ultimate-guitar.com/tab/${encodeURIComponent(
    (hit.artist + ' ' + hit.title).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  )}-${hit.id}`;
  const html = await safely(() => getHtml(guess), '', 'ug-page');
  const store = /data-content="([\s\S]*?)"\s*>/i.exec(html);
  if (store) {
    const decoded = store[1]
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    const contentMatch = /"content":"((?:[^"\\]|\\.)*)"/.exec(decoded);
    if (contentMatch) {
      const raw = JSON.parse(`"${contentMatch[1]}"`) as string;
      const text = ugCleanTab(raw);
      if (looksLikeAsciiTab(text) || /\[[A-G][#b]?/.test(text)) {
        return importFromText(text, {
          title: hit.title,
          artist: hit.artist,
          sourceId: 'ultimateGuitar',
          sourceName: 'Ultimate Guitar',
          url: guess,
        });
      }
    }
  }
  throw new Error('Ultimate Guitar 未返回可解析内容（可能需要登录或被风控）');
}

/* ------------------------------------------------------------------ */
/* 91 谱 / 17 吉他：HTML 谱站通用抓取                                    */
/* ------------------------------------------------------------------ */

function htmlSiteProvider(opts: {
  id: string;
  name: string;
  searchUrl: (q: string) => string;
  linkPattern: RegExp;
  idPattern: RegExp;
  origin: string;
  note?: string;
}): Provider {
  const hits = async (query: string): Promise<SearchHit[]> => {
    const html = await getHtml(opts.searchUrl(encodeURIComponent(query)));
    const anchors = extractAnchors(html, opts.linkPattern);
    const seen = new Set<string>();
    const out: SearchHit[] = [];
    for (const a of anchors) {
      const m = opts.idPattern.exec(a.href);
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      const text = a.text.trim();
      if (text.length < 2) continue;
      const artist = /[-–—]\s*(.+)$/.exec(text);
      out.push({
        providerId: opts.id,
        sourceId: opts.id,
        sourceName: opts.name,
        id,
        title: artist ? text.replace(artist[0], '').trim() : text,
        artist: artist ? artist[1].trim() : '',
        url: absoluteUrl(opts.origin, a.href),
        quality: 60,
        gated: true,
      });
      if (out.length >= 20) break;
    }
    return out;
  };

  const load = async (hit: SearchHit): Promise<ImportResult> => {
    const url = hit.url ?? `${opts.origin}/`;
    const html = await getHtml(url);
    // 谱站详情页通常直接给多张谱图
    const imgs = [...html.matchAll(/https?:\/\/[^"'\s<>]+?\.(?:png|jpg|jpeg|webp)/gi)]
      .map((m) => m[0])
      .filter((u) => /upload|score|pu|tab|image/i.test(u))
      .filter((u, i, arr) => arr.indexOf(u) === i)
      .slice(0, 12);
    const text = stripTags(html);
    if (looksLikeAsciiTab(text) && text.length > 200) {
      return importFromText(text, {
        title: hit.title,
        artist: hit.artist,
        sourceId: opts.id,
        sourceName: opts.name,
        url,
      });
    }
    if (!imgs.length) throw new Error(`${opts.name} 页面里没有找到谱图`);
    const pages: Blob[] = [];
    for (const u of imgs) {
      const bytes = await safely(() => getBinary(u), new Uint8Array(), opts.id);
      if (bytes.length < 8000) continue;
      pages.push(new Blob([bytes as unknown as BlobPart], { type: 'image/jpeg' }));
    }
    if (!pages.length) throw new Error(`${opts.name} 谱图下载失败`);
    return {
      doc: {
        id: `${opts.id}_${hit.id}`,
        title: hit.title,
        artist: hit.artist,
        format: 'image',
        pages,
        sourceId: opts.id,
        sourceName: opts.name,
        sourceUrl: url,
        meta: { tuning: TUNING_STANDARD, pageStarts: pages.map((_, i) => i * 20) },
        createdAt: Date.now(),
        updatedAt: Date.now(),
        hash: hashString(`${opts.id}:${hit.id}`),
      },
      warnings: ['这是图片谱，可用「打点同步」让页面跟随节拍'],
    };
  };

  return { id: opts.id, name: opts.name, note: opts.note, gated: true, search: hits, load };
}

export const jitapu91 = htmlSiteProvider({
  id: 'jitapu91',
  name: '91谱',
  searchUrl: (q) => `https://www.91pu.com/search?keyword=${q}`,
  linkPattern: /\/pu\//,
  idPattern: /\/pu\/(\d+)/,
  origin: 'https://www.91pu.com',
  note: '图片谱；页面结构变化时可能抓不到，可在设置里换镜像域名',
});

export const jita17 = htmlSiteProvider({
  id: 'jita17',
  name: '17吉他',
  searchUrl: (q) => `https://www.17jita.com/search.php?keyword=${q}`,
  linkPattern: /\/(pu|jtp)\//,
  idPattern: /\/(?:pu|jtp)\/(\d+)/,
  origin: 'https://www.17jita.com',
  note: '图片谱；支持镜像域名',
});

/* ------------------------------------------------------------------ */
/* Songsterr                                                           */
/* ------------------------------------------------------------------ */

interface SongsterrSong {
  songId: number;
  title: string;
  artist: string;
  tracks?: Array<{ name?: string; instrument?: string }>;
}

async function songsterrSearch(query: string): Promise<SearchHit[]> {
  const url = `https://www.songsterr.com/api/songs?pattern=${encodeURIComponent(query)}&size=20`;
  const list = await safely(() => getJson<SongsterrSong[]>(url), [] as SongsterrSong[], 'songsterr');
  return list.slice(0, 20).map((s) => ({
    providerId: 'songsterr',
    sourceId: 'songsterr',
    sourceName: 'Songsterr',
    id: String(s.songId),
    title: s.title,
    artist: s.artist,
    quality: 70,
    gated: true,
    preview: s.tracks?.map((t) => t.name).filter(Boolean).slice(0, 3).join(' / '),
  }));
}

async function songsterrLoad(hit: SearchHit): Promise<ImportResult> {
  // Songsterr 的完整谱需要会员；这里抓官方 "meta" 接口里的 measure 数据（有则转换）
  const meta = await safely(
    () => getJson<{ measures?: unknown[] }>(`https://www.songsterr.com/api/meta/${hit.id}/0`),
    {},
    'songsterr-meta',
  );
  if (!meta.measures?.length) {
    throw new Error('Songsterr 该曲谱需要会员，未返回可转换的谱面数据');
  }
  throw new Error('Songsterr 数据格式已变更，暂不支持自动转换（可用浏览器打开原页后另存为 GP 导入）');
}

/* ------------------------------------------------------------------ */
/* GitHub ChordPro 曲库                                                 */
/* ------------------------------------------------------------------ */

async function githubSongbookSearch(query: string): Promise<SearchHit[]> {
  const repo = providerConfig.chordproGithub?.baseUrl || 'REPO_OWNER/REPO_NAME';
  if (!repo.includes('/')) return [];
  const tree = await safely(
    () => getJson<{ tree?: Array<{ path: string; type: string }> }>(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`),
    {},
    'gh-tree',
  );
  const files = (tree.tree ?? []).filter(
    (t) => t.type === 'blob' && /\.(cho|chordpro|crd|pro|txt)$/i.test(t.path) && t.path.toLowerCase().includes(query.toLowerCase()),
  );
  return files.slice(0, 20).map((f) => ({
    providerId: 'chordproGithub',
    sourceId: 'chordproGithub',
    sourceName: 'ChordPro 曲库',
    id: f.path,
    title: f.path.split('/').pop()!.replace(/\.[^.]+$/, ''),
    artist: repo,
    quality: 65,
    gated: false,
  }));
}

async function githubSongbookLoad(hit: SearchHit): Promise<ImportResult> {
  const repo = providerConfig.chordproGithub?.baseUrl || 'REPO_OWNER/REPO_NAME';
  const url = `https://raw.githubusercontent.com/${repo}/HEAD/${hit.id}`;
  const text = await getHtml(url);
  return importFromText(text, {
    title: hit.title,
    artist: '',
    sourceId: 'chordproGithub',
    sourceName: 'ChordPro 曲库',
    url,
  });
}

/* ------------------------------------------------------------------ */

export const ultimateGuitarProvider: Provider = {
  id: 'ultimateGuitar',
  name: 'Ultimate Guitar',
  note: '免费谱源（部分需登录），自动转成可滚动谱',
  gated: false,
  search: ugSearch,
  load: ugLoad,
};

export const songsterrProvider: Provider = {
  id: 'songsterr',
  name: 'Songsterr',
  note: '仅搜索；完整谱需会员',
  gated: true,
  search: songsterrSearch,
  load: songsterrLoad,
};

export const chordproGithubProvider: Provider = {
  id: 'chordproGithub',
  name: 'ChordPro 曲库',
  note: '在设置里填 GitHub 仓库（owner/repo）以启用',
  gated: false,
  search: githubSongbookSearch,
  load: githubSongbookLoad,
};

[ultimateGuitarProvider, songsterrProvider, chordproGithubProvider, jitapu91, jita17].forEach(registerProvider);