import { describe, expect, it } from 'vitest';
import { looksLikeAsciiTab, parseAsciiTab } from '../src/import/asciiTab';
import { looksLikeChordPro, parseChordPro } from '../src/import/chordpro';
import { chordMidi, parseChord, voicingToMidi, chordVoicing } from '../src/import/chords';
import { normalize, searchScores } from '../src/core/fuzzy';
import type { ScoreDoc } from '../src/core/types';

const ASCII = `Song: Test Riff
Artist: GF
e|--0---3---5---3---0-------|
B|--1---3---5---3---1-------|
G|--0---2---4---2---0-------|
D|--2---0---2---0---2-------|
A|--3-------3-------3-------|
E|--------------------------|`;

const CHORDPRO = `{title: Test Ballad}
{artist: GF}
{tempo: 88}
{capo: 2}
[Am]This is a [F]test of the [C]chord parser
[G]Second line [Am]keeps going`;

describe('ASCII 六线谱', () => {
  it('能识别六线谱文本', () => {
    expect(looksLikeAsciiTab(ASCII)).toBe(true);
    expect(looksLikeAsciiTab('随便一段普通文字\n没有谱')).toBe(false);
  });

  it('能解析出音符与小节', () => {
    const res = parseAsciiTab(ASCII, 'fallback');
    expect(res).not.toBeNull();
    expect(res!.noteCount).toBeGreaterThanOrEqual(8);
    expect(res!.measures).toBeGreaterThanOrEqual(1);
    expect(res!.alphaTex).toContain('\\tuning');
    expect(res!.alphaTex).toMatch(/[0-9]\.[1-6]/);
  });

  it('解析标题与艺人', () => {
    const res = parseAsciiTab(ASCII, 'fallback');
    expect(res!.title).toBe('Test Riff');
    expect(res!.artist).toBe('GF');
  });

  it('和弦列会合成同一个 beat', () => {
    const chordTab = `e|--0---|
B|--1---|
G|--2---|
D|--2---|
A|--0---|
E|------|`;
    const res = parseAsciiTab(chordTab, 'x');
    expect(res).not.toBeNull();
    // 同一列的音应合并成一个和弦 beat，例如 (0.1 0.3 1.2 2.4 3.5)
    expect(res!.alphaTex).toMatch(/\(\d+\.\d+ \d+\.\d+/);
    expect(res!.noteCount).toBe(5);
  });
});

describe('ChordPro', () => {
  it('识别 ChordPro', () => {
    expect(looksLikeChordPro(CHORDPRO)).toBe(true);
    expect(looksLikeChordPro('普通歌词\n没有和弦')).toBe(false);
  });

  it('解析元信息与和弦', () => {
    const res = parseChordPro(CHORDPRO)!;
    expect(res).not.toBeNull();
    expect(res.title).toBe('Test Ballad');
    expect(res.artist).toBe('GF');
    expect(res.tempo).toBe(88);
    expect(res.capo).toBe(2);
    expect(res.alphaTex).toContain('\\capo 2');
    expect(res.alphaTex).toMatch(/\d\.\d/);
  });
});

describe('和弦指法与音高', () => {
  it('解析和弦名', () => {
    expect(parseChord('C')!.pc).toBe(0);
    expect(parseChord('Am')!.quality).toBe('min');
    expect(parseChord('F#m7')!.pc).toBe(6);
    expect(parseChord('C/G')!.bassPc).toBe(7);
  });

  it('常见开放和弦音高正确', () => {
    // C 大三和弦：C3 E3 G3 C4 E4
    const c = chordMidi('C');
    expect(c).toEqual([48, 52, 55, 60, 64]);
    const am = chordMidi('Am');
    expect(am).toEqual([45, 52, 57, 60, 64]);
  });

  it('横按和弦根音正确', () => {
    const f = chordMidi('F');
    expect(Math.min(...f)).toBe(41); // F2
    const bb = chordMidi('Bb');
    expect(Math.min(...bb)).toBe(46); // Bb2
  });

  it('未知扩展名也能给出可弹指法', () => {
    const v = chordVoicing('E7sus4');
    expect(v).not.toBeNull();
    expect(voicingToMidi(v!).length).toBeGreaterThan(2);
  });
});

describe('模糊检索', () => {
  const docs: ScoreDoc[] = [
    { id: '1', title: 'Last Night on Earth', artist: 'Green Day', format: 'alphatex', meta: {}, sourceId: 'x', sourceName: 'x', createdAt: 0, updatedAt: 0 },
    { id: '2', title: '晴天', artist: '周杰伦', format: 'alphatex', meta: {}, sourceId: 'x', sourceName: 'x', createdAt: 0, updatedAt: 0 },
    { id: '3', title: 'Wonderwall', artist: 'Oasis', format: 'alphatex', meta: {}, sourceId: 'x', sourceName: 'x', createdAt: 0, updatedAt: 0 },
  ];

  it('归一化去掉噪声词', () => {
    expect(normalize('《晴天》吉他谱')).toBe('晴天');
    expect(normalize('Wonderwall  TAB')).toBe('wonderwall');
  });

  it('子串与拼写容错都能命中', () => {
    expect(searchScores(docs, '晴天')[0]?.id).toBe('2');
    expect(searchScores(docs, 'wonderwal')[0]?.id).toBe('3');
    expect(searchScores(docs, 'green day')[0]?.id).toBe('1');
  });

  it('不相关查询不会硬凑结果', () => {
    expect(searchScores(docs, 'zzzzz')).toHaveLength(0);
  });
});