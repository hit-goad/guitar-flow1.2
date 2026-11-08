/** 移动端布局 + 麦克风音高检测验证（Chrome 假音频设备会输出 440Hz 音） */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5123/';
const PORT = 9338;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = await mkdtemp(join(tmpdir(), 'gf-mobile-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${resolve('tone440.wav')}`,
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const pending = new Map();
let id = 0;
const errors = [];
const logs = [];
let ws;
try {
  let v;
  for (let i = 0; i < 80; i++) {
    try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(250); }
  }
  ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 200));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 160));
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.text ?? 'exception');
  });
  const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s('Page.enable'); await s('Runtime.enable');
  await s('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 3, mobile: true });
  await s('Emulation.setTouchEmulationEnabled', { enabled: true });
  await s('Page.navigate', { url: APP_URL });

  const ev = async (expr) => {
    const r = await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  const waitFor = async (expr, t = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < t) { if (await ev(`!!(${expr})`).catch(() => false)) return true; await sleep(200); }
    return false;
  };
  const shot = async (name) => {
    const r = await s('Page.captureScreenshot', { format: 'png' });
    await writeFile(name, Buffer.from(r.result.data, 'base64'));
  };

  await waitFor("document.querySelector('.score-card')");
  await sleep(400);
  await shot('mobile-library.png');

  await ev("document.querySelector('.score-card').click()");
  await waitFor("document.querySelector('.gf-cursor')", 20000);
  await sleep(1200);
  await shot('mobile-score.png');

  const layout = await ev(`(() => ({
    bodyScrollW: document.body.scrollWidth,
    innerW: window.innerWidth,
    horizontalOverflow: document.body.scrollWidth > window.innerWidth + 2,
    transportVisible: !!document.querySelector('.transport'),
    practiceVisible: !!document.querySelector('.practice'),
    canvasOrSvg: document.querySelectorAll('.score-host .at-surface svg').length,
  }))()`);

  // 开启麦克风监听（假设备输出 440Hz）
  await ev(`Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('开启实时检测'))?.click()`);
  await sleep(2600);
  const geom = await ev(`(() => {
    const g = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), ch: el.clientHeight, sh: el.scrollHeight }; };
    return { scrollY: Math.round(window.scrollY), active: document.activeElement?.tagName + '.' + (document.activeElement?.className ?? ''), bodyH: document.body.scrollHeight, head: g('.score-head'), body: g('.score-body'), host: g('.score-host'), transport: g('.transport'), practice: g('.practice-column'), sidebar: g('.sidebar') };
  })()`);
  const scrollTest = await ev(`(async () => {
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 1500));
    return { after: Math.round(window.scrollY) };
  })()`);
  const mic = await ev(`(() => ({
    pill: document.querySelector('.pill.live')?.textContent ?? '',
    note: document.querySelector('.note-big')?.textContent ?? '',
    cents: document.querySelector('.cents-labels span:nth-child(2)')?.textContent ?? '',
    level: document.querySelector('.level-bar')?.style.width ?? '',
    expected: document.querySelector('.expected b')?.textContent ?? '',
  }))()`);
  await shot('mobile-mic.png');

  console.log(JSON.stringify({ layout, geom, scrollTest, mic, errors: errors.slice(0, 8), logs: logs.filter((l) => l.includes('gf-pitch')).slice(0, 10), worklet: await ev("fetch('worklets/pitch-worklet.js').then(r => r.status)") }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ fatal: String(e?.stack ?? e), errors }, null, 2));
} finally {
  chrome.kill();
  process.exit(0);
}