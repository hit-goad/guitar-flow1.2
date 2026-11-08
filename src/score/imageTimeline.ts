import type { Timeline } from './timeline';

/** 图片谱：把「页」当成拍，用同一套播放器/滚动逻辑驱动翻页 */
export function buildImageTimeline(pageCount: number, secondsPerPage = 20): Timeline {
  const ticksPerPage = 960 * 4; // 4 分音符 * 4 = 一小节
  const beats = Array.from({ length: Math.max(1, pageCount) }, (_, i) => ({
    index: i,
    tick: i * ticksPerPage,
    durationTicks: ticksPerPage,
    endTick: (i + 1) * ticksPerPage,
    isRest: false,
    notes: [],
    barIndex: i,
    // 图片模式没有 alphaTab Beat 对象
    beat: null as never,
    label: `第 ${i + 1} 页`,
  }));
  return {
    title: '',
    artist: '',
    beats,
    notes: [],
    totalTicks: beats.length * ticksPerPage,
    tempos: [{ tick: 0, bpm: 60 }],
    tuning: [],
    tempo: 60,
    trackName: '',
    beatSecs: beats.map((_, i) => (i * ticksPerPage * 60) / 960 / 60 * 4),
    totalSec: (beats.length * ticksPerPage * 60) / 960 / 60 * 4,
  };
}

/** 让 pageStarts（秒）覆盖默认等长分页 */
export function applyPageStarts(timeline: Timeline, pageStarts: number[] | undefined): Timeline {
  if (!pageStarts?.length) return timeline;
  const beats = timeline.beats.map((b, i) => ({
    ...b,
    tick: Math.round(pageStarts[i] * 960 * 60 / 60),
    durationTicks: 960,
    endTick: Math.round(pageStarts[i] * 960) + 960,
  }));
  const totalTicks = Math.max(...beats.map((b) => b.endTick), 1);
  return {
    ...timeline,
    beats,
    totalTicks,
    beatSecs: beats.map((b) => b.tick / 960),
    totalSec: totalTicks / 960,
  };
}