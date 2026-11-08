/** 验证「跟我弹」：用 E2(82.41Hz) 音频模拟弹奏，检查命中计数与光标推进 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9346;
const tone = resolve('tone-e2.wav');
const profile = await mkdtemp(join(tmpdir(), 'gf-follow-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${tone}`,
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1440,960',
  'http://127.0.0.1:5123/',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pending = new Map();
let id = 0;
const errors = [];
try {
  let v;
  for (let i = 0; i < 80; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(250); } }
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') { const t = m.params.args.map((a) => a.value ?? a.description).join(' '); if (t.includes('gf-follow')) errors.push(t.slice(0, 200)); }
  });
  const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('5123'));
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: page.id, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s('Runtime.enable');
  const ev = async (expr) => {
    const r = await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  const waitFor = async (expr, t = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if (await ev(`!!(${expr})`).catch(() => false)) return true; await sleep(200); } return false; };

  await waitFor("document.querySelector('.score-card')");
  await ev("document.querySelector('.score-card').click()");
  await waitFor("document.querySelector('.gf-cursor')", 20000);
  await sleep(800);

  const before = await ev(`({ acc: document.querySelector('.acc')?.textContent, cursor: document.querySelector('.gf-cursor')?.style.left, expected: document.querySelector('.expected b')?.textContent })`);

  // 勾选「跟我弹」
  await ev(`(() => { const label = Array.from(document.querySelectorAll('.chip.toggle')).find((l) => l.textContent.includes('跟我弹')); const input = label?.querySelector('input'); input?.click(); return !!input; })()`);
  await sleep(3500);

  const during = await ev(`({
    acc: document.querySelector('.acc')?.textContent,
    cursor: document.querySelector('.gf-cursor')?.style.left,
    expected: document.querySelector('.expected b')?.textContent,
    note: document.querySelector('.note-big')?.textContent,
    followPill: Array.from(document.querySelectorAll('.pill')).map((p) => p.textContent).join('|'),
    listening: document.querySelector('.pill.live')?.textContent ?? '',
  })`);

  const shot = await s('Page.captureScreenshot', { format: 'png' });
  await writeFile('smoke-follow.png', Buffer.from(shot.result.data, 'base64'));
  console.log(JSON.stringify({ before, during, errors: errors.slice(0, 5) }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ fatal: String(e?.stack ?? e), errors }));
} finally {
  chrome.kill();
  process.exit(0);
}