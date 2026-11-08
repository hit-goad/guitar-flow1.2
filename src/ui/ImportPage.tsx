import { useRef, useState } from 'react';
import { importFile, importFromText } from '../import';
import { recognizeTablature } from '../import/omr/omr';
import { putScore } from '../core/library';
import { httpGetText, pickFiles } from '../core/platform';

interface Props {
  onSaved(docId: string): void;
  onNotify(message: string): void;
}

interface Preview {
  name: string;
  title: string;
  warnings: string[];
  noteCount?: number;
}

export function ImportPage({ onSaved, onNotify }: Props) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteArtist, setPasteArtist] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [url, setUrl] = useState('');
  const [omrText, setOmrText] = useState('');
  const [omrInfo, setOmrInfo] = useState<{ systems: number; glyphs: number; confidence: number; pages: number } | null>(null);
  const [omrBusy, setOmrBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    const results: Preview[] = [];
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const out = await importFile({ name: file.name, bytes, mime: file.type });
        await putScore(out.doc);
        results.push({
          name: file.name,
          title: out.doc.title,
          warnings: out.warnings,
          noteCount: out.doc.meta.noteCount,
        });
        onSaved(out.doc.id);
      } catch (err) {
        results.push({ name: file.name, title: '导入失败', warnings: [(err as Error).message] });
      }
    }
    setPreviews((p) => [...results, ...p]);
    setBusy(false);
    const ok = results.filter((r) => !r.title.includes('失败')).length;
    onNotify(ok ? `已导入 ${ok} 份曲谱` : '导入失败，详见下方提示');
  };

  const pick = async () => {
    const files = await pickFiles('.gp,.gp3,.gp4,.gp5,.gpx,.gp7,.musicxml,.xml,.mid,.midi,.tex,.txt,.tab,.crd,.cho,.chordpro,.pdf,.png,.jpg,.jpeg,.webp');
    if (files.length) void handleFiles(files);
    else inputRef.current?.click();
  };

  const importPaste = async () => {
    if (!pasteText.trim()) return;
    setBusy(true);
    try {
      const out = importFromText(pasteText, {
        title: pasteTitle.trim() || '粘贴导入',
        artist: pasteArtist.trim(),
        sourceId: 'clipboard',
        sourceName: '粘贴导入',
      });
      await putScore(out.doc);
      setPreviews((p) => [
        { name: '粘贴文本', title: out.doc.title, warnings: out.warnings, noteCount: out.doc.meta.noteCount },
        ...p,
      ]);
      onSaved(out.doc.id);
      setPasteText('');
      onNotify(`已转换《${out.doc.title}》`);
    } catch (err) {
      onNotify(`转换失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const runOmr = async () => {
    setOmrBusy(true);
    try {
      const files = await pickFiles('image/*,.pdf');
      if (!files.length) return;
      const parts: string[] = [];
      let systems = 0;
      let glyphs = 0;
      let confSum = 0;
      let confCount = 0;

      const readImage = async (source: Blob) => {
        const bitmap = await createImageBitmap(source);
        const scale = bitmap.width > 2000 ? 2000 / bitmap.width : 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('画布不可用');
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const res = recognizeTablature(img.data, canvas.width, canvas.height);
        systems += res.systems;
        glyphs += res.glyphs;
        if (res.glyphs) {
          confSum += res.confidence;
          confCount++;
        }
        if (res.ascii) parts.push(res.ascii);
        bitmap.close?.();
      };

      for (const file of files) {
        if (/pdf$/i.test(file.name)) {
          const { importPdf } = await import('../import/pdf');
          const res = await importPdf(await file.arrayBuffer(), file.name);
          for (const page of res.pages ?? []) await readImage(page);
        } else {
          await readImage(file);
        }
      }

      const merged = parts.join('\n');
      setOmrText(merged);
      setOmrInfo({ systems, glyphs, confidence: confCount ? confSum / confCount : 0, pages: files.length });
      if (!merged.trim()) onNotify('没有识别出内容：可能是五线谱或扫描质量太差，建议用图片谱模式');
      else onNotify(`识别完成：${systems} 行谱表，${glyphs} 个音符，请检查后生成`);
      if (!pasteTitle.trim() && files.length) setPasteTitle(files[0].name.replace(/\.[^.]+$/, ''));
    } catch (err) {
      onNotify(`识谱失败：${(err as Error).message}`);
    } finally {
      setOmrBusy(false);
    }
  };

  const importUrl = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      const text = await httpGetText(url.trim());
      const name = url.split('/').pop()?.split('?')[0] || 'url-import';
      const out = importFromText(text, {
        title: name.replace(/\.[^.]+$/, ''),
        sourceId: 'url',
        sourceName: 'URL 导入',
        url,
      });
      await putScore(out.doc);
      setPreviews((p) => [{ name: url, title: out.doc.title, warnings: out.warnings }, ...p]);
      onSaved(out.doc.id);
      onNotify(`已从 URL 导入《${out.doc.title}》`);
    } catch (err) {
      onNotify(`URL 导入失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page import-page">
      <header className="page-head">
        <div>
          <h1>导入曲谱</h1>
          <p className="muted">拖进来就自动识别；文本谱/和弦谱会被转换成可滚动、逐音符发声的六线谱</p>
        </div>
      </header>

      <div
        className={`dropzone ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void handleFiles(Array.from(e.dataTransfer.files));
        }}
        onClick={pick}
      >
        <div className="drop-icon">⤓</div>
        <b>{busy ? '处理中…' : '把曲谱文件拖到这里'}</b>
        <span className="muted small">
          Guitar Pro(.gp3/4/5/gpx) · MusicXML · MIDI · alphaTex · 六线谱 txt · ChordPro · PDF · 图片
        </span>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void handleFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>

      <div className="panel omr-panel">
        <div className="local-head">
          <div>
            <h3>图片 / PDF 识谱（Beta）</h3>
            <p className="muted small">
              自动检测六线谱表与品位数字，识别结果先展示成文本，你确认/改正后再生成可滚动曲谱。
              印刷清晰的谱识别效果最好；手写或扫描模糊的谱建议直接用图片谱模式。
            </p>
          </div>
          <button className="btn" disabled={omrBusy} onClick={() => void runOmr()}>
            {omrBusy ? '识别中…' : '选择图片/PDF 识别'}
          </button>
        </div>

        {omrInfo && (
          <div className="omr-meta">
            <span className="tag">谱表 {omrInfo.systems} 行</span>
            <span className="tag subtle">读出 {omrInfo.glyphs} 个音符</span>
            <span className="tag subtle">置信度 {(omrInfo.confidence * 100).toFixed(0)}%</span>
            <span className="tag subtle">页数 {omrInfo.pages}</span>
          </div>
        )}

        {omrText && (
          <>
            <textarea className="textarea" rows={10} value={omrText} onChange={(e) => setOmrText(e.target.value)} />
            <div className="row">
              <button
                className="btn primary"
                onClick={async () => {
                  try {
                    const out = importFromText(omrText, {
                      title: pasteTitle.trim() || '识谱结果',
                      artist: pasteArtist.trim(),
                      sourceId: 'omr',
                      sourceName: '图片识谱',
                    });
                    await putScore(out.doc);
                    setPreviews((p) => [
                      { name: '识谱结果', title: out.doc.title, warnings: out.warnings, noteCount: out.doc.meta.noteCount },
                      ...p,
                    ]);
                    onSaved(out.doc.id);
                    onNotify(`已生成《${out.doc.title}》`);
                  } catch (err) {
                    onNotify(`转换失败：${(err as Error).message}`);
                  }
                }}
              >
                用识别结果生成曲谱
              </button>
              <span className="muted small">识别内容可直接编辑：把读错的数字改掉再生成即可</span>
            </div>
          </>
        )}
      </div>

      <div className="grid-2">
        <div className="panel">
          <h3>粘贴文本谱</h3>
          <div className="field-grid">
            <label>
              <span>曲名</span>
              <input className="input" value={pasteTitle} onChange={(e) => setPasteTitle(e.target.value)} placeholder="例如：Wonderwall" />
            </label>
            <label>
              <span>歌手</span>
              <input className="input" value={pasteArtist} onChange={(e) => setPasteArtist(e.target.value)} placeholder="例如：Oasis" />
            </label>
          </div>
          <textarea
            className="textarea"
            rows={8}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={'e|--0---2---3---|\nB|--1---3---0---|\nG|--0---2---0---|\nD|--2---0---2---|\nA|--3-------3---|\nE|------------3-|\n\n或 ChordPro：\n[Am]Today is gonna be the day\n[F]That they\'re gonna throw it back to [C]you'}
          />
          <button className="btn primary" onClick={importPaste} disabled={busy || !pasteText.trim()}>
            智能转换
          </button>
        </div>

        <div className="panel">
          <h3>从 URL 导入</h3>
          <p className="muted small">直接抓取网页上的六线谱/和弦谱文本，适合谱站链接。</p>
          <input
            className="input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/tab/xxx"
          />
          <button className="btn" onClick={importUrl} disabled={busy || !url.trim()}>
            抓取并转换
          </button>

          <h3 style={{ marginTop: 24 }}>最近导入</h3>
          <div className="preview-list">
            {previews.map((p, i) => (
              <div className="preview-item" key={`${p.name}-${i}`}>
                <div className="preview-head">
                  <b>{p.title}</b>
                  <span className="muted small">{p.name}</span>
                </div>
                {p.noteCount ? <span className="tag subtle">{p.noteCount} 个音符</span> : null}
                {p.warnings.map((w, j) => (
                  <div className="warn-line" key={j}>
                    {w}
                  </div>
                ))}
              </div>
            ))}
            {!previews.length && <p className="muted small">还没有导入记录</p>}
          </div>
        </div>
      </div>
    </div>
  );
}