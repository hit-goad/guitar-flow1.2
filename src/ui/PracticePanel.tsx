import { useEffect, useRef, useState } from 'react';
import type { PitchFrame } from '../audio/pitch';
import { midiToName } from '../core/types';

export interface PracticeStats {
  hits: number;
  misses: number;
  expected: number[];
}

interface Props {
  frame: PitchFrame | null;
  listening: boolean;
  follow: boolean;
  stats: PracticeStats;
  recent: Array<{ midi: number; ts: number }>;
  onToggleListen(): void;
  onRecordMic(): void;
  onRecordInternal(): void;
  micRecording: boolean;
  renderingInternal: boolean;
  systemCaptureSupported: boolean;
  onRecordSystem?(): void;
  onSaveLast?(kind: 'mic' | 'internal'): void;
  lastTake: { kind: 'mic' | 'internal'; name: string } | null;
}

export function PracticePanel(props: Props) {
  const { frame, listening, follow, stats, recent } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [level, setLevel] = useState(0);

  useEffect(() => {
    setLevel(frame?.rms ?? 0);
  }, [frame]);

  // 音高卷轴：把最近弹的音画成横向小条
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const midis = recent.map((r) => r.midi);
    const min = Math.min(48, ...midis);
    const max = Math.max(76, ...midis);
    const span = Math.max(12, max - min);
    const rowH = Math.max(6, h / (span + 2));

    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    ctx.lineWidth = 1;
    for (let m = Math.ceil(min / 12) * 12; m <= max; m += 12) {
      const y = h - ((m - min) / span) * (h - 8) - 4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.25)';
      ctx.font = '9px system-ui';
      ctx.fillText(midiToName(m), 2, y - 2);
    }

    recent.forEach((r, i) => {
      const x = (i / Math.max(1, recent.length - 1)) * (w - 10) + 4;
      const y = h - ((r.midi - min) / span) * (h - 8) - 4;
      const isExpected = stats.expected.includes(r.midi);
      ctx.fillStyle = isExpected ? '#ffc440' : 'rgba(120,200,255,.75)';
      ctx.beginPath();
      ctx.arc(x, y, rowH / 2.6 + 1.6, 0, Math.PI * 2);
      ctx.fill();
    });
  }, [recent, stats.expected]);

  const note = frame && frame.hz > 0 ? midiToName(Math.round(frame.midi)) : '—';
  const cents = frame && frame.hz > 0 ? Math.max(-50, Math.min(50, frame.cents)) : 0;
  const inTune = frame && frame.hz > 0 && Math.abs(frame.cents) < 8;
  const expectedLabel = stats.expected.slice(0, 4).map((m) => midiToName(m)).join(' ');

  return (
    <div className="practice">
      <div className="practice-head">
        <span className={`pill ${listening ? 'live' : ''}`}>{listening ? '麦克风监听中' : '麦克风未开启'}</span>
        {follow && <span className="pill accent">跟我弹</span>}
        <span className="spacer" />
        <span className="acc">命中 {stats.hits} · 漏 {stats.misses}</span>
      </div>

      <div className="tuner">
        <div className={`note-big ${inTune ? 'in-tune' : ''}`}>{note}</div>
        <div className="cents">
          <div className="cents-track">
            <div className="cents-center" />
            <div
              className={`cents-needle ${inTune ? 'in-tune' : ''}`}
              style={{ left: `${50 + cents}%` }}
            />
          </div>
          <div className="cents-labels">
            <span>♭</span>
            <span>{frame && frame.hz > 0 ? `${frame.cents > 0 ? '+' : ''}${frame.cents.toFixed(0)}¢` : '调音'}</span>
            <span>♯</span>
          </div>
        </div>
        <div className="level">
          <div className="level-bar" style={{ width: `${Math.min(100, level * 320)}%` }} />
        </div>
      </div>

      <div className="expected">
        <span className="label">应弹</span>
        <b>{expectedLabel || '—'}</b>
      </div>

      <canvas ref={canvasRef} className="pitch-tape" />

      <div className="practice-actions">
        <button className={`btn ${listening ? 'danger' : 'primary'}`} onClick={props.onToggleListen}>
          {listening ? '停止监听' : '开启实时检测'}
        </button>
        <button className={`btn ${props.micRecording ? 'danger' : ''}`} onClick={props.onRecordMic}>
          {props.micRecording ? '停止录音' : '麦克风录音'}
        </button>
        <button className="btn" onClick={props.onRecordInternal} disabled={props.renderingInternal}>
          {props.renderingInternal ? '内录中…' : '内录当前曲目'}
        </button>
        {props.systemCaptureSupported && props.onRecordSystem && (
          <button className="btn ghost" onClick={props.onRecordSystem}>
            系统内录
          </button>
        )}
        {props.lastTake && props.onSaveLast && (
          <button className="btn ghost" onClick={() => props.onSaveLast!(props.lastTake!.kind)}>
            保存 {props.lastTake.name}
          </button>
        )}
      </div>
    </div>
  );
}