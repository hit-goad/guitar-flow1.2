import { Midi } from '@tonejs/midi';
import { midiToPosition } from './chords';
import { TUNING_STANDARD } from '../core/types';

export interface MidiImportResult {
  alphaTex: string;
  title: string;
  tempo: number;
  noteCount: number;
  warnings: string[];
}

const TICKS_PER_QUARTER = 960;

const DUR_SYMBOL: Array<{ ticks: number; sym: string }> = [
  { ticks: TICKS_PER_QUARTER * 4, sym: ':1' },
  { ticks: TICKS_PER_QUARTER * 3, sym: ':2.' },
  { ticks: TICKS_PER_QUARTER * 2, sym: ':2' },
  { ticks: TICKS_PER_QUARTER * 1.5, sym: ':4.' },
  { ticks: TICKS_PER_QUARTER, sym: ':4' },
  { ticks: TICKS_PER_QUARTER / 2, sym: ':8' },
  { ticks: TICKS_PER_QUARTER / 4, sym: ':16' },
  { ticks: TICKS_PER_QUARTER / 8, sym: ':32' },
];

function durationSymbol(ticks: number): string {
  let best = DUR_SYMBOL[DUR_SYMBOL.length - 1];
  let bestDiff = Infinity;
  for (const d of DUR_SYMBOL) {
    const diff = Math.abs(d.ticks - ticks);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = d;
    }
  }
  return best.sym;
}

/**
 * MIDI → alphaTex（吉他六线谱）。
 * 每个音按最近的弦/品分配，同时发声的音合并成和弦，
 * 小节线按 4/4 自动补齐。
 */
export function midiToAlphaTex(data: ArrayBuffer, fallbackTitle = '导入的 MIDI'): MidiImportResult | null {
  const midi = new Midi(data);
  const warnings: string[] = [];
  const ppq = midi.header.ppq || 480;
  const scale = TICKS_PER_QUARTER / ppq;
  const tempo = midi.header.tempos[0]?.bpm ?? 100;

  let track = midi.tracks[0];
  for (const t of midi.tracks) {
    if ((t.notes?.length ?? 0) > (track?.notes?.length ?? 0)) track = t;
  }
  if (!track || !track.notes.length) return null;

  interface Ev {
    tick: number;
    midis: number[];
    durationTicks: number;
  }
  const groups = new Map<number, { midis: number[]; duration: number }>();
  for (const note of track.notes) {
    const tick = Math.round(note.ticks * scale);
    const dur = Math.round(note.durationTicks * scale);
    const g = groups.get(tick) ?? { midis: [], duration: 0 };
    g.midis.push(note.midi);
    g.duration = Math.max(g.duration, dur);
    groups.set(tick, g);
  }
  const events: Ev[] = [...groups.entries()]
    .map(([tick, g]) => ({ tick, midis: [...new Set(g.midis)].sort((a, b) => a - b), durationTicks: Math.max(1, g.duration) }))
    .sort((a, b) => a.tick - b.tick);

  const bars: string[] = [];
  let cells: string[] = [];
  let barTicks = 0;
  const barLen = TICKS_PER_QUARTER * 4;
  let pendingRest = 0;

  const pushCell = (cell: string, dur: number) => {
    cells.push(`${durationSymbol(dur)} ${cell}`);
    barTicks += dur;
    if (barTicks >= barLen - 1) {
      bars.push(cells.join(' '));
      cells = [];
      barTicks = 0;
    }
  };

  let prevTick = 0;
  for (const ev of events) {
    const gap = ev.tick - prevTick;
    if (gap > TICKS_PER_QUARTER * 4) {
      // 长休止：用整小节休止补齐
      const fullBars = Math.floor(gap / barLen);
      for (let i = 0; i < fullBars; i++) {
        bars.push(':1 r :1 r :1 r :1 r');
      }
      const rem = gap - fullBars * barLen;
      if (rem > 0) pendingRest += rem;
    } else if (gap > 0) {
      pendingRest += gap;
    }
    if (pendingRest > 0) {
      let rest = pendingRest;
      while (rest > 0) {
        const chunk = rest >= TICKS_PER_QUARTER ? TICKS_PER_QUARTER : rest;
        pushCell('r', Math.max(120, chunk));
        rest -= chunk;
      }
      pendingRest = 0;
    }

    const positions = ev.midis
      .map((m) => midiToPosition(m, TUNING_STANDARD))
      .filter((x): x is { string: number; fret: number } => !!x)
      .map((p) => `${p.fret}.${p.string}`);
    if (!positions.length) continue;
    const body = positions.length === 1 ? positions[0] : `(${positions.join(' ')})`;
    pushCell(body, ev.durationTicks);
    prevTick = ev.tick + Math.max(1, ev.durationTicks);
  }

  if (cells.length) {
    while (barTicks < barLen - 1) {
      pushCell('r', barLen - barTicks);
      if (cells.length === 0) break;
    }
    if (cells.length) bars.push(cells.join(' '));
  }

  if (!bars.length) return null;

  const title = track.name?.trim() || fallbackTitle;
  const alphaTex = [
    `\\title "${title.replace(/"/g, "'")}"`,
    `\\tempo ${Math.round(tempo)}`,
    '\\tuning (E4 B3 G3 D3 A2 E2)',
    '.',
    bars.join(' |\n') + ' |',
  ].join('\n');

  if (track.notes.some((n) => n.midi < TUNING_STANDARD[0] || n.midi > TUNING_STANDARD[5] + 20)) {
    warnings.push('部分音符超出标准调弦范围，已移到最近可弹位置');
  }

  return { alphaTex, title, tempo: Math.round(tempo), noteCount: events.length, warnings };
}