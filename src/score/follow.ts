import type { Timeline } from './timeline';
import { midiToName } from '../core/types';

export interface FollowState {
  beatIndex: number;
  tick: number;
  /** 命中/漏掉的统计 */
  hits: number;
  misses: number;
  /** 最近一次比对的期望音 */
  expected: number[];
  lastMatch: { played: number; expected: number; deltaSemitones: number; ts: number } | null;
}

/**
 * 「跟我弹」对齐器：
 * 监听真实演奏音高，在上文就近窗口里找匹配音符，命中则把光标推进到该音，
 * 从而实现谱面跟着人走（不是人跟着伴奏走）。
 */
export class FollowController {
  private timeline: Timeline;
  private pointer = 0;
  private lastNoteByMidi = new Map<number, number>();
  private lastAdvanceTs = 0;
  /** 允许向前跳跃的拍数（弹错/跳过一小节仍能继续） */
  windowBeats = 12;
  state: FollowState = { beatIndex: 0, tick: 0, hits: 0, misses: 0, expected: [], lastMatch: null };

  constructor(timeline: Timeline) {
    this.timeline = timeline;
    this.reset();
  }

  setTimeline(timeline: Timeline) {
    this.timeline = timeline;
    this.reset();
  }

  reset(beatIndex = 0) {
    this.pointer = Math.max(0, Math.min(beatIndex, this.timeline.beats.length - 1));
    this.lastNoteByMidi.clear();
    this.lastAdvanceTs = 0;
    this.state = {
      beatIndex: this.pointer,
      tick: this.timeline.beats[this.pointer]?.tick ?? 0,
      hits: 0,
      misses: 0,
      expected: this.expectedNotes(),
      lastMatch: null,
    };
  }

  /** 当前及之后几个好拍的期望音（给 UI 显示） */
  expectedNotes(count = 3): number[] {
    const out: number[] = [];
    for (let i = this.pointer; i < this.timeline.beats.length && out.length < count; i++) {
      const b = this.timeline.beats[i];
      for (const n of b.notes) out.push(n.midi);
    }
    return out;
  }

  /**
   * 输入一个稳定音（MIDI），返回是否推进了光标。
   * 允许 ±1 半音的容差（按弦按不实），但优先精确匹配。
   */
  feed(playedMidi: number, ts = performance.now()): boolean {
    const beats = this.timeline.beats;
    if (!beats.length) return false;
    // 同一个音 120ms 内重复上报视为一次
    const last = this.lastNoteByMidi.get(playedMidi) ?? 0;
    if (ts - last < 120) return false;
    this.lastNoteByMidi.set(playedMidi, ts);

    const windowEnd = Math.min(beats.length, this.pointer + this.windowBeats);
    let bestIdx = -1;
    let bestCost = Infinity;
    for (let i = this.pointer; i < windowEnd; i++) {
      for (const n of beats[i].notes) {
        const delta = Math.abs(n.midi - playedMidi);
        if (delta > 1) continue;
        const cost = delta * 2 + (i - this.pointer) * 0.35;
        if (cost < bestCost) {
          bestCost = cost;
          bestIdx = i;
        }
      }
    }

    if (bestIdx < 0) {
      this.state.misses++;
      this.state.lastMatch = { played: playedMidi, expected: this.state.expected[0] ?? 0, deltaSemitones: 0, ts };
      return false;
    }

    const prevPointer = this.pointer;
    this.pointer = bestIdx;
    if (bestIdx > prevPointer) {
      // 跳过的拍算漏
      this.state.misses += bestIdx - prevPointer - 1;
    }
    this.state.hits++;
    this.state.beatIndex = this.pointer;
    this.state.tick = beats[this.pointer].tick;
    this.state.expected = this.expectedNotes();
    this.state.lastMatch = {
      played: playedMidi,
      expected: beats[bestIdx].notes[0]?.midi ?? playedMidi,
      deltaSemitones: (beats[bestIdx].notes[0]?.midi ?? playedMidi) - playedMidi,
      ts,
    };
    this.lastAdvanceTs = ts;
    // 命中后光标停在当前拍，等下一个音继续推进
    return true;
  }

  /** 手动切换位置（点击谱面） */
  seek(beatIndex: number) {
    this.pointer = Math.max(0, Math.min(beatIndex, this.timeline.beats.length - 1));
    this.state.beatIndex = this.pointer;
    this.state.tick = this.timeline.beats[this.pointer]?.tick ?? 0;
    this.state.expected = this.expectedNotes();
  }

  get currentBeat() {
    return this.timeline.beats[this.pointer];
  }

  get accuracy(): number {
    const total = this.state.hits + this.state.misses;
    return total === 0 ? 1 : this.state.hits / total;
  }

  describe(): string {
    const b = this.currentBeat;
    if (!b) return '';
    return b.notes.map((n) => midiToName(n.midi)).join(' ') || '休止';
  }
}