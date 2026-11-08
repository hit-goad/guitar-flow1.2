import { chordMidi } from './chords';
import { TUNING_STANDARD } from '../core/types';

export interface ChordProResult {
  title: string;
  artist: string;
  key?: string;
  capo: number;
  tempo: number;
  alphaTex: string;
  warnings: string[];
  sections: number;
}

interface ChordToken {
  chord: string;
  at: number;
}

/**
 * ChordPro → alphaTex。
 * 每个和弦按真实指法生成下扫音（因此每个音都有正确音高），
 * 和弦密度决定每小节时值分配。
 */
export function parseChordPro(text: string, fallbackTitle = '导入的弹唱谱'): ChordProResult | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const warnings: string[] = [];
  let title = fallbackTitle;
  let artist = '';
  let key: string | undefined;
  let capo = 0;
  let tempo = 90;

  const bars: string[] = [];
  let sectionCount = 0;
  let pendingNewline = false;

  const flushLine = (line: string) => {
    const chords: ChordToken[] = [];
    let lyric = '';
    let i = 0;
    while (i < line.length) {
      if (line[i] === '[') {
        const end = line.indexOf(']', i);
        if (end > i) {
          const chord = line.slice(i + 1, end).trim();
          if (chord) chords.push({ chord, at: lyric.length });
          i = end + 1;
          continue;
        }
      }
      lyric += line[i++];
    }
    if (!chords.length) {
      // 可能是纯和弦行：| Am | F | G |
      const maybe = line.match(/\b[A-G][#b]?(?:m|maj|min|dim|aug|sus|add|7|9|6|5)?(?:\/[A-G][#b]?)?\b/g);
      if (maybe && line.includes('|')) {
        maybe.forEach((c) => chords.push({ chord: c, at: 0 }));
      }
    }
    if (!chords.length) return;

    const perBar = 4;
    const beatsPerChord = Math.max(1, Math.floor(perBar / Math.min(chords.length, perBar)));
    const durMap: Record<number, string> = { 4: ':1', 2: ':2', 1: ':4' };
    const dur = durMap[beatsPerChord] ?? ':4';

    const cells: string[] = [];
    for (const c of chords.slice(0, perBar)) {
      const midis = chordMidi(c.chord, TUNING_STANDARD, capo);
      if (!midis.length) {
        warnings.push(`无法识别和弦指法：${c.chord}（已用休止代替）`);
        cells.push(`${dur} r`);
        continue;
      }
      const positions = midis
        .map((m) => fretOf(m, capo))
        .filter((x): x is { string: number; fret: number } => !!x)
        .map((p) => `${p.fret}.${p.string}`);
      const body = positions.length ? (positions.length === 1 ? positions[0] : `(${positions.join(' ')})`) : 'r';
      // 每个和弦弹两下（下扫），节奏更接近弹唱
      cells.push(`${dur} ${body}`);
      cells.push(`${dur} ${body}`);
    }
    // 补一个完整小节
    const slotsNeeded = 4 - chords.slice(0, perBar).length * 2;
    for (let i = 0; i < slotsNeeded; i++) cells.push(':4 r');
    bars.push(cells.join(' '));
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const directive = /^\{\s*([a-zA-Z_]+)\s*:?\s*(.*?)\s*\}$/.exec(line.trim());
    if (directive) {
      const [, name, value] = directive;
      switch (name.toLowerCase()) {
        case 'title':
        case 't':
          title = value || title;
          break;
        case 'artist':
        case 'subtitle':
        case 'st':
          artist = value || artist;
          break;
        case 'key':
          key = value;
          break;
        case 'capo':
          capo = parseInt(value, 10) || 0;
          break;
        case 'tempo':
          tempo = parseInt(value, 10) || tempo;
          break;
        case 'start_of_chorus':
        case 'soc':
        case 'start_of_verse':
        case 'sov':
        case 'start_of_bridge':
        case 'sob':
          sectionCount++;
          bars.push(':4 r :4 r :4 r :4 r');
          break;
        default:
          break;
      }
      continue;
    }
    if (!line.trim()) {
      pendingNewline = true;
      continue;
    }
    if (line.trim().startsWith('#')) continue;
    flushLine(line);
    pendingNewline = false;
  }

  if (!bars.length) return null;

  const alphaTex = [
    `\\title "${title.replace(/"/g, "'")}"`,
    artist ? `\\artist "${artist.replace(/"/g, "'")}"` : '',
    `\\tempo ${tempo}`,
    capo ? `\\capo ${capo}` : '',
    '\\tuning (E4 B3 G3 D3 A2 E2)',
    '.',
    bars.join(' |\n') + ' |',
  ]
    .filter(Boolean)
    .join('\n');

  if (!artist) warnings.push('未找到 {artist} 标签，艺人留空');
  return { title, artist, key, capo, tempo, alphaTex, warnings, sections: sectionCount };
}

function fretOf(midi: number, capo: number): { string: number; fret: number } | null {
  let best: { string: number; fret: number } | null = null;
  for (let i = 0; i < TUNING_STANDARD.length; i++) {
    const fret = midi - TUNING_STANDARD[i] - capo;
    if (fret < 0 || fret > 15) continue;
    if (!best || fret < best.fret) best = { string: TUNING_STANDARD.length - i, fret };
  }
  return best;
}

export function looksLikeChordPro(text: string): boolean {
  return /\[[A-G][#b]?[^\]]*\]/.test(text) || /\{\s*(title|artist|capo|start_of_chorus)\s*:/i.test(text);
}