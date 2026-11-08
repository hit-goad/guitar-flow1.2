import type { ScoreDoc } from './types';
import { TUNING_STANDARD } from './types';
import { hashString, uid } from './id';
import index from '../data/library-index.json';

export interface LibraryEntry {
  id: string;
  title: string;
  artist: string;
  pages: number;
  files: string[];
}

export interface LibraryIndex {
  generatedAt: string;
  totalFiles: number;
  totalSongs: number;
  entries: LibraryEntry[];
}

export const localIndex = index as unknown as LibraryIndex;

export interface LocalFolder {
  name: string;
  files: Map<string, File>;
}

/** 选择一个文件夹（Chromium/Electron/Android WebView 都支持 webkitdirectory） */
export async function pickFolder(): Promise<LocalFolder | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) {
        resolve(null);
        return;
      }
      const map = new Map<string, File>();
      for (const f of files) map.set(f.name, f);
      const first = files[0] as File & { webkitRelativePath?: string };
      const root = first.webkitRelativePath?.split('/')[0] ?? '本地文件夹';
      resolve({ name: root, files: map });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export function filesForEntry(folder: LocalFolder, entry: LibraryEntry): File[] {
  const out: File[] = [];
  for (const name of entry.files) {
    const f = folder.files.get(name);
    if (f) out.push(f);
  }
  return out;
}

/** 把选中的页图做成一份图片谱文档（只复制这首歌的页，避免整库 500MB 塞进 IndexedDB） */
export async function docFromEntry(entry: LibraryEntry, files: File[]): Promise<ScoreDoc> {
  const pages = files
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
    .map((f) => f.slice(0, f.size, f.type || 'image/jpeg'));
  return {
    id: `local_${entry.id}_${uid('p').slice(0, 6)}`,
    title: entry.title,
    artist: entry.artist,
    format: 'image',
    pages,
    sourceId: 'localFolder',
    sourceName: '本机曲库',
    meta: { tuning: TUNING_STANDARD, pageStarts: pages.map((_, i) => i * 20) },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hash: hashString(`local:${entry.id}:${pages.length}`),
  };
}

export function searchIndex(query: string, limit = 60): LibraryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return localIndex.entries.slice(0, limit);
  const scored = localIndex.entries
    .map((e) => {
      const title = e.title.toLowerCase();
      let score = -1;
      if (title === q) score = 100;
      else if (title.startsWith(q)) score = 80;
      else if (title.includes(q)) score = 60;
      else if (e.artist.toLowerCase().includes(q)) score = 40;
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.e.title.localeCompare(b.e.title, 'zh-Hans-CN'));
  return scored.slice(0, limit).map((x) => x.e);
}