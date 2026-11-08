import type { Provider, SearchHit } from '../core/types';
import { httpGet, httpGetJson, HttpError } from '../core/platform';

export type { Provider, SearchHit };

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export interface FetchOpts {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  cookie?: string;
}

export async function getHtml(url: string, opts: FetchOpts = {}): Promise<string> {
  return (await httpGet(url, { headers: { 'User-Agent': UA, ...(opts.headers ?? {}) }, allowProxy: true, timeoutMs: 20000 })).text;
}

export async function getJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  return httpGetJson<T>(url, { headers: { 'User-Agent': UA, ...(opts.headers ?? {}) } });
}

export async function getBinary(url: string, opts: FetchOpts = {}): Promise<Uint8Array> {
  return (await httpGet(url, { headers: { 'User-Agent': UA, ...(opts.headers ?? {}) }, binary: true })).bytes;
}

export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从 HTML 锚点里抽搜索结果 */
export function extractAnchors(
  html: string,
  pattern: RegExp,
): Array<{ href: string; text: string }> {
  const out: Array<{ href: string; text: string }> = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (!pattern.test(m[1])) continue;
    const text = stripTags(m[2]);
    if (!text) continue;
    out.push({ href: m[1], text });
  }
  return out;
}

export function absoluteUrl(base: string, href: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** 统一处理来源异常，避免一个源挂了影响整个检索 */
export async function safely<T>(fn: () => Promise<T>, fallback: T, label: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) return fallback;
    console.warn(`[source:${label}]`, err);
    return fallback;
  }
}

export interface ProviderConfig {
  enabled: boolean;
  cookie?: string;
  /** 部分源需要自建反代或镜像域名 */
  baseUrl?: string;
}

export const providerConfig: Record<string, ProviderConfig> = {
  guitarworld: { enabled: true },
  ultimateGuitar: { enabled: true },
  jitapu91: { enabled: true },
  jita17: { enabled: true },
  songsterr: { enabled: true },
  chordproGithub: { enabled: true },
};

export function setProviderConfig(id: string, patch: Partial<ProviderConfig>) {
  providerConfig[id] = { ...(providerConfig[id] ?? { enabled: true }), ...patch };
}

const PROVIDERS: Provider[] = [];

export function registerProvider(p: Provider) {
  const idx = PROVIDERS.findIndex((x) => x.id === p.id);
  if (idx >= 0) PROVIDERS[idx] = p;
  else PROVIDERS.push(p);
}

export function allProviders(): Provider[] {
  return PROVIDERS;
}

export function enabledProviders(): Provider[] {
  return PROVIDERS.filter((p) => (providerConfig[p.id]?.enabled ?? true) && p.enabled !== false);
}