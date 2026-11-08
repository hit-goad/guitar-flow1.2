/** 直接测量麦克风输入 RMS，判断是采集问题还是音高算法问题 */
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9340;
const wav = resolve('tone440.wav');
const profile = await mkdtemp(join(tmpdir(), 'gf-mic-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${wav}`,
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pending = new Map();
let id = 0;
let ws;
try {
  let v;
  for (let i = 0; i < 80; i++) { try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(250); } }
  ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const { result: { targetId } } = await send('Target.createTarget', { url: 'http://127.0.0.1:5123/' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s('Runtime.enable');
  const ev = async (expr) => {
    const r = await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { err: r.result.exceptionDetails.text, details: r.result.exceptionDetails };
    return r.result?.result?.value;
  };
  const probe = await ev(`(async () => {
    const ctx = new AudioContext();
    await ctx.resume();
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
    catch (e) { return { stage: 'getUserMedia', error: String(e) }; }
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    src.connect(an);
    const buf = new Float32Array(2048);
    let max = 0;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      an.getFloatTimeDomainData(buf);
      let s2 = 0;
      for (const x of buf) s2 += x * x;
      max = Math.max(max, Math.sqrt(s2 / buf.length));
    }
    return { stage: 'ok', ctxState: ctx.state, maxRms: max, tracks: stream.getAudioTracks().map((t) => ({ label: t.label, enabled: t.enabled, muted: t.muted, state: t.readyState })) };
  })()`);
  console.log(JSON.stringify(probe, null, 2));
} catch (e) {
  console.log(JSON.stringify({ fatal: String(e) }));
} finally {
  chrome.kill();
  process.exit(0);
}