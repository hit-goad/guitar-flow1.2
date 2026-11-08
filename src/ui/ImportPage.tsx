import { useRef, useState } from 'react';
import { importFile, importFromText, importMultiPageImages } from '../import';
import { recognizeImagePages } from '../import/omr/omr';
import { putScore } from '../core/library';
import { httpGetText, pickFiles } from '../core/platform';

interface Props {
  onSaved(docId: string): void;
  onNotify(message: string): void;
}

interface Preview {
  id?: string;
  name: string;
  title: string;
  format: string;
  warnings: string[];
  noteCount?: number;
  chords?: string[];
}

export function ImportPage({ onSaved, onNotify }: Props) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mergeImages, setMergeImages] = useState(true);
  const [resolveChordX, setResolveChordX] = useState(true);
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteArtist, setPasteArtist] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [url, setUrl] = useState('');
  const [omrText, setOmrText] = useState('');
  const [omrAlphaTex, setOmrAlphaTex] = useState('');
  const [omrPages, setOmrPages] = useState<Blob[]>([]);
  const [omrInfo, setOmrInfo] = useState<{
    systems: number;
    measures: number;
    glyphs: number;
    chords: string[];
    confidence: number;
    pages: number;
  } | null>(null);
  const [omrBusy, setOmrBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    const results: Preview[] = [];

    try {
      const imageFiles = files.filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name));
      const otherFiles = files.filter((f) => !/\.(png|jpe?g|webp)$/i.test(f.name));

      // 若用户同时拖入多张图片且开启了「合并为同一首多页曲谱」，自动按页序合并识谱
      if (mergeImages && imageFiles.length > 1) {
        try {
          const inputs = await Promise.all(
            imageFiles.map(async (f) => ({
              name: f.name,
              bytes: new Uint8Array(await f.arrayBuffer()),
              mime: f.type,
            })),
          );
          const out = await importMultiPageImages(inputs, pasteTitle.trim() || undefined, pasteArtist.trim() || undefined);
          await putScore(out.doc);
          results.push({
            id: out.doc.id,
            name: `${imageFiles.length} 张曲谱图合并`,
            title: out.doc.title,
            format: out.doc.format === 'alphatex' ? '可滚动六线谱' : '图片谱',
            warnings: out.warnings,
            noteCount: out.doc.meta.noteCount,
            chords: out.doc.meta.chords,
          });
          onSaved(out.doc.id);
        } catch (err) {
          results.push({
            name: '多图合并',
            title: '导入失败',
            format: '错误',
            warnings: [(err as Error).message],
          });
        }
      } else {
        otherFiles.push(...imageFiles);
      }

      for (const file of otherFiles) {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const out = await importFile({ name: file.name, bytes, mime: file.type });
          await putScore(out.doc);
          results.push({
            id: out.doc.id,
            name: file.name,
            title: out.doc.title,
            format: out.doc.format === 'alphatex' ? '可滚动六线谱' : out.doc.format,
            warnings: out.warnings,
            noteCount: out.doc.meta.noteCount,
            chords: out.doc.meta.chords,
          });
          if (out.doc.meta.omrAscii) {
            setOmrText(out.doc.meta.omrAscii);
            setOmrAlphaTex(out.doc.text ?? '');
            setOmrPages(out.doc.pages ?? []);
          }
          onSaved(out.doc.id);
        } catch (err) {
          results.push({ name: file.name, title: '导入失败', format: '错误', warnings: [(err as Error).message] });
        }
      }
    } finally {
      setPreviews((p) => [...results, ...p]);
      setBusy(false);
      const ok = results.filter((r) => !r.title.includes('失败')).length;
      onNotify(ok ? `成功导入并转换 ${ok} 份可滚动曲谱` : '导入失败，详见下方提示');
    }
  };

  const pick = async () => {
    const files = await pickFiles(
      '.gp,.gp3,.gp4,.gp5,.gpx,.gp7,.musicxml,.xml,.mid,.midi,.tex,.txt,.tab,.crd,.cho,.chordpro,.pdf,.png,.jpg,.jpeg,.webp',
    );
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
        {
          id: out.doc.id,
          name: '粘贴文本',
          title: out.doc.title,
          format: '可滚动六线谱',
          warnings: out.warnings,
          noteCount: out.doc.meta.noteCount,
        },
        ...p,
      ]);
      onSaved(out.doc.id);
      setPasteText('');
      onNotify(`已精准转换《${out.doc.title}》`);
    } catch (err) {
      onNotify(`转换失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const runOmrWorkbench = async () => {
    setOmrBusy(true);
    try {
      const files = await pickFiles('image/*,.pdf,.png,.jpg,.jpeg,.webp');
      if (!files.length) return;
      const pageBlobs: Blob[] = [];
      for (const file of files) {
        if (/\.pdf$/i.test(file.name)) {
          const { pdfToPageImages } = await import('../import/pdf');
          const rendered = await pdfToPageImages(await file.arrayBuffer(), 2.2);
          pageBlobs.push(...rendered);
        } else {
          pageBlobs.push(file);
        }
      }

      const inferredTitle =
        pasteTitle.trim() ||
        files[0].name
          .replace(/\.[^.]+$/, '')
          .replace(/[-_\s]*(?:page|p|第)?\s*\d+\s*页?$/i, '')
          .trim() ||
        '图片识谱曲目';
      if (!pasteTitle.trim()) setPasteTitle(inferredTitle);

      const res = await recognizeImagePages(pageBlobs, {
        title: inferredTitle,
        artist: pasteArtist.trim(),
        resolveChordX,
      });

      setOmrText(res.ascii);
      setOmrAlphaTex(res.alphaTex);
      setOmrPages(pageBlobs);
      setOmrInfo({
        systems: res.systems,
        measures: res.measures,
        glyphs: res.glyphs,
        chords: res.chords,
        confidence: res.confidence,
        pages: pageBlobs.length,
      });

      if (!res.ascii.trim()) {
        onNotify('未检测到六线谱弦线：该图可能是纯歌词谱或分辨率过低');
      } else {
        onNotify(
          `识别完成：${res.systems} 行谱表 · ${res.measures} 小节 · ${res.glyphs} 个音符（置信度 ${(res.confidence * 100).toFixed(0)}%），可校对或一键生成可滚动曲谱`,
        );
      }
    } catch (err) {
      onNotify(`识谱失败：${(err as Error).message}`);
    } finally {
      setOmrBusy(false);
    }
  };

  const saveOmrAsScrollableScore = async (useDirectAlphaTex: boolean) => {
    try {
      const title = pasteTitle.trim() || '图片识谱曲目';
      const artist = pasteArtist.trim();
      const sourceText = useDirectAlphaTex && omrAlphaTex.trim() ? omrAlphaTex : omrText;
      const out = importFromText(sourceText, {
        title,
        artist,
        sourceId: 'omr',
        sourceName: 'PDF/图片精准识谱',
        pages: omrPages.length ? omrPages : undefined,
      });
      out.doc.meta.omrAscii = omrText;
      out.doc.meta.chords = omrInfo?.chords;
      out.doc.meta.omrConfidence = omrInfo?.confidence;
      out.doc.meta.noteCount = omrInfo?.glyphs ?? out.doc.meta.noteCount;
      await putScore(out.doc);
      setPreviews((p) => [
        {
          id: out.doc.id,
          name: `识谱转换 (${omrPages.length || 1}页)`,
          title: out.doc.title,
          format: '可滚动六线谱',
          warnings: out.warnings,
          noteCount: out.doc.meta.noteCount,
          chords: out.doc.meta.chords,
        },
        ...p,
      ]);
      onSaved(out.doc.id);
      onNotify(`已生成可滚动曲谱《${out.doc.title}》`);
    } catch (err) {
      onNotify(`转换失败：${(err as Error).message}`);
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
      setPreviews((p) => [
        { id: out.doc.id, name: url, title: out.doc.title, format: '可滚动六线谱', warnings: out.warnings },
        ...p,
      ]);
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
          <h1>导入与图片/PDF 精准识谱</h1>
          <p className="muted">
            支持 PDF / JPG / PNG / WebP 图片曲谱、Guitar Pro、MusicXML、MIDI、ASCII 六线谱与 ChordPro，自动识别和弦图、品位与节奏并精准转换为可滚动、可逐音发声的交互六线谱
          </p>
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
        <b>{busy ? '正在识别与转换曲谱…' : '点击选择或把 PDF / JPG / PNG / GP 曲谱拖到这里（直接转换为可滚动六线谱）'}</b>
        <span className="muted small">
          支持：PDF（文本/扫描版） · JPG / PNG / WebP 六线谱图片 · Guitar Pro(.gp3/4/5/gpx) · MusicXML · MIDI · 六线谱 TXT · ChordPro
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

      <div className="row" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <label className="chip toggle on" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={mergeImages} onChange={(e) => setMergeImages(e.target.checked)} />
          同时拖入多张 JPG/PNG 时自动合并为同一首多页可滚动曲谱
        </label>
        <label className="chip toggle on" style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={resolveChordX} onChange={(e) => setResolveChordX(e.target.checked)} />
          识别谱表上方和弦图并将「×」伴奏音型自动还原为真实和弦品位
        </label>
      </div>

      <div className="panel omr-panel">
        <div className="local-head">
          <div>
            <h3>PDF / JPG / PNG 曲谱识别与校对工作台</h3>
            <p className="muted small">
              自动完成彩色水印消除、6 弦谱表与小节竖线定位、上方和弦指法图（C/G/Am/Em/F/D 等）几何识别、品位数字分类与符尾时值分析。支持直接生成可滚动曲谱，也可在下方微调文本后再生成。
            </p>
          </div>
          <button className="btn primary" disabled={omrBusy} onClick={() => void runOmrWorkbench()}>
            {omrBusy ? '高精度识别中…' : '选择 PDF / JPG / PNG 识别并预览'}
          </button>
        </div>

        {omrInfo && (
          <div className="omr-meta" style={{ marginTop: 10 }}>
            <span className="tag">谱表 {omrInfo.systems} 行</span>
            <span className="tag">小节 {omrInfo.measures} 个</span>
            <span className="tag">识别音符 {omrInfo.glyphs} 个</span>
            <span className="tag subtle">置信度 {(omrInfo.confidence * 100).toFixed(0)}%</span>
            <span className="tag subtle">共 {omrInfo.pages} 页</span>
            {omrInfo.chords.length > 0 && (
              <span className="tag subtle">
                识别和弦：{omrInfo.chords.slice(0, 12).join(' → ')}
                {omrInfo.chords.length > 12 ? '…' : ''}
              </span>
            )}
          </div>
        )}

        {omrText && (
          <>
            <div className="field-grid" style={{ marginTop: 10 }}>
              <label>
                <span>曲名</span>
                <input
                  className="input"
                  value={pasteTitle}
                  onChange={(e) => setPasteTitle(e.target.value)}
                  placeholder="输入曲名"
                />
              </label>
              <label>
                <span>歌手 / 编配</span>
                <input
                  className="input"
                  value={pasteArtist}
                  onChange={(e) => setPasteArtist(e.target.value)}
                  placeholder="输入歌手或制谱者"
                />
              </label>
            </div>
            <textarea
              className="textarea"
              rows={11}
              value={omrText}
              onChange={(e) => {
                setOmrText(e.target.value);
                setOmrAlphaTex('');
              }}
            />
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <button className="btn primary" onClick={() => void saveOmrAsScrollableScore(true)}>
                ⚡ 直接生成可滚动曲谱（保留原谱对照）
              </button>
              <button className="btn" onClick={() => void saveOmrAsScrollableScore(false)}>
                按编辑后的六线谱文本重新生成
              </button>
              <span className="muted small">
                提示：上方文本中的数字即为各弦品位，可直接手工修改任意小节或数字后重新生成
              </span>
            </div>
          </>
        )}
      </div>

      <div className="grid-2">
        <div className="panel">
          <h3>粘贴六线谱 / 和弦谱文本</h3>
          <div className="field-grid">
            <label>
              <span>曲名</span>
              <input
                className="input"
                value={pasteTitle}
                onChange={(e) => setPasteTitle(e.target.value)}
                placeholder="例如：500 Miles / Amani"
              />
            </label>
            <label>
              <span>歌手</span>
              <input
                className="input"
                value={pasteArtist}
                onChange={(e) => setPasteArtist(e.target.value)}
                placeholder="例如：The Journeymen / Beyond"
              />
            </label>
          </div>
          <textarea
            className="textarea"
            rows={8}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={
              'e|--0---2---3---|\nB|--1---3---0---|\nG|--0---2---0---|\nD|--2---0---2---|\nA|--3-------3---|\nE|------------3-|\n\n或 ChordPro：\n[Am]Today is gonna be the day\n[F]That they\'re gonna throw it back to [C]you'
            }
          />
          <button className="btn primary" onClick={importPaste} disabled={busy || !pasteText.trim()}>
            智能转换为可滚动曲谱
          </button>
        </div>

        <div className="panel">
          <h3>从网页 URL 导入</h3>
          <p className="muted small">输入包含六线谱或和弦谱的网页地址，自动抓取并转换为可滚动曲谱。</p>
          <input
            className="input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.jita5.cn/qupu/..."
          />
          <button className="btn" onClick={importUrl} disabled={busy || !url.trim()}>
            抓取并转换
          </button>

          <h3 style={{ marginTop: 24 }}>最近导入与转换记录</h3>
          <div className="preview-list">
            {previews.map((p, i) => (
              <div className="preview-item" key={`${p.name}-${i}`}>
                <div className="preview-head">
                  <b>{p.title}</b>
                  <span className="muted small">{p.name}</span>
                </div>
                <div className="row" style={{ gap: 6, margin: '4px 0', flexWrap: 'wrap' }}>
                  <span className="tag">{p.format}</span>
                  {p.noteCount ? <span className="tag subtle">{p.noteCount} 个音符</span> : null}
                  {p.chords?.length ? (
                    <span className="tag subtle">和弦：{p.chords.slice(0, 6).join(' ')}</span>
                  ) : null}
                  {p.id && (
                    <button className="btn tiny primary" onClick={() => onSaved(p.id!)}>
                      打开跟练
                    </button>
                  )}
                </div>
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