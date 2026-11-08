import { ensureRunning } from './synth';
import { freqToMidi, midiToName } from '../core/types';

export interface PitchFrame {
  hz: number;
  clarity: number;
  rms: number;
  /** 平滑后的 MIDI 音高（含小数） */
  midi: number;
  note: string;
  cents: number;
  ts: number;
}

export interface StableNote {
  midi: number;
  note: string;
  cents: number;
  startTs: number;
  endTs: number;
  velocity: number;
}

export type PitchListener = (frame: PitchFrame) => void;
export type NoteListener = (note: StableNote) => void;

const WORKLET_URL = new URL('worklets/pitch-worklet.js', document.baseURI).href;

/**
 * 麦克风实时音高检测。
 * 优先 AudioWorklet；不支持时退回主线程 YIN。
 */
export class PitchDetector {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private raf = 0;
  private buf: Float32Array<ArrayBuffer> = new Float32Array(new ArrayBuffer(2048 * 4));
  private listeners = new Set<PitchListener>();
  private noteListeners = new Set<NoteListener>();
  private history: number[] = [];
  private current: {
    midi: number;
    startTs: number;
    lastTs: number;
    cents: number;
    frames: number;
    emitted: boolean;
    rms: number;
  } | null = null;
  private lastNoteEnd = 0;
  private gotFrame = false;
  private startedAt = 0;
  private silentGain: GainNode | null = null;
  running = false;
  inputLevel = 0;

  onFrame(fn: PitchListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onNote(fn: NoteListener): () => void {
    this.noteListeners.add(fn);
    return () => this.noteListeners.delete(fn);
  }

  async start(deviceId?: string): Promise<void> {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前环境不支持麦克风采集');
    // 独立上下文：避免与播放用的共享 AudioContext 互相影响（也符合 iOS 手势内创建的要求）
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor({ latencyHint: 'interactive' });
    await ensureRunning(ctx);
    this.ctx = ctx;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    this.source = ctx.createMediaStreamSource(this.stream);

    // 高通去掉低频噪声，避免误判低八度
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 60;
    this.source.connect(hp);

    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      this.node = new AudioWorkletNode(ctx, 'pitch-detector', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.node.port.onmessage = (ev) => {
        this.gotFrame = true;
        this.handle(ev.data as { hz: number; clarity: number; rms: number });
      };
      hp.connect(this.node);
      // 必须连接到输出，否则 0 输出的 worklet 不会被渲染循环驱动
      const silent = ctx.createGain();
      silent.gain.value = 0;
      this.node.connect(silent);
      silent.connect(ctx.destination);
      this.silentGain = silent;
      // 兜底：worklet 1.2s 内没有任何回调就切回主线程分析
      window.setTimeout(() => {
        if (!this.gotFrame && this.running) void this.startAnalyserFallback(hp);
      }, 1200);
    } catch {
      await this.startAnalyserFallback(hp);
    }
    this.running = true;
    this.startedAt = performance.now();
  }

  /** 无 AudioWorklet 或 worklet 未回调时的兜底路径 */
  private async startAnalyserFallback(source: AudioNode) {
    const ctx = this.ctx;
    if (!ctx || this.analyser) return;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    source.connect(this.analyser);
    const loop = () => {
      if (!this.running) return;
      this.analyser!.getFloatTimeDomainData(this.buf);
      const { hz, clarity, rms } = autocorrelate(this.buf, ctx.sampleRate);
      this.handle({ hz, clarity, rms });
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private handle(raw: { hz: number; clarity: number; rms: number }) {
    const ts = performance.now();
    this.inputLevel = raw.rms;
    // 忽略刚开流时的一段爬升噪声
    if (this.startedAt && ts - this.startedAt < 220) return;
    if (raw.hz <= 0 || raw.clarity < 0.55 || raw.rms < 0.0015) {
      this.flushNote(ts);
      const idle: PitchFrame = { hz: 0, clarity: raw.clarity, rms: raw.rms, midi: 0, note: '', cents: 0, ts };
      this.listeners.forEach((fn) => fn(idle));
      return;
    }
    const midi = freqToMidi(raw.hz);
    // 中值平滑（3 帧）抑制抖动
    this.history.push(midi);
    if (this.history.length > 3) this.history.shift();
    const sorted = [...this.history].sort((a, b) => a - b);
    const smooth = sorted[Math.floor(sorted.length / 2)];
    const nearest = Math.round(smooth);
    const cents = (smooth - nearest) * 100;
    const frame: PitchFrame = {
      hz: raw.hz,
      clarity: raw.clarity,
      rms: raw.rms,
      midi: smooth,
      note: midiToName(nearest),
      cents,
      ts,
    };
    this.listeners.forEach((fn) => fn(frame));
    this.trackNote(nearest, cents, raw.rms, ts);
  }

  /**
   * 稳定音跟踪：连续 2 帧落在同一个半音、且持续 ≥60ms 就立刻上报一次（起音即触发），
   * 这样「跟我弹」才能在按弦的瞬间响应，而不是等音结束。
   */
  private trackNote(nearest: number, cents: number, rms: number, ts: number) {
    const cur = this.current;
    if (cur && Math.abs(cur.midi - nearest) < 1) {
      cur.lastTs = ts;
      cur.cents = cents;
      cur.frames++;
      cur.rms = Math.max(cur.rms, rms);
      if (!cur.emitted && cur.frames >= 3 && ts - cur.startTs >= 70) this.emitNote(cur);
      return;
    }
    if (cur) this.flushNote(ts);
    this.current = { midi: nearest, startTs: ts, lastTs: ts, cents, frames: 1, emitted: false, rms };
  }

  private emitNote(cur: {
    midi: number;
    startTs: number;
    lastTs: number;
    cents: number;
    frames: number;
    emitted: boolean;
    rms: number;
  }) {
    cur.emitted = true;
    this.lastNoteEnd = cur.lastTs;
    const stable: StableNote = {
      midi: cur.midi,
      note: midiToName(cur.midi),
      cents: cur.cents,
      startTs: cur.startTs,
      endTs: cur.lastTs,
      velocity: Math.min(1, 0.4 + cur.rms * 1.6),
    };
    this.noteListeners.forEach((fn) => fn(stable));
  }

  private flushNote(_ts: number) {
    const cur = this.current;
    this.current = null;
    if (!cur || cur.emitted) return;
    if (cur.frames >= 3 && cur.lastTs - cur.startTs >= 70) this.emitNote(cur);
  }

  async stop(): Promise<void> {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.node?.port.close();
    this.node?.disconnect();
    this.silentGain?.disconnect();
    this.analyser?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node = null;
    this.analyser = null;
    this.source = null;
    this.stream = null;
    if (this.ctx && this.ctx.state !== 'closed') {
      try {
        await this.ctx.close();
      } catch {
        /* ignore */
      }
    }
    this.ctx = null;
    this.history = [];
    this.current = null;
  }
}

/** 主线程兜底的自相关（无 AudioWorklet 的旧 WebView） */
function autocorrelate(buf: Float32Array, sr: number): { hz: number; clarity: number; rms: number } {
  let rms = 0;
  for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / buf.length);
  if (rms < 0.0008) return { hz: 0, clarity: 0, rms };

  const size = buf.length;
  const minLag = Math.floor(sr / 1200);
  const maxLag = Math.floor(sr / 55);
  let bestLag = -1;
  let best = 0;
  const corr = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < size - lag; i += 2) {
      sum += buf[i] * buf[i + lag];
      norm += buf[i] * buf[i];
    }
    const v = norm > 0 ? sum / norm : 0;
    corr[lag] = v;
    if (v > best) {
      best = v;
      bestLag = lag;
    }
  }
  if (bestLag <= 0 || best < 0.3) return { hz: 0, clarity: best, rms };
  const y0 = corr[bestLag - 1] ?? 0;
  const y1 = corr[bestLag];
  const y2 = corr[bestLag + 1] ?? 0;
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
  return { hz: sr / (bestLag + shift), clarity: best, rms };
}

export function emptyFrame(): PitchFrame {
  return { hz: 0, clarity: 0, rms: 0, midi: 0, note: '', cents: 0, ts: performance.now() };
}