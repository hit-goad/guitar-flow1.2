import { TUNING_STANDARD } from '../core/types';

/** 六根弦从低到高（6弦→1弦）的品位，-1 = 不弹 */
export type Voicing = number[];

const OPEN_VOICINGS: Record<string, Voicing> = {
  C: [-1, 3, 2, 0, 1, 0],
  Cm: [-1, 3, 5, 5, 4, 3],
  C7: [-1, 3, 2, 3, 1, 0],
  Cmaj7: [-1, 3, 2, 0, 0, 0],
  Cm7: [-1, 3, 5, 3, 4, 3],
  Csus2: [-1, 3, 0, 0, 3, 3],
  Csus4: [-1, 3, 3, 0, 1, 1],
  Cadd9: [-1, 3, 2, 0, 3, 0],
  C6: [-1, 3, 2, 2, 1, 0],
  Cm6: [-1, 3, 1, 2, 1, 3],
  Cdim: [-1, 3, 4, 5, 4, -1],
  Caug: [-1, 3, 2, 1, 1, 0],
  C9: [-1, 3, 2, 3, 3, 3],
  D: [-1, -1, 0, 2, 3, 2],
  Dm: [-1, -1, 0, 2, 3, 1],
  D7: [-1, -1, 0, 2, 1, 2],
  Dmaj7: [-1, -1, 0, 2, 2, 2],
  Dm7: [-1, -1, 0, 2, 1, 1],
  Dsus2: [-1, -1, 0, 2, 3, 0],
  Dsus4: [-1, -1, 0, 2, 3, 3],
  Dadd9: [-1, -1, 0, 2, 3, 0],
  D6: [-1, -1, 0, 2, 0, 2],
  Ddim: [-1, -1, 0, 1, 3, 1],
  D9: [-1, -1, 0, 2, 1, 0],
  E: [0, 2, 2, 1, 0, 0],
  Em: [0, 2, 2, 0, 0, 0],
  E7: [0, 2, 0, 1, 0, 0],
  Emaj7: [0, 2, 1, 1, 0, 0],
  Em7: [0, 2, 0, 0, 0, 0],
  Esus4: [0, 2, 2, 2, 0, 0],
  E6: [0, 2, 2, 1, 2, 0],
  Eadd9: [0, 2, 2, 1, 0, 2],
  E9: [0, 2, 0, 1, 0, 2],
  Edim: [0, 1, 2, 3, 2, -1],
  Eaug: [0, 3, 2, 1, 1, 0],
  F: [1, 3, 3, 2, 1, 1],
  Fm: [1, 3, 3, 1, 1, 1],
  F7: [1, 3, 1, 2, 1, 1],
  Fmaj7: [1, 3, 2, 2, 1, 1],
  Fm7: [1, 3, 1, 1, 1, 1],
  Fsus4: [1, 3, 3, 3, 1, 1],
  F6: [1, 3, 3, 2, 3, 1],
  Fadd9: [1, 3, 3, 2, 1, 3],
  Fdim: [1, 2, 3, 4, 3, -1],
  G: [3, 2, 0, 0, 0, 3],
  Gm: [3, 5, 5, 3, 3, 3],
  G7: [3, 2, 0, 0, 0, 1],
  Gmaj7: [3, 2, 0, 0, 0, 2],
  Gm7: [3, 5, 3, 3, 3, 3],
  Gsus2: [3, 0, 0, 0, 3, 3],
  Gsus4: [3, 3, 0, 0, 1, 3],
  Gadd9: [3, 0, 0, 2, 0, 3],
  G6: [3, 2, 0, 0, 0, 0],
  G9: [3, 2, 0, 2, 0, 1],
  Gdim: [3, 4, 5, 3, 5, -1],
  A: [-1, 0, 2, 2, 2, 0],
  Am: [-1, 0, 2, 2, 1, 0],
  A7: [-1, 0, 2, 0, 2, 0],
  Amaj7: [-1, 0, 2, 1, 2, 0],
  Am7: [-1, 0, 2, 0, 1, 0],
  Asus2: [-1, 0, 2, 2, 0, 0],
  Asus4: [-1, 0, 2, 2, 3, 0],
  Aadd9: [-1, 0, 2, 4, 2, 0],
  A6: [-1, 0, 2, 2, 2, 2],
  A9: [-1, 0, 2, 0, 2, 2],
  Am6: [-1, 0, 2, 2, 1, 2],
  Adim: [-1, 0, 1, 2, 1, -1],
  Aaug: [-1, 0, 3, 2, 2, 1],
  B: [-1, 2, 4, 4, 4, 2],
  Bm: [-1, 2, 4, 4, 3, 2],
  B7: [-1, 2, 1, 2, 0, 2],
  Bmaj7: [-1, 2, 4, 3, 4, 2],
  Bm7: [-1, 2, 4, 2, 3, 2],
  Bsus2: [-1, 2, 4, 4, 2, 2],
  Bsus4: [-1, 2, 4, 4, 5, 2],
  Badd9: [-1, 2, 4, 4, 4, 1],
  Bdim: [-1, 2, 3, 4, 3, -1],
  Baug: [-1, 2, 4, 4, 4, 1],
  Bb: [-1, 1, 3, 3, 3, 1],
  Bbm: [-1, 1, 3, 3, 2, 1],
  Bb7: [-1, 1, 3, 1, 2, 1],
  Bbmaj7: [-1, 1, 3, 2, 3, 1],
  Bbm7: [-1, 1, 3, 1, 2, 1],
  Bb6: [-1, 1, 3, 3, 3, 3],
  Ab: [4, 6, 6, 5, 4, 4],
  Abm: [4, 6, 6, 4, 4, 4],
  Ab7: [4, 6, 4, 5, 4, 4],
  Db: [-1, 4, 6, 6, 6, 4],
  Dbm: [-1, 4, 6, 6, 5, 4],
  Eb: [-1, 6, 8, 8, 8, 6],
  Ebm: [-1, 6, 8, 8, 7, 6],
  Fm7b5: [1, -1, 1, 2, 1, -1],
};

const PC_NAMES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const QUALITY_ALIASES: Record<string, string> = {
  '': 'maj',
  M: 'maj',
  maj: 'maj',
  major: 'maj',
  m: 'min',
  min: 'min',
  '-': 'min',
  mi: 'min',
  '7': '7',
  dom7: '7',
  'maj7': 'maj7',
  M7: 'maj7',
  m7: 'm7',
  min7: 'm7',
  '6': '6',
  m6: 'm6',
  min6: 'm6',
  '9': '9',
  m9: 'm9',
  add9: 'add9',
  '2': 'sus2',
  sus2: 'sus2',
  '4': 'sus4',
  sus: 'sus4',
  sus4: 'sus4',
  dim: 'dim',
  '°': 'dim',
  o: 'dim',
  aug: 'aug',
  '+': 'aug',
  '7sus4': '7sus4',
  '11': '11',
  '13': '13',
  'maj9': 'maj9',
  '5': '5',
};

export interface ParsedChord {
  root: string;
  pc: number;
  quality: string;
  bassPc?: number;
  raw: string;
}

export function parseChord(raw: string): ParsedChord | null {
  const name = raw.trim().replace(/♯/g, '#').replace(/♭/g, 'b');
  const m = /^([A-Ga-g])([#b]?)(.*)$/.exec(name);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  const pc = (PC_NAMES[letter] + accidental + 12) % 12;
  let rest = m[3].trim();
  let bassPc: number | undefined;
  const slash = rest.match(/\/\s*([A-G][#b]?)$/);
  if (slash) {
    const bm = /^([A-G])([#b]?)$/.exec(slash[1]);
    if (bm) bassPc = (PC_NAMES[bm[1]] + (bm[2] === '#' ? 1 : bm[2] === 'b' ? -1 : 0) + 12) % 12;
    rest = rest.slice(0, slash.index).trim();
  }
  const quality = QUALITY_ALIASES[rest] ?? QUALITY_ALIASES[rest.toLowerCase()] ?? 'maj';
  return { root: letter + m[2], pc, quality, bassPc, raw: name };
}

const E_SHAPE: Record<string, Voicing> = {
  maj: [0, 2, 2, 1, 0, 0],
  min: [0, 2, 2, 0, 0, 0],
  '7': [0, 2, 0, 1, 0, 0],
  maj7: [0, 2, 1, 1, 0, 0],
  m7: [0, 2, 0, 0, 0, 0],
  m9: [0, 2, 0, 0, 0, 2],
  '9': [0, 2, 0, 1, 0, 2],
  maj9: [0, 2, 1, 1, 0, 2],
  '6': [0, 2, 2, 1, 2, 0],
  m6: [0, 2, 2, 0, 2, 0],
  add9: [0, 2, 2, 1, 0, 2],
  sus2: [0, 2, 4, 4, 0, 0],
  sus4: [0, 2, 2, 2, 0, 0],
  '7sus4': [0, 2, 0, 2, 0, 0],
  dim: [0, 1, 2, 0, 2, -1],
  '5': [0, 2, 2, -1, -1, -1],
};

const A_SHAPE: Record<string, Voicing> = {
  maj: [-1, 0, 2, 2, 2, 0],
  min: [-1, 0, 2, 2, 1, 0],
  '7': [-1, 0, 2, 0, 2, 0],
  maj7: [-1, 0, 2, 1, 2, 0],
  m7: [-1, 0, 2, 0, 1, 0],
  '9': [-1, 0, 2, 0, 2, 2],
  maj9: [-1, 0, 2, 1, 2, 2],
  '6': [-1, 0, 2, 2, 2, 2],
  m6: [-1, 0, 2, 2, 1, 2],
  add9: [-1, 0, 2, 4, 2, 0],
  sus2: [-1, 0, 2, 2, 0, 0],
  sus4: [-1, 0, 2, 2, 3, 0],
  '7sus4': [-1, 0, 2, 0, 3, 0],
  dim: [-1, 0, 1, 2, 1, -1],
  '5': [-1, 0, 2, 2, -1, -1],
};

/** 质量名 → 开放和弦表里的后缀写法 */
const QUALITY_SUFFIX: Record<string, string> = {
  maj: '',
  min: 'm',
  '7': '7',
  maj7: 'maj7',
  m7: 'm7',
  m9: 'm9',
  '9': '9',
  maj9: 'maj9',
  '6': '6',
  m6: 'm6',
  add9: 'add9',
  sus2: 'sus2',
  sus4: 'sus4',
  '7sus4': '7sus4',
  dim: 'dim',
  aug: 'aug',
  '5': '5',
};

/** 把和弦名解析成实际品位（自动选择把位；根音在第 6 弦优先） */
export function chordVoicing(name: string, tuning: number[] = TUNING_STANDARD): Voicing | null {
  const parsed = parseChord(name);
  if (!parsed) return null;
  const key = parsed.root;
  const suffix = QUALITY_SUFFIX[parsed.quality] ?? '';
  const direct = OPEN_VOICINGS[key + suffix];
  // 开放和弦只在原调式（根音相同）时使用
  if (direct && direct.length === 6) {
    return applyBass(direct, parsed, tuning);
  }

  const shape = E_SHAPE[parsed.quality] ?? E_SHAPE.maj;
  const eLowPc = tuning[0] % 12;
  const aLowPc = tuning[1] % 12;
  const eFret = ((parsed.pc - eLowPc) % 12 + 12) % 12;
  const aFret = ((parsed.pc - aLowPc) % 12 + 12) % 12;

  let voicing: Voicing;
  if (parsed.quality === '5') {
    voicing = [eFret, eFret + 2, eFret + 2, -1, -1, -1];
  } else if (eFret <= 8) {
    voicing = shape.map((f) => (f < 0 ? f : f + eFret));
  } else {
    const aShape = A_SHAPE[parsed.quality] ?? A_SHAPE.maj;
    voicing = aShape.map((f) => (f < 0 ? f : f + aFret));
  }
  return applyBass(voicing, parsed, tuning);
}

function applyBass(voicing: Voicing, parsed: ParsedChord, tuning: number[]): Voicing {
  if (parsed.bassPc === undefined) return voicing;
  const lowPc = tuning[0] % 12;
  const fret = ((parsed.bassPc - lowPc) % 12 + 12) % 12;
  const out = [...voicing];
  if (fret <= 12) out[0] = fret;
  return out;
}

/** 品位 → MIDI 音高数组 */
export function voicingToMidi(voicing: Voicing, tuning: number[] = TUNING_STANDARD, capo = 0): number[] {
  const out: number[] = [];
  voicing.forEach((fret, i) => {
    if (fret < 0) return;
    const open = tuning[i] ?? TUNING_STANDARD[i];
    out.push(open + (fret === 0 ? capo : fret + capo));
  });
  return out.sort((a, b) => a - b);
}

export function chordMidi(name: string, tuning: number[] = TUNING_STANDARD, capo = 0): number[] {
  const v = chordVoicing(name, tuning);
  return v ? voicingToMidi(v, tuning, capo) : [];
}

/** 把 MIDI 音高分配到最合理的 6 弦品位 */
export function midiToPosition(midi: number, tuning: number[] = TUNING_STANDARD): { string: number; fret: number } | null {
  let best: { string: number; fret: number } | null = null;
  for (let i = 0; i < tuning.length; i++) {
    const fret = midi - tuning[i];
    if (fret < 0 || fret > 19) continue;
    if (!best || fret < best.fret) best = { string: tuning.length - i, fret };
  }
  if (best) return best;
  // 超范围：放到 1 弦高位或 6 弦低位
  for (let i = 0; i < tuning.length; i++) {
    const fret = midi - tuning[i];
    if (fret >= 0 && fret <= 24) return { string: tuning.length - i, fret };
  }
  return null;
}

export const ALL_CHORD_NAMES = Object.keys(OPEN_VOICINGS);