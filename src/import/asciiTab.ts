import { TUNING_STANDARD } from '../core/types';
import { chordVoicing } from './chords';

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
  /** 1 = 高音 e 弦 .. 6 = 低音 E 弦 */
  string: number;
  fret: number;
  tech?: 'h' | 'p' | 'b' | 's' | 'x';
}

const STRING_LINE = /^\s*[eEaAbBdDgG1-6]\s*[|:\-]/;
const TAB_CHARS = /^[\s|:0-9a-gxhpb/~\\()\-\^v↑↓]+$/i;

function isTabLine(line: string): boolean {
  if (!STRING_LINE.test(line)) return false;
  if (!line.includes('|') && !line.includes(':') && !line.includes('--')) return false;
  return TAB_CHARS.test(line);
}

/**
 * 解析单条弦线：
 *  - 数字 0..24 直接作为品位
 *  - 'x'/'X' 若当前小节有和弦指法，自动按该和弦在对应弦上的品位发声（不再简单丢弃成休止符）
 */
function parseStringLine(line: string, stringIndex: number, chordList: string[]): Token[] {
  const tokens: Token[] = [];
  const barPositions = barlines(line);
  let i = line.indexOf('|');
  if (i < 0) i = line.indexOf(':');
  if (i < 0) i = 1;

  while (i < line.length) {
    const ch = line[i];
    if (ch >= '0' && ch <= '9') {
      let num = ch;
      let j = i + 1;
      if (line[j] >= '0' && line[j] <= '9' && num !== '0') {
        const twoDigit = parseInt(num + line[j], 10);
        if (twoDigit <= 24) {
          num += line[j];
          j++;
        }
      }
      let tech: Token['tech'];
      const next = line[j];
      if (next === 'h' || next === 'p' || next === 'b' || next === 'r' || next === '/') tech = 'h';
      else if (next === '~') tech = 's';
      tokens.push({ col: i, string: stringIndex, fret: parseInt(num, 10), tech });
      i = j;
      continue;
    }
    if (ch === 'x' || ch === 'X') {
      // 确定当前列所在的小节序号，匹配和弦指法
      let barIdx = 0;
      for (let b = 0; b < barPositions.length; b++) {
        if (barPositions[b] < i) barIdx = b;
      }
      const chordName = chordList.length ? chordList[Math.min(barIdx, chordList.length - 1)] : 'C';
      const voicing = chordVoicing(chordName) ?? [-1, 3, 2, 0, 1, 0];
      // voicing 顺序为 6弦->1弦，stringIndex 为 1弦(1)->6弦(6)
      const resolvedFret = Math.max(0, voicing[6 - stringIndex] ?? 0);
      tokens.push({ col: i, string: stringIndex, fret: resolvedFret, tech: 'x' });
    }
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
 * 支持和弦列、休止、击勾弦、推弦、x 伴奏音型（结合上方和弦自动还原品位）、多段/多小节；
 * 小节切分优先用行内竖线，没有内部分隔时按 8 个八分音符合成一小节。
 */
export function parseAsciiTab(text: string, fallbackTitle = '导入的六线谱'): AsciiTabResult | null {
  const warnings: string[] = [];
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n');

  let title = fallbackTitle;
  let artist = '';
  let tempo = 96;
  for (const line of rawLines.slice(0, 12)) {
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
    const bpmMatch = /(?:tempo|bpm|速度)\s*[:：=]?\s*(\d{2,3})/i.exec(t);
    if (bpmMatch) {
      tempo = Math.max(40, Math.min(240, parseInt(bpmMatch[1], 10)));
      continue;
    }
    if (title === fallbackTitle && t.length < 60 && !t.startsWith('#')) title = t;
  }

  // 收集连续的 tab 行块，同时提取块上方的和弦注释行（如 # Chords: G | Em | Am | D）
  const blocks: Array<{ lines: string[]; chords: string[] }> = [];
  let pendingChords: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const trimmed = rawLines[i].trim();
    if (/^#\s*chords\s*:/i.test(trimmed)) {
      pendingChords = trimmed
        .replace(/^#\s*chords\s*:\s*/i, '')
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }
    if (!isTabLine(rawLines[i])) {
      const chordMatches = trimmed.match(/\b[A-G][#b]?(?:m|maj7|m7|7|sus2|sus4|add9|dim|aug)?\b/g);
      if (chordMatches && chordMatches.length >= 2 && trimmed.length < 100) {
        pendingChords = chordMatches;
      }
      continue;
    }
    const group: string[] = [];
    let j = i;
    while (j < rawLines.length && isTabLine(rawLines[j]) && group.length < 7) {
      group.push(rawLines[j]);
      j++;
    }
    if (group.length >= 5) {
      blocks.push({ lines: group.slice(0, 6), chords: pendingChords });
      pendingChords = [];
    }
    i = j - 1;
  }
  if (!blocks.length) return null;

  interface Segment {
    tokens: Token[];
    bars: number[];
    firstCol: number;
    lastCol: number;
  }
  const segments: Segment[] = blocks.map(({ lines: block, chords }) => {
    const tokens: Token[] = [];
    block.forEach((line, idx) => tokens.push(...parseStringLine(line, idx + 1, chords)));
    const cols = tokens.map((t) => t.col);
    return {
      tokens,
      bars: barlines(block[0]),
      firstCol: cols.length ? Math.min(...cols) : 0,
      lastCol: cols.length ? Math.max(...cols) : 0,
    };
  });

  // 列间距 → 十六分/八分音符栅格
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
    if (ratio >= 6.5) return ':1';
    if (ratio >= 3.1) return ':2';
    if (ratio >= 1.6) return ':4';
    if (ratio >= 0.75) return ':8';
    return ':16';
  };

  const tokenToBeat = (group: Token[]): string => {
    const byStr = new Map<number, number>();
    for (const t of group) {
      if (t.fret >= 0 && !byStr.has(t.string)) byStr.set(t.string, t.fret);
    }
    const parts = [...byStr.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([str, fret]) => `${fret}.${str}`);
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

    clusters.forEach((cluster, idx) => {
      const barKey = interiorBars.length
        ? interiorBars.filter((c) => c < cluster[0].col).length
        : Math.floor(idx / 8);

      if (barKey !== currentBarKey && current.length) {
        measures.push(current);
        current = [];
      }
      currentBarKey = barKey;

      const next = clusters[idx + 1];
      const sameBar =
        next &&
        (interiorBars.length
          ? interiorBars.filter((c) => c < next[0].col).length === barKey
          : Math.floor((idx + 1) / 8) === barKey);
      const gap = next && sameBar ? Math.max(1, next[0].col - cluster[0].col) : grid * 2;

      current.push(`${durForGap(gap)} ${tokenToBeat(cluster)}`);
      noteCount += cluster.filter((t) => t.fret >= 0).length;
    });
    if (current.length) measures.push(current);
  }

  if (!measures.length) return null;

  const bars = measures.map((m) => m.join(' ')).join(' |\n');
  const alphaTex = [
    `\\title "${title.replace(/"/g, "'")}"`,
    artist ? `\\artist "${artist.replace(/"/g, "'")}"` : '',
    `\\tempo ${tempo}`,
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
    } else if (line.trim() && !line.trim().startsWith('#')) {
      run = 0;
    }
  }
  return false;
}

/** 从文本里推断调弦（默认标准调弦） */
export function detectTuning(): number[] {
  return TUNING_STANDARD;
}