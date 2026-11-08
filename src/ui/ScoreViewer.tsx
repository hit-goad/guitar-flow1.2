import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as alphaTab from '@coderline/alphatab';
import type { ScoreDoc } from '../core/types';
import { buildTimeline, type Timeline } from '../score/timeline';

type ApiSettings = ConstructorParameters<typeof alphaTab.AlphaTabApi>[1];

export interface ScoreViewerHandle {
  scrollToBeat(index: number, smooth?: boolean): void;
  refreshLayout(): void;
}

interface Props {
  doc: ScoreDoc;
  currentBeat: number;
  autoScroll: boolean;
  onTimeline(timeline: Timeline): void;
  onSeekBeat(index: number): void;
  onError(message: string): void;
  onPreviewBeat?(index: number): void;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const SCROLL_ANCHOR = 0.34;

/**
 * alphaTab 渲染宿主 + 自绘光标。
 * alphaTab 1.9 用 SVG surface 渲染，并按页生成多个 .at-surface；
 * bounds 是页面内坐标，所以每个 beat 记录「surface 索引 + 局部坐标」，
 * 光标用「surface 在滚动内容里的偏移 + 局部坐标」定位。
 */
export const ScoreViewer = forwardRef<ScoreViewerHandle, Props>(function ScoreViewer(
  { doc, currentBeat, autoScroll, onTimeline, onSeekBeat, onError, onPreviewBeat },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<alphaTab.AlphaTabApi | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const rectsRef = useRef<Map<number, Rect>>(new Map());
  const beatRefsRef = useRef<alphaTab.model.Beat[]>([]);
  const lastScrollBeat = useRef(-1);
  const currentBeatRef = useRef(currentBeat);
  currentBeatRef.current = currentBeat;
  const cbRef = useRef({ onTimeline, onSeekBeat, onError, onPreviewBeat });
  cbRef.current = { onTimeline, onSeekBeat, onError, onPreviewBeat };
  const [renderEpoch, setRenderEpoch] = useState(0);

  const scrollToBeat = (index: number, smooth = true) => {
    const host = hostRef.current;
    if (!host) return;
    const rect = rectsRef.current.get(index);
    const viewport = findViewport(host);
    if (!rect || !viewport) return;
    const target = Math.max(0, rect.y - viewport.clientHeight * SCROLL_ANCHOR + rect.h / 2);
    viewport.scrollTo({ top: target, behavior: smooth ? 'smooth' : 'auto' });
  };

  useImperativeHandle(ref, () => ({
    scrollToBeat,
    refreshLayout: () => scheduleRectRefresh(),
  }));

  useEffect(() => {
    const host = hostRef.current;
    if (!host || doc.format === 'image') return;

    const settings = {
      core: {
        fontDirectory: new URL('./font/', document.baseURI).href,
        logLevel: 'warning',
      },
      display: {
        scale: host.clientWidth < 720 ? 0.85 : 1.0,
        layoutMode: 'page',
        staveProfile: 'scoretab',
        barsPerRow: -1,
        padding: [14, 14, 14, 14],
      },
      player: { enablePlayer: false },
    } as unknown as ApiSettings;

    const api = new alphaTab.AlphaTabApi(host, settings);
    apiRef.current = api;

    api.error.on((err) => {
      console.error('[alphaTab]', err);
      cbRef.current.onError(err?.message ?? String(err));
    });

    api.scoreLoaded.on((score) => {
      try {
        const timeline = buildTimeline(score);
        beatRefsRef.current = timeline.beats.map((b) => b.beat);
        cbRef.current.onTimeline(timeline);
      } catch (err) {
        cbRef.current.onError(`解析时间轴失败：${(err as Error).message}`);
      }
      scheduleRectRefresh();
    });

    try {
      if (doc.format === 'gp' || doc.format === 'musicxml') {
        if (!doc.bytes) throw new Error('缺少二进制谱面数据');
        api.load(new Uint8Array(doc.bytes));
      } else if (doc.format === 'alphatex') {
        if (!doc.text) throw new Error('缺少 alphaTex 文本');
        api.tex(doc.text);
      } else {
        throw new Error(`当前渲染器不支持格式 ${doc.format}`);
      }
    } catch (err) {
      cbRef.current.onError((err as Error).message);
    }

    const ro = new ResizeObserver(() => scheduleRectRefresh(6, 160));
    ro.observe(host);

    const onPointerDown = (ev: PointerEvent) => {
      const hit = hitTest(ev.clientX, ev.clientY);
      if (hit !== null) {
        cbRef.current.onSeekBeat(hit);
        cbRef.current.onPreviewBeat?.(hit);
      }
    };
    host.addEventListener('pointerdown', onPointerDown);

    return () => {
      host.removeEventListener('pointerdown', onPointerDown);
      ro.disconnect();
      try {
        api.destroy();
      } catch {
        /* ignore */
      }
      apiRef.current = null;
      rectsRef.current.clear();
      overlayRef.current?.remove();
      overlayRef.current = null;
      cursorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id]);

  /** 渲染完成事件在不同版本/布局下不一致，用有限次轮询兜底 */
  function scheduleRectRefresh(tries = 24, delay = 120) {
    let n = 0;
    const tick = () => {
      if (!apiRef.current || !hostRef.current) return;
      const ok = rebuildRects();
      setRenderEpoch((e) => e + 1);
      if (ok || ++n >= tries) return;
      window.setTimeout(tick, delay);
    };
    window.setTimeout(tick, delay);
  }

  function viewportEl(): HTMLElement | null {
    const host = hostRef.current;
    return host ? findViewport(host) : null;
  }

  function surfaceOrigin(surface: HTMLElement, viewport: HTMLElement): { x: number; y: number } {
    const sr = surface.getBoundingClientRect();
    const vr = viewport.getBoundingClientRect();
    return {
      x: Math.round(sr.left - vr.left + viewport.scrollLeft),
      y: Math.round(sr.top - vr.top + viewport.scrollTop),
    };
  }

  function rebuildRects(): boolean {
    const api = apiRef.current;
    const host = hostRef.current;
    const viewport = viewportEl();
    if (!api || !host || !viewport) return false;
    const lookup = api.boundsLookup;
    if (!lookup) return false;
    const surfaces = Array.from(host.querySelectorAll<HTMLElement>('.at-surface'));
    if (!surfaces.length) return false;

    const origins = surfaces.map((s) => ({ el: s, ...surfaceOrigin(s, viewport) }));
    const map = new Map<number, Rect>();
    const perSurface = new Array(surfaces.length).fill(0);

    const surfaceIndexOf = (b: { y: number; h: number }) => {
      for (let i = 0; i < surfaces.length; i++) {
        const h = surfaces[i].offsetHeight;
        if (b.y >= -2 && b.y + b.h <= h + 4) return i;
      }
      return 0;
    };

    beatRefsRef.current.forEach((beat, index) => {
      let bb: alphaTab.rendering.BeatBounds | null = null;
      try {
        bb = lookup.findBeat(beat);
      } catch {
        bb = null;
      }
      if (!bb) return;
      const b = bb.visualBounds;
      const si = surfaceIndexOf(b);
      const o = origins[si];
      perSurface[si]++;
      map.set(index, { x: o.x + b.x, y: o.y + b.y, w: Math.max(6, b.w), h: Math.max(10, b.h) });
    });

    rectsRef.current = map;
    ensureCursor();
    drawCursor(currentBeatRef.current);
    return map.size > 0;
  }

  function ensureCursor() {
    const viewport = viewportEl();
    if (!viewport) return;
    if (getComputedStyle(viewport).position === 'static') viewport.style.position = 'relative';
    if (!overlayRef.current || !overlayRef.current.isConnected) {
      const overlay = document.createElement('div');
      overlay.className = 'gf-overlay';
      overlay.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:0;pointer-events:none;z-index:6;';
      const cursor = document.createElement('div');
      cursor.className = 'gf-cursor';
      cursor.style.cssText =
        'position:absolute;pointer-events:none;border:2px solid rgba(226,132,32,.95);border-radius:4px;background:rgba(255,196,64,.16);box-shadow:0 0 14px rgba(255,196,64,.35);opacity:0;transition:left .09s linear,top .09s linear,width .12s,height .12s,opacity .2s;';
      overlay.appendChild(cursor);
      viewport.appendChild(overlay);
      overlayRef.current = overlay;
      cursorRef.current = cursor;
    }
    overlayRef.current.style.height = `${viewport.scrollHeight}px`;
  }

  function drawCursor(index: number) {
    const cursor = cursorRef.current;
    const rect = rectsRef.current.get(index);
    if (!cursor) return;
    if (!rect) {
      cursor.style.opacity = '0';
      return;
    }
    const viewport = viewportEl();
    if (overlayRef.current && viewport) overlayRef.current.style.height = `${viewport.scrollHeight}px`;
    cursor.style.opacity = '1';
    cursor.style.left = `${Math.round(rect.x - 3)}px`;
    cursor.style.top = `${Math.round(rect.y - 3)}px`;
    cursor.style.width = `${Math.round(rect.w + 6)}px`;
    cursor.style.height = `${Math.round(rect.h + 6)}px`;
  }

  function hitTest(clientX: number, clientY: number): number | null {
    const viewport = viewportEl();
    if (!viewport) return null;
    const vr = viewport.getBoundingClientRect();
    const x = clientX - vr.left + viewport.scrollLeft;
    const y = clientY - vr.top + viewport.scrollTop;
    let best: { index: number; dist: number } | null = null;
    rectsRef.current.forEach((r, index) => {
      const inside = x >= r.x - 6 && x <= r.x + r.w + 6 && y >= r.y - 10 && y <= r.y + r.h + 10;
      const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
      const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
      const dist = inside ? 0 : Math.hypot(dx, dy);
      if (!best || dist < best.dist) best = { index, dist };
    });
    if (!best) return null;
    return (best as { index: number; dist: number }).index;
  }

  useEffect(() => {
    drawCursor(currentBeat);
    if (!autoScroll) return;
    if (currentBeat === lastScrollBeat.current) return;
    lastScrollBeat.current = currentBeat;
    scrollToBeat(currentBeat, true);
  }, [currentBeat, autoScroll, renderEpoch]);

  return (
    <div className="score-stage">
      <div ref={hostRef} className="score-host" />
    </div>
  );
});

function findViewport(host: HTMLElement): HTMLElement | null {
  const surfaces = host.querySelectorAll<HTMLElement>('.at-surface');
  let el: HTMLElement | null = surfaces.length ? surfaces[0].parentElement : host;
  while (el && el !== host.parentElement) {
    const style = getComputedStyle(el);
    if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 4) return el;
    el = el.parentElement;
  }
  el = surfaces.length ? surfaces[0].parentElement : host;
  while (el && el !== host.parentElement) {
    const style = getComputedStyle(el);
    if (/(auto|scroll|hidden)/.test(style.overflowY)) return el;
    el = el.parentElement;
  }
  return host;
}