import { describe, expect, it } from 'vitest';
import { FollowController } from '../src/score/follow';
import { beatIndexAtTick, secToTick, tickToSec, type Timeline, type BeatRef } from '../src/score/timeline';

function makeTimeline(midisPerBeat: number[]): Timeline {
  const beats: BeatRef[] = midisPerBeat.map((midi, i) => ({
    index: i,
    tick: i * 480,
    durationTicks: 480,
    endTick: (i + 1) * 480,
    isRest: midi < 0,
    notes: midi < 0 ? [] : [{ tick: i * 480, durationTicks: 480, midi, velocity: 0.8, beatIndex: i }],
    barIndex: Math.floor(i / 8),
    beat: null as never,
    label: '',
  }));
  const timeline: Timeline = {
    title: 't',
    artist: '',
    beats,
    notes: beats.flatMap((b) => b.notes),
    totalTicks: beats.length * 480,
    tempos: [{ tick: 0, bpm: 120 }],
    tuning: [40, 45, 50, 55, 59, 64],
    tempo: 120,
    trackName: 'guitar',
    beatSecs: [],
    totalSec: 0,
  };
  timeline.beatSecs = beats.map((b) => tickToSec(timeline, b.tick));
  timeline.totalSec = tickToSec(timeline, timeline.totalTicks);
  return timeline;
}

describe('时间轴换算', () => {
  const tl = makeTimeline([64, 66, 67, 69]);

  it('120BPM 下四分音符 = 0.5 秒（960 tick）', () => {
    expect(tickToSec(tl, 0)).toBeCloseTo(0, 3);
    expect(tickToSec(tl, 960)).toBeCloseTo(0.5, 3);
    expect(tickToSec(tl, 1920)).toBeCloseTo(1, 3);
  });

  it('秒 → tick 可逆', () => {
    expect(secToTick(tl, 1)).toBeCloseTo(1920, -2);
    expect(secToTick(tl, 2.5)).toBeCloseTo(4800, -2);
  });

  it('拍索引查找', () => {
    expect(beatIndexAtTick(tl, 0)).toBe(0);
    expect(beatIndexAtTick(tl, 500)).toBe(1);
    expect(beatIndexAtTick(tl, 9999)).toBe(3);
  });
});

describe('跟我弹对齐', () => {
  it('弹对当前音会推进并计命中', () => {
    const fc = new FollowController(makeTimeline([64, 66, 67, 69]));
    const advanced = fc.feed(64, 1000);
    expect(advanced).toBe(true);
    expect(fc.state.hits).toBe(1);
    expect(fc.currentBeat?.notes[0].midi).toBe(64);
  });

  it('跳过一段后弹后面的音也能接上', () => {
    const fc = new FollowController(makeTimeline([64, 66, 67, 69]));
    fc.feed(64, 1000);
    const advanced = fc.feed(69, 1600);
    expect(advanced).toBe(true);
    expect(fc.currentBeat?.notes[0].midi).toBe(69);
    expect(fc.state.misses).toBeGreaterThan(0);
  });

  it('相邻半音容错', () => {
    const fc = new FollowController(makeTimeline([64, 66, 67, 69]));
    // 65 与 64 相差 1 个半音，按「按弦不实」处理仍算命中
    expect(fc.feed(65, 1000)).toBe(true);
  });

  it('完全无关的音不推进', () => {
    const fc = new FollowController(makeTimeline([64, 66, 67, 69]));
    expect(fc.feed(40, 1000)).toBe(false);
    expect(fc.state.misses).toBe(1);
    expect(fc.state.beatIndex).toBe(0);
  });

  it('同一音短时间内重复上报会被忽略', () => {
    const fc = new FollowController(makeTimeline([64, 66, 67, 69]));
    fc.feed(64, 1000);
    expect(fc.feed(64, 1050)).toBe(false);
  });

  it('手动跳转后可继续跟随', () => {
    const fc = new FollowController(makeTimeline([64, 66, 67, 69]));
    fc.seek(2);
    expect(fc.state.beatIndex).toBe(2);
    expect(fc.feed(69, 2000)).toBe(true);
    expect(fc.currentBeat?.notes[0].midi).toBe(69);
  });
});