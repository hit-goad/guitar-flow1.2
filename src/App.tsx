import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ScoreDoc } from './core/types';
import { deleteScore, getScore, getSetting, listScores, putScore, setSetting, toggleFavorite } from './core/library';
import { demoDoc } from './import';
import { buildTimeline, notesWithTime, type Timeline } from './score/timeline';
import { applyPageStarts, buildImageTimeline } from './score/imageTimeline';
import { FollowController } from './score/follow';
import { ScorePlayer, type PlayerSnapshot } from './audio/player';
import { PitchDetector, type PitchFrame } from './audio/pitch';
import { MicRecorder, renderTimelineToWav, saveRecording } from './audio/recorder';
import { audioContext, ensureRunning, synth } from './audio/synth';
import { exportLibrary, importLibrary } from './core/archive';
import { isElectron, pickFiles, saveBlob } from './core/platform';
import { Library } from './ui/Library';
import { SearchPage } from './ui/SearchPage';
import { ImportPage } from './ui/ImportPage';
import { ScoreViewer, type ScoreViewerHandle } from './ui/ScoreViewer';
import { ImageScoreView } from './ui/ImageScoreView';
import { Transport } from './ui/Transport';
import { PracticePanel } from './ui/PracticePanel';

type View = 'library' | 'score' | 'search' | 'import' | 'settings';

const IDLE_POS: PlayerSnapshot = { state: 'idle', tick: 0, beatIndex: 0, timeSec: 0, totalSec: 0 };

export default function App() {
  const [view, setView] = useState<View>('library');
  const [docs, setDocs] = useState<ScoreDoc[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [doc, setDoc] = useState<ScoreDoc | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [pos, setPos] = useState<PlayerSnapshot>(IDLE_POS);
  const [autoScroll, setAutoScroll] = useState(true);
  const [follow, setFollow] = useState(false);
  const [metronome, setMetronome] = useState(false);
  const [rate, setRate] = useState(1);
  const [listening, setListening] = useState(false);
  const [frame, setFrame] = useState<PitchFrame | null>(null);
  const [recent, setRecent] = useState<Array<{ midi: number; ts: number }>>([]);
  const [stats, setStats] = useState<{ hits: number; misses: number; expected: number[] }>({ hits: 0, misses: 0, expected: [] });
  const [micRecording, setMicRecording] = useState(false);
  const [internalBusy, setInternalBusy] = useState(false);
  const [lastTake, setLastTake] = useState<{ kind: 'mic' | 'internal'; name: string; blob: Blob } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [volume, setVolume] = useState(0.7);

  const playerRef = useRef<ScorePlayer | null>(null);
  const followRef = useRef<FollowController | null>(null);
  const detectorRef = useRef<PitchDetector | null>(null);
  const micRef = useRef<MicRecorder | null>(null);
  const viewerRef = useRef<ScoreViewerHandle | null>(null);
  const followModeRef = useRef(false);
  const listeningRef = useRef(false);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 3600);
  }, []);

  /* ---------------- 启动 ---------------- */
  useEffect(() => {
    (async () => {
      let list = await listScores();
      if (!list.length) {
        const demo = demoDoc();
        await putScore(demo.doc);
        list = await listScores();
      }
      setDocs(list);
      const savedVolume = await getSetting('volume', 0.7);
      setVolume(savedVolume);
      synth().setVolume(savedVolume);
    })().catch((err) => setErrorBanner(`初始化失败：${(err as Error).message}`));
  }, []);

  const refreshLibrary = useCallback(async () => {
    const list = await listScores();
    setDocs(list);
  }, []);

  /* ---------------- 打开曲谱 ---------------- */
  const openDoc = useCallback(
    async (id: string) => {
      const found = await getScore(id);
      if (!found) return;
      // 必须在挂载 ScoreViewer 之前定好 timeline，否则谱面加载完成后的 setTimeline
      // 会被这里的「非图片谱 → null」覆盖掉（竞态）。
      if (found.format === 'image') {
        const pages = found.pages?.length ?? 1;
        const tl = buildImageTimeline(pages, 20);
        setTimeline(found.meta.pageStarts?.length ? applyPageStarts(tl, found.meta.pageStarts) : tl);
      } else {
        setTimeline(null);
      }
      setActiveId(id);
      setDoc(found);
      setView('score');
      // 移动端页面会滚动：切到谱面后把页面钉回顶部，避免导航被顶出屏幕
      const pinTop = () => {
        if (window.scrollY > 0) window.scrollTo({ top: 0 });
      };
      requestAnimationFrame(pinTop);
      window.setTimeout(pinTop, 120);
      window.setTimeout(pinTop, 360);
      window.setTimeout(pinTop, 900);
      setPos(IDLE_POS);
      setErrorBanner(null);
      found.openedAt = Date.now();
      void putScore(found);
      void refreshLibrary();
    },
    [refreshLibrary],
  );

  /* ---------------- 播放器 ---------------- */
  useEffect(() => {
    if (!timeline) return;
    const p = new ScorePlayer(timeline);
    p.onPosition = (snap) => setPos(snap);
    p.onEnd = () => setPos((s) => ({ ...s, state: 'idle', timeSec: 0 }));
    p.setOptions({ rate, metronome, silent: followModeRef.current });
    playerRef.current = p;
    setPos({ state: 'idle', tick: 0, beatIndex: 0, timeSec: 0, totalSec: timeline.totalSec });
    return () => {
      p.dispose();
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline]);

  useEffect(() => {
    playerRef.current?.setOptions({ metronome, silent: follow });
  }, [metronome, follow]);

  useEffect(() => {
    playerRef.current?.setRate(rate);
  }, [rate]);

  /* ---------------- 跟随对齐 ---------------- */
  useEffect(() => {
    if (!timeline) {
      followRef.current = null;
      return;
    }
    const fc = new FollowController(timeline);
    followRef.current = fc;
    setStats({ hits: 0, misses: 0, expected: fc.expectedNotes() });
  }, [timeline]);

  /* ---------------- 音高检测器 ---------------- */
  useEffect(() => {
    const detector = new PitchDetector();
    detectorRef.current = detector;
    const offFrame = detector.onFrame((f) => setFrame(f));
    const offNote = detector.onNote((note) => {
      setRecent((r) => [...r.slice(-64), { midi: note.midi, ts: note.endTs }]);
      const fc = followRef.current;
      if (!fc || !followModeRef.current) return;
      const advanced = fc.feed(note.midi, note.endTs);
      setStats({ hits: fc.state.hits, misses: fc.state.misses, expected: fc.state.expected });
      if (advanced) {
        const beat = fc.currentBeat;
        if (beat) playerRef.current?.seekTick(beat.tick);
      }
    });
    return () => {
      offFrame();
      offNote();
      void detector.stop();
      detectorRef.current = null;
    };
  }, []);

  const toggleListen = useCallback(async () => {
    const detector = detectorRef.current;
    if (!detector) return;
    if (listeningRef.current) {
      await detector.stop();
      listeningRef.current = false;
      setListening(false);
      return;
    }
    try {
      await ensureRunning(audioContext());
      await detector.start();
      listeningRef.current = true;
      setListening(true);
      notify('麦克风已开启：能看到实时音高，也可用「跟我弹」让谱跟随你');
    } catch (err) {
      notify(`麦克风开启失败：${(err as Error).message}`);
    }
  }, [notify]);

  const toggleFollow = useCallback(
    (next: boolean) => {
      setFollow(next);
      followModeRef.current = next;
      if (next) {
        const fc = followRef.current;
        if (fc) {
          fc.reset(pos.beatIndex);
          setStats({ hits: 0, misses: 0, expected: fc.state.expected });
        }
        playerRef.current?.pause();
        if (!listeningRef.current) void toggleListen();
      }
    },
    [pos.beatIndex, toggleListen],
  );

  /* ---------------- 播放控制 ---------------- */
  const togglePlay = useCallback(async () => {
    const p = playerRef.current;
    if (!p) {
      notify('当前曲谱没有可播放的音符');
      return;
    }
    await ensureRunning(audioContext());
    if (p.state === 'playing') p.pause();
    else await p.play();
  }, [notify]);

  const seekSec = useCallback((sec: number) => {
    playerRef.current?.seekSec(sec);
    const tl = timeline;
    if (tl) {
      let idx = 0;
      tl.beatSecs.forEach((t, i) => {
        if (t <= sec) idx = i;
      });
      followRef.current?.seek(idx);
    }
  }, [timeline]);

  const seekBeat = useCallback(
    (index: number) => {
      const tl = timeline;
      if (!tl) return;
      const beat = tl.beats[index];
      if (!beat) return;
      playerRef.current?.seekTick(beat.tick);
      followRef.current?.seek(index);
      const fc = followRef.current;
      if (fc) setStats({ hits: fc.state.hits, misses: fc.state.misses, expected: fc.state.expected });
      if (!followModeRef.current && beat.notes[0]) synth().preview(beat.notes[0].midi);
    },
    [timeline],
  );

  /* ---------------- 键盘快捷键 ---------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /input|textarea|select/i.test(target.tagName)) return;
      if (view !== 'score') return;
      if (e.code === 'Space') {
        e.preventDefault();
        void togglePlay();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        seekBeat(Math.min((timeline?.beats.length ?? 1) - 1, pos.beatIndex + 1));
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        seekBeat(Math.max(0, pos.beatIndex - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, togglePlay, seekBeat, pos.beatIndex, timeline]);

  /* ---------------- 录音 ---------------- */
  const toggleMicRecord = useCallback(async () => {
    if (micRecording) {
      const res = await micRef.current?.stop();
      micRef.current = null;
      setMicRecording(false);
      if (res && res.blob.size > 0) {
        setLastTake({ kind: 'mic', name: '麦克风录音', blob: res.blob });
        notify(`录音完成 ${res.durationSec.toFixed(1)}s，可点击保存`);
      }
      return;
    }
    try {
      const rec = new MicRecorder();
      await rec.start();
      micRef.current = rec;
      setMicRecording(true);
      await ensureRunning(audioContext());
      playerRef.current?.play();
      notify('正在录音（同时播放曲谱）');
    } catch (err) {
      notify(`录音失败：${(err as Error).message}`);
    }
  }, [micRecording, notify]);

  const recordInternal = useCallback(async () => {
    if (!timeline || !timeline.notes.length) {
      notify('这份曲谱没有音符，无法内录（图片谱请用麦克风或系统内录）');
      return;
    }
    setInternalBusy(true);
    try {
      const events = notesWithTime(timeline);
      const blob = await renderTimelineToWav(events, timeline.totalSec, { name: doc?.title });
      setLastTake({ kind: 'internal', name: doc?.title ?? '内录', blob });
      notify('内录完成（应用内音源离线渲染）');
    } catch (err) {
      notify(`内录失败：${(err as Error).message}`);
    } finally {
      setInternalBusy(false);
    }
  }, [timeline, doc, notify]);

  const saveTake = useCallback(
    async (kind: 'mic' | 'internal') => {
      if (!lastTake) return;
      const name = `${(doc?.title ?? 'guitarflow').replace(/[\\/:*?"<>|]/g, '_')}-${kind === 'internal' ? '内录' : '录音'}`;
      const saved = await saveRecording(lastTake.blob, name);
      if (saved) notify(`已保存：${saved}`);
    },
    [lastTake, doc, notify],
  );

  /* ---------------- 曲库操作 ---------------- */
  /** 图片谱打点：把当前页的开始时间设为当前播放位置 */
  const tapPageStart = useCallback(async () => {
    if (!timeline || doc?.format !== 'image') return;
    const page = pos.beatIndex;
    const starts = [...(doc.meta.pageStarts ?? timeline.beats.map((b, i) => i * 20))];
    starts[page] = Number(pos.timeSec.toFixed(2));
    const next = { ...doc, meta: { ...doc.meta, pageStarts: starts }, updatedAt: Date.now() };
    setDoc(next);
    await putScore(next);
    const tl = buildImageTimeline(starts.length, 20);
    setTimeline(applyPageStarts(tl, starts));
    notify(`第 ${page + 1} 页起始时间已设为 ${pos.timeSec.toFixed(1)}s`);
  }, [timeline, doc, pos.beatIndex, pos.timeSec, notify]);

  const removeDoc = useCallback(
    async (id: string) => {
      await deleteScore(id);
      await refreshLibrary();
      if (activeId === id) {
        setActiveId(null);
        setDoc(null);
        setTimeline(null);
        setView('library');
      }
      notify('已删除');
    },
    [activeId, refreshLibrary, notify],
  );

  const favDoc = useCallback(
    async (id: string) => {
      await toggleFavorite(id);
      await refreshLibrary();
    },
    [refreshLibrary],
  );

  /* ---------------- 设置 ---------------- */
  const changeVolume = useCallback((v: number) => {
    setVolume(v);
    synth().setVolume(v);
    void setSetting('volume', v);
  }, []);

  const doExport = useCallback(async () => {
    const archive = await exportLibrary();
    const blob = new Blob([JSON.stringify(archive)], { type: 'application/json' });
    const saved = await saveBlob(`guitarflow-library-${new Date().toISOString().slice(0, 10)}.json`, blob);
    notify(saved ? `曲库已导出：${saved}` : '导出已开始');
  }, [notify]);

  const doImportLibrary = useCallback(async () => {
    const files = await pickFiles('.json');
    if (!files.length) return;
    try {
      const text = await files[0].text();
      const count = await importLibrary(JSON.parse(text));
      await refreshLibrary();
      notify(`导入 ${count} 份曲谱`);
    } catch (err) {
      notify(`导入失败：${(err as Error).message}`);
    }
  }, [refreshLibrary, notify]);

  /* ---------------- 派生数据 ---------------- */
  const expected = useMemo(() => {
    if (!timeline) return [];
    if (follow) return stats.expected;
    const beat = timeline.beats[pos.beatIndex];
    return beat ? beat.notes.map((n) => n.midi) : [];
  }, [timeline, follow, stats.expected, pos.beatIndex]);

  const currentBeat = pos.beatIndex;
  const tempoBase = timeline?.tempo ?? 100;
  const displayBpm = Math.round(tempoBase * rate);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand" onClick={() => setView('library')}>
          <span className="brand-mark">GF</span>
          <div>
            <b>GuitarFlow</b>
            <small>吉他流</small>
          </div>
        </div>

        <nav>
          <button className={view === 'library' ? 'active' : ''} onClick={() => setView('library')}>
            <span>♪</span> 曲库
          </button>
          <button className={view === 'search' ? 'active' : ''} onClick={() => setView('search')}>
            <span>⌕</span> 搜谱
          </button>
          <button className={view === 'import' ? 'active' : ''} onClick={() => setView('import')}>
            <span>⤓</span> 导入
          </button>
          <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>
            <span>⚙</span> 设置
          </button>
        </nav>

        <div className="sidebar-list">
          <div className="sidebar-title">最近</div>
          {docs.slice(0, 10).map((d) => (
            <button
              key={d.id}
              className={`side-item ${activeId === d.id ? 'active' : ''}`}
              onClick={() => void openDoc(d.id)}
              title={`${d.title} · ${d.artist}`}
            >
              <span className="side-title">{d.title}</span>
              <span className="side-artist">{d.artist || '—'}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-foot">
          <span className="pill">{isElectron ? '桌面版' : 'Web/移动'}</span>
          <span className="muted small">v1.0.0</span>
        </div>
      </aside>

      <main className="main">
        {errorBanner && (
          <div className="error-banner">
            <span>{errorBanner}</span>
            <button className="btn tiny ghost" onClick={() => setErrorBanner(null)}>
              关闭
            </button>
          </div>
        )}

        {view === 'library' && (
          <Library
            docs={docs}
            activeId={activeId}
            onOpen={(id) => void openDoc(id)}
            onDelete={(id) => void removeDoc(id)}
            onToggleFavorite={(id) => void favDoc(id)}
            onImport={() => setView('import')}
            onSearch={() => setView('search')}
          />
        )}

        {view === 'search' && (
          <SearchPage
            onSaved={(id) => {
              void refreshLibrary();
              void openDoc(id);
            }}
            onNotify={notify}
          />
        )}

        {view === 'import' && (
          <ImportPage
            onSaved={(id) => {
              void refreshLibrary();
              setActiveId(id);
            }}
            onNotify={notify}
          />
        )}

        {view === 'settings' && (
          <div className="page settings">
            <header className="page-head">
              <div>
                <h1>设置</h1>
                <p className="muted">音色、曲库备份与平台信息</p>
              </div>
            </header>

            <div className="panel">
              <h3>音色音量</h3>
              <input
                type="range"
                min={0}
                max={1}
                step={0.02}
                value={volume}
                onChange={(e) => changeVolume(Number(e.target.value))}
              />
              <p className="muted small">合成器为 Karplus–Strong 物理建模，每个音符按实际弦长/品位发声。</p>
            </div>

            <div className="panel">
              <h3>曲库备份</h3>
              <div className="row">
                <button className="btn" onClick={() => void doExport()}>
                  导出曲库 JSON
                </button>
                <button className="btn ghost" onClick={() => void doImportLibrary()}>
                  导入曲库 JSON
                </button>
              </div>
            </div>

            <div className="panel">
              <h3>关于</h3>
              <p className="muted small">
                GuitarFlow 1.0 · 跨平台（Windows / Android / iOS）。谱面渲染基于 alphaTab，音频与音高检测为自研实现。
              </p>
              <p className="muted small">快捷键：空格播放/暂停 · ←/→ 前后一个音符 · 点击谱面跳转。</p>
            </div>
          </div>
        )}

        {view === 'score' && doc && (
          <div className="score-layout">
            <div className="score-column">
              <header className="score-head">
                <button className="btn tiny ghost" onClick={() => setView('library')}>
                  ← 曲库
                </button>
                <div className="score-titles">
                  <h2>{doc.title}</h2>
                  <div className="muted small">
                    {doc.artist || '未知艺人'}
                    {doc.meta.bpm ? ` · ${Math.round(doc.meta.bpm)} BPM` : ''}
                    {` · ${doc.sourceName}`}
                  </div>
                </div>
                <div className="head-actions">
                  <button className={`btn tiny ${doc.favorite ? 'primary' : 'ghost'}`} onClick={() => void favDoc(doc.id)}>
                    ★
                  </button>
                  {doc.format === 'image' && (
                    <button className="btn tiny ghost" onClick={() => void tapPageStart()} title="把当前页的开始时间绑定到当前播放位置">
                      打点同步
                    </button>
                  )}
                  {pos.state !== 'idle' && <span className="pill live">播放中</span>}
                </div>
              </header>

              <div className="score-body">
                {doc.format === 'image' ? (
                  <ImageScoreView
                    doc={doc}
                    pageIndex={currentBeat}
                    autoScroll={autoScroll}
                    onPageChange={(i) => seekBeat(i)}
                  />
                ) : (
                  <ScoreViewer
                    ref={viewerRef}
                    doc={doc}
                    currentBeat={currentBeat}
                    autoScroll={autoScroll}
                    onTimeline={(tl) => setTimeline(tl)}
                    onSeekBeat={seekBeat}
                    onError={(msg) => setErrorBanner(`谱面解析：${msg}`)}
                  />
                )}
              </div>

              <Transport
                state={pos.state}
                timeSec={pos.timeSec}
                totalSec={pos.totalSec || timeline?.totalSec || 0}
                tempo={tempoBase}
                rate={rate}
                metronome={metronome}
                autoScroll={autoScroll}
                follow={follow}
                disabled={!timeline}
                onTogglePlay={() => void togglePlay()}
                onStop={() => {
                  playerRef.current?.stop();
                  followRef.current?.reset(0);
                }}
                onSeek={seekSec}
                onRate={(v) => setRate(v)}
                onTempoDelta={(d) => setRate(Math.max(0.35, Math.min(2, (tempoBase + d) / tempoBase)))}
                onMetronome={setMetronome}
                onAutoScroll={setAutoScroll}
                onFollow={toggleFollow}
                pitch={{ note: frame?.note ?? '', cents: frame?.cents ?? 0, active: listening }}
              />
            </div>

            <aside className="practice-column">
              <PracticePanel
                frame={frame}
                listening={listening}
                follow={follow}
                stats={{ hits: stats.hits, misses: stats.misses, expected }}
                recent={recent}
                onToggleListen={() => void toggleListen()}
                onRecordMic={() => void toggleMicRecord()}
                onRecordInternal={() => void recordInternal()}
                micRecording={micRecording}
                renderingInternal={internalBusy}
                systemCaptureSupported={isElectron}
                onRecordSystem={() => notify('系统内录：请在弹窗中选择「整个屏幕」并勾选共享音频')}
                lastTake={lastTake ? { kind: lastTake.kind, name: lastTake.name } : null}
                onSaveLast={(kind) => void saveTake(kind)}
              />
            </aside>
          </div>
        )}

        {view === 'score' && !doc && <div className="empty-note">请选择一份曲谱</div>}
      </main>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}