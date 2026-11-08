/**
 * 用本机 Chrome + CDP 验证构建产物：
 *  - React 是否挂载
 *  - 内置示例谱能否被 alphaTab 渲染成 canvas
 *  - 光标覆盖层是否存在
 *  - 有无运行时错误
 * 输出 smoke.png 与 JSON 结论。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:5123/';
const PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function waitForChrome() {
  for (let i = 0; i < 80; i++) {
    try {
      return await getJson(`http://127.0.0.1:${PORT}/json/version`);
    } catch {
      await sleep(250);
    }
  }
  throw new Error('Chrome 远程调试端口没有就绪');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        this.handlers.get(msg.method)?.(msg.params, msg.sessionId);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(method, fn) {
    this.handlers.set(method, fn);
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(new CDP(ws)));
    ws.addEventListener('error', (e) => reject(new Error('WS 连接失败')));
  });
}

const profile = await mkdtemp(join(tmpdir(), 'gf-chrome-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1440,960',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const errors = [];
const consoleLogs = [];
let cdp;
let sessionId;

try {
  const version = await waitForChrome();
  cdp = await connect(version.webSocketDebuggerUrl);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  sessionId = attached.sessionId;

  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails;
    errors.push(`${d.text} ${d.exception?.description ?? ''}`.slice(0, 500));
  });
  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = p.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
    consoleLogs.push(`${p.type}: ${text}`.slice(0, 300));
    if (p.type === 'error') errors.push(text.slice(0, 500));
  });
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error') errors.push(`${p.entry.text} ${p.entry.url ?? ''}`.slice(0, 400));
  });

  const send = (m, p) => cdp.send(m, p, sessionId);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });

  await send('Page.navigate', { url: APP_URL });
  await send('Runtime.evaluate', { expression: '1', awaitPromise: true });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  const waitFor = async (expr, timeout = 20000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await evaluate(`!!(${expr})`).catch(() => false)) return true;
      await sleep(250);
    }
    return false;
  };

  const mounted = await waitFor("document.querySelector('.score-card') || document.querySelector('.empty-state')", 20000);
  await sleep(500);
  const clicked = mounted ? await evaluate("(() => { const el = document.querySelector('.score-card'); if (!el) return false; el.click(); return true; })()") : false;
  const rendered = await waitFor("document.querySelector('.score-host canvas')", 25000);
  await sleep(2500);

  const diag = await evaluate(`(() => {
    const host = document.querySelector('.score-host');
    const canvas = host?.querySelector('canvas');
    return {
      mounted: !!document.querySelector('.app'),
      cards: document.querySelectorAll('.score-card').length,
      clicked: ${clicked},
      rendered: !!canvas,
      canvasSize: canvas ? { w: canvas.width, h: canvas.height } : null,
      surface: !!host?.querySelector('.at-surface'),
      cursor: !!document.querySelector('.gf-cursor'),
      cursorBox: (() => { const c = document.querySelector('.gf-cursor'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), opacity: getComputedStyle(c).opacity }; })(),
      transport: !!document.querySelector('.transport'),
      practice: !!document.querySelector('.practice'),
      practiceNote: document.querySelector('.note-big')?.textContent ?? null,
      expected: document.querySelector('.expected b')?.textContent ?? null,
      errorBanner: document.querySelector('.error-banner')?.textContent?.trim() ?? null,
      hint: document.querySelector('.score-hint')?.textContent?.trim() ?? null,
      bodyScroll: document.body.scrollHeight,
      svg: host?.querySelectorAll('svg').length ?? 0,
      canvasAll: host?.querySelectorAll('canvas').length ?? 0,
      hostHtml: (host?.innerHTML ?? '').slice(0, 500),
      rects: window.__gfRects ?? null,
      geom: (() => {
        const host = document.querySelector('.score-host');
        const surface = host?.querySelector('.at-surface');
        const vp = surface?.parentElement;
        const pick = (el) => el ? { tag: el.tagName, cls: el.className, x: Math.round(el.getBoundingClientRect().x), y: Math.round(el.getBoundingClientRect().y), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height), sw: el.scrollWidth, sh: el.scrollHeight, ov: getComputedStyle(el).overflowY } : null;
        return { host: pick(host), vp: pick(vp), surface: pick(surface), surfaces: host?.querySelectorAll('.at-surface').length ?? 0 };
      })(),
      clicks: window.__gfClicks ?? null,
      viewportH: (() => { const v = host?.querySelector('.at-surface')?.parentElement; return v ? { h: v.clientHeight, sh: v.scrollHeight } : null; })(),
    };
  })()`);

  // 再点一次谱面中部，验证点击跳转不报错
  if (diag.canvasSize) {
    await evaluate(`(() => {
      const canvas = document.querySelector('.score-host canvas');
      const r = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.x + r.width * 0.55, clientY: r.y + r.height * 0.42, bubbles: true }));
      return true;
    })()`);
    await sleep(700);
  }

  // 播放 3 秒，验证位置推进、自动滚动、光标移动
  const before = await evaluate(`(() => {
    const vp = document.querySelector('.score-host .at-surface')?.parentElement;
    return { scrollTop: vp?.scrollTop ?? 0, pos: document.querySelector('.seek-meta')?.textContent ?? '', cursorTop: document.querySelector('.gf-cursor')?.style.top ?? '' };
  })()`);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true })); true`);
  await sleep(3200);
  const during = await evaluate(`(() => {
    const vp = document.querySelector('.score-host .at-surface')?.parentElement;
    return { scrollTop: vp?.scrollTop ?? 0, pos: document.querySelector('.seek-meta')?.textContent ?? '', cursorTop: document.querySelector('.gf-cursor')?.style.top ?? '', playState: document.querySelector('.pill.live')?.textContent ?? '' };
  })()`);
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true })); true`);
  await sleep(400);

  // 用真实鼠标事件点击谱面 60% 高度处，验证跳转
  const clickPt = await evaluate(`(() => {
    const vp = document.querySelector('.score-host .at-surface')?.parentElement;
    const surface = document.querySelector('.score-host .at-surface');
    if (!vp || !surface) return null;
    const r = vp.getBoundingClientRect();
    return { x: Math.round(r.left + r.width * 0.35), y: Math.round(r.top + r.height * 0.6) };
  })()`);
  if (clickPt) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickPt.x, y: clickPt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickPt.x, y: clickPt.y, button: 'left', clickCount: 1, pointerType: 'mouse' });
  }
  await sleep(900);
  const afterClickJump = await evaluate(`(() => ({ pos: document.querySelector('.seek-meta')?.textContent ?? '', cursorTop: document.querySelector('.gf-cursor')?.style.top ?? '', cursorLeft: document.querySelector('.gf-cursor')?.style.left ?? '', scroll: document.querySelector('.score-host .at-surface')?.parentElement?.scrollTop ?? 0 }))()`);
  const cursorLeftDuring = await evaluate(`document.querySelector('.gf-cursor')?.style.left ?? ''`);
  const clickDiag = await evaluate(`({ clicks: window.__gfClicks ?? null, scrollTop: document.querySelector('.score-host')?.scrollTop ?? null })`);

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile('smoke.png', Buffer.from(shot.data, 'base64'));

  const after = await evaluate(`(() => ({ cursor: !!document.querySelector('.gf-cursor'), pos: document.querySelector('.seek-meta')?.textContent ?? '' }))()`);

  console.log(
    JSON.stringify(
      { url: APP_URL, diag: { ...diag, afterClick: after, playback: { before, during, clickPt, afterClickJump, cursorLeftDuring, clickDiag } }, errors: errors.slice(0, 15), consoleTail: consoleLogs.slice(-12) },
      null,
      2,
    ),
  );
} catch (err) {
  console.log(JSON.stringify({ fatal: String(err?.stack ?? err), errors: errors.slice(0, 10) }, null, 2));
} finally {
  try {
    await cdp?.send('Browser.close');
  } catch {
    /* ignore */
  }
  chrome.kill();
  process.exit(0);
}