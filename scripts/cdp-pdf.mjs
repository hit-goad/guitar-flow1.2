/** 验证 PDF / 图片导入（走 pdfjs worker 与页图渲染） */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9344;
const PDF = resolve('..', 'last-night-on-earth_完整吉他谱.pdf');
const IMG = resolve('..', '吉他世界_第1页预览.png');
const profile = await mkdtemp(join(tmpdir(), 'gf-pdf-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1440,960', 'http://127.0.0.1:5123/'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pending = new Map();
let id = 0;
const errors = [];
async function main() {
  let v;
  for (let i = 0; i < 80; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(250); } }
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 160));
  });
  const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('5123'));
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: page.id, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s('Page.enable'); await s('Runtime.enable'); await s('DOM.enable');
  const ev = async (expr) => {
    const r = await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  const waitFor = async (expr, t = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if (await ev(`!!(${expr})`).catch(() => false)) return true; await sleep(250); } return false; };

  await waitFor("document.querySelector('.score-card')");
  await ev(`Array.from(document.querySelectorAll('.sidebar nav button')).find((b) => b.textContent.includes('导入')).click()`);
  await waitFor("document.querySelector('.import-page input[type=file]')");

  const setFile = async (file) => {
    const doc = await s('DOM.getDocument', { depth: -1 });
    const node = await s('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '.import-page input[type=file]' });
    await s('DOM.setFileInputFiles', { files: [file], nodeId: node.result.nodeId });
    await sleep(2500);
  };

  const before = await ev("document.querySelectorAll('.preview-item').length");
  await setFile(PDF);
  const afterPdf = await ev(`({
    previews: Array.from(document.querySelectorAll('.preview-item')).map((p) => ({ title: p.querySelector('b')?.textContent, meta: p.querySelector('.tag')?.textContent, warn: Array.from(p.querySelectorAll('.warn-line')).map((w) => w.textContent) })),
    banner: document.querySelector('.error-banner')?.textContent ?? '',
    toast: document.querySelector('.toast')?.textContent ?? '',
  })`);

  await setFile(IMG);
  await sleep(1500);
  const afterImg = await ev(`({
    previews: Array.from(document.querySelectorAll('.preview-item')).map((p) => ({ title: p.querySelector('b')?.textContent, meta: p.querySelector('.tag')?.textContent, warn: Array.from(p.querySelectorAll('.warn-line')).map((w) => w.textContent) })),
    banner: document.querySelector('.error-banner')?.textContent ?? '',
  })`);

  // 打开图片谱，确认页面可见并可打点
  await ev(`Array.from(document.querySelectorAll('.sidebar nav button')).find((b) => b.textContent.includes('曲库')).click()`);
  await sleep(700);
  const cards = await ev(`Array.from(document.querySelectorAll('.score-card h3')).map((h) => h.textContent)`);
  await ev(`(() => { const c = Array.from(document.querySelectorAll('.score-card')).find((x) => /预览|last/i.test(x.querySelector('h3')?.textContent ?? '') || x.querySelector('.tag')?.textContent === '图片谱'); c?.click(); return !!c; })()`);
  await sleep(2200);
  const imageView = await ev(`({
    pages: document.querySelectorAll('.page-sheet img').length,
    tapButton: Array.from(document.querySelectorAll('button')).some((b) => b.textContent.includes('打点同步')),
    transport: !!document.querySelector('.transport'),
    error: document.querySelector('.error-banner')?.textContent ?? '',
  })`);
  const shot = await s('Page.captureScreenshot', { format: 'png' });
  await writeFile('smoke-pdf.png', Buffer.from(shot.result.data, 'base64'));

  console.log(JSON.stringify({ before, afterPdf, afterImg, cards, imageView, errors: errors.slice(0, 6) }, null, 2));
}
try { await main(); } catch (e) { console.log(JSON.stringify({ fatal: String(e?.stack ?? e), errors })); }
finally { chrome.kill(); process.exit(0); }