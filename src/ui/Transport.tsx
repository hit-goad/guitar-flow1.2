import type { PlayerState } from '../audio/player';

interface Props {
  state: PlayerState;
  timeSec: number;
  totalSec: number;
  tempo: number;
  rate: number;
  metronome: boolean;
  autoScroll: boolean;
  follow: boolean;
  disabled?: boolean;
  onTogglePlay(): void;
  onStop(): void;
  onSeek(sec: number): void;
  onRate(value: number): void;
  onTempoDelta(delta: number): void;
  onMetronome(value: boolean): void;
  onAutoScroll(value: boolean): void;
  onFollow(value: boolean): void;
  /** 移动端在播放条上常驻显示实时音高 */
  pitch?: { note: string; cents: number; active: boolean };
}

function fmt(sec: number): string {
  if (!Number.isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function Transport(props: Props) {
  const { state, timeSec, totalSec, rate, tempo, disabled } = props;
  const playing = state === 'playing';

  return (
    <div className="transport">
      <div className="transport-main">
        <button
          className={`btn round primary ${playing ? 'active' : ''}`}
          onClick={props.onTogglePlay}
          disabled={disabled}
          title="播放 / 暂停（空格）"
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <button className="btn round" onClick={props.onStop} disabled={disabled} title="回到开头">
          ■
        </button>

        <div className="seek">
          <input
            type="range"
            min={0}
            max={Math.max(1, totalSec)}
            step={0.05}
            value={Math.min(timeSec, totalSec)}
            onChange={(e) => props.onSeek(Number(e.target.value))}
            disabled={disabled}
          />
          <div className="seek-meta">
            <span>{fmt(timeSec)}</span>
            <span className="dot">/</span>
            <span>{fmt(totalSec)}</span>
          </div>
        </div>

        {props.pitch && (props.pitch.active || props.pitch.note) && (
          <div className={`pitch-chip ${Math.abs(props.pitch.cents) < 8 ? 'in-tune' : ''}`}>
            <b>{props.pitch.note || '—'}</b>
            <span>{props.pitch.note ? `${props.pitch.cents > 0 ? '+' : ''}${props.pitch.cents.toFixed(0)}¢` : '静音'}</span>
          </div>
        )}

        <div className="tempo">
          <button className="btn tiny" onClick={() => props.onTempoDelta(-4)} disabled={disabled}>
            −
          </button>
          <div className="tempo-value">
            <b>{Math.round(tempo)}</b>
            <span>BPM</span>
          </div>
          <button className="btn tiny" onClick={() => props.onTempoDelta(4)} disabled={disabled}>
            +
          </button>
        </div>
      </div>

      <div className="transport-sub">
        <label className="chip">
          <span>速度</span>
          <select value={rate} onChange={(e) => props.onRate(Number(e.target.value))} disabled={disabled}>
            {[0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5].map((r) => (
              <option key={r} value={r}>
                {Math.round(r * 100)}%
              </option>
            ))}
          </select>
        </label>

        <label className={`chip toggle ${props.metronome ? 'on' : ''}`}>
          <input type="checkbox" checked={props.metronome} onChange={(e) => props.onMetronome(e.target.checked)} />
          节拍器
        </label>

        <label className={`chip toggle ${props.autoScroll ? 'on' : ''}`}>
          <input type="checkbox" checked={props.autoScroll} onChange={(e) => props.onAutoScroll(e.target.checked)} />
          自动滚动
        </label>

        <label className={`chip toggle ${props.follow ? 'on' : ''}`} title="用麦克风听你弹，谱面跟着你走">
          <input type="checkbox" checked={props.follow} onChange={(e) => props.onFollow(e.target.checked)} />
          跟我弹
        </label>

        <span className="hint-text">空格播放/暂停 · ←/→ 切换音符 · 点击谱面任意位置跳转</span>
      </div>
    </div>
  );
}