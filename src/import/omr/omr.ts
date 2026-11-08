/**
 * 六线谱图片识别（OMR）
 *
 * 流程：图片 → 灰度 → 二值化 → 检测弦线 → 分行谱表 → 擦除弦线与节奏符干
 *      → 连通域取字形 → 同页聚类（字体一致，聚类后整体贴标签）
 *      → 按 x 坐标铺成 ASCII 六线谱 → 交给 asciiTab 转 alphaTex。
 *
 * 设计取舍：纯前端、无模型文件；识别结果是「初稿」，UI 里提供可编辑预览，
 * 用户校正后再生成为可滚动、可播放的谱。
 */

export interface BinaryImage {
  width: number;
  height: number;
  /** 1 = 墨迹，0 = 背景 */
  data: Uint8Array;
}

export interface SystemBox {
  lines: number[];
  gap: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface Glyph {
  x: number;
  y: number;
  w: number;
  h: number;
  stringIndex: number;
  label: string;
  score: number;
}

export interface OmrResult {
  ascii: string;
  systems: number;
  glyphs: number;
  confidence: number;
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* 基础图像处理                                                        */
/* ------------------------------------------------------------------ */

export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
  }
  return gray;
}

/** Otsu 全局阈值（印刷谱背景干净，够用） */
export function binarize(gray: Uint8Array, width: number, height: number): Uint8Array {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
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
  const out = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) out[i] = gray[i] < threshold ? 1 : 0;
  return out;
}

/* ------------------------------------------------------------------ */
/* 谱表检测                                                            */
/* ------------------------------------------------------------------ */

/** 找出所有长横线（六线谱的 6 条弦线） */
export function findHorizontalLines(bin: BinaryImage, minRatio = 0.25): number[] {
  const { width, height, data } = bin;
  const minRun = Math.max(40, Math.floor(width * minRatio));
  const rows: number[] = [];
  for (let y = 0; y < height; y++) {
    let run = 0;
    let bestRun = 0;
    const base = y * width;
    for (let x = 0; x < width; x++) {
      if (data[base + x]) {
        run++;
        if (run > bestRun) bestRun = run;
      } else run = 0;
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

/** 把横线按等间距分组，得到每一行谱表 */
export function groupSystems(lines: number[], stringsPerSystem = 6): SystemBox[] {
  const systems: SystemBox[] = [];
  let i = 0;
  while (i < lines.length) {
    const candidate: number[] = [lines[i]];
    let j = i + 1;
    let gap = 0;
    while (j < lines.length && candidate.length < stringsPerSystem) {
      const d = lines[j] - candidate[candidate.length - 1];
      if (gap === 0) gap = d;
      if (d < gap * 0.65 || d > gap * 1.45) break;
      candidate.push(lines[j]);
      gap = (gap * (candidate.length - 2) + d) / (candidate.length - 1);
      j++;
    }
    if (candidate.length >= Math.min(6, stringsPerSystem)) {
      const g = (candidate[candidate.length - 1] - candidate[0]) / (candidate.length - 1);
      systems.push({
        lines: candidate,
        gap: g,
        top: candidate[0] - g * 0.7,
        bottom: candidate[candidate.length - 1] + g * 0.95,
        left: 0,
        right: 0,
      });
      i += candidate.length;
    } else {
      i++;
    }
  }
  return systems;
}

/** 谱表左右边界（去掉 TAB 谱号） */
export function measureSpan(bin: BinaryImage, system: SystemBox): void {
  const { width, data } = bin;
  const top = Math.max(0, Math.floor(system.top));
  const bottom = Math.min(bin.height - 1, Math.ceil(system.bottom));
  let firstInk = width;
  let lastInk = 0;
  for (let y = top; y <= bottom; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) {
      if (data[base + x]) {
        if (x < firstInk) firstInk = x;
        if (x > lastInk) lastInk = x;
      }
    }
  }
  system.left = firstInk === width ? 0 : firstInk;
  system.right = lastInk || width - 1;
}

/* ------------------------------------------------------------------ */
/* 谱线与符干擦除                                                      */
/* ------------------------------------------------------------------ */

/**
 * 擦除弦线：只删「很长的水平 run」，跨线的数字笔画（短 run）保留，
 * 避免把数字切成上下两半。
 */
export function stripStaffLines(bin: BinaryImage, lineYs: number[]): BinaryImage {
  const { width, height } = bin;
  const data = new Uint8Array(bin.data);
  const minRun = Math.max(14, Math.floor(width * 0.045));
  for (const ly of lineYs) {
    for (let dy = -2; dy <= 2; dy++) {
      const y = ly + dy;
      if (y < 0 || y >= height) continue;
      const base = y * width;
      let x = 0;
      while (x < width) {
        if (!data[base + x]) {
          x++;
          continue;
        }
        let end = x;
        while (end < width && data[base + end]) end++;
        if (end - x >= minRun) for (let k = x; k < end; k++) data[base + k] = 0;
        x = end;
      }
    }
  }
  return { width, height, data };
}

/** 擦除节奏符干：细长竖直 run，会把同一列多个音粘成超长连通域 */
export function stripVerticalStems(bin: BinaryImage, systems: SystemBox[]): BinaryImage {
  const { width, height } = bin;
  const data = new Uint8Array(bin.data);
  for (const sys of systems) {
    const y0 = Math.max(0, Math.floor(sys.top - sys.gap));
    const y1 = Math.min(height - 1, Math.ceil(sys.bottom + sys.gap));
    const maxRun = Math.floor(sys.gap * 1.6);
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
          let neighbourInk = 0;
          for (let yy = y; yy < end; yy++) {
            if (x > 0 && data[yy * width + x - 1]) neighbourInk++;
            if (x < width - 1 && data[yy * width + x + 1]) neighbourInk++;
          }
          if (neighbourInk < len * 0.6) for (let yy = y; yy < end; yy++) data[yy * width + x] = 0;
        }
        y = end;
      }
    }
  }
  return { width, height, data };
}

/* ------------------------------------------------------------------ */
/* 连通域                                                              */
/* ------------------------------------------------------------------ */

interface Component {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** 绝对像素索引（y * width + x） */
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
        for (const [nx, ny] of [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ]) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (seen[ni] || !data[(box.y0 + ny) * width + (box.x0 + nx)]) continue;
          seen[ni] = 1;
          stack.push(ni);
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

/** 弦线会把跨线数字切成两半，这里把 x 重叠、竖直相邻的碎片合并 */
function mergeFragments(comps: Component[], gap: number): Component[] {
  const items = comps.map((c) => ({ ...c }));
  const merged: Component[] = [];
  const used = new Set<number>();
  items.sort((a, b) => a.minY - b.minY || a.minX - b.minX);
  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    let cur = { ...items[i] };
    used.add(i);
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < items.length; j++) {
        if (used.has(j)) continue;
        const o = items[j];
        const overlap = Math.min(cur.maxX, o.maxX) - Math.max(cur.minX, o.minX);
        const minW = Math.min(cur.maxX - cur.minX, o.maxX - o.minX) + 1;
        const vGap = Math.max(cur.minY, o.minY) - Math.min(cur.maxY, o.maxY);
        const heightIfMerged = Math.max(cur.maxY, o.maxY) - Math.min(cur.minY, o.minY) + 1;
        if (overlap >= minW * 0.45 && vGap <= gap * 0.85 && heightIfMerged <= gap * 1.45) {
          cur = {
            minX: Math.min(cur.minX, o.minX),
            minY: Math.min(cur.minY, o.minY),
            maxX: Math.max(cur.maxX, o.maxX),
            maxY: Math.max(cur.maxY, o.maxY),
            pixels: cur.pixels.concat(o.pixels),
            area: cur.area + o.area,
          };
          used.add(j);
          changed = true;
        }
      }
    }
    merged.push(cur);
  }
  return merged;
}

/* ------------------------------------------------------------------ */
/* 字形归一化与模板                                                    */
/* ------------------------------------------------------------------ */

const TW = 10;
const TH = 14;

const RAW_TEMPLATES: Record<string, string[]> = {
  '0': ['  ####  ', ' ##  ## ', '##    ##', '##    ##', '##    ##', '##    ##', '##    ##', '##    ##', '##    ##', ' ##  ## ', '  ####  ', '        '],
  '1': ['   ##   ', '  ###   ', ' ####   ', '   ##   ', '   ##   ', '   ##   ', '   ##   ', '   ##   ', '   ##   ', '   ##   ', ' ###### ', '        '],
  '2': [' #####  ', '##   ## ', '     ## ', '    ##  ', '   ##   ', '  ##    ', ' ##     ', '##      ', '##      ', '##      ', '####### ', '        '],
  '3': [' #####  ', '##   ## ', '     ## ', '    ##  ', '  ###   ', '    ##  ', '     ## ', '     ## ', '##   ## ', '##   ## ', ' #####  ', '        '],
  '4': ['    ##  ', '   ###  ', '  ####  ', ' ## ##  ', '##  ##  ', '##  ##  ', '####### ', '    ##  ', '    ##  ', '    ##  ', '    ##  ', '        '],
  '5': ['######  ', '##      ', '##      ', '#####   ', '    ##  ', '     ## ', '     ## ', '     ## ', '##   ## ', '##   ## ', ' #####  ', '        '],
  '6': ['  ###   ', ' ##     ', '##      ', '##      ', '#####   ', '##  ##  ', '##   ## ', '##   ## ', '##   ## ', ' ## ##  ', '  ###   ', '        '],
  '7': ['####### ', '##   ## ', '     ## ', '     ## ', '    ##  ', '    ##  ', '   ##   ', '   ##   ', '  ##    ', '  ##    ', '  ##    ', '        '],
  '8': ['  ###   ', ' ## ##  ', '##   ## ', '##   ## ', ' ## ##  ', '  ###   ', ' ## ##  ', '##   ## ', '##   ## ', ' ## ##  ', '  ###   ', '        '],
  '9': ['  ###   ', ' ## ##  ', '##   ## ', '##   ## ', '##   ## ', ' ## ### ', '   ###  ', '     ## ', '     ## ', '    ##  ', ' ####   ', '        '],
  x: ['        ', '        ', '##   ## ', ' ## ##  ', '  ###   ', '  ###   ', ' ## ##  ', '##   ## ', '        ', '        ', '        ', '        '],
};

/** 把 8×12 模板放大居中到 10×14 画布 */
function buildTemplates(): Map<string, Float32Array> {
  const map = new Map<string, Float32Array>();
  for (const [label, rows] of Object.entries(RAW_TEMPLATES)) {
    const vec = new Float32Array(TW * TH);
    const ox = 1;
    const oy = 1;
    for (let y = 0; y < rows.length && y + oy < TH; y++) {
      const row = rows[y];
      for (let x = 0; x < row.length && x + ox < TW; x++) {
        if (row[x] === '#') vec[(y + oy) * TW + (x + ox)] = 1;
      }
    }
    map.set(label, vec);
  }
  return map;
}

const TEMPLATES = buildTemplates();

/** 保持长宽比、居中填充到 10×14，记录每格墨迹占比 */
function normalizeGlyph(bin: BinaryImage, c: Component): Float32Array {
  const w = c.maxX - c.minX + 1;
  const h = c.maxY - c.minY + 1;
  const out = new Float32Array(TW * TH);
  const ink = new Set<number>(c.pixels);
  const scale = Math.min((TW - 2) / w, (TH - 2) / h);
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const ox = Math.floor((TW - nw) / 2);
  const oy = Math.floor((TH - nh) / 2);
  for (let ty = 0; ty < nh; ty++) {
    const sy0 = c.minY + Math.floor((ty * h) / nh);
    const sy1 = c.minY + Math.max(Math.floor(((ty + 1) * h) / nh), sy0 - c.minY + 1);
    for (let tx = 0; tx < nw; tx++) {
      const sx0 = c.minX + Math.floor((tx * w) / nw);
      const sx1 = c.minX + Math.max(Math.floor(((tx + 1) * w) / nw), sx0 - c.minX + 1);
      let hit = 0;
      let total = 0;
      for (let y = sy0; y < Math.min(sy1, c.maxY + 1); y++) {
        for (let x = sx0; x < Math.min(sx1, c.maxX + 1); x++) {
          total++;
          if (ink.has(y * bin.width + x)) hit++;
        }
      }
      out[(oy + ty) * TW + (ox + tx)] = total ? hit / total : 0;
    }
  }
  return out;
}

function similarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function classify(vec: Float32Array): { label: string; score: number } {
  let bestLabel = '?';
  let best = -1;
  TEMPLATES.forEach((tpl, label) => {
    const s = similarity(vec, tpl);
    if (s > best) {
      best = s;
      bestLabel = label;
    }
  });
  return { label: bestLabel, score: best };
}

/**
 * 同一页字体一致：先 k-means 聚类，再用模板给「类中心」贴标签，
 * 个别字形误判不会破坏整体一致性。
 */
function clusterAndLabel(vectors: Float32Array[], k = 12): Array<{ label: string; score: number }> {
  const n = vectors.length;
  if (!n) return [];
  const dim = TW * TH;
  const kk = Math.min(k, n);
  const centroids: Float32Array[] = [];
  for (let i = 0; i < kk; i++) centroids.push(Float32Array.from(vectors[Math.floor((i * n) / kk)]));
  const assign = new Int32Array(n).fill(-1);

  for (let iter = 0; iter < 12; iter++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestSim = -Infinity;
      for (let c = 0; c < kk; c++) {
        const sim = similarity(vectors[i], centroids[c]);
        if (sim > bestSim) {
          bestSim = sim;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        moved++;
      }
    }
    const sums = Array.from({ length: kk }, () => new Float32Array(dim));
    const counts = new Int32Array(kk);
    for (let i = 0; i < n; i++) {
      const c = assign[i];
      counts[c]++;
      for (let d = 0; d < dim; d++) sums[c][d] += vectors[i][d];
    }
    for (let c = 0; c < kk; c++) {
      if (!counts[c]) continue;
      for (let d = 0; d < dim; d++) centroids[c][d] = sums[c][d] / counts[c];
    }
    if (!moved) break;
  }

  const labels = centroids.map((cent) => classify(cent));
  return Array.from({ length: n }, (_, i) => labels[assign[i]]);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

export function recognizeTablature(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): OmrResult {
  const warnings: string[] = [];
  const gray = rgbaToGray(rgba, width, height);
  const bin: BinaryImage = { width, height, data: binarize(gray, width, height) };

  const lineYs = findHorizontalLines(bin);
  if (lineYs.length < 6) {
    return {
      ascii: '',
      systems: 0,
      glyphs: 0,
      confidence: 0,
      warnings: ['没有检测到六线谱（可能是五线谱、和弦图，或扫描太淡）'],
    };
  }

  const systems = groupSystems(lineYs, 6);
  if (!systems.length) {
    return { ascii: '', systems: 0, glyphs: 0, confidence: 0, warnings: ['检测到横线，但没能分出六线谱表'] };
  }

  const lineOnly = stripStaffLines(bin, lineYs);
  const stripped = stripVerticalStems(lineOnly, systems);

  interface Candidate {
    x: number;
    y: number;
    w: number;
    h: number;
    stringIndex: number;
    vec: Float32Array;
  }
  const candidates: Candidate[] = [];

  for (const sys of systems) {
    measureSpan(bin, sys);
    const g = sys.gap;
    const box = {
      x0: Math.max(0, Math.floor(sys.left + g * 0.6)),
      y0: Math.max(0, Math.floor(sys.top)),
      x1: Math.min(width - 1, Math.ceil(sys.right)),
      y1: Math.min(height - 1, Math.ceil(sys.bottom)),
    };
    const comps = mergeFragments(components(stripped, box), g);

    for (const c of comps) {
      const w = c.maxX - c.minX + 1;
      const h = c.maxY - c.minY + 1;
      if (h < g * 0.55 || h > g * 1.1) continue;
      if (w < g * 0.22 || w > g * 1.2) continue;
      if (c.area < Math.max(24, g * g * 0.1)) continue;
      if (w > h * 2.2) continue;

      const cy = (c.minY + c.maxY) / 2;
      let stringIndex = -1;
      let bestDist = Infinity;
      sys.lines.forEach((ly, idx) => {
        const d = Math.abs(ly - cy);
        if (d < bestDist) {
          bestDist = d;
          stringIndex = idx;
        }
      });
      if (stringIndex < 0 || bestDist > g * 0.55) continue;

      candidates.push({
        x: Math.round((c.minX + c.maxX) / 2),
        y: Math.round(cy),
        w,
        h,
        stringIndex,
        vec: normalizeGlyph(stripped, c),
      });
    }
  }

  if (!candidates.length) {
    return { ascii: '', systems: systems.length, glyphs: 0, confidence: 0, warnings: ['识别到谱表但没读出品位数字'] };
  }

  const labels = clusterAndLabel(candidates.map((c) => c.vec), 12);
  const glyphs: Glyph[] = candidates.map((c, i) => ({
    x: c.x,
    y: c.y,
    w: c.w,
    h: c.h,
    stringIndex: c.stringIndex,
    label: labels[i]?.label ?? '?',
    score: labels[i]?.score ?? 0,
  }));

  const confidence = glyphs.reduce((a, g2) => a + g2.score, 0) / glyphs.length;
  return { ascii: glyphsToAscii(glyphs, systems), systems: systems.length, glyphs: glyphs.length, confidence, warnings };
}

/** 把数字按 x 坐标铺到字符网格，输出 6 行 ASCII 六线谱 */
export function glyphsToAscii(glyphs: Glyph[], systems: SystemBox[]): string {
  const order = ['e', 'B', 'G', 'D', 'A', 'E'];
  const out: string[] = [];

  for (const sys of systems) {
    const inSys = glyphs.filter((gl) => gl.y >= sys.top && gl.y <= sys.bottom);
    if (!inSys.length) continue;

    const left = Math.min(sys.left, ...inSys.map((g) => g.x));
    const right = Math.max(sys.right, ...inSys.map((g) => g.x));
    const cell = Math.max(2, Math.round(sys.gap * 0.55));
    const cols = Math.max(8, Math.ceil((right - left) / cell) + 1);
    const rows: string[][] = Array.from({ length: 6 }, () => Array.from({ length: cols }, () => '-'));

    for (const gl of inSys) {
      const col = Math.max(0, Math.min(cols - 1, Math.round((gl.x - left) / cell)));
      rows[gl.stringIndex][col] = gl.label;
    }

    for (let r = 0; r < 6; r++) {
      const body = rows[r].join('');
      const chunks: string[] = [];
      for (let i = 0; i < body.length; i += 8) chunks.push(body.slice(i, i + 8));
      out.push(`${order[r]}|${chunks.join('|')}|`);
    }
    out.push('');
  }

  return out.join('\n');
}