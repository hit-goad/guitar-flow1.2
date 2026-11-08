import { useCallback, useEffect, useRef, useState } from 'react';
import type { TakeKind, TakeRecord } from '../core/library';
import { addTake, deleteTake, formatDuration, formatSize, listTakes, renameTake, updateTakePitchRange } from '../core/takes';
import { pickFiles, saveBlob } from '../core/platform';
import { encodeMp3, resample } from '../audio/mp3';
import { decodeToSamples } from '../audio/decode';
import {
  analyzeAudioPitchContour,
  LiveInternalRecorder,
  type InternalCaptureMode,
  type PitchAnalysisSummary,
} from '../audio/internalRecorder';
import { midiToName } from '../core/types';

interface Props {
  onNotify(message: string): void;
  refreshKey: number;
}

const KIND_LABEL: Record<TakeKind, string> = {
  internal: '应用内录',
  system: '系统内录',
  mixed: '内录+麦混录',
  mic: '麦克风录音',
};

/**
 * 录音与内录音高分析中心（完整移植《音高》APK 的内录、外部音频导入测音高、音高曲线图与 MP3/WAV 导出）：
 *  - 支持直接在本页启动「应用内录」「系统跨应用内录」「内录+麦克风混录」
 *  - 支持导入任意外部音频（MP3/WAV/M4A）提取音高曲线与最高/最低音域
 *  - 提供交互式音高轨迹画布（PitchContourCanvas），回放时实时同步游标与当前音名/频率
 */
export function TakesPage({ onNotify, refreshKey }: Props) {
  const [takes, setTakes] = useState<TakeRecord[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [playTimeSec, setPlayTimeSec] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [activeTakeId, setActiveTakeId] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<PitchAnalysisSummary | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [recMode, setRecMode] = useState<InternalCaptureMode>('system-loopback');
  const [recording, setRecording] = useState(false);
  const [recSec, setRecSec] = useState(0);
  const [liveHz, setLiveHz] = useState<{ hz: number; note: string; cents: number } | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const recRef = useRef<LiveInternalRecorder | null>(null);
  const timerRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const reload = useCallback(async () => {
    const list = await listTakes();
    setTakes(list);
    if (!activeTakeId && list.length > 0) {
      setActiveTakeId(list[0].id);
    }
  }, [activeTakeId]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  useEffect(
    () => () => {
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      if (timerRef.current) window.clearInterval(timerRef.current);
    },
    [],
  );

  // 当选中某条录音时，自动分析其音高轨迹（对应《音高》App 的音高图）
  useEffect(() => {
    const target = takes.find((t) => t.id === activeTakeId);
    if (!target) {
      setAnalysis(null);
      return;
    }
    let cancelled = false;
    setAnalyzing(true);
    analyzeAudioPitchContour(target.blob, 260)
      .then(async (res) => {
        if (cancelled) return;
        setAnalysis(res);
        if (res.minNote !== '—' && !target.pitchRange) {
          const rangeStr = `${res.minNote} ~ ${res.maxNote}`;
          await updateTakePitchRange(target.id, rangeStr);
          setTakes((prev) => prev.map((x) => (x.id === target.id ? { ...x, pitchRange: rangeStr } : x)));
        }
      })
      .catch(() => {
        if (!cancelled) setAnalysis(null);
      })
      .finally(() => {
        if (!cancelled) setAnalyzing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTakeId, takes]);

  // 绘制《音高》App 风格的音高曲线图 + 底部波形包络 + 播放游标
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !analysis) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 720;
    const h = canvas.clientHeight || 220;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const padLeft = 42;
    const padRight = 14;
    const padTop = 14;
    const padBot = 36;
    const plotW = Math.max(10, w - padLeft - padRight);
    const plotH = Math.max(10, h - padTop - padBot);

    const minM = analysis.minMidi > 0 ? Math.max(36, analysis.minMidi - 3) : 48;
    const maxM = analysis.maxMidi > 0 ? Math.min(96, analysis.maxMidi + 3) : 76;
    const span = Math.max(12, maxM - minM);

    // 1. 绘制半音/八度水平参考网格线与左侧音名坐标轴
    ctx.font = '11px system-ui';
    const step = span > 24 ? 3 : 2;
    for (let m = Math.ceil(minM / step) * step; m <= maxM; m += step) {
      const y = padTop + plotH - ((m - minM) / span) * plotH;
      ctx.strokeStyle = m % 12 === 0 ? 'rgba(255, 196, 64, 0.22)' : 'rgba(255, 255, 255, 0.06)';
      ctx.lineWidth = m % 12 === 0 ? 1.2 : 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.stroke();

      ctx.fillStyle = m % 12 === 0 ? '#ffc440' : 'rgba(255, 255, 255, 0.45)';
      ctx.fillText(midiToName(m), 6, y + 4);
    }

    // 2. 绘制底部音频波形包络
    const waveBaseY = h - 6;
    const waveMaxH = 22;
    ctx.fillStyle = 'rgba(120, 200, 255, 0.22)';
    analysis.peaks.forEach((pk, idx) => {
      const x = padLeft + (idx / Math.max(1, analysis.peaks.length)) * plotW;
      const bw = Math.max(1.5, plotW / analysis.peaks.length - 1);
      const bh = Math.max(1, pk * waveMaxH);
      ctx.fillRect(x, waveBaseY - bh, bw, bh);
    });

    // 3. 绘制连续音高曲线与采样点
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffc440';
    let inSegment = false;
    ctx.beginPath();
    analysis.points.forEach((pt, idx) => {
      const x = padLeft + (idx / Math.max(1, analysis.points.length - 1)) * plotW;
      if (pt.midi <= 0) {
        inSegment = false;
        return;
      }
      const exactMidi = pt.midi + pt.cents / 100;
      const y = padTop + plotH - ((exactMidi - minM) / span) * plotH;
      if (!inSegment) {
        ctx.moveTo(x, y);
        inSegment = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();

    analysis.points.forEach((pt, idx) => {
      if (pt.midi <= 0) return;
      const x = padLeft + (idx / Math.max(1, analysis.points.length - 1)) * plotW;
      const exactMidi = pt.midi + pt.cents / 100;
      const y = padTop + plotH - ((exactMidi - minM) / span) * plotH;
      ctx.fillStyle = Math.abs(pt.cents) < 10 ? '#4ade80' : '#ffc440';
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    });

    // 4. 若当前正在回放该录音，绘制实时同步游标
    if (playingId === activeTakeId && analysis.durationSec > 0) {
      const ratio = Math.max(0, Math.min(1, playTimeSec / analysis.durationSec));
      const cx = padLeft + ratio * plotW;
      ctx.strokeStyle = '#ff5c5c';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, padTop);
      ctx.lineTo(cx, h - 4);
      ctx.stroke();
    }
  }, [analysis, playingId, activeTakeId, playTimeSec]);

  const toggleDirectInternalRecord = async () => {
    if (recording) {
      const res = await recRef.current?.stop();
      recRef.current = null;
      setRecording(false);
      setRecSec(0);
      setLiveHz(null);
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (res && res.samples.length > 0) {
        const kind: TakeKind =
          recMode === 'system-loopback' ? 'system' : recMode === 'mix-live' ? 'mixed' : 'internal';
        const modeTitle = KIND_LABEL[kind];
        const summary = await analyzeAudioPitchContour(res.wavBlob, 200).catch(() => null);
        const pitchRange =
          summary && summary.minNote !== '—' ? `${summary.minNote} ~ ${summary.maxNote}` : undefined;
        const take = await addTake({
          title: `${modeTitle} ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`,
          kind,
          blob: res.wavBlob,
          durationSec: res.durationSec,
          pitchRange,
        });
        await reload();
        setActiveTakeId(take.id);
        onNotify(
          `内录完成 (${res.durationSec.toFixed(1)}s)${pitchRange ? ` · 识别音域 ${pitchRange}` : ''}，已生成音高曲线图`,
        );
      }
      return;
    }

    try {
      const rec = new LiveInternalRecorder();
      const { autocorrelate } = await import('../audio/pitch');
      const { freqToMidi } = await import('../core/types');
      await rec.start(recMode, (chunk, sr) => {
        const r = autocorrelate(chunk, sr);
        if (r.hz >= 55 && r.hz <= 1400 && r.clarity >= 0.5 && r.rms >= 0.002) {
          const m = freqToMidi(r.hz);
          const near = Math.round(m);
          setLiveHz({ hz: r.hz, note: midiToName(near), cents: (m - near) * 100 });
        }
      });
      recRef.current = rec;
      setRecording(true);
      setRecSec(0);
      timerRef.current = window.setInterval(() => setRecSec((v) => v + 1), 1000);
      onNotify(
        recMode === 'system-loopback'
          ? '系统内录已启动：正在录制系统/其他应用播放的声音并实时测算音高'
          : '内录已启动：正在录制并实时分析音高',
      );
    } catch (err) {
      onNotify(`内录启动失败：${(err as Error).message}`);
    }
  };

  const importExternalAudioForPitch = async () => {
    const files = await pickFiles('audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac,.webm');
    if (!files.length) return;
    setAnalyzing(true);
    try {
      for (const file of files) {
        const summary = await analyzeAudioPitchContour(file, 260);
        const pitchRange = summary.minNote !== '—' ? `${summary.minNote} ~ ${summary.maxNote}` : undefined;
        const take = await addTake({
          title: file.name.replace(/\.[^.]+$/, ''),
          kind: 'internal',
          blob: file,
          durationSec: summary.durationSec,
          pitchRange,
        });
        await reload();
        setActiveTakeId(take.id);
        setAnalysis(summary);
      }
      onNotify(`已导入音频并完成全曲音高轨迹分析`);
    } catch (err) {
      onNotify(`音频音高分析失败：${(err as Error).message}`);
    } finally {
      setAnalyzing(false);
    }
  };

  const play = (take: TakeRecord) => {
    setActiveTakeId(take.id);
    if (playingId === take.id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    audioRef.current?.pause();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    const url = URL.createObjectURL(take.blob);
    urlRef.current = url;
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.ontimeupdate = () => setPlayTimeSec(audio.currentTime);
    audio.onended = () => {
      setPlayingId(null);
      setPlayTimeSec(0);
    };
    audio.onerror = () => onNotify('这段录音无法播放（可能是编码格式不被当前平台支持）');
    void audio.play();
    setPlayingId(take.id);
  };

  const exportAs = async (take: TakeRecord, format: 'wav' | 'mp3') => {
    setBusyId(take.id);
    try {
      if (format === 'mp3') {
        if (take.mime.includes('mpeg')) {
          await saveBlob(`${take.title}.mp3`, take.blob);
          onNotify('已导出 MP3');
          return;
        }
        const { samples, sampleRate } = await decodeToSamples(take.blob);
        const mp3 = await encodeMp3(resample(samples, sampleRate), 44100, { bitRate: 160 });
        const saved = await saveBlob(`${take.title}.mp3`, mp3);
        onNotify(saved ? `已导出 MP3：${saved}` : '导出 MP3 已开始');
      } else {
        await saveBlob(`${take.title}.wav`, take.blob);
        onNotify('已导出 WAV');
      }
    } catch (err) {
      onNotify(`导出失败：${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  };

  const rename = async (take: TakeRecord) => {
    const next = prompt('重命名这段录音', take.title);
    if (!next) return;
    await renameTake(take.id, next.trim() || take.title);
    await reload();
  };

  const remove = async (take: TakeRecord) => {
    if (!confirm(`删除录音「${take.title}」？`)) return;
    if (playingId === take.id) {
      audioRef.current?.pause();
      setPlayingId(null);
    }
    await deleteTake(take.id);
    await reload();
    onNotify('已删除');
  };

  const activeTake = takes.find((t) => t.id === activeTakeId) ?? null;

  return (
    <div className="page takes-page">
      <header className="page-head">
        <div>
          <h1>内录与音高分析中心</h1>
          <p className="muted">
            已移植《音高》App 的内录与音高曲线图功能：支持系统跨应用内录、应用内零杂音内录、伴奏+麦克风混录、导入外部音频测音高，以及 LAME MP3 / WAV 无损导出
          </p>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select
            value={recMode}
            disabled={recording}
            onChange={(e) => setRecMode(e.target.value as InternalCaptureMode)}
            className="input"
            style={{ width: 'auto', minWidth: 195 }}
          >
            <option value="system-loopback">系统跨应用内录（录其他App/系统声音）</option>
            <option value="app-live">应用内实时内录（仅录曲谱合成器）</option>
            <option value="mix-live">内录伴奏 + 麦克风弹唱混录</option>
          </select>
          <button
            className={`btn ${recording ? 'danger' : 'primary'}`}
            onClick={() => void toggleDirectInternalRecord()}
          >
            {recording ? `■ 停止内录 (${recSec}s)` : '⏺ 启动实时内录'}
          </button>
          <button className="btn ghost" onClick={() => void importExternalAudioForPitch()}>
            📂 导入音频文件测音高
          </button>
        </div>
      </header>

      {recording && (
        <div className="panel" style={{ marginBottom: 14, borderColor: 'rgba(255,196,64,0.5)' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <span className="pill live">正在实时内录 · {recSec}s</span>
              <span style={{ marginLeft: 12 }}>
                实时音高：
                <b>{liveHz ? `${liveHz.note} (${liveHz.hz.toFixed(1)} Hz, ${liveHz.cents > 0 ? '+' : ''}${liveHz.cents.toFixed(0)}¢)` : '等待声音输入…'}</b>
              </span>
            </div>
            <button className="btn tiny danger" onClick={() => void toggleDirectInternalRecord()}>
              完成并生成音高图
            </button>
          </div>
        </div>
      )}

      {activeTake && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="local-head" style={{ marginBottom: 8 }}>
            <div>
              <h3>
                📈 音高轨迹与音域图：{activeTake.title}
                {analyzing && <span className="muted small"> · 正在计算音高曲线…</span>}
              </h3>
              {analysis && (
                <div className="omr-meta" style={{ marginTop: 6 }}>
                  <span className="tag">
                    音域范围：{analysis.minNote} ~ {analysis.maxNote}
                  </span>
                  <span className="tag subtle">平均音准偏差：±{analysis.avgCents.toFixed(1)}¢</span>
                  <span className="tag subtle">有效发声占比：{(analysis.voicedRatio * 100).toFixed(0)}%</span>
                  <span className="tag subtle">时长：{formatDuration(analysis.durationSec)}</span>
                </div>
              )}
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn tiny primary" onClick={() => play(activeTake)}>
                {playingId === activeTake.id ? '❚❚ 暂停回放' : '▶ 播放并同步游标'}
              </button>
              <button className="btn tiny" onClick={() => void exportAs(activeTake, 'mp3')}>
                导出 MP3
              </button>
              <button className="btn tiny ghost" onClick={() => void exportAs(activeTake, 'wav')}>
                导出 WAV
              </button>
            </div>
          </div>
          <canvas
            ref={canvasRef}
            style={{
              width: '100%',
              height: 220,
              display: 'block',
              borderRadius: 10,
              background: 'rgba(10, 14, 20, 0.85)',
              border: '1px solid var(--line)',
              cursor: 'pointer',
            }}
            onClick={(e) => {
              if (!analysis || !audioRef.current || playingId !== activeTake.id) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left - 42) / Math.max(1, rect.width - 56)));
              audioRef.current.currentTime = ratio * analysis.durationSec;
              setPlayTimeSec(audioRef.current.currentTime);
            }}
          />
        </div>
      )}

      {!takes.length && (
        <div className="empty-state">
          <div className="empty-icon">⏺</div>
          <h2>还没有内录或录音记录</h2>
          <p className="muted">
            点击右上角「⏺ 启动实时内录」或「📂 导入音频文件测音高」，也可在曲谱练习页边弹边内录。
          </p>
        </div>
      )}

      <div className="take-list">
        {takes.map((take) => (
          <div
            className={`take-row ${playingId === take.id || activeTakeId === take.id ? 'playing' : ''}`}
            key={take.id}
            onClick={() => setActiveTakeId(take.id)}
            style={{ cursor: 'pointer' }}
          >
            <button
              className="btn round primary"
              onClick={(e) => {
                e.stopPropagation();
                play(take);
              }}
            >
              {playingId === take.id ? '❚❚' : '▶'}
            </button>
            <div className="take-main">
              <div className="take-title">
                {take.title}
                <span className="tag subtle">{KIND_LABEL[take.kind] ?? '应用内录'}</span>
                {take.pitchRange && <span className="tag">音域 {take.pitchRange}</span>}
              </div>
              <div className="muted small">
                {formatDuration(take.durationSec)} · {formatSize(take.size)} ·{' '}
                {new Date(take.createdAt).toLocaleString('zh-CN')}
                {take.scoreTitle ? ` · 《${take.scoreTitle}》` : ''}
              </div>
            </div>
            <div className="take-actions" onClick={(e) => e.stopPropagation()}>
              <button className="btn tiny ghost" onClick={() => setActiveTakeId(take.id)}>
                📈 音高图
              </button>
              <button className="btn tiny" onClick={() => void exportAs(take, 'mp3')} disabled={busyId === take.id}>
                {busyId === take.id ? '导出中…' : 'MP3'}
              </button>
              <button className="btn tiny ghost" onClick={() => void exportAs(take, 'wav')}>
                WAV
              </button>
              <button className="btn tiny ghost" onClick={() => void rename(take)}>
                改名
              </button>
              <button className="btn tiny ghost danger-text" onClick={() => void remove(take)}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}