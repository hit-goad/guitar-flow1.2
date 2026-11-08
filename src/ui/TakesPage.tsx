import { useCallback, useEffect, useRef, useState } from 'react';
import type { TakeRecord } from '../core/library';
import { deleteTake, formatDuration, formatSize, listTakes, renameTake } from '../core/takes';
import { saveBlob } from '../core/platform';
import { encodeMp3, resample } from '../audio/mp3';
import { decodeToSamples } from '../audio/decode';

interface Props {
  onNotify(message: string): void;
  refreshKey: number;
}

/**
 * 录音库：列表 + 回放 + 改名 + 导出（WAV/MP3）+ 删除。
 * 对应参考 App 里「录完能听、能导出」的那部分体验。
 */
export function TakesPage({ onNotify, refreshKey }: Props) {
  const [takes, setTakes] = useState<TakeRecord[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const reload = useCallback(async () => {
    setTakes(await listTakes());
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  useEffect(
    () => () => {
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const play = (take: TakeRecord) => {
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
    audio.onended = () => setPlayingId(null);
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

  return (
    <div className="page takes-page">
      <header className="page-head">
        <div>
          <h1>录音库</h1>
          <p className="muted">
            {takes.length} 段录音 · 录音时同步播放曲谱，可导出 WAV / MP3（MP3 用 LAME 编码，与常见练琴 App 一致）
          </p>
        </div>
      </header>

      {!takes.length && (
        <div className="empty-state">
          <div className="empty-icon">⏺</div>
          <h2>还没有录音</h2>
          <p className="muted">打开一份曲谱 → 点「麦克风录音」或「内录当前曲目」，录完就会出现在这里。</p>
        </div>
      )}

      <div className="take-list">
        {takes.map((take) => (
          <div className={`take-row ${playingId === take.id ? 'playing' : ''}`} key={take.id}>
            <button className="btn round primary" onClick={() => play(take)}>
              {playingId === take.id ? '❚❚' : '▶'}
            </button>
            <div className="take-main">
              <div className="take-title">
                {take.title}
                <span className="tag subtle">{take.kind === 'mic' ? '麦克风' : '应用内录'}</span>
              </div>
              <div className="muted small">
                {formatDuration(take.durationSec)} · {formatSize(take.size)} ·{' '}
                {new Date(take.createdAt).toLocaleString('zh-CN')}
                {take.scoreTitle ? ` · ${take.scoreTitle}` : ''}
              </div>
            </div>
            <div className="take-actions">
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