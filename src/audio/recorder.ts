import { GuitarSynth } from './synth';
import type { TickNote } from '../score/timeline';
import { saveBlob } from '../core/platform';

/** 16bit PCM WAV 编码 */
export function encodeWav(channels: Float32Array[], sampleRate: number): Blob {
  const numChannels = Math.max(1, channels.length);
  const length = channels[0]?.length ?? 0;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i] ?? 0));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export interface InternalRenderOptions {
  sampleRate?: number;
  tailSec?: number;
  metronome?: boolean;
  name?: string;
}

/**
 * 内录（应用内录）：把当前曲谱的播放渲染成 WAV。
 * 与麦克风录制不同，它拿到的是「应用自己发出的声音」的干净信号。
 */
export async function renderTimelineToWav(
  events: TickNote[],
  totalSec: number,
  opts: InternalRenderOptions = {},
): Promise<Blob> {
  const sampleRate = opts.sampleRate ?? 44100;
  const tail = opts.tailSec ?? 2;
  const duration = Math.max(1, totalSec + tail);
  const ctx = new OfflineAudioContext(2, Math.ceil(sampleRate * duration), sampleRate);
  const s = new GuitarSynth(ctx);
  s.setVolume(0.8);

  for (const item of events) {
    s.pluck(item.event.midi, item.timeSec, {
      velocity: item.event.velocity,
      duration: item.durationSec,
    });
  }
  const rendered = await ctx.startRendering();
  const left = rendered.getChannelData(0);
  const right = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : left;
  return encodeWav([left, right], sampleRate);
}

export interface MicRecording {
  blob: Blob;
  mime: string;
  durationSec: number;
}

/** 麦克风录制（用于回听自己的演奏） */
export class MicRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private stream: MediaStream | null = null;
  private startedAt = 0;
  private mime = 'audio/webm';

  get recording(): boolean {
    return this.recorder?.state === 'recording';
  }

  static supported(): boolean {
    return typeof MediaRecorder !== 'undefined';
  }

  async start(stream?: MediaStream): Promise<void> {
    if (!MicRecorder.supported()) throw new Error('当前平台不支持录制');
    this.stream = stream ?? (await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } }));
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'];
    this.mime = candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
    this.recorder = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.startedAt = performance.now();
    this.recorder.start(200);
  }

  async stop(): Promise<MicRecording> {
    const rec = this.recorder;
    if (!rec) return { blob: new Blob(), mime: this.mime, durationSec: 0 };
    const done = new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
    });
    rec.stop();
    await done;
    this.stream?.getTracks().forEach((t) => t.stop());
    const blob = new Blob(this.chunks, { type: this.mime || 'audio/webm' });
    return {
      blob,
      mime: this.mime,
      durationSec: (performance.now() - this.startedAt) / 1000,
    };
  }
}

/** 桌面端系统内录（Electron 下 getDisplayMedia 可带系统音频） */
export async function captureSystemAudio(): Promise<MediaStream | null> {
  try {
    if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') return null;
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true } as DisplayMediaStreamOptions);
    // 只要音轨
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      stream.getTracks().forEach((t) => t.stop());
      return null;
    }
    stream.getVideoTracks().forEach((t) => t.stop());
    return new MediaStream(audioTracks);
  } catch {
    return null;
  }
}

export async function saveRecording(blob: Blob, name: string): Promise<string | null> {
  const ext = blob.type.includes('wav') ? 'wav' : blob.type.includes('mp4') ? 'm4a' : 'webm';
  return saveBlob(`${name}.${ext}`, blob);
}