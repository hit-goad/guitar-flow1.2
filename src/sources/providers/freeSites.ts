import type { ImportResult } from '../../core/types';
import {
  getHtml,
  getJson,
  providerConfig,
  registerProvider,
  safely,
  type Provider,
  type SearchHit,
} from '../base';
import { looksLikeAsciiTab } from '../../import/asciiTab';
import { importFromText } from '../../import';

/* ------------------------------------------------------------------ */
/* Ultimate Guitar（免费英文/国际六线谱与和弦谱）                       */
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
      gated: false,
      meta: { difficulty: undefined },
      preview: t.type || '免费文本六线谱',
    }));
  }
  return [];
}

async function ugLoad(hit: SearchHit): Promise<ImportResult> {
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
  throw new Error('Ultimate Guitar 未返回可解析内容');
}

/* ------------------------------------------------------------------ */
/* GitHub 开源 ChordPro / 六线谱曲库                                    */
/* ------------------------------------------------------------------ */

async function githubSongbookSearch(query: string): Promise<SearchHit[]> {
  const repo = providerConfig.chordproGithub?.baseUrl || '';
  if (!repo.includes('/')) return [];
  const tree = await safely(
    () => getJson<{ tree?: Array<{ path: string; type: string }> }>(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`),
    {},
    'gh-tree',
  );
  const files = (tree.tree ?? []).filter(
    (t) => t.type === 'blob' && /\.(cho|chordpro|crd|pro|txt|tab)$/i.test(t.path) && t.path.toLowerCase().includes(query.toLowerCase()),
  );
  return files.slice(0, 20).map((f) => ({
    providerId: 'chordproGithub',
    sourceId: 'chordproGithub',
    sourceName: 'GitHub 开源曲库',
    id: f.path,
    title: f.path.split('/').pop()!.replace(/\.[^.]+$/, ''),
    artist: repo,
    quality: 75,
    gated: false,
    preview: '开源文本谱',
  }));
}

async function githubSongbookLoad(hit: SearchHit): Promise<ImportResult> {
  const repo = providerConfig.chordproGithub?.baseUrl || '';
  const url = `https://raw.githubusercontent.com/${repo}/HEAD/${hit.id}`;
  const text = await getHtml(url);
  return importFromText(text, {
    title: hit.title,
    artist: '',
    sourceId: 'chordproGithub',
    sourceName: 'GitHub 开源曲库',
    url,
  });
}

export const ultimateGuitarProvider: Provider = {
  id: 'ultimateGuitar',
  name: 'Ultimate Guitar (免费英文谱)',
  note: '免费国际六线谱/和弦谱，自动转换为可滚动曲谱',
  gated: false,
  search: ugSearch,
  load: ugLoad,
};

export const chordproGithubProvider: Provider = {
  id: 'chordproGithub',
  name: 'GitHub 开源曲谱库',
  note: '可在设置中填写开源曲谱仓库（owner/repo）',
  gated: false,
  search: githubSongbookSearch,
  load: githubSongbookLoad,
};

[ultimateGuitarProvider, chordproGithubProvider].forEach(registerProvider);