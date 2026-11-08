import type { ImportResult, Provider, SearchHit } from '../core/types';
import { rankHits, searchScores } from '../core/fuzzy';
import { allProviders, enabledProviders, providerConfig } from './base';
import './providers/guitarworld';
import './providers/freeSites';

export interface SearchOutcome {
  hits: SearchHit[];
  errors: Array<{ provider: string; message: string }>;
  /** 本地曲库里的模糊匹配 */
  local: SearchHit[];
}

const cache = new Map<string, SearchOutcome>();
const CACHE_TTL = 5 * 60 * 1000;

/** 跨源检索：并发请求所有启用的源，失败单独记录，不影响整体 */
export async function searchAll(query: string, signal?: AbortSignal): Promise<SearchOutcome> {
  const q = query.trim();
  if (!q) return { hits: [], errors: [], local: [] };
  const cached = cache.get(q);
  if (cached && Date.now() - (cached as unknown as { ts: number }).ts < CACHE_TTL) {
    return cached;
  }

  const providers = enabledProviders().filter((p) => p.id !== 'localLibrary');
  const errors: Array<{ provider: string; message: string }> = [];

  const results = await Promise.all(
    providers.map(async (p) => {
      try {
        const hits = await p.search(q, signal);
        return hits;
      } catch (err) {
        errors.push({ provider: p.name, message: (err as Error).message });
        return [] as SearchHit[];
      }
    }),
  );

  const flat = results.flat();
  const hits = rankHits(flat, q);
  const outcome: SearchOutcome = { hits, errors, local: [] };
  (outcome as unknown as { ts: number }).ts = Date.now();
  cache.set(q, outcome);
  return outcome;
}

/** 加载某个检索结果 */
export async function loadHit(hit: SearchHit, signal?: AbortSignal): Promise<ImportResult> {
  const provider = allProviders().find((p) => p.id === hit.providerId);
  if (!provider) throw new Error(`未知来源：${hit.providerId}`);
  return provider.load(hit, signal);
}

export function providerStatus(): Array<{ id: string; name: string; enabled: boolean; note?: string }> {
  return allProviders().map((p) => ({
    id: p.id,
    name: p.name,
    enabled: providerConfig[p.id]?.enabled ?? true,
    note: p.note,
  }));
}

export function clearSearchCache() {
  cache.clear();
}

export { searchScores, allProviders };
export type { Provider, SearchHit };