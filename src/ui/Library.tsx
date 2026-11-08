import { useMemo, useState } from 'react';
import type { ScoreDoc } from '../core/types';
import { searchScores } from '../core/fuzzy';
import {
  docFromEntry,
  filesForEntry,
  localIndex,
  pickFolder,
  searchIndex,
  type LibraryEntry,
  type LocalFolder,
} from '../core/localFolder';

interface Props {
  docs: ScoreDoc[];
  activeId: string | null;
  onOpen(id: string): void;
  onDelete(id: string): void;
  onToggleFavorite(id: string): void;
  onImport(): void;
  onSearch(): void;
  /** 本机曲库条目打开后交回 App 落库并打开 */
  onOpenLocalDoc(doc: ScoreDoc): void;
  onNotify(message: string): void;
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

export function Library(props: Props) {
  const { docs, activeId, onOpen, onDelete, onToggleFavorite, onImport, onSearch, onOpenLocalDoc, onNotify } = props;
  const [query, setQuery] = useState('');
  const [onlyFav, setOnlyFav] = useState(false);
  const [folder, setFolder] = useState<LocalFolder | null>(null);
  const [localQuery, setLocalQuery] = useState('');
  const [loadingEntry, setLoadingEntry] = useState<string | null>(null);

  const filtered = useMemo(
    () => searchScores(docs, query, { filter: onlyFav ? (d) => !!d.favorite : undefined, limit: 200 }),
    [docs, query, onlyFav],
  );
  const localHits = useMemo(() => searchIndex(localQuery, 30), [localQuery]);

  const chooseFolder = async () => {
    const picked = await pickFolder();
    if (picked) {
      setFolder(picked);
      onNotify(`已选中文件夹「${picked.name}」，共 ${picked.files.size} 个文件`);
    }
  };

  const openLocal = async (entry: LibraryEntry) => {
    if (!folder) {
      onNotify('请先选择本机曲库文件夹');
      return;
    }
    const files = filesForEntry(folder, entry);
    if (!files.length) {
      onNotify(`文件夹里没有找到《${entry.title}》的页图，可能文件名已变化`);
      return;
    }
    setLoadingEntry(entry.id);
    try {
      const doc = await docFromEntry(entry, files);
      onOpenLocalDoc(doc);
    } finally {
      setLoadingEntry(null);
    }
  };

  return (
    <div className="page library">
      <header className="page-head">
        <div>
          <h1>曲库</h1>
          <p className="muted">
            {docs.length} 份曲谱 · 本机曲库索引 {localIndex.totalSongs} 首（{localIndex.totalFiles} 张谱图）
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

      <div className="panel local-library">
        <div className="local-head">
          <div>
            <h3>本机曲库 · {localIndex.totalSongs} 首</h3>
            <p className="muted small">
              {folder
                ? `已连接「${folder.name}」（${folder.files.size} 个文件）· 点歌名即可载入页图并打开`
                : '索引已内置；点「连接文件夹」选中存放谱图的目录，即可按需载入（不会整库复制，省空间）'}
            </p>
          </div>
          <button className="btn" onClick={() => void chooseFolder()}>
            {folder ? '重新选择文件夹' : '连接文件夹'}
          </button>
        </div>
        <input
          className="input"
          placeholder="在本机曲库里搜：例如 晴天 / canon / 指弹"
          value={localQuery}
          onChange={(e) => setLocalQuery(e.target.value)}
        />
        <div className="local-list">
          {localHits.map((entry) => (
            <button
              key={entry.id}
              className="local-item"
              onClick={() => void openLocal(entry)}
              disabled={loadingEntry === entry.id}
              title={entry.files.join(' / ')}
            >
              <span className="local-title">{entry.title}</span>
              <span className="muted small">
                {entry.artist ? `${entry.artist} · ` : ''}
                {entry.pages} 页
                {loadingEntry === entry.id ? ' · 载入中…' : ''}
              </span>
            </button>
          ))}
          {!localHits.length && <p className="muted small">没有匹配的曲目</p>}
        </div>
      </div>

      {!docs.length && (
        <div className="empty-state">
          <div className="empty-icon">🎸</div>
          <h2>还没有打开过曲谱</h2>
          <p className="muted">从本机曲库点一首、导入文件，或在线搜谱。</p>
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