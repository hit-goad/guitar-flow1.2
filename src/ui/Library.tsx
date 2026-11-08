import { useMemo, useState } from 'react';
import type { ScoreDoc } from '../core/types';
import { searchScores } from '../core/fuzzy';

interface Props {
  docs: ScoreDoc[];
  activeId: string | null;
  onOpen(id: string): void;
  onDelete(id: string): void;
  onToggleFavorite(id: string): void;
  onImport(): void;
  onSearch(): void;
}

const FORMAT_LABEL: Record<string, string> = {
  alphatex: '六线谱',
  gp: 'Guitar Pro',
  musicxml: 'MusicXML',
  midi: 'MIDI',
  ascii: '文本谱',
  chordpro: '和弦谱',
  image: '图片谱',
  pdf: 'PDF',
};

export function Library({ docs, activeId, onOpen, onDelete, onToggleFavorite, onImport, onSearch }: Props) {
  const [query, setQuery] = useState('');
  const [onlyFav, setOnlyFav] = useState(false);

  const filtered = useMemo(
    () => searchScores(docs, query, { filter: onlyFav ? (d) => !!d.favorite : undefined, limit: 200 }),
    [docs, query, onlyFav],
  );

  return (
    <div className="page library">
      <header className="page-head">
        <div>
          <h1>曲库</h1>
          <p className="muted">
            {docs.length} 份曲谱 · 支持 Guitar Pro / MusicXML / MIDI / 六线谱文本 / 和弦谱 / PDF / 图片
          </p>
        </div>
        <div className="head-actions">
          <button className="btn ghost" onClick={() => setOnlyFav((v) => !v)}>
            {onlyFav ? '★ 只看收藏' : '☆ 收藏'}
          </button>
          <button className="btn" onClick={onSearch}>
            在线搜谱
          </button>
          <button className="btn primary" onClick={onImport}>
            导入曲谱
          </button>
        </div>
      </header>

      <div className="search-row">
        <input
          className="input big"
          placeholder="搜索曲名、歌手、标签…（支持模糊匹配）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="btn tiny ghost" onClick={() => setQuery('')}>
            清除
          </button>
        )}
      </div>

      {!docs.length && (
        <div className="empty-state">
          <div className="empty-icon">🎸</div>
          <h2>还没有曲谱</h2>
          <p className="muted">导入本地文件、或从在线谱源搜索一首歌开始。</p>
          <div className="row">
            <button className="btn primary" onClick={onImport}>
              导入文件
            </button>
            <button className="btn" onClick={onSearch}>
              在线搜谱
            </button>
          </div>
        </div>
      )}

      <div className="score-grid">
        {filtered.map((doc) => (
          <article
            key={doc.id}
            className={`score-card ${activeId === doc.id ? 'active' : ''}`}
            onClick={() => onOpen(doc.id)}
          >
            <div className="card-top">
              <span className="tag">{FORMAT_LABEL[doc.format] ?? doc.format}</span>
              {doc.meta.bpm ? <span className="tag subtle">{Math.round(doc.meta.bpm)} BPM</span> : null}
              <span className="spacer" />
              <button
                className={`star ${doc.favorite ? 'on' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFavorite(doc.id);
                }}
                title="收藏"
              >
                ★
              </button>
            </div>
            <h3>{doc.title || '未命名'}</h3>
            <p className="artist">{doc.artist || '未知艺人'}</p>
            <div className="card-foot">
              <span className="source">{doc.sourceName}</span>
              <span className="spacer" />
              <button
                className="btn tiny ghost danger-text"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`删除《${doc.title}》？`)) onDelete(doc.id);
                }}
              >
                删除
              </button>
            </div>
          </article>
        ))}
      </div>

      {!!docs.length && !filtered.length && <p className="muted center">没有匹配「{query}」的曲谱</p>}
    </div>
  );
}