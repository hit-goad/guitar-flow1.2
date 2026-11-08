import { useEffect, useRef, useState } from 'react';
import type { ScoreDoc } from '../core/types';

interface Props {
  doc: ScoreDoc;
  pageIndex: number;
  autoScroll: boolean;
  onPageChange(index: number): void;
  /** 打点：把当前页的起始时间设为当前播放时间 */
  onTapPage?(index: number): void;
}

/**
 * 图片谱/扫描件阅读器：
 *  - 页面纵向排列，随播放进度滚动
 *  - 点击页面可跳到该页
 *  - 「打点」把当前播放时间绑定到该页，实现手动同步
 */
export function ImageScoreView({ doc, pageIndex, autoScroll, onPageChange }: Props) {
  const urls = usePageUrls(doc);
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    if (!autoScroll) return;
    const el = pageRefs.current[pageIndex];
    const container = containerRef.current;
    if (el && container) {
      const offset = el.offsetTop - container.clientHeight * 0.12;
      container.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
    }
  }, [pageIndex, autoScroll]);

  return (
    <div className="image-stage" ref={containerRef}>
      {urls.map((url, i) => (
        <div
          key={i}
          ref={(el) => {
            pageRefs.current[i] = el;
          }}
          className={`page-sheet ${i === pageIndex ? 'active' : ''}`}
          onClick={() => onPageChange(i)}
        >
          <img src={url} alt={`第 ${i + 1} 页`} draggable={false} />
          <div className="page-badge">{i + 1}</div>
        </div>
      ))}
      {!urls.length && <div className="empty-note">没有可显示的页面</div>}
    </div>
  );
}

function usePageUrls(doc: ScoreDoc): string[] {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const created = (doc.pages ?? []).map((b) => URL.createObjectURL(b));
    setUrls(created);
    return () => created.forEach((u) => URL.revokeObjectURL(u));
  }, [doc.id]);
  return urls;
}