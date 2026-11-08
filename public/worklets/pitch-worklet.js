// 音高检测 AudioWorklet：FFT 自相关（Wiener–Khinchin）+ 抛物线插值。
// 独立文件放在 public/worklets 下，避免被 TS 编译链改动。
/* eslint-disable */
class PitchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 4096;
    this.hop = 2048;
    this.ring = new Float32Array(this.size);
    this.fill = 0;
    this.re = new Float32Array(this.size);
    this.im = new Float32Array(this.size);
    this.window = new Float32Array(this.size);
    for (let i = 0; i < this.size; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (this.size - 1));
    }
    this.frames = 0;
    // 30Hz 以下 / 1000Hz 以上不做基频估计
    this.minLag = Math.max(2, Math.floor(sampleRate / 1000));
    this.maxLag = Math.floor(sampleRate / 55);
  }

  fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang);
      const wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ar = re[i + k], ai = im[i + k];
          const br = re[i + k + len / 2], bi = im[i + k + len / 2];
          const tr = br * cr - bi * ci;
          const ti = br * ci + bi * cr;
          re[i + k] = ar + tr;
          im[i + k] = ai + ti;
          re[i + k + len / 2] = ar - tr;
          im[i + k + len / 2] = ai - ti;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  analyse() {
    const n = this.size;
    const re = this.re;
    const im = this.im;
    let rms = 0;
    for (let i = 0; i < n; i++) {
      const v = this.ring[(this.fill + i) % n] * this.window[i];
      rms += v * v;
      re[i] = v;
      im[i] = 0;
    }
    rms = Math.sqrt(rms / n);
    if (rms < 0.0012) return { hz: 0, clarity: 0, rms };

    // 去均值，减少低频噪声
    let mean = 0;
    for (let i = 0; i < n; i++) mean += re[i];
    mean /= n;
    for (let i = 0; i < n; i++) re[i] -= mean;

    this.fft(re, im);
    for (let i = 0; i < n; i++) {
      re[i] = re[i] * re[i] + im[i] * im[i];
      im[i] = 0;
    }
    // IFFT：共轭再 FFT，即可得到自相关
    this.fft(re, im);
    // 归一化（自相关零延迟 = 1）
    const r0 = re[0] || 1e-9;
    let bestLag = -1;
    let bestVal = 0;
    for (let lag = this.minLag; lag <= this.maxLag; lag++) {
      const v = re[lag] / r0;
      if (v > bestVal) {
        bestVal = v;
        bestLag = lag;
      }
    }
    if (bestLag <= 0 || bestVal < 0.35) return { hz: 0, clarity: bestVal, rms };

    // 抛物线插值
    const y0 = re[bestLag - 1] / r0;
    const y1 = re[bestLag] / r0;
    const y2 = re[bestLag + 1] / r0;
    const denom = y0 - 2 * y1 + y2;
    const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
    const lag = bestLag + Math.max(-0.5, Math.min(0.5, shift));
    const hz = sampleRate / lag;
    if (hz < 55 || hz > 1400) return { hz: 0, clarity: bestVal, rms };
    return { hz, clarity: Math.max(0, Math.min(1, bestVal)), rms };
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch) return true;
    const n = this.size;
    for (let i = 0; i < ch.length; i++) {
      if (Math.abs(ch[i]) > (this.peak || 0)) this.peak = Math.abs(ch[i]);
      this.ring[this.fill] = ch[i];
      this.fill = (this.fill + 1) % n;
      this.acc = (this.acc || 0) + 1;
    }
    if (this.acc >= this.hop) {
      this.acc = 0;
      this.frames++;
      // 每两帧算一次，控制主线程消息量
      if (this.frames % 2 === 0) {
        const r = this.analyse();
        r.peak = this.peak || 0;
        this.peak = 0;
        this.port.postMessage(r);
      }
    }
    return true;
  }
}
registerProcessor('pitch-detector', PitchProcessor);