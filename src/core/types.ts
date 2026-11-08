/** 全局数据模型。所有来源的曲谱最终都归一化成 ScoreDoc。 */

export type ScoreFormat =
  | 'alphatex'
  | 'gp'
  | 'musicxml'
  | 'midi'
  | 'ascii'
  | 'chordpro'
  | 'image'
  | 'pdf';

export interface ScoreMeta {
  bpm?: number;
  key?: string;
  timeSignature?: string;
  /** 6 根弦，低音弦在前（E2 A2 D3 G3 B3 E4），MIDI 音高 */
  tuning?: number[];
  capo?: number;
  difficulty?: number;
  tags?: string[];
  /** 图片谱：每页起始时间（秒），用于滚动同步 */
  pageStarts?: number[];
  noteCount?: number;
  durationSec?: number;
  /** 图片/PDF 识谱得到的 ASCII 六线谱原文（便于二次校对与重生成） */
  omrAscii?: string;
  /** 识别到的和弦序列 */
  chords?: string[];
  /** 识谱置信度 0..1 */
  omrConfidence?: number;
}

export interface ScoreDoc {
  id: string;
  title: string;
  artist: string;
  album?: string;
  format: ScoreFormat;
  /** 文本载荷：alphaTex 源码 / ASCII 谱原文 / ChordPro 原文 */
  text?: string;
  /** 二进制载荷：GP、MusicXML、MIDI */
  bytes?: ArrayBuffer;
  /** 图片谱页（扫描件、PDF 渲染页、截图；当已转成 alphatex 时可同时保留以便原谱对照） */
  pages?: Blob[];
  meta: ScoreMeta;
  sourceId: string;
  sourceName: string;
  sourceUrl?: string;
  createdAt: number;
  updatedAt: number;
  openedAt?: number;
  favorite?: boolean;
  /** 内容指纹，用于去重 */
  hash?: string;
}

export interface ImportResult {
  doc: ScoreDoc;
  warnings: string[];
}

export interface SearchHit {
  /** provider 内部 id */
  providerId: string;
  sourceId: string;
  sourceName: string;
  id: string;
  title: string;
  artist: string;
  album?: string;
  url?: string;
  /** 0-100，来源可信度/可播放性 */
  quality?: number;
  /** 是否需要登录/购买 */
  gated?: boolean;
  preview?: string;
  meta?: Partial<ScoreMeta>;
}

export interface Provider {
  id: string;
  name: string;
  /** 来源说明 */
  note?: string;
  gated?: boolean;
  enabled?: boolean;
  search(query: string, signal?: AbortSignal): Promise<SearchHit[]>;
  load(hit: SearchHit, signal?: AbortSignal): Promise<ImportResult>;
}

export const TUNING_STANDARD: number[] = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export function midiToName(midi: number): string {
  const n = Math.round(midi);
  return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function freqToMidi(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440);
}