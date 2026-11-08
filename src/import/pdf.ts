import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { parseAsciiTab, looksLikeAsciiTab, type AsciiTabResult } from './asciiTab';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfImportResult {
  kind: 'text-tab' | 'pages';
  ascii?: AsciiTabResult;
  pages?: Blob[];
  pageCount: number;
  textPreview: string;
  warnings: string[];
}

/** pdfjs 会把传入的 ArrayBuffer 转移给 worker，第二次使用前必须给副本 */
function freshBytes(data: ArrayBuffer): Uint8Array {
  return new Uint8Array(data.slice(0));
}

/** pdfjs v6 的关闭方法名有变动，做兼容 */
async function closePdf(doc: unknown): Promise<void> {
  const d = doc as { destroy?: () => Promise<void>; cleanup?: () => Promise<void> };
  if (typeof d.destroy === 'function') await d.destroy();
  else if (typeof d.cleanup === 'function') await d.cleanup();
}

interface TextLine {
  y: number;
  text: string;
}

/** 按 y 坐标重建文本行（PDF 里六线谱是文本时可直接还原） */
async function extractLines(data: ArrayBuffer): Promise<{ lines: string[]; pageCount: number; pagesText: string[] }> {
  const doc = await pdfjs.getDocument({ data: freshBytes(data) }).promise;
  const pagesText: string[] = [];
  const allLines: string[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const rows = new Map<number, { x: number; str: string }[]>();
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const it = item as { str: string; transform: number[] };
      if (!it.str.trim()) continue;
      const y = Math.round(it.transform[5] / 2) * 2;
      const x = it.transform[4];
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y)!.push({ x, str: it.str });
    }
    const pageLines: TextLine[] = [...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([y, items]) => ({
        y,
        text: items.sort((a, b) => a.x - b.x).map((i) => i.str).join(''),
      }));
    const texts = pageLines.map((l) => l.text);
    pagesText.push(texts.join('\n'));
    allLines.push(...texts, '');
    page.cleanup();
  }
  await closePdf(doc);
  return { lines: allLines, pageCount: pagesText.length, pagesText };
}

/** 把 PDF 每页渲染成 PNG（用于扫描版曲谱） */
export async function pdfToPageImages(data: ArrayBuffer, scale = 2): Promise<Blob[]> {
  const doc = await pdfjs.getDocument({ data: freshBytes(data) }).promise;
  const out: Blob[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, canvas } as unknown as Parameters<typeof page.render>[0]).promise;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (blob) out.push(blob);
    page.cleanup();
  }
  await closePdf(doc);
  return out;
}

/**
 * PDF 导入：
 *  - 如果 PDF 内嵌文本能还原成六线谱 → 直接转成可滚动播放的 alphaTex
 *  - 否则渲染成页图，进入「图片谱 + 手动打点同步」模式
 */
export async function importPdf(data: ArrayBuffer, filename: string): Promise<PdfImportResult> {
  const warnings: string[] = [];
  const { lines, pageCount, pagesText } = await extractLines(data);
  const joined = lines.join('\n');

  if (pagesText.some((t) => looksLikeAsciiTab(t))) {
    // 用最长的一页文本尝试解析（多页 PDF 常把谱拆页）
    const best = pagesText
      .map((t) => ({ t, result: parseAsciiTab(t, filename.replace(/\.pdf$/i, '')) }))
      .filter((x) => x.result)
      .sort((a, b) => (b.result?.noteCount ?? 0) - (a.result?.noteCount ?? 0))[0];
    if (best?.result) {
      if (pageCount > 1) warnings.push('PDF 有多页，已取音符最多的一页转换成可滚动谱；其余页可用图片模式导入');
      return { kind: 'text-tab', ascii: best.result, pageCount, textPreview: joined.slice(0, 800), warnings };
    }
  }

  const pages = await pdfToPageImages(data);
  if (!pages.length) warnings.push('PDF 渲染失败，没有得到页面图像');
  else warnings.push('该 PDF 是扫描/图片谱，已生成页面图像，请在阅读器中打点同步滚动');
  return { kind: 'pages', pages, pageCount, textPreview: joined.slice(0, 400), warnings };
}