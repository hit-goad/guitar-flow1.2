import { audioContext, ensureRunning, synth, type GuitarSynth } from '../audio/synth';
import {
  beatIndexAtTick,
  notesWithTime,
  tickToSec,
  type NoteEvent,
  type TickNote,
  type Timeline,
} from '../score/timeline';

export type PlayerState = 'idle' | 'playing' | 'paused';

export interface PlayerSnapshot {
  state: PlayerState;
  tick: number;
  beatIndex: number;
  timeSec: number;
  totalSec: number;
}

export interface PlayerOptions {
  metronome?: boolean;
  /** 速度倍率 0.25 - 2 */
  rate?: number;
  /** 只滚动不发声（跟随模式） */
  silent?: boolean;
  /** 循环区间（tick） */
  loop?: { from: number; to: number } | null;
}

/**
 * 时间轴播放器：以 AudioContext 时钟为基准，提前 120ms 调度音符，
 * 并逐帧上报光标位置（不依赖 alphaTab 的播放器，便于自定义音色与跟随逻辑）。
 */
export class ScorePlayer {
  private timeline: Timeline;
  private synth: GuitarSynth;
  private events: TickNote[] = [];
  private pointer = 0;
  private clickPointer = 0;
  private startedAt = 0;
  private baseSec = 0;
  private raf = 0;
  private lastBeat = -1;
  state: PlayerState = 'idle';
  options: Required<PlayerOptions> = {
    metronome: false,
    rate: 1,
    silent: false,
    loop: null,
  };

  onPosition: (snap: PlayerSnapshot) => void = () => {};
  onNote: (ev: NoteEvent) => void = () => {};
  onEnd: () => void = () => {};

  constructor(timeline: Timeline, s: GuitarSynth = synth()) {
    this.timeline = timeline;
    this.synth = s;
    this.events = notesWithTime(timeline);
  }

  setTimeline(timeline: Timeline) {
    this.stop();
    this.timeline = timeline;
    this.events = notesWithTime(timeline);
    this.lastBeat = -1;
  }

  setOptions(patch: Partial<PlayerOptions>) {
    this.options = { ...this.options, ...patch };
  }

  get currentSec(): number {
    if (this.state === 'playing') {
      const ctx = audioContext();
      return this.baseSec + (ctx.currentTime - this.startedAt) * this.options.rate;
    }
    return this.baseSec;
  }

  async play(fromSec?: number) {
    const ctx = audioContext();
    await ensureRunning(ctx);
    if (fromSec !== undefined) this.seekSec(fromSec);
    if (this.state === 'playing') return;
    this.startedAt = ctx.currentTime + 0.06;
    this.state = 'playing';
    this.resetPointers();
    this.emit();
    this.loop();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.baseSec = this.currentSec;
    this.state = 'paused';
    cancelAnimationFrame(this.raf);
    this.emit();
  }

  stop() {
    this.state = 'idle';
    this.baseSec = 0;
    cancelAnimationFrame(this.raf);
    this.emit();
  }

  seekSec(sec: number) {
    const clamped = Math.max(0, Math.min(this.timeline.totalSec, sec));
    this.baseSec = clamped;
    if (this.state === 'playing') {
      this.startedAt = audioContext().currentTime + 0.02;
    }
    this.resetPointers();
    this.emit();
  }

  seekTick(tick: number) {
    this.seekSec(tickToSec(this.timeline, tick));
  }

  /** 速率改变后重新对齐时钟 */
  setRate(rate: number) {
    const cur = this.currentSec;
    this.options.rate = Math.max(0.25, Math.min(2, rate));
    this.baseSec = cur;
    if (this.state === 'playing') this.startedAt = audioContext().currentTime + 0.02;
    this.resetPointers();
  }

  private resetPointers() {
    const sec = this.baseSec;
    let i = 0;
    while (i < this.events.length && this.events[i].timeSec < sec - 1e-6) i++;
    this.pointer = i;
    let c = 0;
    while (c < this.timeline.beats.length && tickToSec(this.timeline, this.timeline.beats[c].tick) < sec - 1e-6) c++;
    this.clickPointer = c;
  }

  private emit() {
    const timeSec = this.currentSec;
    const tick = Math.round((timeSec / Math.max(1e-6, this.timeline.totalSec)) * this.timeline.totalTicks);
    const beatIndex = beatIndexAtTick(this.timeline, tick);
    this.onPosition({
      state: this.state,
      tick,
      beatIndex,
      timeSec,
      totalSec: this.timeline.totalSec,
    });
    this.lastBeat = beatIndex;
  }

  private loop = () => {
    if (this.state !== 'playing') return;
    const ctx = audioContext();
    const elapsed = (ctx.currentTime - this.startedAt) * this.options.rate;
    const nowSec = this.baseSec + Math.max(0, elapsed);

    // 循环处理
    const loopRange = this.options.loop;
    if (loopRange) {
      const loopFrom = tickToSec(this.timeline, loopRange.from);
      const loopTo = tickToSec(this.timeline, loopRange.to);
      if (nowSec >= loopTo) {
        this.baseSec = loopFrom;
        this.startedAt = ctx.currentTime + 0.02;
        this.resetPointers();
      }
    }

    const lookahead = 0.14;
    while (this.pointer < this.events.length && this.events[this.pointer].timeSec <= nowSec + lookahead) {
      const item = this.events[this.pointer++];
      if (item.timeSec < nowSec - 0.25) continue;
      const when = ctx.currentTime + Math.max(0, item.timeSec - nowSec) + 0.01;
      if (!this.options.silent) {
        this.synth.pluck(item.event.midi, when, {
          velocity: item.event.velocity,
          duration: item.durationSec,
        });
      }
      if (item.timeSec <= nowSec + 0.03) this.onNote(item.event);
    }

    if (this.options.metronome && !this.options.silent) {
      while (this.clickPointer < this.timeline.beats.length) {
        const beat = this.timeline.beats[this.clickPointer];
        const t = tickToSec(this.timeline, beat.tick);
        if (t > nowSec + lookahead) break;
        this.clickPointer++;
        if (t < nowSec - 0.1) continue;
        const strong = beat.barIndex !== this.timeline.beats[Math.max(0, this.clickPointer - 2)]?.barIndex;
        this.synth.click(ctx.currentTime + Math.max(0, t - nowSec), strong);
      }
    }

    const beatIndex = beatIndexAtTick(this.timeline, this.secToTickSafe(nowSec));
    this.onPosition({
      state: 'playing',
      tick: this.secToTickSafe(nowSec),
      beatIndex,
      timeSec: nowSec,
      totalSec: this.timeline.totalSec,
    });
    if (beatIndex !== this.lastBeat) this.lastBeat = beatIndex;

    if (nowSec >= this.timeline.totalSec) {
      this.baseSec = 0;
      this.state = 'idle';
      cancelAnimationFrame(this.raf);
      this.emit();
      this.onEnd();
      return;
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private secToTickSafe(sec: number): number {
    // 用拍表做线性插值，避免重复积分 tempo 段
    const beats = this.timeline.beats;
    if (!beats.length) return 0;
    const secs = this.timeline.beatSecs;
    if (sec <= secs[0]) return beats[0].tick;
    let lo = 0;
    let hi = secs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (secs[mid] <= sec) lo = mid;
      else hi = mid - 1;
    }
    const a = beats[lo];
    const b = beats[Math.min(lo + 1, beats.length - 1)];
    const ta = secs[lo];
    const tb = secs[Math.min(lo + 1, secs.length - 1)];
    if (tb <= ta) return a.tick;
    const f = (sec - ta) / (tb - ta);
    return Math.round(a.tick + (b.tick - a.tick) * f);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
  }
}