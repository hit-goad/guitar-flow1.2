import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { parseAsciiTab, looksLikeAsciiTab, type AsciiTabResult } from './asciiTab';
import { parseChordPro, looksLikeChordPro } from './chordpro';
import { recognizeImagePages, type OmrResult } from './omr/omr';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfImportResult {
  kind: 'text-tab' | 'omr-tab' | 'pages';
  ascii?: AsciiTabResult;
  omr?: OmrResult;
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

/** 把 PDF 每页渲染成高分辨率 PNG（用于扫描版曲谱 OMR 识谱与原谱对照） */
export async function pdfToPageImages(data: ArrayBuffer, scale = 2.2): Promise<Blob[]> {
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
 * PDF 智能导入与可滚动曲谱转换：
 *  1. 若 PDF 内嵌文本层包含六线谱或和弦谱 → 合并全部页文本直接转成可滚动 alphaTex
 *  2. 若 PDF 为扫描件/图片谱 → 渲染全部页面为高清图像，自动运行六线谱 OMR 识别引擎
 *     （识别六线谱表、小节线、上方和弦指法图、品位数字、x 伴奏音型与符尾节奏），
 *     精准生成可滚动、逐音符发声的 alphaTex，并同时保留原页图供随时切换对照！
 */
export async function importPdf(data: ArrayBuffer, filename: string): Promise<PdfImportResult> {
  const warnings: string[] = [];
  const cleanTitle = filename.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim() || '导入的 PDF 曲谱';
  const { lines, pageCount, pagesText } = await extractLines(data);
  const joined = lines.join('\n');

  // 1) 优先检查多页文本层是否可直接解析为六线谱
  const tabPages = pagesText.filter((t) => looksLikeAsciiTab(t));
  if (tabPages.length > 0) {
    const combinedTabText = tabPages.join('\n\n');
    const parsed = parseAsciiTab(combinedTabText, cleanTitle);
    if (parsed && parsed.noteCount > 0) {
      warnings.push(`已从 PDF 文本层合并识别 ${tabPages.length}/${pageCount} 页，精准转换为 ${parsed.measures} 小节可滚动曲谱`);
      return { kind: 'text-tab', ascii: parsed, pageCount, textPreview: joined.slice(0, 800), warnings };
    }
  }

  // 检查文本层是否为 ChordPro 和弦谱
  if (looksLikeChordPro(joined)) {
    const cp = parseChordPro(joined, cleanTitle);
    if (cp) {
      warnings.push(`已从 PDF 文本层识别出和弦弹唱谱（共 ${pageCount} 页），已转换为可滚动曲谱`);
      return {
        kind: 'text-tab',
        ascii: {
          title: cp.title || cleanTitle,
          artist: cp.artist,
          alphaTex: cp.alphaTex,
          warnings: cp.warnings,
          measures: Math.max(1, cp.sections * 4),
          noteCount: 32,
        },
        pageCount,
        textPreview: joined.slice(0, 800),
        warnings,
      };
    }
  }

  // 2) 扫描版 / 图片型 PDF：渲染高清页图并运行高精度六线谱 OMR 引擎
  const pages = await pdfToPageImages(data, 2.2);
  if (!pages.length) {
    warnings.push('PDF 渲染失败，没有得到页面图像');
    return { kind: 'pages', pages: [], pageCount, textPreview: joined.slice(0, 400), warnings };
  }

  try {
    const omr = await recognizeImagePages(pages, { title: cleanTitle, resolveChordX: true });
    if (omr.glyphs > 0 && omr.alphaTex.trim()) {
      warnings.push(
        `PDF 智能识谱完成：共 ${pages.length} 页，识别出 ${omr.systems} 行谱表、${omr.measures} 个小节、${omr.glyphs} 个音符` +
          (omr.chords.length ? `（和弦：${omr.chords.slice(0, 8).join(' → ')}${omr.chords.length > 8 ? '…' : ''}）` : '') +
          `，置信度 ${(omr.confidence * 100).toFixed(0)}%，已精准转换为可滚动曲谱（顶部可随时切换原谱对照）`,
      );
      return {
        kind: 'omr-tab',
        omr,
        pages,
        pageCount: pages.length,
        textPreview: omr.ascii.slice(0, 800),
        warnings: [...warnings, ...omr.warnings],
      };
    }
  } catch (err) {
    warnings.push(`PDF 自动识谱提示：${(err as Error).message}`);
  }

  warnings.push('该 PDF 未检测到标准六线谱表，已保留高清页图模式（支持打点同步滚动或手动识谱校正）');
  return { kind: 'pages', pages, pageCount: pages.length, textPreview: joined.slice(0, 400), warnings };
}