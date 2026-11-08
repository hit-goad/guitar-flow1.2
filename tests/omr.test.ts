import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { binarize, findHorizontalLines, groupSystems, recognizeTablature, rgbaToGray } from '../src/import/omr/omr';
import { parseAsciiTab } from '../src/import/asciiTab';

function load(path: string) {
  const png = PNG.sync.read(readFileSync(path));
  return { rgba: new Uint8Array(png.data), width: png.width, height: png.height };
}

describe('六线谱图片识别（真实扫描样本）', () => {
  const sample = 'tmpimg/sample1.png';

  it('能检测出成组的六条弦线', () => {
    const { rgba, width, height } = load(sample);
    const gray = rgbaToGray(rgba, width, height);
    const bin = { width, height, data: binarize(gray, width, height) };
    const lines = findHorizontalLines(bin);
    const systems = groupSystems(lines, 6);
    expect(lines.length).toBeGreaterThan(20);
    expect(systems.length).toBeGreaterThanOrEqual(3);
    // 每行谱表 6 条线，间距一致
    for (const s of systems) {
      expect(s.lines.length).toBe(6);
      const gaps = s.lines.slice(1).map((y, i) => y - s.lines[i]);
      const spread = Math.max(...gaps) - Math.min(...gaps);
      expect(spread).toBeLessThan(6);
    }
  });

  it('识别出品位数字并还原成可解析的 ASCII 谱', () => {
    const { rgba, width, height } = load(sample);
    const res = recognizeTablature(rgba, width, height);
    console.log('systems', res.systems, 'glyphs', res.glyphs, 'conf', res.confidence.toFixed(3));
    console.log(res.ascii.split('\n').slice(0, 14).join('\n'));
    expect(res.systems).toBeGreaterThanOrEqual(3);
    expect(res.glyphs).toBeGreaterThan(80);
    expect(res.confidence).toBeGreaterThan(0.6);

    const parsed = parseAsciiTab(res.ascii);
    expect(parsed).not.toBeNull();
    expect(parsed!.noteCount).toBeGreaterThan(30);
  });
});