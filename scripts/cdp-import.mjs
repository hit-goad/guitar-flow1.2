/** 端到端验证导入流程：ASCII 六线谱 + ChordPro 文本 → 可播放谱面 */
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5123/';
const PORT = 9336;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = await mkdtemp(join(tmpdir(), 'gf-import-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--autoplay-policy=no-user-gesture-required', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1440,960', 'about:blank'], { stdio: 'ignore' });

const ASCII = `Song: Test Riff
Artist: GF
e|--0---3---5---3---0-------|
B|--1---3---5---3---1-------|
G|--0---2---4---2---0-------|
D|--2---0---2---0---2-------|
A|--3-------3-------3-------|
E|--------------------------|`;

const CHORDPRO = `{title: Test Ballad}
{artist: GF}
{tempo: 88}
{capo: 2}
[Am]This is a [F]test of the [C]chord parser
[G]Second line [Am]keeps going`;

let ws;
let id = 0;
const pending = new Map();
const errors = [];

async function version() {
  for (let i = 0; i < 80; i++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); }
  }
  throw new Error('chrome not ready');
}

try {
  const v = await version();
  ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.text ?? 'exception');
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 200));
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s('Page.enable'); await s('Runtime.enable');
  await s('Page.navigate', { url: APP_URL });

  const ev = async (expr) => {
    const r = await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const waitFor = async (expr, timeout = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (await ev(`!!(${expr})`).catch(() => false)) return true; await sleep(200); }
    return false;
  };

  await waitFor("document.querySelector('.score-card')");
  const out = {};

  const importText = async (title, text) => {
    await ev(`Array.from(document.querySelectorAll('.sidebar nav button')).find((b) => b.textContent.includes('导入')).click()`);
    await waitFor("document.querySelector('textarea')");
    await ev(`(() => {
      const ta = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const inputs = document.querySelectorAll('.import-page input.input');
      const t = inputs[0];
      const is = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      is.call(t, ${JSON.stringify(title)});
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
    await ev(`Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === '智能转换').click()`);
    await sleep(1800);
    return ev(`({ toast: document.querySelector('.toast')?.textContent ?? '', banner: document.querySelector('.error-banner')?.textContent ?? '', previews: Array.from(document.querySelectorAll('.preview-item b')).map((x) => x.textContent), warnings: Array.from(document.querySelectorAll('.warn-line')).map((x) => x.textContent) })`);
  };

  out.ascii = await importText('Test Riff', ASCII);
  out.chordpro = await importText('Test Ballad', CHORDPRO);

  // 回到曲库，确认新增两份
  await ev(`Array.from(document.querySelectorAll('.sidebar nav button')).find((b) => b.textContent.includes('曲库')).click()`);
  await sleep(600);
  out.library = await ev(`({ cards: Array.from(document.querySelectorAll('.score-card h3')).map((h) => h.textContent) })`);

  // 打开 ASCII 导入的那份，确认渲染与时长
  await ev(`(() => { const card = Array.from(document.querySelectorAll('.score-card')).find((c) => c.querySelector('h3')?.textContent.includes('Test Riff')); card?.click(); return !!card; })()`);
  await waitFor("document.querySelector('.gf-cursor')", 20000);
  await sleep(1200);
  out.rendered = await ev(`(() => ({
    pos: document.querySelector('.seek-meta')?.textContent ?? '',
    cursor: document.querySelector('.gf-cursor')?.style.left ?? '',
    svg: document.querySelectorAll('.score-host .at-surface svg').length,
    error: document.querySelector('.error-banner')?.textContent ?? '',
    tuning: document.querySelector('.score-host .at-surface')?.textContent?.includes('Tuning') ?? false,
  }))()`);

  await s('Page.captureScreenshot', { format: 'png' }).then(async (shot) => {
    await import('node:fs/promises').then((fs) => fs.writeFile('smoke-import.png', Buffer.from(shot.result.data, 'base64')));
  });

  out.errors = errors.slice(0, 8);
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.log(JSON.stringify({ fatal: String(e?.stack ?? e), errors }, null, 2));
} finally {
  chrome.kill();
  process.exit(0);
}