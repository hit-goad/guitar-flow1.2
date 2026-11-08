import { useEffect, useState } from 'react';
import type { SearchHit } from '../core/types';
import { clearSearchCache, loadHit, providerStatus, searchAll } from '../sources';
import { putScore } from '../core/library';
import {
  autoConvertOnlineImageScores,
  providerConfig,
  setAutoConvertOnlineImageScores,
  setProviderConfig,
} from '../sources/base';

interface Props {
  onSaved(docId: string): void;
  onNotify(message: string): void;
}

export function SearchPage({ onSaved, onNotify }: Props) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [errors, setErrors] = useState<Array<{ provider: string; message: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [providers, setProviders] = useState(providerStatus());
  const [ghRepo, setGhRepo] = useState(providerConfig.chordproGithub?.baseUrl ?? '');
  const [autoOmr, setAutoOmr] = useState(autoConvertOnlineImageScores);
  const [filterSource, setFilterSource] = useState<string>('all');
  const [showSources, setShowSources] = useState(false);

  useEffect(() => {
    setProviders(providerStatus());
  }, []);

  const run = async (q: string) => {
    if (!q.trim()) return;
    setBusy(true);
    setErrors([]);
    try {
      const out = await searchAll(q);
      setHits(out.hits);
      setErrors(out.errors);
    } catch (err) {
      onNotify(`搜索失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const importHit = async (hit: SearchHit) => {
    setLoadingId(`${hit.providerId}:${hit.id}`);
    try {
      const res = await loadHit(hit);
      await putScore(res.doc);
      onSaved(res.doc.id);
      onNotify(
        res.warnings.length
          ? `已导入《${res.doc.title}》：${res.warnings[0]}`
          : `已导入《${res.doc.title}》`,
      );
    } catch (err) {
      onNotify(`导入失败：${(err as Error).message}`);
    } finally {
      setLoadingId(null);
    }
  };

  const visibleHits = filterSource === 'all' ? hits : hits.filter((h) => h.providerId === filterSource);

  return (
    <div className="page search-page">
      <header className="page-head">
        <div>
          <h1>在线免费搜谱</h1>
          <p className="muted">
            已彻底移除付费谱源；聚合吉他屋(jita5)、吉他之家(798com)、17吉他网、虫虫吉他、吉他社、爱曲谱网、吉他网免费区与 Ultimate Guitar，导入时自动识别为可滚动曲谱
          </p>
        </div>
        <button className="btn ghost" onClick={() => setShowSources((v) => !v)}>
          免费谱源管理 ({providers.filter((p) => p.enabled).length}/{providers.length})
        </button>
      </header>

      <form
        className="search-row"
        onSubmit={(e) => {
          e.preventDefault();
          void run(query);
        }}
      >
        <input
          className="input big"
          placeholder="输入歌名或歌手搜索免费吉他谱，例如：晴天 / 成都 / Amani / 500 miles / Wonderwall"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? '搜索中…' : '全网免费搜谱'}
        </button>
      </form>

      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <label className="chip toggle on" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={autoOmr}
            onChange={(e) => {
              setAutoOmr(e.target.checked);
              setAutoConvertOnlineImageScores(e.target.checked);
            }}
          />
          导入图片谱时自动 OMR 识别并转换为可滚动六线谱
        </label>
        <button
          type="button"
          className={`btn tiny ${filterSource === 'all' ? 'primary' : 'ghost'}`}
          onClick={() => setFilterSource('all')}
        >
          全部来源 ({hits.length})
        </button>
        {providers
          .filter((p) => p.enabled)
          .map((p) => {
            const cnt = hits.filter((h) => h.providerId === p.id).length;
            return (
              <button
                key={p.id}
                type="button"
                className={`btn tiny ${filterSource === p.id ? 'primary' : 'ghost'}`}
                onClick={() => setFilterSource(p.id)}
              >
                {p.name.split(' ')[0]} {cnt ? `(${cnt})` : ''}
              </button>
            );
          })}
      </div>

      {showSources && (
        <div className="panel">
          <h3>免费谱源开关</h3>
          <div className="source-list">
            {providers.map((p) => (
              <label key={p.id} className="source-row">
                <input
                  type="checkbox"
                  checked={p.enabled}
                  onChange={(e) => {
                    setProviderConfig(p.id, { enabled: e.target.checked });
                    clearSearchCache();
                    setProviders(providerStatus());
                  }}
                />
                <div>
                  <b>{p.name}</b>
                  {p.note && <span className="muted small"> · {p.note}</span>}
                </div>
              </label>
            ))}
          </div>
          <div className="field-grid" style={{ marginTop: 12 }}>
            <label>
              <span>GitHub 开源曲谱库仓库（owner/repo，可选）</span>
              <input
                className="input"
                value={ghRepo}
                placeholder="例如 your-name/guitar-songbook"
                onChange={(e) => setGhRepo(e.target.value)}
                onBlur={() => {
                  setProviderConfig('chordproGithub', { baseUrl: ghRepo.trim() });
                  clearSearchCache();
                }}
              />
            </label>
          </div>
        </div>
      )}

      {!!errors.length && (
        <div className="warn-box">
          {errors.map((e) => (
            <div key={e.provider}>
              <b>{e.provider}</b>：{e.message}
            </div>
          ))}
        </div>
      )}

      <div className="result-list">
        {visibleHits.map((hit) => {
          const key = `${hit.providerId}:${hit.id}`;
          return (
            <div className="result-row" key={key}>
              <div className="result-main">
                <div className="result-title">
                  {hit.title}
                  <span className="tag subtle">免费</span>
                </div>
                <div className="muted small">
                  {hit.artist || '未知艺人'} · {hit.sourceName}
                  {hit.preview ? ` · ${hit.preview}` : ''}
                </div>
              </div>
              <div className="result-actions">
                {hit.url && (
                  <a className="btn tiny ghost" href={hit.url} target="_blank" rel="noreferrer">
                    原页
                  </a>
                )}
                <button className="btn tiny primary" onClick={() => void importHit(hit)} disabled={loadingId === key}>
                  {loadingId === key ? '识谱导入中…' : '导入并转可滚动谱'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {!busy && !visibleHits.length && query && (
        <p className="muted center">没有找到匹配结果，可尝试简化关键词（只填歌名）或切换谱源筛选</p>
      )}
    </div>
  );
}