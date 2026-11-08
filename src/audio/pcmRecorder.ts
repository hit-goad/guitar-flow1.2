/**
 * PCM 录音：直接抓麦克风原始采样，避免各平台 MediaRecorder 编码格式不一致
 * （Android 出 webm/opus、iOS 出 mp4/aac），后续统一转 WAV / MP3。
 */
export class PcmRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private startedAt = 0;
  private sampleRate = 48000;
  recording = false;

  /** 录音过程中的实时峰值（给 UI 电平条） */
  level = 0;

  async start(stream?: MediaStream): Promise<void> {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor({ latencyHint: 'interactive' });
    await ctx.resume().catch(() => {});
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;

    this.stream =
      stream ??
      (await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      }));

    this.source = ctx.createMediaStreamSource(this.stream);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 40;

    const proc = ctx.createScriptProcessor(4096, 1, 1);
    this.processor = proc;
    this.chunks = [];
    proc.onaudioprocess = (ev) => {
      if (!this.recording) return;
      const input = ev.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input.length);
      copy.set(input);
      this.chunks.push(copy);
      let peak = 0;
      for (let i = 0; i < copy.length; i += 8) {
        const v = Math.abs(copy[i]);
        if (v > peak) peak = v;
      }
      this.level = peak;
    };

    // ScriptProcessor 必须接到 destination 才会被驱动，用 0 增益避免回声
    const silent = ctx.createGain();
    silent.gain.value = 0;
    this.source.connect(hp);
    hp.connect(proc);
    proc.connect(silent);
    silent.connect(ctx.destination);

    this.startedAt = performance.now();
    this.recording = true;
  }

  async stop(): Promise<{ samples: Float32Array; sampleRate: number; durationSec: number }> {
    this.recording = false;
    const durationSec = (performance.now() - this.startedAt) / 1000;
    const total = this.chunks.reduce((a, c) => a + c.length, 0);
    const merged = new Float32Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close().catch(() => {});
    this.ctx = null;
    this.processor = null;
    this.source = null;
    this.stream = null;
    this.chunks = [];
    return { samples: merged, sampleRate: this.sampleRate, durationSec };
  }
}

/** Float32 单声道 → 16bit WAV */
export function samplesToWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}