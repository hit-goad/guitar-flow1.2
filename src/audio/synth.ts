/**
 * 吉他合成器：Karplus–Strong 物理建模拨弦。
 * 每个音符都按真实弦长/品位的基频渲染，因此「每到一个音符就有对应的音高」，
 * 不依赖 soundfont，安装包也小。
 * 同时暴露 master 输出节点，支持实时应用内录（Live App Internal Recording）直接抓取合成器总线信号。
 */
export interface PluckOptions {
  velocity?: number;
  /** 音长（秒） */
  duration?: number;
  /** 在时间轴上延迟（秒） */
  delay?: number;
  /** 声像，-1..1 */
  pan?: number;
}

const MIN_CACHE = 120;

export class GuitarSynth {
  readonly ctx: BaseAudioContext;
  private master: GainNode;
  private comp: DynamicsCompressorNode;
  private cache = new Map<number, AudioBuffer>();

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.7;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -18;
    this.comp.knee.value = 24;
    this.comp.ratio.value = 3;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.22;
    this.master.connect(this.comp);
    this.comp.connect(ctx.destination);
  }

  /** 暴露压缩后主输出节点，供实时内录器（MediaStreamDestination / PCM Tap）直接挂接 */
  get outputNode(): AudioNode {
    return this.comp;
  }

  setVolume(v: number) {
    this.master.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.05);
  }

  /** 单音渲染（缓存），时长 1.6s 足够听出音高与衰减 */
  private bufferFor(midi: number): AudioBuffer {
    const cached = this.cache.get(midi);
    if (cached) return cached;

    const sr = this.ctx.sampleRate;
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const seconds = freq < 120 ? 2.2 : 1.6;
    const len = Math.floor(sr * seconds);
    const buf = this.ctx.createBuffer(1, len, sr);
    const out = buf.getChannelData(0);

    const n = Math.max(2, Math.round(sr / freq));
    const delay = new Float32Array(n);
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const white = Math.random() * 2 - 1;
      prev = 0.62 * prev + 0.38 * white;
      delay[i] = prev;
    }
    const rho = Math.min(0.9995, Math.max(0.988, 1 - freq / 22000));
    let idx = 0;
    let peak = 0;
    for (let i = 0; i < len; i++) {
      const cur = delay[idx];
      const nxt = delay[(idx + 1) % n];
      delay[idx] = 0.5 * (cur + nxt) * rho;
      out[i] = cur;
      if (Math.abs(cur) > peak) peak = Math.abs(cur);
      idx = (idx + 1) % n;
    }
    const gain = peak > 1e-4 ? 0.82 / peak : 1;
    const tailStart = Math.floor(len * 0.82);
    for (let i = 0; i < len; i++) {
      let g = gain;
      if (i > tailStart) g *= 1 - (i - tailStart) / (len - tailStart);
      out[i] *= g;
    }

    if (this.cache.size > MIN_CACHE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(midi, buf);
    return buf;
  }

  /** 播放一个音（绝对时间 when，单位秒，基于 ctx.currentTime） */
  pluck(midi: number, when: number, options: PluckOptions = {}): void {
    const velocity = options.velocity ?? 0.8;
    const duration = options.duration ?? 1.4;
    const pan = options.pan ?? 0;
    const buffer = this.bufferFor(midi);

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = 1;

    const gain = this.ctx.createGain();
    const start = Math.max(when, this.ctx.currentTime);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.9 * velocity, start + 0.004);
    gain.gain.setTargetAtTime(0.55 * velocity, start + 0.01, 0.28);
    const stop = start + Math.min(duration + 0.35, buffer.duration);
    gain.gain.setTargetAtTime(0, Math.max(start + 0.02, stop - 0.18), 0.06);

    let node: AudioNode = gain;
    if (this.ctx.createStereoPanner) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      gain.connect(panner);
      node = panner;
    }
    if (midi < 52) {
      const shelf = this.ctx.createBiquadFilter();
      shelf.type = 'peaking';
      shelf.frequency.value = 110;
      shelf.gain.value = 3.5;
      shelf.Q.value = 1.2;
      node.connect(shelf);
      shelf.connect(this.master);
    } else {
      node.connect(this.master);
    }

    src.connect(gain);
    src.start(start);
    src.stop(Math.min(start + buffer.duration, start + duration + 0.4));
  }

  /** 和弦/扫弦：从小指到拇指依次拨，spread 控制扫弦间距 */
  strum(midis: number[], when: number, spread = 0.018, velocity = 0.75, duration = 1.6): void {
    const ordered = [...midis].sort((a, b) => a - b);
    ordered.forEach((m, i) => {
      this.pluck(m, when + i * spread, {
        velocity: velocity * (0.78 + 0.22 * Math.random()),
        duration,
        pan: (i / Math.max(1, ordered.length - 1) - 0.5) * 0.5,
      });
    });
  }

  /** 节拍器：短促木质 click */
  click(when: number, accent = false): void {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = accent ? 1760 : 1180;
    const start = Math.max(when, this.ctx.currentTime);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(accent ? 0.22 : 0.12, start + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.05);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(start);
    osc.stop(start + 0.06);
  }

  /** 试听某个品位的音 */
  preview(midi: number, velocity = 0.85): void {
    this.pluck(midi, this.ctx.currentTime + 0.01, { velocity, duration: 1.2 });
  }

  dispose(): void {
    try {
      this.comp.disconnect();
      this.master.disconnect();
    } catch {
      /* ignore */
    }
    this.cache.clear();
  }
}

let sharedCtx: AudioContext | null = null;

export function audioContext(): AudioContext {
  if (!sharedCtx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedCtx = new Ctor({ latencyHint: 'interactive' });
  }
  return sharedCtx;
}

export async function ensureRunning(ctx: AudioContext): Promise<void> {
  if (ctx.state !== 'running') {
    try {
      await ctx.resume();
    } catch {
      /* 用户手势尚未发生 */
    }
  }
}

let sharedSynth: GuitarSynth | null = null;

export function synth(): GuitarSynth {
  if (!sharedSynth) sharedSynth = new GuitarSynth(audioContext());
  return sharedSynth;
}

/** 用于内录：在 OfflineAudioContext 里重新渲染同一段演奏 */
export function offlineSynth(ctx: OfflineAudioContext): GuitarSynth {
  return new GuitarSynth(ctx);
}