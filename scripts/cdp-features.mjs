/** 验证：本机曲库索引、录音库页面、识谱面板是否存在且可交互 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\Program Files\Google\Chrome\Application\chrome.exe';
const PORT = 9352;
const profile = await mkdtemp(join(tmpdir(), 'gf-feat-'));
const attachPort = process.env.CDP_PORT;
const chrome = attachPort ? null : spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1440,960', 'http://127.0.0.1:5123/'], { stdio: 'ignore' });
const port = attachPort ? Number(attachPort) : PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pending = new Map();
let id = 0;
const errors = [];
try {
  let v;
  for (let i = 0; i < 80; i++) { try { v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(250); } }
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 200));
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.text ?? 'exception');
  });
  const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const created = await send('Target.createTarget', { url: 'http://127.0.0.1:5123/' });
  const targetId = created.result?.targetId;
  if (!targetId) throw new Error('无法创建页面: ' + JSON.stringify(created).slice(0, 200));
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s('Runtime.enable');
  const ev = async (expr) => {
    const r = await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  const waitFor = async (expr, t = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if (await ev(`!!(${expr})`).catch(() => false)) return true; await sleep(200); } return false; };

  await waitFor("document.querySelector('.score-card')");
  const library = await ev(`({
    total: document.querySelector('.page-head .muted')?.textContent?.trim(),
    localTitle: document.querySelector('.local-library h3')?.textContent,
    localCount: document.querySelectorAll('.local-item').length,
    firstLocal: document.querySelector('.local-title')?.textContent,
  })`);

  // 搜索本机曲库
  await ev(`(() => { const i = document.querySelector('.local-library input.input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '晴天'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(500);
  const localSearch = await ev(`Array.from(document.querySelectorAll('.local-title')).slice(0, 5).map((x) => x.textContent)`);

  // 切到录音库
  await ev(`Array.from(document.querySelectorAll('.sidebar nav button')).find((b) => b.textContent.includes('录音')).click()`);
  await sleep(700);
  const takes = await ev(`({ heading: document.querySelector('.takes-page h1')?.textContent, empty: document.querySelector('.takes-page .empty-state h2')?.textContent })`);

  // 切到导入页看识谱面板
  await ev(`Array.from(document.querySelectorAll('.sidebar nav button')).find((b) => b.textContent.includes('导入')).click()`);
  await sleep(600);
  const omr = await ev(`({ heading: document.querySelector('.omr-panel h3')?.textContent, hasButton: !!Array.from(document.querySelectorAll('.omr-panel button')).find((b) => b.textContent.includes('识别')) })`);

  const shot = await s('Page.captureScreenshot', { format: 'png' });
  await writeFile('smoke-features.png', Buffer.from(shot.result.data, 'base64'));
  console.log(JSON.stringify({ library, localSearch, takes, omr, errors: errors.slice(0, 6) }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ fatal: String(e?.stack ?? e), errors }));
} finally {
  chrome?.kill();
  process.exit(0);
}
