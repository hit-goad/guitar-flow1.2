import Fuse from 'fuse.js';
import type { ScoreDoc } from './types';

const NOISE_WORDS = [
  '吉他谱', '六线谱', '指弹谱', '弹唱谱', '独奏谱', '简谱', '和弦谱', '曲谱', '乐谱',
  'guitar tab', 'guitar tabs', 'tab', 'tabs', 'chords', '吉他', '谱',
];

/** 归一化：统一全半角、去标点、去「吉他谱」类噪声词、压缩空白 */
export function normalize(raw: string): string {
  let s = (raw ?? '').normalize('NFKC').toLowerCase();
  s = s.replace(/[（(【\[].*?[）)】\]]/g, ' ');
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  for (const w of NOISE_WORDS) s = s.split(w).join(' ');
  return s.replace(/\s+/g, ' ').trim();
}

const fuseCache = new WeakMap<ScoreDoc[], Fuse<ScoreDoc>>();

function index(docs: ScoreDoc[]): Fuse<ScoreDoc> {
  let f = fuseCache.get(docs);
  if (!f) {
    f = new Fuse(docs, {
      includeScore: true,
      ignoreLocation: true,
      threshold: 0.45,
      minMatchCharLength: 1,
      keys: [
        { name: 'title', weight: 0.5 },
        { name: 'artist', weight: 0.34 },
        { name: 'album', weight: 0.06 },
        { name: 'meta.tags', weight: 0.1 },
      ],
    });
    fuseCache.set(docs, f);
  }
  return f;
}

export interface FuzzyOptions {
  limit?: number;
  /** 额外过滤，如只看收藏 */
  filter?: (doc: ScoreDoc) => boolean;
}

export function searchScores(docs: ScoreDoc[], query: string, opts: FuzzyOptions = {}): ScoreDoc[] {
  const limit = opts.limit ?? 50;
  const q = normalize(query);
  const pool = opts.filter ? docs.filter(opts.filter) : docs;
  if (!q) return pool.slice(0, limit);
  const fuse = index(pool);
  const hits = fuse.search(q, { limit: limit * 2 });

  // 子串命中优先于编辑距离命中（中文场景更符合直觉）
  const scored = hits.map((h) => {
    const title = normalize(h.item.title);
    const artist = normalize(h.item.artist);
    let bonus = 0;
    if (title.startsWith(q)) bonus += 0.35;
    else if (title.includes(q)) bonus += 0.22;
    if (artist.includes(q)) bonus += 0.12;
    const tokens = q.split(' ').filter(Boolean);
    if (tokens.length > 1 && tokens.every((t) => title.includes(t) || artist.includes(t))) bonus += 0.2;
    return { doc: h.item, score: (h.score ?? 1) - bonus };
  });

  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => s.doc);
}

/** 跨源检索结果的排序：标题精确 > 可播放 > 来源权重 */
export function rankHits<T extends { title: string; artist: string; quality?: number; gated?: boolean }>(
  hits: T[],
  query: string,
): T[] {
  const q = normalize(query);
  return [...hits].sort((a, b) => scoreHit(b, q) - scoreHit(a, q));
}

function scoreHit(hit: { title: string; artist: string; quality?: number; gated?: boolean }, q: string): number {
  let s = (hit.quality ?? 50) / 100;
  const title = normalize(hit.title);
  const artist = normalize(hit.artist);
  if (title === q) s += 1.2;
  else if (title.includes(q)) s += 0.5;
  if (artist.includes(q)) s += 0.25;
  if (hit.gated) s -= 0.15;
  return s;
}