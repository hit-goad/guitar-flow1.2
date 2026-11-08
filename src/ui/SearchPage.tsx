import { useEffect, useState } from 'react';
import type { SearchHit } from '../core/types';
import { loadHit, providerStatus, searchAll } from '../sources';
import { putScore } from '../core/library';
import { setProviderConfig, providerConfig } from '../sources/base';

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
  const [gwCookie, setGwCookie] = useState(providerConfig.guitarworld?.cookie ?? '');
  const [ghRepo, setGhRepo] = useState(providerConfig.chordproGithub?.baseUrl ?? '');
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

  return (
    <div className="page search-page">
      <header className="page-head">
        <div>
          <h1>在线搜谱</h1>
          <p className="muted">聚合免费谱源；来源返回的文本谱会自动转成可滚动、可发声的六线谱</p>
        </div>
        <button className="btn ghost" onClick={() => setShowSources((v) => !v)}>
          谱源设置
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
          placeholder="输入歌名或歌手，例如：Wonderwall / 晴天"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? '搜索中…' : '搜索'}
        </button>
      </form>

      {showSources && (
        <div className="panel">
          <h3>谱源</h3>
          <div className="source-list">
            {providers.map((p) => (
              <label key={p.id} className="source-row">
                <input
                  type="checkbox"
                  checked={p.enabled}
                  onChange={(e) => {
                    setProviderConfig(p.id, { enabled: e.target.checked });
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
          <div className="field-grid">
            <label>
              <span>吉他世界 Cookie（已购/登录后可用）</span>
              <input
                className="input"
                value={gwCookie}
                placeholder="PHPSESSID=...; token=..."
                onChange={(e) => setGwCookie(e.target.value)}
                onBlur={() => setProviderConfig('guitarworld', { cookie: gwCookie.trim() })}
              />
            </label>
            <label>
              <span>ChordPro 曲库仓库（owner/repo）</span>
              <input
                className="input"
                value={ghRepo}
                placeholder="例如 your-name/songbook"
                onChange={(e) => setGhRepo(e.target.value)}
                onBlur={() => setProviderConfig('chordproGithub', { baseUrl: ghRepo.trim() })}
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
        {hits.map((hit) => {
          const key = `${hit.providerId}:${hit.id}`;
          return (
            <div className="result-row" key={key}>
              <div className="result-main">
                <div className="result-title">
                  {hit.title}
                  {hit.gated && <span className="tag warn">需会员/图片谱</span>}
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
                  {loadingId === key ? '导入中…' : '导入'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {!busy && !hits.length && query && <p className="muted center">没有找到结果，换个关键词或检查谱源设置</p>}
    </div>
  );
}