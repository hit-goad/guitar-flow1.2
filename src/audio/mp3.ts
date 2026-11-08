/**
 * MP3 编码：与参考 App 一致（LAME），把录好的 WAV/PCM 压成 mp3 便于分享。
 * 浏览器 / Electron / Capacitor 都能跑（纯 JS）。
 */
import { Mp3Encoder } from 'lamejs';

export interface Mp3Options {
  bitRate?: number;
  sampleRate?: number;
}

function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** 单声道 PCM → MP3 Blob。异步分块编码，避免长录音卡住主线程。 */
export async function encodeMp3(
  samples: Float32Array,
  sampleRate = 44100,
  opts: Mp3Options = {},
): Promise<Blob> {
  const bitRate = opts.bitRate ?? 128;
  const encoder = new Mp3Encoder(1, sampleRate, bitRate);
  const pcm = floatToInt16(samples);
  const blockSize = 1152 * 8;
  const parts: Uint8Array[] = [];

  for (let i = 0; i < pcm.length; i += blockSize) {
    const chunk = pcm.subarray(i, Math.min(i + blockSize, pcm.length));
    const encoded = encoder.encodeBuffer(chunk);
    if (encoded.length) parts.push(new Uint8Array(encoded));
    // 让出主线程，界面不卡
    if (i % (blockSize * 8) === 0) await new Promise((r) => setTimeout(r, 0));
  }
  const tail = encoder.flush();
  if (tail.length) parts.push(new Uint8Array(tail));

  return new Blob(parts as unknown as BlobPart[], { type: 'audio/mpeg' });
}

/** 重采样（线性插值），把任意采样率对齐到 44.1k，LAME 对非标准采样率支持有限 */
export function resample(input: Float32Array, from: number, to = 44100): Float32Array {
  if (from === to) return input;
  const ratio = to / from;
  const length = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}