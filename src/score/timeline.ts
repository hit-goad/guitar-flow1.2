import type * as alphaTabNS from '@coderline/alphatab';
import { midiToName, midiToFreq, TUNING_STANDARD } from '../core/types';

export interface NoteEvent {
  tick: number;
  durationTicks: number;
  midi: number;
  velocity: number;
  string?: number;
  fret?: number;
  beatIndex: number;
}

export interface BeatRef {
  index: number;
  tick: number;
  durationTicks: number;
  endTick: number;
  isRest: boolean;
  notes: NoteEvent[];
  barIndex: number;
  beat: alphaTabNS.model.Beat;
  /** 该好拍的显示名（和弦标记或音名） */
  label: string;
}

export interface TempoSegment {
  tick: number;
  bpm: number;
}

export interface Timeline {
  title: string;
  artist: string;
  beats: BeatRef[];
  notes: NoteEvent[];
  totalTicks: number;
  tempos: TempoSegment[];
  tuning: number[];
  tempo: number;
  trackName: string;
  /** 每拍起始秒（播放结束后用于百分比定位） */
  beatSecs: number[];
  totalSec: number;
}

const DEFAULT_TICKS_PER_QUARTER = 960;

/**
 * 把 alphaTab Score 展平成我们自己的时间轴：
 *  - beats：用于光标/点击跳转/滚动
 *  - notes：用于合成器逐音符发声与音高比对
 */
export function buildTimeline(score: alphaTabNS.model.Score, preferredTrack = 0): Timeline {
  const tracks = score.tracks ?? [];
  const track =
    tracks.find((t) => t.index === preferredTrack) ??
    tracks.find((t) => t.staves.some((s) => s.bars.some((b) => b.voices.some((v) => v.beats.some((x) => !x.isEmpty))))) ??
    tracks[0];

  const beats: BeatRef[] = [];
  const notes: NoteEvent[] = [];
  const masterBarStarts = new Map<alphaTabNS.model.MasterBar, number>();

  if (track) {
    for (const stave of track.staves) {
      for (const bar of stave.bars) {
        const mb = bar.masterBar;
        for (const voice of bar.voices) {
          if (voice.isEmpty) continue;
          for (const beat of voice.beats) {
            const tick = beat.absolutePlaybackStart;
            if (!masterBarStarts.has(mb) || masterBarStarts.get(mb)! > tick) masterBarStarts.set(mb, tick);

            const beatNotes: NoteEvent[] = [];
            if (!beat.isEmpty && beat.notes) {
              for (const note of beat.notes) {
                if (note.isTieDestination) continue;
                const midi = note.realValue;
                if (midi <= 0) continue;
                const ev: NoteEvent = {
                  tick,
                  durationTicks: Math.max(1, beat.playbackDuration ?? beat.duration ?? 1),
                  midi,
                  velocity: Math.min(1, Math.max(0.25, (beat.dynamics ?? 6) / 8)),
                  string: note.string || undefined,
                  fret: note.fret,
                  beatIndex: beats.length,
                };
                beatNotes.push(ev);
                notes.push(ev);
              }
            }
            const label = beatNotes.length
              ? [...new Set(beatNotes.map((n) => midiToName(n.midi)))].join(' ')
              : '';
            beats.push({
              index: beats.length,
              tick,
              durationTicks: Math.max(1, beat.playbackDuration || beat.duration || DEFAULT_TICKS_PER_QUARTER),
              endTick: tick + Math.max(1, beat.playbackDuration || beat.duration || DEFAULT_TICKS_PER_QUARTER),
              isRest: beat.isEmpty || beatNotes.length === 0,
              notes: beatNotes,
              barIndex: bar.index,
              beat,
              label,
            });
          }
        }
      }
    }
  }

  beats.sort((a, b) => a.tick - b.tick);
  beats.forEach((b, i) => (b.index = i));
  // 重新绑定 beatIndex（排序后）
  for (const ev of notes) {
    const owner = beats.find((b) => b.tick <= ev.tick && ev.tick < b.endTick) ?? beats[0];
    ev.beatIndex = owner ? owner.index : 0;
  }

  const totalTicks = beats.length ? Math.max(...beats.map((b) => b.endTick)) : 0;
  const tempos = collectTempos(score, masterBarStarts);
  const timeline: Timeline = {
    title: score.title || '未命名',
    artist: score.artist || '',
    beats,
    notes,
    totalTicks,
    tempos,
    tuning: TUNING_STANDARD,
    tempo: tempos[0]?.bpm ?? score.tempo ?? 100,
    trackName: track?.name || 'Track 1',
    beatSecs: [],
    totalSec: 0,
  };
  timeline.beatSecs = beats.map((b) => tickToSec(timeline, b.tick));
  timeline.totalSec = tickToSec(timeline, totalTicks);
  return timeline;
}

function collectTempos(
  score: alphaTabNS.model.Score,
  masterBarStarts: Map<alphaTabNS.model.MasterBar, number>,
): TempoSegment[] {
  const firstMasterBar = score.masterBars?.[0];
  const initialTempo =
    firstMasterBar?.tempoAutomations?.find((a) => a.value > 0)?.value ?? score.tempo ?? 100;
  const segs: TempoSegment[] = [{ tick: 0, bpm: initialTempo }];
  let last = initialTempo;
  for (const mb of score.masterBars ?? []) {
    const start = masterBarStarts.get(mb) ?? 0;
    const automations = (mb.tempoAutomations ?? []).filter((a) => a.value > 0);
    if (automations.length === 0) continue;
    const dur = mb.calculateDuration() || DEFAULT_TICKS_PER_QUARTER * 4;
    for (const a of automations) {
      const tick = start + Math.round(dur * Math.max(0, Math.min(1, a.ratioPosition ?? 0)));
      const bpm = a.value;
      if (!Number.isFinite(bpm) || bpm <= 0) continue;
      if (Math.abs(bpm - last) < 0.01) continue;
      segs.push({ tick, bpm });
      last = bpm;
    }
  }
  segs.sort((a, b) => a.tick - b.tick);
  return segs;
}

export function tickToSec(timeline: Timeline, tick: number): number {
  const segs = timeline.tempos;
  let sec = 0;
  let prevTick = 0;
  let bpm = segs[0]?.bpm ?? timeline.tempo ?? 100;
  for (let i = 1; i < segs.length; i++) {
    if (tick <= segs[i].tick) break;
    const span = segs[i].tick - prevTick;
    sec += (span / DEFAULT_TICKS_PER_QUARTER) * (60 / bpm);
    prevTick = segs[i].tick;
    bpm = segs[i].bpm;
  }
  sec += ((tick - prevTick) / DEFAULT_TICKS_PER_QUARTER) * (60 / bpm);
  return Math.max(0, sec);
}

export function secToTick(timeline: Timeline, sec: number): number {
  const segs = timeline.tempos;
  let acc = 0;
  let prevTick = 0;
  let bpm = segs[0]?.bpm ?? timeline.tempo ?? 100;
  for (let i = 1; i < segs.length; i++) {
    const span = segs[i].tick - prevTick;
    const dur = (span / DEFAULT_TICKS_PER_QUARTER) * (60 / bpm);
    if (sec <= acc + dur) break;
    acc += dur;
    prevTick = segs[i].tick;
    bpm = segs[i].bpm;
  }
  const remaining = Math.max(0, sec - acc);
  return Math.round(prevTick + remaining * DEFAULT_TICKS_PER_QUARTER * (bpm / 60));
}

/** 当前 tick 对应的拍索引（二分） */
export function beatIndexAtTick(timeline: Timeline, tick: number): number {
  const beats = timeline.beats;
  if (!beats.length) return 0;
  let lo = 0;
  let hi = beats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (beats[mid].tick <= tick) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface TickNote {
  timeSec: number;
  durationSec: number;
  event: NoteEvent;
}

export function notesWithTime(timeline: Timeline): TickNote[] {
  return timeline.notes
    .map((event) => ({
      timeSec: tickToSec(timeline, event.tick),
      durationSec: Math.max(0.05, tickToSec(timeline, event.tick + event.durationTicks) - tickToSec(timeline, event.tick)),
      event,
    }))
    .sort((a, b) => a.timeSec - b.timeSec || a.event.midi - b.event.midi);
}

export function describeBeat(beat: BeatRef): string {
  if (!beat.notes.length) return '休止';
  return beat.notes
    .map((n) => `${n.string ?? '?'}弦${n.fret ?? '?'}品 ${midiToName(n.midi)}`)
    .join(' · ');
}

export function noteFreq(midi: number): number {
  return midiToFreq(midi);
}