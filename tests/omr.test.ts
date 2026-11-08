import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import {
  binarize,
  detectChordDiagrams,
  findHorizontalLines,
  groupSystems,
  measureSpan,
  recognizeTablature,
  rgbaToGray,
} from '../src/import/omr/omr';
import { parseAsciiTab } from '../src/import/asciiTab';

function load(path: string) {
  const png = PNG.sync.read(readFileSync(path));
  return { rgba: new Uint8Array(png.data), width: png.width, height: png.height };
}

describe('六线谱图片高精度识别与转换（真实扫描/图片样本）', () => {
  const sample1 = 'tmpimg/sample1.png';
  const sample2 = 'tmpimg/sample2.png';

  it('能检测出成组的六条弦线、小节竖线与上方和弦指法图', () => {
    const { rgba, width, height } = load(sample1);
    const gray = rgbaToGray(rgba, width, height);
    const bin = { width, height, data: binarize(gray, width, height) };
    const lines = findHorizontalLines(bin);
    const systems = groupSystems(lines, 6);
    expect(lines.length).toBeGreaterThan(20);
    expect(systems.length).toBe(6);

    for (const s of systems) {
      expect(s.lines.length).toBe(6);
      const gaps = s.lines.slice(1).map((y, i) => y - s.lines[i]);
      const spread = Math.max(...gaps) - Math.min(...gaps);
      expect(spread).toBeLessThan(6);
      measureSpan(bin, s);
      expect((s.bars ?? []).length).toBeGreaterThanOrEqual(6);
    }

    const chords0 = detectChordDiagrams(bin, systems[0]);
    expect(chords0.map((c) => c.name)).toEqual(['G', 'Em', 'Am', 'Am', 'Am', 'D']);
  });

  it('精准识别 sample1 (500 miles) 与 sample2 (Amani) 并转换为可滚动 alphaTex 曲谱', () => {
    const img1 = load(sample1);
    const res1 = recognizeTablature(img1.rgba, img1.width, img1.height, { title: '500 miles' });
    expect(res1.systems).toBe(6);
    expect(res1.measures).toBeGreaterThanOrEqual(35);
    expect(res1.glyphs).toBeGreaterThan(400);
    expect(res1.confidence).toBeGreaterThan(0.9);
    expect(res1.alphaTex).toContain('\\title "500 miles"');

    const parsed1 = parseAsciiTab(res1.ascii, '500 miles');
    expect(parsed1).not.toBeNull();
    expect(parsed1!.noteCount).toBeGreaterThan(400);

    const img2 = load(sample2);
    const res2 = recognizeTablature(img2.rgba, img2.width, img2.height, { title: 'Amani' });
    expect(res2.systems).toBe(5);
    expect(res2.measures).toBeGreaterThanOrEqual(16);
    expect(res2.glyphs).toBeGreaterThan(160);
    expect(res2.confidence).toBeGreaterThan(0.9);
    expect(res2.chords.slice(0, 4)).toEqual(['C', 'G', 'F', 'C']);
  });
});