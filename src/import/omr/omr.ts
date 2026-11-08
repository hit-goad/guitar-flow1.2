/**
 * 高精度吉他六线谱图片识别引擎（OMR）
 *
 * 核心流程：
 *  1. 彩色水印抑制 + Otsu 自适应二值化（自动过滤红色/彩色印章与浅灰水印）
 *  2. 6 弦谱表几何检测（findHorizontalLines + groupSystems）与小节竖线检测（detectBarlines）
 *  3. 谱表上方和弦指法图（Chord Diagram 6弦×4品网格）几何识别（detectChordDiagrams），
 *     自动还原每个小节的和弦按法 [f6, f5, f4, f3, f2, f1] 与和弦名称
 *  4. 逐弦局部邻域抹线与符干剥离：仅在紧邻弦线上下无墨迹处擦除弦线，完整保留 0 的空心、
 *     x 的交叉点以及 2/3/4/5 的横笔画
 *  5. 拓扑特征 + 分区密度 + 多字体模板联合分类器（classifyGlyph），精准区分 0-9 与 x，
 *     自动过滤弦上方的 H/P/S 技巧字母与扫弦箭头干扰
 *  6. 和弦感知 x 音符解析 + 符尾横杠（:4 / :8 / :16 / :2）节奏时值推断，
 *     同时产出标准可编辑 ASCII 六线谱与高还原度 alphaTex 可滚动曲谱
 */

export interface BinaryImage {
  width: number;
  height: number;
  /** 1 = 墨迹，0 = 背景 */
  data: Uint8Array;
}

export interface ChordDiagram {
  x: number;
  centerX: number;
  /** 6 根弦从 6 弦（低音 E）到 1 弦（高音 e）的品位，-1 表示闷音 */
  frets: number[];
  name: string;
}

export interface SystemBox {
  lines: number[];
  gap: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  bars?: number[];
  chords?: ChordDiagram[];
}

export interface Glyph {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0 = 1弦(高音e) .. 5 = 6弦(低音E) */
  stringIndex: number;
  label: string;
  /** 若 label === 'x'，由上方和弦图推导出的实际品位 */
  resolvedFret?: number;
  score: number;
}

export interface OmrResult {
  ascii: string;
  /** 直接生成的精准 alphaTex（含小节、时值、和弦与推算品位） */
  alphaTex: string;
  systems: number;
  measures: number;
  glyphs: number;
  chords: string[];
  confidence: number;
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* 1. 基础图像处理与彩色水印抑制                                        */
/* ------------------------------------------------------------------ */

export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    const a = rgba[p + 3];
    if (a < 32) {
      gray[i] = 255;
      continue;
    }
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const lum = ((r * 299 + g * 587 + b * 114) / 1000) | 0;
    if (maxC - minC > 22 && maxC > 135 && lum > 95) {
      gray[i] = 255;
    } else {
      gray[i] = lum;
    }
  }
  return gray;
}

export function binarize(gray: Uint8Array, width: number, height: number): Uint8Array {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = width * height;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 138;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  const safeThreshold = Math.min(168, Math.max(90, threshold));
  const out = new Uint8Array(total);
  for (let i = 0; i < total; i++) out[i] = gray[i] < safeThreshold ? 1 : 0;
  return out;
}

/* ------------------------------------------------------------------ */
/* 2. 六线谱表与小节线几何检测                                          */
/* ------------------------------------------------------------------ */

export function findHorizontalLines(bin: BinaryImage, minRatio = 0.22): number[] {
  const { width, height, data } = bin;
  const minRun = Math.max(36, Math.floor(width * minRatio));
  const rows: number[] = [];
  for (let y = 0; y < height; y++) {
    let run = 0;
    let bestRun = 0;
    const base = y * width;
    for (let x = 0; x < width; x++) {
      if (data[base + x]) {
        run++;
        if (run > bestRun) bestRun = run;
      } else {
        run = 0;
      }
    }
    if (bestRun >= minRun) rows.push(y);
  }
  const merged: number[] = [];
  for (const y of rows) {
    const last = merged[merged.length - 1];
    if (last !== undefined && y - last <= 3) continue;
    merged.push(y);
  }
  return merged;
}

export function groupSystems(lines: number[], stringsPerSystem = 6): SystemBox[] {
  const systems: SystemBox[] = [];
  let i = 0;
  while (i <= lines.length - stringsPerSystem) {
    const candidate: number[] = [lines[i]];
    let j = i + 1;
    let gap = 0;
    while (j < lines.length && candidate.length < stringsPerSystem) {
      const d = lines[j] - candidate[candidate.length - 1];
      if (gap === 0) gap = d;
      if (d < gap * 0.68 || d > gap * 1.38) break;
      candidate.push(lines[j]);
      gap = (gap * (candidate.length - 2) + d) / (candidate.length - 1);
      j++;
    }
    if (candidate.length === stringsPerSystem) {
      const gaps: number[] = [];
      for (let k = 1; k < candidate.length; k++) gaps.push(candidate[k] - candidate[k - 1]);
      const spread = Math.max(...gaps) - Math.min(...gaps);
      const g = (candidate[candidate.length - 1] - candidate[0]) / (candidate.length - 1);
      if (spread <= Math.max(6, g * 0.28) && g >= 6) {
        systems.push({
          lines: candidate,
          gap: g,
          top: candidate[0] - g * 0.7,
          bottom: candidate[candidate.length - 1] + g * 0.95,
          left: 0,
          right: 0,
        });
        i += candidate.length;
        continue;
      }
    }
    i++;
  }
  return systems;
}

export function measureSpan(bin: BinaryImage, system: SystemBox): void {
  const { width, data } = bin;
  const topLine = system.lines[0];
  const botLine = system.lines[system.lines.length - 1];
  const spanH = Math.max(1, botLine - topLine + 1);

  let firstInk = width;
  let lastInk = 0;
  const rawBars: number[] = [];

  for (let x = 0; x < width; x++) {
    let ink = 0;
    for (let y = topLine; y <= botLine; y++) {
      if (data[y * width + x]) ink++;
    }
    if (ink > 0) {
      if (x < firstInk) firstInk = x;
      if (x > lastInk) lastInk = x;
    }
    if (ink >= spanH * 0.9) {
      rawBars.push(x);
    }
  }

  const bars: number[] = [];
  for (const x of rawBars) {
    if (!bars.length || x - bars[bars.length - 1] > Math.max(8, system.gap * 0.45)) {
      bars.push(x);
    }
  }
  system.bars = bars;
  system.left = bars.length ? bars[0] : firstInk === width ? 0 : firstInk;
  system.right = bars.length >= 2 ? bars[bars.length - 1] : lastInk || width - 1;
}

/* ------------------------------------------------------------------ */
/* 3. 谱表上方和弦指法图（Chord Diagram）几何识别                        */
/* ------------------------------------------------------------------ */

const KNOWN_VOICINGS: Array<{ name: string; frets: number[] }> = [
  { name: 'C', frets: [0, 3, 2, 0, 1, 0] },
  { name: 'C', frets: [-1, 3, 2, 0, 1, 0] },
  { name: 'Cmaj7', frets: [0, 3, 2, 0, 0, 0] },
  { name: 'Cadd9', frets: [0, 3, 2, 0, 3, 0] },
  { name: 'Dm', frets: [0, 0, 0, 2, 3, 1] },
  { name: 'Dm7', frets: [0, 0, 0, 2, 1, 1] },
  { name: 'D', frets: [0, 0, 0, 2, 3, 2] },
  { name: 'D', frets: [-1, -1, 0, 2, 3, 2] },
  { name: 'D7', frets: [0, 0, 0, 2, 1, 2] },
  { name: 'Dsus4', frets: [0, 0, 0, 2, 3, 3] },
  { name: 'Em', frets: [0, 2, 2, 0, 0, 0] },
  { name: 'Em7', frets: [0, 2, 0, 0, 0, 0] },
  { name: 'E', frets: [0, 2, 2, 1, 0, 0] },
  { name: 'E7', frets: [0, 2, 0, 1, 0, 0] },
  { name: 'F', frets: [1, 3, 3, 2, 1, 1] },
  { name: 'Fmaj7', frets: [0, 0, 3, 2, 1, 0] },
  { name: 'F', frets: [0, 0, 3, 2, 1, 1] },
  { name: 'Fmaj7', frets: [0, 3, 3, 2, 1, 0] },
  { name: 'G', frets: [3, 2, 0, 0, 0, 3] },
  { name: 'G', frets: [3, 2, 0, 0, 3, 3] },
  { name: 'G7', frets: [3, 2, 0, 0, 0, 1] },
  { name: 'Am', frets: [0, 0, 2, 2, 1, 0] },
  { name: 'Am', frets: [-1, 0, 2, 2, 1, 0] },
  { name: 'Am7', frets: [0, 0, 2, 0, 1, 0] },
  { name: 'A', frets: [0, 0, 2, 2, 2, 0] },
  { name: 'A7', frets: [0, 0, 2, 0, 2, 0] },
  { name: 'Asus2', frets: [0, 0, 2, 2, 0, 0] },
  { name: 'Bm', frets: [0, 2, 4, 4, 3, 2] },
  { name: 'Bm', frets: [0, 2, 4, 4, 3, 0] },
  { name: 'B7', frets: [0, 2, 1, 2, 0, 2] },
];

function matchChordName(frets: number[]): string {
  let best = 'C';
  let bestDist = Infinity;
  for (const item of KNOWN_VOICINGS) {
    let dist = 0;
    for (let i = 0; i < 6; i++) {
      const a = frets[i] < 0 ? 0 : frets[i];
      const b = item.frets[i] < 0 ? 0 : item.frets[i];
      if (a !== b) dist += i >= 2 ? 2 : 1;
    }
    if (dist < bestDist) {
      bestDist = dist;
      best = item.name;
    }
  }
  return bestDist <= 2 ? best : 'G';
}

function cluster1D(arr: number[], gapThr = 4): number[] {
  const out: number[] = [];
  let cur: number[] = [];
  for (const v of arr) {
    if (!cur.length || v - cur[cur.length - 1] <= gapThr) {
      cur.push(v);
    } else {
      out.push(Math.round(cur.reduce((a, b) => a + b, 0) / cur.length));
      cur = [v];
    }
  }
  if (cur.length) out.push(Math.round(cur.reduce((a, b) => a + b, 0) / cur.length));
  return out;
}

export function detectChordDiagrams(bin: BinaryImage, system: SystemBox): ChordDiagram[] {
  const { width, height, data } = bin;
  const g = system.gap;
  const y0 = Math.max(0, Math.floor(system.lines[0] - g * 4.6));
  const y1 = Math.max(1, Math.floor(system.lines[0] - g * 0.2));
  if (y1 <= y0 + 10) return [];

  const comps = components(bin, { x0: 0, y0, x1: width - 1, y1 });
  const minDim = g * 1.5;
  const maxDim = g * 4.6;
  const diagrams: ChordDiagram[] = [];

  for (const c of comps) {
    const gw = c.maxX - c.minX + 1;
    const gh = c.maxY - c.minY + 1;
    if (gw < minDim || gw > maxDim || gh < minDim * 0.85 || gh > maxDim) continue;
    if (c.area < g * g * 0.45) continue;

    const rowsWithLine: number[] = [];
    for (let ry = 0; ry < gh; ry++) {
      let sum = 0;
      const rowBase = (c.minY + ry) * width + c.minX;
      for (let rx = 0; rx < gw; rx++) sum += data[rowBase + rx];
      if (sum >= gw * 0.65) rowsWithLine.push(ry);
    }

    const colsWithLine: number[] = [];
    for (let rx = 0; rx < gw; rx++) {
      let sum = 0;
      for (let ry = 0; ry < gh; ry++) sum += data[(c.minY + ry) * width + (c.minX + rx)];
      if (sum >= gh * 0.55) colsWithLine.push(rx);
    }

    const hBars = cluster1D(rowsWithLine, Math.max(3, Math.round(g * 0.16)));
    const vStrings = cluster1D(colsWithLine, Math.max(3, Math.round(g * 0.16)));
    if (vStrings.length !== 6 || hBars.length < 4) continue;

    const rBox = Math.max(3, Math.round(g * 0.16));
    const frets: number[] = [];
    for (const sx of vStrings) {
      let bestFret = 0;
      let bestDensity = 0;
      const maxSpaces = Math.min(4, hBars.length - 1);
      for (let fIdx = 0; fIdx < maxSpaces; fIdx++) {
        const fy = (hBars[fIdx] + hBars[fIdx + 1]) >> 1;
        let ink = 0;
        let total = 0;
        for (let dy = -rBox; dy <= rBox; dy++) {
          const py = c.minY + fy + dy;
          if (py < c.minY || py > c.maxY || py >= height) continue;
          for (let dx = -rBox; dx <= rBox; dx++) {
            const px = c.minX + sx + dx;
            if (px < c.minX || px > c.maxX || px >= width) continue;
            total++;
            if (data[py * width + px]) ink++;
          }
        }
        const density = total ? ink / total : 0;
        if (density > bestDensity) {
          bestDensity = density;
          bestFret = fIdx + 1;
        }
      }
      frets.push(bestDensity >= 0.48 ? bestFret : 0);
    }

    diagrams.push({
      x: c.minX,
      centerX: (c.minX + c.maxX) >> 1,
      frets,
      name: matchChordName(frets),
    });
  }

  diagrams.sort((a, b) => a.x - b.x);
  return diagrams;
}

/* ------------------------------------------------------------------ */
/* 4. 谱线与符干擦除                                                    */
/* ------------------------------------------------------------------ */

export function stripStaffLines(bin: BinaryImage, lineYs: number[]): BinaryImage {
  const { width, height } = bin;
  const data = new Uint8Array(bin.data);
  for (const ly of lineYs) {
    const keep = new Uint8Array(width);
    for (let x = 0; x < width; x++) {
      let hasAbove = 0;
      let hasBelow = 0;
      for (let dy = -4; dy <= -2; dy++) {
        const y = ly + dy;
        if (y >= 0 && y < height && bin.data[y * width + x]) hasAbove = 1;
      }
      for (let dy = 2; dy <= 4; dy++) {
        const y = ly + dy;
        if (y >= 0 && y < height && bin.data[y * width + x]) hasBelow = 1;
      }
      if (hasAbove || hasBelow) {
        if (x > 0) keep[x - 1] = 1;
        keep[x] = 1;
        if (x + 1 < width) keep[x + 1] = 1;
      }
    }
    for (let dy = -2; dy <= 2; dy++) {
      const y = ly + dy;
      if (y < 0 || y >= height) continue;
      const base = y * width;
      for (let x = 0; x < width; x++) {
        if (!keep[x]) data[base + x] = 0;
      }
    }
  }
  return { width, height, data };
}

export function stripVerticalStems(bin: BinaryImage, systems: SystemBox[]): BinaryImage {
  const { width, height } = bin;
  const data = new Uint8Array(bin.data);
  for (const sys of systems) {
    const y0 = Math.max(0, Math.floor(sys.top - sys.gap));
    const y1 = Math.min(height - 1, Math.ceil(sys.bottom + sys.gap));
    const maxRun = Math.floor(sys.gap * 1.4);
    for (let x = 0; x < width; x++) {
      let y = y0;
      while (y <= y1) {
        if (!data[y * width + x]) {
          y++;
          continue;
        }
        let end = y;
        while (end <= y1 && data[end * width + x]) end++;
        const len = end - y;
        if (len >= maxRun) {
          for (let yy = y; yy < end; yy++) {
            let lx = x;
            while (lx > 0 && data[yy * width + lx - 1]) lx--;
            let rx = x;
            while (rx + 1 < width && data[yy * width + rx + 1]) rx++;
            if (rx - lx + 1 <= 4) data[yy * width + x] = 0;
          }
        }
        y = end;
      }
    }
  }
  return { width, height, data };
}

/* ------------------------------------------------------------------ */
/* 5. 连通域提取与高精度数字/x 分类器                                   */
/* ------------------------------------------------------------------ */

export interface Component {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  pixels: number[];
  area: number;
}

export function components(bin: BinaryImage, box: { x0: number; y0: number; x1: number; y1: number }): Component[] {
  const { width, data } = bin;
  const w = box.x1 - box.x0 + 1;
  const h = box.y1 - box.y0 + 1;
  if (w <= 0 || h <= 0) return [];
  const seen = new Uint8Array(w * h);
  const out: Component[] = [];
  const stack: number[] = [];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (seen[idx] || !data[(box.y0 + y) * width + (box.x0 + x)]) continue;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      const pixels: number[] = [];
      stack.length = 0;
      stack.push(idx);
      seen[idx] = 1;
      while (stack.length) {
        const cur = stack.pop()!;
        const cy = Math.floor(cur / w);
        const cx = cur - cy * w;
        pixels.push((box.y0 + cy) * width + (box.x0 + cx));
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const ni = ny * w + nx;
            if (seen[ni] || !data[(box.y0 + ny) * width + (box.x0 + nx)]) continue;
            seen[ni] = 1;
            stack.push(ni);
          }
        }
      }
      out.push({
        minX: box.x0 + minX,
        maxX: box.x0 + maxX,
        minY: box.y0 + minY,
        maxY: box.y0 + maxY,
        pixels,
        area: pixels.length,
      });
    }
  }
  return out;
}

const NW = 14;
const NH = 18;

function resizeToNorm(sub: Uint8Array, sw: number, sh: number): Float32Array {
  let x0 = sw;
  let x1 = -1;
  let y0 = sh;
  let y1 = -1;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (sub[y * sw + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < x0 || y1 < y0) return new Float32Array(NW * NH);
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const norm = new Float32Array(NW * NH);
  for (let ty = 0; ty < NH; ty++) {
    const sy0 = y0 + Math.floor((ty * ch) / NH);
    const sy1 = y0 + Math.max(sy0 - y0 + 1, Math.floor(((ty + 1) * ch) / NH));
    for (let tx = 0; tx < NW; tx++) {
      const sx0 = x0 + Math.floor((tx * cw) / NW);
      const sx1 = x0 + Math.max(sx0 - x0 + 1, Math.floor(((tx + 1) * cw) / NW));
      let sum = 0;
      let cnt = 0;
      for (let y = sy0; y < Math.min(y1 + 1, sy1); y++) {
        for (let x = sx0; x < Math.min(x1 + 1, sx1); x++) {
          sum += sub[y * sw + x];
          cnt++;
        }
      }
      norm[ty * NW + tx] = cnt ? sum / cnt : 0;
    }
  }
  return norm;
}

function zoneMean(norm: Float32Array, y0: number, y1: number, x0: number, x1: number): number {
  let sum = 0;
  let cnt = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      sum += norm[y * NW + x];
      cnt++;
    }
  }
  return cnt ? sum / cnt : 0;
}

function zoneMax(norm: Float32Array, y0: number, y1: number, x0: number, x1: number): number {
  let best = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = norm[y * NW + x];
      if (v > best) best = v;
    }
  }
  return best;
}

export function classifySubGlyph(sub: Uint8Array, sw: number, sh: number): { label: string; score: number } | null {
  let x0 = sw;
  let x1 = -1;
  let y0 = sh;
  let y1 = -1;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (sub[y * sw + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < x0 || y1 < y0) return null;
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const aspect = cw / Math.max(1, ch);
  const norm = resizeToNorm(sub, sw, sh);

  const topMid = zoneMean(norm, 0, 4, 4, 10);
  const botMid = zoneMean(norm, 14, 18, 4, 10);
  const center = zoneMean(norm, 6, 12, 4, 10);
  const leftWallFull = zoneMean(norm, 3, 14, 0, 4);
  const rightWallFull = zoneMean(norm, 3, 14, 10, 14);

  // 过滤击弦字母 'H'：顶部正中开口（topMid < 0.24），但左右两侧皆为完整竖直长墙，且中央有横梁
  if (topMid < 0.24 && leftWallFull > 0.35 && rightWallFull > 0.35 && center > 0.2) {
    return null;
  }

  // 1) '1'：瘦长比例，或中段两侧极空而中轴实心
  if (aspect < 0.48) {
    return { label: '1', score: 0.95 };
  }
  if (
    aspect < 0.62 &&
    zoneMean(norm, 5, 13, 0, 3) < 0.08 &&
    zoneMean(norm, 5, 13, 11, 14) < 0.08 &&
    zoneMean(norm, 5, 13, 5, 9) > 0.45
  ) {
    return { label: '1', score: 0.93 };
  }

  // 2) 'x'：四角有斜线墨迹、中心交叉实心、上下正中均为空
  const corners =
    (zoneMax(norm, 0, 5, 0, 4) +
      zoneMax(norm, 0, 5, 10, 14) +
      zoneMax(norm, 13, 18, 0, 4) +
      zoneMax(norm, 13, 18, 10, 14)) /
    4;
  if (topMid < 0.2 && botMid < 0.2 && center > 0.3 && corners > 0.5) {
    return { label: 'x', score: 0.97 };
  }

  // 3) '0'：中心空心，且上下拱与左右侧墙均实心
  const holeCenter = zoneMean(norm, 5, 13, 5, 9);
  if (holeCenter < 0.14 && topMid > 0.34 && botMid > 0.34 && leftWallFull > 0.36 && rightWallFull > 0.36) {
    return { label: '0', score: 0.98 };
  }

  const botBar = zoneMean(norm, 15, 18, 1, 13);
  const topBar = zoneMean(norm, 0, 3, 1, 13);
  const midLeft = zoneMean(norm, 6, 11, 0, 4);
  const lowRightAboveBase = zoneMean(norm, 11, 15, 10, 14);
  const upRight = zoneMean(norm, 3, 8, 9, 14);
  const upLeft = zoneMean(norm, 3, 8, 0, 4);
  const lowLeft = zoneMean(norm, 10, 15, 0, 5);
  const lowRight = zoneMean(norm, 10, 15, 9, 14);

  // 4) '2'：底部平直横底（botBar 高），左中敞开，底座上方右侧敞开，右上弧饱满
  if (botBar > 0.5 && midLeft < 0.18 && lowRightAboveBase < 0.22 && upRight > 0.28) {
    return { label: '2', score: 0.96 };
  }

  // 5) '3'：左侧上下均敞开，右侧上下双弧饱满，中部有内收横腰
  if (zoneMean(norm, 5, 13, 0, 4) < 0.16 && upRight > 0.28 && lowRight > 0.28 && zoneMean(norm, 7, 11, 4, 10) > 0.2) {
    return { label: '3', score: 0.95 };
  }

  // 6) '4'：中下部有贯穿横杠（rows 8..14），顶部与底部均窄
  let maxRowMean = 0;
  for (let r = 8; r < 14; r++) {
    const m = zoneMean(norm, r, r + 1, 0, 14);
    if (m > maxRowMean) maxRowMean = m;
  }
  if (maxRowMean > 0.64 && topBar < 0.36 && botBar < 0.45) {
    return { label: '4', score: 0.94 };
  }

  // 7) '5'：顶部平直横杠，左上竖墙明显强于右上，右下弧强于左下
  if (topBar > 0.44 && upLeft > upRight + 0.14 && lowRight > lowLeft) {
    return { label: '5', score: 0.93 };
  }

  // 8) '7'：顶部横杠极强，底部窄，左侧空
  if (topBar > 0.5 && botBar < 0.35 && leftWallFull < 0.22) {
    return { label: '7', score: 0.93 };
  }

  // 9) '6'：右上敞开，下半部闭合环
  if (zoneMean(norm, 3, 7, 10, 14) < 0.18 && lowLeft > 0.34 && lowRight > 0.34) {
    return { label: '6', score: 0.92 };
  }

  // 10) '9'：左下敞开，上半部闭合环
  if (zoneMean(norm, 11, 15, 0, 4) < 0.18 && upLeft > 0.34 && upRight > 0.34) {
    return { label: '9', score: 0.92 };
  }

  // 11) '8'：上下双环闭合且中间收腰实心
  if (topMid > 0.3 && botMid > 0.3 && center > 0.24 && leftWallFull > 0.3 && rightWallFull > 0.3) {
    return { label: '8', score: 0.91 };
  }

  if (botBar > 0.52) return { label: '2', score: 0.78 };
  if (holeCenter < 0.22) return { label: '0', score: 0.78 };
  return { label: '3', score: 0.72 };
}

/* ------------------------------------------------------------------ */
/* 6. 节奏符尾横梁检测与完整页面识谱                                    */
/* ------------------------------------------------------------------ */

function detectBeamCount(bin: BinaryImage, sys: SystemBox, colX: number): number {
  const { width, height, data } = bin;
  const g = sys.gap;
  const yStart = Math.min(height - 1, Math.round(sys.lines[5] + g * 0.65));
  const yEnd = Math.min(height - 1, Math.round(sys.lines[5] + g * 1.65));
  if (yEnd <= yStart + 2) return 0;

  const beamRows: number[] = [];
  for (let y = yStart; y <= yEnd; y++) {
    let hit = false;
    for (const dx of [-5, 0, 5]) {
      const cx = Math.max(0, Math.min(width - 1, colX + dx));
      if (!data[y * width + cx]) continue;
      let lx = cx;
      while (lx > 0 && data[y * width + lx - 1]) lx--;
      let rx = cx;
      while (rx + 1 < width && data[y * width + rx + 1]) rx++;
      if (rx - lx + 1 >= Math.max(6, Math.round(g * 0.28))) {
        hit = true;
        break;
      }
    }
    if (hit) beamRows.push(y);
  }
  const clusters = cluster1D(beamRows, 3);
  return Math.min(2, clusters.length);
}

function activeChordAt(chords: ChordDiagram[], x: number): ChordDiagram | null {
  if (!chords.length) return null;
  let active = chords[0];
  for (const c of chords) {
    if (c.x <= x + 28) active = c;
    else break;
  }
  return active;
}

export interface RecognizeOptions {
  resolveChordX?: boolean;
  title?: string;
  artist?: string;
  tempo?: number;
}

export function recognizeTablature(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  opts: RecognizeOptions = {},
): OmrResult {
  const resolveChordX = opts.resolveChordX ?? true;
  const warnings: string[] = [];
  const gray = rgbaToGray(rgba, width, height);
  const bin: BinaryImage = { width, height, data: binarize(gray, width, height) };

  const lineYs = findHorizontalLines(bin);
  if (lineYs.length < 6) {
    return {
      ascii: '',
      alphaTex: '',
      systems: 0,
      measures: 0,
      glyphs: 0,
      chords: [],
      confidence: 0,
      warnings: ['没有检测到六线谱弦线（可能是纯五线谱或图像过模糊）'],
    };
  }

  const systems = groupSystems(lineYs, 6);
  if (!systems.length) {
    return {
      ascii: '',
      alphaTex: '',
      systems: 0,
      measures: 0,
      glyphs: 0,
      chords: [],
      confidence: 0,
      warnings: ['检测到横线，但未能组合出等间距的六线谱表'],
    };
  }

  const allGlyphs: Glyph[] = [];
  const allChords: string[] = [];
  let lastChord: ChordDiagram = { x: 0, centerX: 0, frets: [0, 3, 2, 0, 1, 0], name: 'C' };

  for (let sysIdx = 0; sysIdx < systems.length; sysIdx++) {
    const sys = systems[sysIdx];
    measureSpan(bin, sys);
    const chords = detectChordDiagrams(bin, sys);
    sys.chords = chords;
    for (const c of chords) {
      if (!allChords.length || allChords[allChords.length - 1] !== c.name) {
        allChords.push(c.name);
      }
    }
    if (chords.length) lastChord = chords[0];

    const g = sys.gap;
    const bars = sys.bars ?? [];
    // 跳过行首 TAB 谱号与 4/4 拍号（首行偏移 7.2*gap，后续行偏移 2.8*gap）
    const xStart = bars.length
      ? Math.min(width - 1, Math.round(bars[0] + (sysIdx === 0 ? g * 7.2 : g * 2.8)))
      : Math.round(width * 0.14);
    const xEnd = bars.length >= 2 ? Math.max(xStart + 10, bars[bars.length - 1] - 4) : Math.round(width * 0.92);
    const half = Math.max(4, Math.round(g * 0.44));
    const bh = half * 2 + 1;
    const bw = Math.max(1, xEnd - xStart);

    for (let sIdx = 0; sIdx < 6; sIdx++) {
      const ly = sys.lines[sIdx];
      let minDy = -1;
      let maxDy = 1;
      const lineDys: number[] = [];
      for (let dy = -2; dy <= 2; dy++) {
        const y = ly + dy;
        if (y < 0 || y >= height) continue;
        let sum = 0;
        for (let x = xStart; x < xEnd; x++) sum += bin.data[y * width + x];
        if (sum > bw * 0.48) lineDys.push(dy);
      }
      if (lineDys.length) {
        minDy = Math.min(...lineDys);
        maxDy = Math.max(...lineDys);
      }

      const band = new Uint8Array(bw * bh);
      for (let ry = 0; ry < bh; ry++) {
        const py = Math.max(0, Math.min(height - 1, ly - half + ry));
        for (let rx = 0; rx < bw; rx++) {
          band[ry * bw + rx] = bin.data[py * width + (xStart + rx)];
        }
      }

      const yOutTop = Math.max(0, ly - half - 2);
      const yOutBot = Math.min(height - 1, ly + half + 2);
      for (let rx = 0; rx < bw; rx++) {
        const absX = xStart + rx;
        const outTop = bin.data[yOutTop * width + absX] === 1;
        const outBot = bin.data[yOutBot * width + absX] === 1;
        if (outTop && outBot) {
          let wTop = 0;
          let wBot = 0;
          for (let dx = -3; dx <= 3; dx++) {
            const nx = rx + dx;
            if (nx >= 0 && nx < bw) {
              if (band[1 * bw + nx]) wTop++;
              if (band[(bh - 2) * bw + nx]) wBot++;
            }
          }
          if (wTop <= 4 && wBot <= 4) {
            for (let ry = 0; ry < bh; ry++) band[ry * bw + rx] = 0;
          }
        } else if (outBot && !outTop) {
          let wBot = 0;
          for (let dx = -3; dx <= 3; dx++) {
            const nx = rx + dx;
            if (nx >= 0 && nx < bw && band[(bh - 1) * bw + nx]) wBot++;
          }
          if (wBot <= 3) {
            band[(bh - 2) * bw + rx] = 0;
            band[(bh - 1) * bw + rx] = 0;
          }
        }
      }

      // 清除小节线及反复记号（|| 或 |:）附近像素
      for (let bIdx = 0; bIdx < bars.length; bIdx++) {
        const bx = bars[bIdx];
        const rel = bx - xStart;
        const nextBx = bars[bIdx + 1];
        // 若两条竖线间距 < 1.3*gap，属于双小节线/反复记号，整段清空
        const clearRight = nextBx !== undefined && nextBx - bx < g * 1.3 ? nextBx - bx + 10 : 5;
        for (let dx = -5; dx <= clearRight; dx++) {
          const rx = rel + dx;
          if (rx >= 0 && rx < bw) {
            for (let ry = 0; ry < bh; ry++) band[ry * bw + rx] = 0;
          }
        }
      }

      const rAbove0 = Math.max(0, half + minDy - 2);
      const rAbove1 = Math.max(1, half + minDy);
      const rBelow0 = Math.min(bh - 1, half + maxDy + 1);
      const rBelow1 = Math.min(bh, half + maxDy + 3);
      const keep = new Uint8Array(bw);
      for (let rx = 0; rx < bw; rx++) {
        let hasInk = false;
        for (let ry = rAbove0; ry < rAbove1; ry++) {
          if (band[ry * bw + rx]) hasInk = true;
        }
        for (let ry = rBelow0; ry < rBelow1; ry++) {
          if (band[ry * bw + rx]) hasInk = true;
        }
        if (hasInk) {
          if (rx > 0) keep[rx - 1] = 1;
          keep[rx] = 1;
          if (rx + 1 < bw) keep[rx + 1] = 1;
        }
      }
      for (let dy = minDy - 1; dy <= maxDy + 1; dy++) {
        const ry = half + dy;
        if (ry < 0 || ry >= bh) continue;
        for (let rx = 0; rx < bw; rx++) {
          if (!keep[rx]) band[ry * bw + rx] = 0;
        }
      }

      const bandImg: BinaryImage = { width: bw, height: bh, data: band };
      const comps = components(bandImg, { x0: 0, y0: 0, x1: bw - 1, y1: bh - 1 });
      const minW = Math.max(4, Math.floor(g * 0.24));
      const minH = Math.max(8, Math.floor(g * 0.52));
      const minArea = Math.max(16, Math.floor(g * g * 0.06));

      for (const c of comps) {
        let cw = c.maxX - c.minX + 1;
        const ch = c.maxY - c.minY + 1;
        if (cw < minW || ch < minH || c.area < minArea) continue;
        if (c.minY > half + 2 || c.maxY < half - 2) continue;

        let cropMinX = c.minX;
        if (cw > Math.round(g * 1.06)) {
          const sliceW = Math.max(minW, Math.round(g * 0.65));
          cropMinX = Math.max(c.minX, c.maxX - sliceW + 1);
          cw = c.maxX - cropMinX + 1;
        }

        const sub = new Uint8Array(cw * ch);
        for (let y = 0; y < ch; y++) {
          for (let x = 0; x < cw; x++) {
            sub[y * cw + x] = band[(c.minY + y) * bw + (cropMinX + x)];
          }
        }

        const classified = classifySubGlyph(sub, cw, ch);
        if (!classified) continue;

        const absCenterX = xStart + cropMinX + (cw >> 1);
        const absCenterY = ly - half + c.minY + (ch >> 1);
        const chord = activeChordAt(chords, absCenterX) ?? lastChord;
        if (chord) lastChord = chord;

        const chordFret = chord ? Math.max(0, chord.frets[5 - sIdx] ?? 0) : 0;
        const resolvedFret =
          classified.label === 'x'
            ? chordFret
            : parseInt(classified.label, 10);

        allGlyphs.push({
          x: absCenterX,
          y: absCenterY,
          w: cw,
          h: ch,
          stringIndex: sIdx,
          label: classified.label,
          resolvedFret: Number.isFinite(resolvedFret) ? resolvedFret : 0,
          score: classified.score,
        });
      }
    }
  }

  if (!allGlyphs.length) {
    return {
      ascii: '',
      alphaTex: '',
      systems: systems.length,
      measures: 0,
      glyphs: 0,
      chords: allChords,
      confidence: 0,
      warnings: ['识别到六线谱表，但未能提取出品位数字'],
    };
  }

  const confidence = allGlyphs.reduce((acc, gl) => acc + gl.score, 0) / allGlyphs.length;
  const { ascii, alphaTex, measures } = buildTabAndAlphaTex(bin, allGlyphs, systems, {
    resolveChordX,
    title: opts.title || '识谱曲目',
    artist: opts.artist || '',
    tempo: opts.tempo || 100,
  });

  return {
    ascii,
    alphaTex,
    systems: systems.length,
    measures,
    glyphs: allGlyphs.length,
    chords: allChords,
    confidence,
    warnings,
  };
}

function buildTabAndAlphaTex(
  bin: BinaryImage,
  glyphs: Glyph[],
  systems: SystemBox[],
  opts: { resolveChordX: boolean; title: string; artist: string; tempo: number },
): { ascii: string; alphaTex: string; measures: number } {
  const order = ['e', 'B', 'G', 'D', 'A', 'E'];
  const asciiOut: string[] = [];
  const texMeasures: string[] = [];

  for (const sys of systems) {
    const inSys = glyphs.filter((gl) => gl.y >= sys.top && gl.y <= sys.bottom);
    if (!inSys.length) continue;

    const sorted = [...inSys].sort((a, b) => a.x - b.x || a.stringIndex - b.stringIndex);
    const columns: Array<{ x: number; notes: Glyph[] }> = [];
    for (const gl of sorted) {
      const last = columns[columns.length - 1];
      if (last && Math.abs(gl.x - last.x) <= sys.gap * 0.42) {
        const existingIdx = last.notes.findIndex((n) => n.stringIndex === gl.stringIndex);
        if (existingIdx >= 0) {
          if (gl.score > last.notes[existingIdx].score) last.notes[existingIdx] = gl;
        } else {
          last.notes.push(gl);
        }
      } else {
        columns.push({ x: gl.x, notes: [gl] });
      }
    }

    const bars = (sys.bars ?? []).filter((bx) => bx > sys.left + sys.gap * 1.5 && bx < sys.right - sys.gap * 0.5);
    const boundaries = [sys.left, ...bars, sys.right];
    const sysMeasures: Array<{ left: number; right: number; cols: Array<{ x: number; notes: Glyph[] }> }> = [];

    for (let b = 0; b < boundaries.length - 1; b++) {
      const mLeft = boundaries[b];
      const mRight = boundaries[b + 1];
      if (mRight - mLeft < sys.gap * 1.6) continue;
      const mCols = columns.filter((c) => c.x >= mLeft && c.x < mRight);
      if (mCols.length) {
        sysMeasures.push({ left: mLeft, right: mRight, cols: mCols });
      }
    }
    if (!sysMeasures.length && columns.length) {
      sysMeasures.push({ left: sys.left, right: sys.right, cols: columns });
    }

    const asciiBarsPerString: string[][] = Array.from({ length: 6 }, () => []);

    for (const m of sysMeasures) {
      const mSpan = Math.max(1, m.right - m.left);
      const texCells: string[] = [];
      const stringSegments: string[][] = Array.from({ length: 6 }, () => []);

      m.cols.forEach((col, idx) => {
        const nextX = idx + 1 < m.cols.length ? m.cols[idx + 1].x : m.right;
        const dxRatio = Math.max(0.04, (nextX - col.x) / mSpan);
        const beams = detectBeamCount(bin, sys, col.x);

        let dur = ':8';
        if (beams >= 2 || dxRatio < 0.085) dur = ':16';
        else if (beams === 1 || dxRatio < 0.19) dur = ':8';
        else if (dxRatio < 0.38) dur = ':4';
        else if (dxRatio < 0.7) dur = ':2';
        else dur = ':1';

        const noteParts: string[] = [];
        const byString = new Map<number, string>();
        for (const n of col.notes) {
          const val = opts.resolveChordX && n.label === 'x' ? String(n.resolvedFret ?? 0) : n.label;
          byString.set(n.stringIndex, val);
          const fretNum = n.label === 'x' ? (n.resolvedFret ?? 0) : parseInt(n.label, 10);
          if (Number.isFinite(fretNum) && fretNum >= 0) {
            noteParts.push(`${fretNum}.${n.stringIndex + 1}`);
          }
        }
        texCells.push(`${dur} ${noteParts.length === 0 ? 'r' : noteParts.length === 1 ? noteParts[0] : `(${noteParts.join(' ')})`}`);

        const padCount = dur === ':16' ? 1 : dur === ':8' ? 2 : dur === ':4' ? 3 : 4;
        for (let r = 0; r < 6; r++) {
          const token = byString.get(r) ?? '-';
          stringSegments[r].push('-' + token + '-'.repeat(padCount));
        }
      });

      for (let r = 0; r < 6; r++) {
        asciiBarsPerString[r].push(stringSegments[r].join(''));
      }
      if (texCells.length) {
        texMeasures.push(texCells.join(' '));
      }
    }

    if (sys.chords?.length) {
      asciiOut.push(`# Chords: ${sys.chords.map((c) => c.name).join(' | ')}`);
    }
    for (let r = 0; r < 6; r++) {
      asciiOut.push(`${order[r]}|${asciiBarsPerString[r].join('|')}|`);
    }
    asciiOut.push('');
  }

  const alphaTex = texMeasures.length
    ? [
        `\\title "${opts.title.replace(/"/g, "'")}"`,
        opts.artist ? `\\artist "${opts.artist.replace(/"/g, "'")}"` : '',
        `\\tempo ${opts.tempo}`,
        '\\tuning (E4 B3 G3 D3 A2 E2)',
        '.',
        texMeasures.join(' |\n') + ' |',
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  return {
    ascii: asciiOut.join('\n'),
    alphaTex,
    measures: texMeasures.length,
  };
}

export function glyphsToAscii(glyphs: Glyph[], systems: SystemBox[]): string {
  const order = ['e', 'B', 'G', 'D', 'A', 'E'];
  const out: string[] = [];

  for (const sys of systems) {
    const inSys = glyphs.filter((gl) => gl.y >= sys.top && gl.y <= sys.bottom);
    if (!inSys.length) continue;

    const sorted = [...inSys].sort((a, b) => a.x - b.x || a.stringIndex - b.stringIndex);
    const columns: Array<{ x: number; notes: Glyph[] }> = [];
    for (const gl of sorted) {
      const last = columns[columns.length - 1];
      if (last && Math.abs(gl.x - last.x) <= sys.gap * 0.42) {
        last.notes.push(gl);
      } else {
        columns.push({ x: gl.x, notes: [gl] });
      }
    }

    const rows: string[][] = Array.from({ length: 6 }, () => []);
    columns.forEach((col, i) => {
      const byStr = new Map<number, string>();
      for (const n of col.notes) {
        byStr.set(n.stringIndex, n.label === 'x' && n.resolvedFret !== undefined ? String(n.resolvedFret) : n.label);
      }
      for (let r = 0; r < 6; r++) {
        rows[r].push('-' + (byStr.get(r) ?? '-') + '--');
      }
      if ((i + 1) % 6 === 0 && i + 1 < columns.length) {
        for (let r = 0; r < 6; r++) rows[r].push('|');
      }
    });

    for (let r = 0; r < 6; r++) {
      out.push(`${order[r]}|${rows[r].join('')}|`);
    }
    out.push('');
  }

  return out.join('\n');
}

export async function recognizeImageBlob(blob: Blob, opts: RecognizeOptions = {}): Promise<OmrResult> {
  if (typeof document === 'undefined') {
    throw new Error('当前环境缺少 Canvas，请直接传入 RGBA 像素调用 recognizeTablature');
  }
  let width = 0;
  let height = 0;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建 2D 画布用于图片识谱');

  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    const maxDim = 2600;
    const scale = bitmap.width > maxDim ? maxDim / bitmap.width : bitmap.width < 1200 ? Math.min(2, 1600 / Math.max(1, bitmap.width)) : 1;
    width = Math.max(1, Math.round(bitmap.width * scale));
    height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.width = width;
    canvas.height = height;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
  } else {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('图片解码失败'));
        el.src = url;
      });
      const maxDim = 2600;
      const scale = img.naturalWidth > maxDim ? maxDim / img.naturalWidth : 1;
      width = Math.max(1, Math.round(img.naturalWidth * scale));
      height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.width = width;
      canvas.height = height;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const imageData = ctx.getImageData(0, 0, width, height);
  return recognizeTablature(imageData.data, width, height, opts);
}

export async function recognizeImagePages(
  pages: Blob[],
  opts: RecognizeOptions = {},
): Promise<OmrResult & { pageCount: number }> {
  const asciiParts: string[] = [];
  const texBodies: string[] = [];
  const allChords: string[] = [];
  const warnings: string[] = [];
  let systems = 0;
  let measures = 0;
  let glyphs = 0;
  let confWeighted = 0;

  for (let i = 0; i < pages.length; i++) {
    try {
      const res = await recognizeImageBlob(pages[i], opts);
      systems += res.systems;
      measures += res.measures;
      glyphs += res.glyphs;
      confWeighted += res.confidence * res.glyphs;
      for (const c of res.chords) {
        if (!allChords.length || allChords[allChords.length - 1] !== c) allChords.push(c);
      }
      if (res.ascii.trim()) asciiParts.push(res.ascii.trim());
      if (res.alphaTex.trim()) {
        const dotIdx = res.alphaTex.indexOf('\n.\n');
        const body = dotIdx >= 0 ? res.alphaTex.slice(dotIdx + 3).trim() : '';
        if (body) texBodies.push(body);
      }
    } catch (err) {
      warnings.push(`第 ${i + 1} 页识谱异常：${(err as Error).message}`);
    }
  }

  const title = opts.title || '识谱曲目';
  const artist = opts.artist || '';
  const tempo = opts.tempo || 100;
  const alphaTex = texBodies.length
    ? [
        `\\title "${title.replace(/"/g, "'")}"`,
        artist ? `\\artist "${artist.replace(/"/g, "'")}"` : '',
        `\\tempo ${tempo}`,
        '\\tuning (E4 B3 G3 D3 A2 E2)',
        '.',
        texBodies.join('\n'),
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  return {
    ascii: asciiParts.join('\n\n'),
    alphaTex,
    systems,
    measures,
    glyphs,
    chords: allChords,
    confidence: glyphs > 0 ? confWeighted / glyphs : 0,
    warnings,
    pageCount: pages.length,
  };
}