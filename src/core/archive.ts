import type { ScoreDoc } from './types';
import { putScore, listScores } from './library';

interface DocArchive {
  doc: Omit<ScoreDoc, 'bytes' | 'pages'> & {
    bytesBase64?: string;
    pagesBase64?: Array<{ type: string; data: string }>;
  };
}

export interface LibraryArchive {
  app: 'guitarflow';
  version: 1;
  exportedAt: number;
  docs: DocArchive[];
}

function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function exportLibrary(): Promise<LibraryArchive> {
  const docs = await listScores();
  const out: DocArchive[] = [];
  for (const doc of docs) {
    const { bytes, pages, ...rest } = doc;
    const item: DocArchive = { doc: { ...rest } };
    if (bytes) item.doc.bytesBase64 = toBase64(bytes);
    if (pages?.length) {
      item.doc.pagesBase64 = await Promise.all(
        pages.map(async (p) => ({ type: p.type, data: toBase64(await p.arrayBuffer()) })),
      );
    }
    out.push(item);
  }
  return { app: 'guitarflow', version: 1, exportedAt: Date.now(), docs: out };
}

export async function importLibrary(archive: LibraryArchive): Promise<number> {
  if (archive?.app !== 'guitarflow') throw new Error('不是 GuitarFlow 曲库文件');
  let count = 0;
  for (const item of archive.docs ?? []) {
    const { bytesBase64, pagesBase64, ...rest } = item.doc;
    const doc: ScoreDoc = { ...(rest as ScoreDoc) };
    if (bytesBase64) doc.bytes = fromBase64(bytesBase64).slice().buffer as ArrayBuffer;
    if (pagesBase64?.length) {
      doc.pages = pagesBase64.map((p) => new Blob([fromBase64(p.data) as unknown as BlobPart], { type: p.type }));
    }
    await putScore(doc);
    count++;
  }
  return count;
}