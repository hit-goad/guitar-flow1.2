import type { ScoreDoc } from '../core/types';
import { hashString, hashBytes, uid } from '../core/id';
import { TUNING_STANDARD } from '../core/types';
import { parseAsciiTab, looksLikeAsciiTab } from './asciiTab';
import { parseChordPro, looksLikeChordPro } from './chordpro';
import { midiToAlphaTex } from './midi';
import { importPdf } from './pdf';

export interface ImportInput {
  name: string;
  bytes: Uint8Array;
  mime?: string;
}

export interface ImportOutcome {
  doc: ScoreDoc;
  warnings: string[];
}

const EXT_FORMAT: Record<string, ScoreDoc['format']> = {
  tex: 'alphatex',
  alphatex: 'alphatex',
  gp: 'gp',
  gp3: 'gp',
  gp4: 'gp',
  gp5: 'gp',
  gpx: 'gp',
  gp7: 'gp',
  musicxml: 'musicxml',
  xml: 'musicxml',
  mid: 'midi',
  midi: 'midi',
  txt: 'ascii',
  tab: 'ascii',
  crd: 'chordpro',
  cho: 'chordpro',
  chordpro: 'chordpro',
  pro: 'chordpro',
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
};

function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function newDoc(partial: Partial<ScoreDoc> & Pick<ScoreDoc, 'title' | 'format' | 'sourceId' | 'sourceName'>): ScoreDoc {
  const now = Date.now();
  return {
    id: uid(),
    artist: '',
    meta: { tuning: TUNING_STANDARD },
    createdAt: now,
    updatedAt: now,
    ...partial,
  } as ScoreDoc;
}

/**
 * 统一导入入口：按扩展名 + 内容嗅探决定转换器。
 * 目标：任何格式进来，都尽量变成「可滚、可点、有声」的谱。
 */
export async function importFile(input: ImportInput): Promise<ImportOutcome> {
  const { name, bytes } = input;
  const e = ext(name);
  const declared = EXT_FORMAT[e];
  const warnings: string[] = [];
  const title = baseName(name) || '未命名曲谱';
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

  // 1) Guitar Pro / MusicXML：原样交给 alphaTab 解析（它内建 GP3-8 与 MusicXML 解析器）
  if (declared === 'gp' || declared === 'musicxml') {
    const hash = await hashBytes(bytes);
    return {
      doc: newDoc({
        title,
        format: declared,
        bytes: buffer,
        sourceId: 'local',
        sourceName: '本地导入',
        hash,
      }),
      warnings,
    };
  }

  // 2) MIDI
  if (declared === 'midi') {
    try {
      const res = midiToAlphaTex(buffer, title);
      if (!res) throw new Error('MIDI 中没有音符');
      warnings.push(...res.warnings);
      return {
        doc: newDoc({
          title: res.title || title,
          format: 'alphatex',
          text: res.alphaTex,
          sourceId: 'local',
          sourceName: '本地导入',
          meta: { bpm: res.tempo, tuning: TUNING_STANDARD, noteCount: res.noteCount },
          hash: hashString(res.alphaTex),
        }),
        warnings,
      };
    } catch (err) {
      warnings.push(`MIDI 解析失败：${(err as Error).message}`);
      return {
        doc: newDoc({ title, format: 'midi', bytes: buffer, sourceId: 'local', sourceName: '本地导入' }),
        warnings,
      };
    }
  }

  // 3) PDF
  if (declared === 'pdf') {
    const res = await importPdf(buffer, name);
    warnings.push(...res.warnings);
    if (res.kind === 'text-tab' && res.ascii) {
      return {
        doc: newDoc({
          title: res.ascii.title || title,
          artist: res.ascii.artist,
          format: 'alphatex',
          text: res.ascii.alphaTex,
          sourceId: 'local',
          sourceName: 'PDF 智能识别',
          meta: { tuning: TUNING_STANDARD, noteCount: res.ascii.noteCount },
          hash: hashString(res.ascii.alphaTex),
        }),
        warnings,
      };
    }
    return {
      doc: newDoc({
        title,
        format: 'image',
        pages: res.pages,
        sourceId: 'local',
        sourceName: 'PDF 页图',
        meta: { tuning: TUNING_STANDARD, pageStarts: res.pages?.map((_, i) => i * 20) },
        hash: await hashBytes(bytes),
      }),
      warnings,
    };
  }

  // 4) 图片谱
  if (declared === 'image') {
    const mime = input.mime || (e === 'png' ? 'image/png' : e === 'webp' ? 'image/webp' : 'image/jpeg');
    const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
    warnings.push('图片谱无法自动 OCR 成六线谱，已进入打点同步模式：播放时按空格打点即可让页面跟随');
    return {
      doc: newDoc({
        title,
        format: 'image',
        pages: [blob],
        sourceId: 'local',
        sourceName: '本地图片',
        meta: { tuning: TUNING_STANDARD, pageStarts: [0] },
        hash: await hashBytes(bytes),
      }),
      warnings,
    };
  }

  // 5) 文本类：alphaTex / ASCII / ChordPro
  const text = decode(bytes);

  if (declared === 'alphatex' || /^\\title|^\s*\.\s*$/m.test(text)) {
    return {
      doc: newDoc({
        title,
        format: 'alphatex',
        text,
        sourceId: 'local',
        sourceName: 'alphaTex',
        meta: { tuning: TUNING_STANDARD },
        hash: hashString(text),
      }),
      warnings,
    };
  }

  if (looksLikeAsciiTab(text)) {
    const res = parseAsciiTab(text, title);
    if (res) {
      return {
        doc: newDoc({
          title: res.title || title,
          artist: res.artist,
          format: 'alphatex',
          text: res.alphaTex,
          sourceId: 'local',
          sourceName: '六线谱识别',
          meta: { tuning: TUNING_STANDARD, noteCount: res.noteCount },
          hash: hashString(res.alphaTex),
        }),
        warnings: [...warnings, ...res.warnings],
      };
    }
  }

  if (looksLikeChordPro(text)) {
    const res = parseChordPro(text, title);
    if (res) {
      return {
        doc: newDoc({
          title: res.title || title,
          artist: res.artist,
          format: 'alphatex',
          text: res.alphaTex,
          sourceId: 'local',
          sourceName: '和弦谱转换',
          meta: { bpm: res.tempo, key: res.key, capo: res.capo, tuning: TUNING_STANDARD },
          hash: hashString(res.alphaTex),
        }),
        warnings: [...warnings, ...res.warnings],
      };
    }
  }

  // 6) 兜底：纯文本歌词/和弦混排，尽量按 ChordPro 兜一次
  const fallback = parseChordPro(text, title);
  if (fallback) {
    warnings.push('未识别出明确格式，已按和弦谱尝试转换');
    return {
      doc: newDoc({
        title: fallback.title,
        artist: fallback.artist,
        format: 'alphatex',
        text: fallback.alphaTex,
        sourceId: 'local',
        sourceName: '文本兜底转换',
        meta: { bpm: fallback.tempo, tuning: TUNING_STANDARD },
        hash: hashString(fallback.alphaTex),
      }),
      warnings: [...warnings, ...fallback.warnings],
    };
  }

  throw new Error(`无法识别的文件格式：${name}`);
}

/** 直接把一个来源给的文本（如网页抓到的 tab 文本）转成 doc */
export function importFromText(
  text: string,
  opts: { title: string; artist?: string; sourceId: string; sourceName: string; url?: string },
): ImportOutcome {
  const warnings: string[] = [];
  if (looksLikeAsciiTab(text)) {
    const res = parseAsciiTab(text, opts.title);
    if (res) {
      return {
        doc: newDoc({
          title: opts.title || res.title,
          artist: opts.artist || res.artist,
          format: 'alphatex',
          text: res.alphaTex,
          sourceId: opts.sourceId,
          sourceName: opts.sourceName,
          sourceUrl: opts.url,
          meta: { tuning: TUNING_STANDARD, noteCount: res.noteCount },
          hash: hashString(res.alphaTex),
        }),
        warnings: [...warnings, ...res.warnings],
      };
    }
  }
  const cp = parseChordPro(text, opts.title);
  if (!cp) throw new Error('来源内容不是可解析的曲谱');
  return {
    doc: newDoc({
      title: opts.title || cp.title,
      artist: opts.artist || cp.artist,
      format: 'alphatex',
      text: cp.alphaTex,
      sourceId: opts.sourceId,
      sourceName: opts.sourceName,
      sourceUrl: opts.url,
      meta: { bpm: cp.tempo, tuning: TUNING_STANDARD },
      hash: hashString(cp.alphaTex),
    }),
    warnings: [...warnings, ...cp.warnings],
  };
}

/** 内置示例谱：原创 E 小调练习曲，用来保证首次启动就有东西可看 */
export const DEMO_ALPHATEX = `\\title "First Light 练习曲"
\\artist "GuitarFlow 示例"
\\tempo 96
\\tuning (E4 B3 G3 D3 A2 E2)
.
:8 0.6 0.5 2.4 0.5 3.3 0.5 2.4 0.5 |
:8 0.6 0.5 2.4 0.5 3.3 0.4 2.3 0.4 |
:8 (0.6 0.5 0.4 0.3 0.2 0.1) :8 (0.6 0.5 0.4 0.3 0.2 0.1) :8 (0.5 0.4 0.3 0.2 0.1) :8 (0.5 0.4 0.3 0.2 0.1) |
:8 5.5 0.5 3.4 0.5 0.3 0.5 3.4 0.5 |
:8 5.6 0.5 3.5 0.5 0.2 0.5 3.5 0.5 |
:8 (0.6 0.5 0.4 0.3 0.2 0.1) :8 (2.6 2.5 2.4 2.3 2.2 2.1) :8 (2.6 2.5 2.4 2.3 2.2 2.1) :2 (0.6 0.5 0.4 0.3 0.2 0.1) |`;

export function demoDoc(): ImportOutcome {
  return {
    doc: newDoc({
      title: 'First Light 练习曲',
      artist: 'GuitarFlow 示例',
      format: 'alphatex',
      text: DEMO_ALPHATEX,
      sourceId: 'demo',
      sourceName: '内置示例',
      meta: { bpm: 96, tuning: TUNING_STANDARD, noteCount: 44 },
      hash: hashString(DEMO_ALPHATEX),
      favorite: true,
    }),
    warnings: [],
  };
}