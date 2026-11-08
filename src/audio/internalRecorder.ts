import { audioContext, ensureRunning, synth } from './synth';
import { samplesToWav } from './pcmRecorder';
import { captureSystemAudio } from './recorder';
import { autocorrelate } from './pitch';
import { decodeToSamples, waveformPeaks } from './decode';
import { freqToMidi, midiToName } from '../core/types';

/**
 * 移植自《音高》(com.bideyuanli.pitch2) 的内录与音高轨迹分析核心模块：
 *
 * 1. 支持多源内录模式（InternalCaptureMode）：
 *    - 'app-live'：实时应用内录（直接从 GuitarSynth 主输出总线抓取实时演奏音频，零环境杂音）
 *    - 'mix-live'：内录伴奏 + 麦克风混录（同时录制应用内伴奏与麦克风弹唱，合成单轨 WAV/MP3）
 *    - 'system-loopback'：系统级跨应用内录（Windows/Electron loopback、Web 屏幕共享音频、Android 10+ AudioPlaybackCapture 原生系统内录）
 * 2. 内录期间同步输出 MediaStream / PCM 帧，可同时驱动实时音高检测与「内录听音跟谱」
 * 3. 录音完成或导入外部音频后，自动提取全曲音高轨迹（PitchTrackPoint[]）、音域范围（最低音 ~ 最高音）、
 *    平均音准偏差与包络波形（对应《音高》App 的 SpecView / ViewPainter 音高曲线图）
 */

export type InternalCaptureMode = 'app-live' | 'mix-live' | 'system-loopback';

export interface PitchTrackPoint {
  timeSec: number;
  hz: number;
  midi: number;
  note: string;
  cents: number;
  rms: number;
}

export interface PitchAnalysisSummary {
  points: PitchTrackPoint[];
  peaks: number[];
  minMidi: number;
  maxMidi: number;
  minNote: string;
  maxNote: string;
  avgCents: number;
  voicedRatio: number;
  durationSec: number;
}

interface AndroidInternalAudioBridge {
  isAvailable?: () => boolean;
  startInternalCapture?: () => boolean;
  stopInternalCapture?: () => string; // base64 WAV or PCM
}

declare global {
  interface Window {
    gfAndroidAudio?: AndroidInternalAudioBridge;
    __onAndroidInternalPcm?: (base64Int16: string, sampleRate: number) => void;
  }
}

export function isAndroidNativeInternalAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.gfAndroidAudio?.isAvailable?.();
}

/**
 * 实时内录器：支持「应用内实时内录」「内录+麦克风混录」「系统跨应用内录（含 Android AudioPlaybackCapture）」
 */
export class LiveInternalRecorder {
  private ctx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private synthTapGain: GainNode | null = null;
  private externalStream: MediaStream | null = null;
  private externalSource: MediaStreamAudioSourceNode | null = null;
  private streamDest: MediaStreamAudioDestinationNode | null = null;
  private silentGain: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private startedAt = 0;
  private sampleRate = 44100;
  private usingAndroidNative = false;
  mode: InternalCaptureMode = 'app-live';
  recording = false;
  level = 0;

  /** 供 PitchDetector 实时监听的内部音频流 */
  get monitorStream(): MediaStream | null {
    return this.streamDest?.stream ?? this.externalStream;
  }

  async start(
    mode: InternalCaptureMode = 'app-live',
    onPcmChunk?: (samples: Float32Array, sampleRate: number) => void,
  ): Promise<MediaStream | null> {
    if (this.recording) await this.stop();
    this.mode = mode;
    this.chunks = [];
    this.level = 0;
    this.usingAndroidNative = false;

    // Android 原生系统内录（MediaProjection + AudioPlaybackCaptureConfiguration）
    if (mode === 'system-loopback' && isAndroidNativeInternalAvailable()) {
      const ok = window.gfAndroidAudio?.startInternalCapture?.();
      if (ok) {
        this.usingAndroidNative = true;
        this.sampleRate = 44100;
        this.startedAt = performance.now();
        this.recording = true;
        window.__onAndroidInternalPcm = (b64: string, sr: number) => {
          if (!this.recording) return;
          this.sampleRate = sr || 44100;
          const bin = atob(b64);
          const len = bin.length >> 1;
          const floatBuf = new Float32Array(len);
          let peak = 0;
          for (let i = 0; i < len; i++) {
            const lo = bin.charCodeAt(i * 2);
            const hi = bin.charCodeAt(i * 2 + 1);
            let s16 = (hi << 8) | lo;
            if (s16 >= 0x8000) s16 -= 0x10000;
            const v = s16 / 32768;
            floatBuf[i] = v;
            if (Math.abs(v) > peak) peak = Math.abs(v);
          }
          this.level = peak;
          this.chunks.push(floatBuf);
          onPcmChunk?.(floatBuf, this.sampleRate);
        };
        return null;
      }
    }

    const ctx = audioContext();
    await ensureRunning(ctx);
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;

    const proc = ctx.createScriptProcessor(4096, 2, 1);
    this.processor = proc;
    const dest = ctx.createMediaStreamDestination();
    this.streamDest = dest;

    if (mode === 'app-live' || mode === 'mix-live') {
      // 挂接 GuitarSynth 的主输出节点
      const s = synth();
      const tapGain = ctx.createGain();
      tapGain.gain.value = 1.0;
      s.outputNode.connect(tapGain);
      tapGain.connect(proc);
      tapGain.connect(dest);
      this.synthTapGain = tapGain;
    }

    if (mode === 'mix-live') {
      // 同时采集麦克风混入内录总线
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      this.externalStream = micStream;
      const micSource = ctx.createMediaStreamSource(micStream);
      const micGain = ctx.createGain();
      micGain.gain.value = 0.95;
      micSource.connect(micGain);
      micGain.connect(proc);
      micGain.connect(dest);
      this.externalSource = micSource;
    } else if (mode === 'system-loopback') {
      const sysStream = await captureSystemAudio();
      if (!sysStream) {
        throw new Error('未获取到系统内录音频流（请在弹窗中勾选「同时共享系统音频 / 标签页音频」）');
      }
      this.externalStream = sysStream;
      const sysSource = ctx.createMediaStreamSource(sysStream);
      sysSource.connect(proc);
      sysSource.connect(dest);
      this.externalSource = sysSource;
    }

    proc.onaudioprocess = (ev) => {
      if (!this.recording) return;
      const ch0 = ev.inputBuffer.getChannelData(0);
      const ch1 = ev.inputBuffer.numberOfChannels > 1 ? ev.inputBuffer.getChannelData(1) : ch0;
      const copy = new Float32Array(ch0.length);
      let peak = 0;
      for (let i = 0; i < ch0.length; i++) {
        const v = (ch0[i] + ch1[i]) * 0.5;
        copy[i] = v;
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
      this.level = peak;
      this.chunks.push(copy);
      onPcmChunk?.(copy, this.sampleRate);
    };

    const silent = ctx.createGain();
    silent.gain.value = 0;
    proc.connect(silent);
    silent.connect(ctx.destination);
    this.silentGain = silent;

    this.startedAt = performance.now();
    this.recording = true;
    return dest.stream;
  }

  async stop(): Promise<{ wavBlob: Blob; samples: Float32Array; sampleRate: number; durationSec: number }> {
    this.recording = false;
    const durationSec = Math.max(0.1, (performance.now() - this.startedAt) / 1000);

    if (this.usingAndroidNative) {
      window.gfAndroidAudio?.stopInternalCapture?.();
      window.__onAndroidInternalPcm = undefined;
    }

    const total = this.chunks.reduce((acc, c) => acc + c.length, 0);
    const merged = new Float32Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      merged.set(c, offset);
      offset += c.length;
    }

    try {
      this.synthTapGain?.disconnect();
      this.externalSource?.disconnect();
      this.processor?.disconnect();
      this.silentGain?.disconnect();
      this.externalStream?.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }

    this.synthTapGain = null;
    this.externalSource = null;
    this.processor = null;
    this.silentGain = null;
    this.externalStream = null;
    this.streamDest = null;
    this.chunks = [];
    this.level = 0;

    const wavBlob = samplesToWav(merged, this.sampleRate);
    return { wavBlob, samples: merged, sampleRate: this.sampleRate, durationSec };
  }
}

/**
 * 音频音高轨迹与音域分析（移植自《音高》App 的 SpecModel + PitchItem）：
 * 输入任意音频 Blob（录音或外部导入的 MP3/WAV/M4A），提取逐帧音高曲线、最高/最低音与音准统计。
 */
export async function analyzeAudioPitchContour(blob: Blob, maxPoints = 240): Promise<PitchAnalysisSummary> {
  const { samples, sampleRate } = await decodeToSamples(blob);
  const durationSec = samples.length / Math.max(1, sampleRate);
  const windowSize = 2048;
  const totalFrames = Math.max(1, Math.floor((samples.length - windowSize) / 1024));
  const hop = Math.max(512, Math.floor((samples.length - windowSize) / Math.min(maxPoints, Math.max(1, totalFrames))));

  const points: PitchTrackPoint[] = [];
  let minMidi = Infinity;
  let maxMidi = -Infinity;
  let centsSum = 0;
  let voicedCount = 0;
  let totalChecked = 0;

  for (let start = 0; start + windowSize <= samples.length; start += hop) {
    totalChecked++;
    const slice = samples.subarray(start, start + windowSize);
    const { hz, clarity, rms } = autocorrelate(slice, sampleRate);
    const timeSec = start / sampleRate;
    if (hz >= 55 && hz <= 1400 && clarity >= 0.5 && rms >= 0.002) {
      const midiFloat = freqToMidi(hz);
      const nearest = Math.round(midiFloat);
      const cents = (midiFloat - nearest) * 100;
      if (nearest < minMidi) minMidi = nearest;
      if (nearest > maxMidi) maxMidi = nearest;
      centsSum += Math.abs(cents);
      voicedCount++;
      points.push({
        timeSec,
        hz,
        midi: nearest,
        note: midiToName(nearest),
        cents,
        rms,
      });
    } else {
      points.push({
        timeSec,
        hz: 0,
        midi: 0,
        note: '',
        cents: 0,
        rms,
      });
    }
  }

  const hasVoiced = voicedCount > 0 && Number.isFinite(minMidi) && Number.isFinite(maxMidi);
  return {
    points,
    peaks: waveformPeaks(samples, 96),
    minMidi: hasVoiced ? minMidi : 0,
    maxMidi: hasVoiced ? maxMidi : 0,
    minNote: hasVoiced ? midiToName(minMidi) : '—',
    maxNote: hasVoiced ? midiToName(maxMidi) : '—',
    avgCents: voicedCount > 0 ? centsSum / voicedCount : 0,
    voicedRatio: totalChecked > 0 ? voicedCount / totalChecked : 0,
    durationSec,
  };
}
