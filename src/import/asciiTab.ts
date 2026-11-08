import { TUNING_STANDARD } from '../core/types';

export interface AsciiTabResult {
  title: string;
  artist: string;
  alphaTex: string;
  warnings: string[];
  measures: number;
  noteCount: number;
}

interface Token {
  col: number;
  /** 1 = 高音 e 弦 */
  string: number;
  fret: number;
  tech?: 'h' | 'p' | 'b' | 's' | 'x';
}

const STRING_LINE = /^\s*[eEaAbBdDgG]\s*[|:]/;
const TAB_CHARS = /^[\s|:0-9a-gxhpb/~\\()\-]+$/i;

function isTabLine(line: string): boolean {
  if (!STRING_LINE.test(line)) return false;
  if (!line.includes('|') && !line.includes(':')) return false;
  return TAB_CHARS.test(line);
}

function parseStringLine(line: string, stringIndex: number): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch >= '0' && ch <= '9') {
      let num = ch;
      let j = i + 1;
      if (line[j] >= '0' && line[j] <= '9' && num !== '0') {
        num += line[j];
        j++;
      }
      let tech: Token['tech'];
      const next = line[j];
      if (next === 'h' || next === 'p' || next === 'b' || next === 'r' || next === '/') tech = 'h';
      else if (next === '~') tech = 's';
      tokens.push({ col: i, string: stringIndex, fret: parseInt(num, 10), tech });
      i = j;
      continue;
    }
    if (ch === 'x' || ch === 'X') tokens.push({ col: i, string: stringIndex, fret: -1, tech: 'x' });
    i++;
  }
  return tokens;
}

function barlines(line: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < line.length; i++) if (line[i] === '|' || line[i] === ':') out.push(i);
  return out;
}

/**
 * ASCII 六线谱 → alphaTex。
 * 支持和弦列、休止、击勾弦、推弦、多段/多小节；
 * 小节切分优先用行内竖线，没有内部分隔时按 8 个八分音符合成一小节。
 */
export function parseAsciiTab(text: string, fallbackTitle = '导入的六线谱'): AsciiTabResult | null {
  const warnings: string[] = [];
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n');

  let title = fallbackTitle;
  let artist = '';
  for (const line of rawLines.slice(0, 10)) {
    const t = line.trim();
    if (!t || isTabLine(t)) continue;
    const m = /^(?:title|song|歌曲|曲名|歌名)\s*[:：]\s*(.+)$/i.exec(t);
    if (m) {
      title = m[1].trim();
      continue;
    }
    const a = /^(?:artist|歌手|艺人|演唱)\s*[:：]\s*(.+)$/i.exec(t);
    if (a) {
      artist = a[1].trim();
      continue;
    }
    if (title === fallbackTitle && t.length < 60 && !t.startsWith('#')) title = t;
  }

  // 收集连续的 tab 行块
  const blocks: string[][] = [];
  for (let i = 0; i < rawLines.length; i++) {
    if (!isTabLine(rawLines[i])) continue;
    const group: string[] = [];
    let j = i;
    while (j < rawLines.length && isTabLine(rawLines[j]) && group.length < 7) {
      group.push(rawLines[j]);
      j++;
    }
    if (group.length >= 5) blocks.push(group);
    i = j - 1;
  }
  if (!blocks.length) return null;

  interface Segment {
    tokens: Token[];
    bars: number[];
    firstCol: number;
    lastCol: number;
  }
  const segments: Segment[] = blocks.map((block) => {
    const tokens: Token[] = [];
    block.forEach((line, idx) => tokens.push(...parseStringLine(line, idx + 1)));
    const cols = tokens.map((t) => t.col);
    return {
      tokens,
      bars: barlines(block[0]),
      firstCol: cols.length ? Math.min(...cols) : 0,
      lastCol: cols.length ? Math.max(...cols) : 0,
    };
  });

  // 列间距 → 十六分音符栅格
  const allCols = [...new Set(segments.flatMap((s) => s.tokens.map((t) => t.col)))].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < allCols.length; i++) {
    const g = allCols[i] - allCols[i - 1];
    if (g > 0) gaps.push(g);
  }
  gaps.sort((a, b) => a - b);
  const grid = Math.max(1, gaps[Math.floor(gaps.length * 0.25)] || 2);

  const durForGap = (gap: number): string => {
    const ratio = gap / grid;
    if (ratio >= 7) return ':1';
    if (ratio >= 3.2) return ':2';
    if (ratio >= 1.7) return ':4';
    return ':8';
  };

  const tokenToBeat = (group: Token[]): string => {
    const parts = group
      .filter((t) => t.fret >= 0)
      .map((t) => `${t.fret}.${t.string}`)
      .sort();
    if (!parts.length) return 'r';
    return parts.length === 1 ? parts[0] : `(${parts.join(' ')})`;
  };

  const measures: string[][] = [];
  let noteCount = 0;

  for (const seg of segments) {
    const sorted = [...seg.tokens].sort((a, b) => a.col - b.col || a.string - b.string);
    const clusters: Token[][] = [];
    for (const tok of sorted) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(last[0].col - tok.col) <= 1) last.push(tok);
      else clusters.push([tok]);
    }
    if (!clusters.length) continue;

    const interiorBars = seg.bars
      .filter((c) => c > seg.firstCol + 2 && c < seg.lastCol - 1)
      .sort((a, b) => a - b);

    let current: string[] = [];
    let currentBarKey = 0;
    let beatCountInBar = 0;

    clusters.forEach((cluster, idx) => {
      const barKey = interiorBars.length
        ? interiorBars.filter((c) => c < cluster[0].col).length
        : Math.floor(idx / 8);

      if (barKey !== currentBarKey && current.length) {
        measures.push(current);
        current = [];
        beatCountInBar = 0;
      }
      currentBarKey = barKey;

      const next = clusters[idx + 1];
      const sameBar = next && (interiorBars.length
        ? interiorBars.filter((c) => c < next[0].col).length === barKey
        : Math.floor((idx + 1) / 8) === barKey);
      const gap = next && sameBar ? Math.max(1, next[0].col - cluster[0].col) : grid * 2;

      current.push(`${durForGap(gap)} ${tokenToBeat(cluster)}`);
      beatCountInBar++;
      noteCount += cluster.filter((t) => t.fret >= 0).length;
    });
    if (current.length) measures.push(current);
  }

  if (!measures.length) return null;

  const bars = measures.map((m) => m.join(' ')).join(' |\n');
  const alphaTex = [
    `\\title "${title.replace(/"/g, "'")}"`,
    artist ? `\\artist "${artist.replace(/"/g, "'")}"` : '',
    '\\tempo 90',
    '\\tuning (E4 B3 G3 D3 A2 E2)',
    '.',
    bars + ' |',
  ]
    .filter(Boolean)
    .join('\n');

  if (noteCount === 0) warnings.push('未识别到有效音符');
  if (measures.length < 2) warnings.push('只识别出 1 个小节，可能是片段谱');

  return { title, artist, alphaTex, warnings, measures: measures.length, noteCount };
}

/** 判断文本是否是六线谱（导入器做类型嗅探） */
export function looksLikeAsciiTab(text: string): boolean {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let run = 0;
  for (const line of lines) {
    if (isTabLine(line)) {
      run++;
      if (run >= 4) return true;
    } else if (line.trim()) {
      run = 0;
    }
  }
  return false;
}

/** 从文本里推断调弦（默认标准调弦） */
export function detectTuning(): number[] {
  return TUNING_STANDARD;
}