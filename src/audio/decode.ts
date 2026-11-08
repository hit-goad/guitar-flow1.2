/**
 * 把任意音频 Blob（wav / webm / mp4）解码成 Float32 单声道采样，
 * 供 MP3 导出与波形显示使用。
 */
export async function decodeToSamples(blob: Blob): Promise<{ samples: Float32Array; sampleRate: number }> {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctor();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audio = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const ch0 = audio.getChannelData(0);
    let mono: Float32Array;
    if (audio.numberOfChannels > 1) {
      const ch1 = audio.getChannelData(1);
      mono = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i] + ch1[i]) / 2;
    } else {
      mono = new Float32Array(ch0);
    }
    return { samples: mono, sampleRate: audio.sampleRate };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** 生成归一化的波形点（0..1），用于列表里的迷你波形 */
export function waveformPeaks(samples: Float32Array, buckets = 80): number[] {
  const step = Math.max(1, Math.floor(samples.length / buckets));
  const peaks: number[] = [];
  for (let b = 0; b < buckets; b++) {
    let max = 0;
    const start = b * step;
    for (let i = start; i < Math.min(start + step, samples.length); i += 4) {
      const v = Math.abs(samples[i]);
      if (v > max) max = v;
    }
    peaks.push(max);
  }
  const top = Math.max(0.01, ...peaks);
  return peaks.map((p) => p / top);
}