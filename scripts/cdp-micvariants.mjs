/** 分离排查：约束/滤波器/Worklet 接线三处 */
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9342;
const wav = resolve('tone440.wav');
const profile = await mkdtemp(join(tmpdir(), 'gf-mic2-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${wav}`,
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'http://127.0.0.1:5123/',
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
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('5123'));
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: page.id, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s('Runtime.enable');

  const expr = `(async () => {
    const out = {};
    await new Promise((r) => setTimeout(r, 8000));
    const rmsOf = async (ctx, an) => {
      const buf = new Float32Array(an.fftSize);
      let max = 0;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 50));
        an.getFloatTimeDomainData(buf);
        let s2 = 0; for (const x of buf) s2 += x * x;
        max = Math.max(max, Math.sqrt(s2 / buf.length));
      }
      return max;
    };

    // A: 与应用一致的约束 + 高通 + analyser
    {
      const ctx = new AudioContext(); await ctx.resume();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
      const src = ctx.createMediaStreamSource(stream);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 60;
      const an = ctx.createAnalyser(); an.fftSize = 2048;
      src.connect(hp); hp.connect(an);
      out.A_constrained_hp = await rmsOf(ctx, an);
      stream.getTracks().forEach((t) => t.stop()); await ctx.close();
    }
    // B: 默认约束
    {
      const ctx = new AudioContext(); await ctx.resume();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser(); an.fftSize = 2048;
      src.connect(an);
      out.B_default = await rmsOf(ctx, an);
      stream.getTracks().forEach((t) => t.stop()); await ctx.close();
    }
    // C: 振荡器 → worklet，检查 worklet 本身
    {
      const ctx = new AudioContext(); await ctx.resume();
      await ctx.audioWorklet.addModule('worklets/pitch-worklet.js');
      const node = new AudioWorkletNode(ctx, 'pitch-detector', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const osc = ctx.createOscillator(); osc.frequency.value = 440; osc.type = 'sine';
      const g = ctx.createGain(); g.gain.value = 0.4;
      const silent = ctx.createGain(); silent.gain.value = 0;
      const frames = [];
      node.port.onmessage = (e) => frames.push(e.data);
      osc.connect(g); g.connect(node); node.connect(silent); silent.connect(ctx.destination);
      osc.start();
      await new Promise((r) => setTimeout(r, 1200));
      osc.stop(); await ctx.close();
      out.C_worklet = frames.slice(-3);
      out.C_frames = frames.length;
    }
    // D: 麦克风 → worklet（不经过高通）
    {
      const ctx = new AudioContext(); await ctx.resume();
      await ctx.audioWorklet.addModule('worklets/pitch-worklet.js');
      const node = new AudioWorkletNode(ctx, 'pitch-detector', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const silent = ctx.createGain(); silent.gain.value = 0;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      const src = ctx.createMediaStreamSource(stream);
      const frames = [];
      node.port.onmessage = (e) => frames.push(e.data);
      src.connect(node); node.connect(silent); silent.connect(ctx.destination);
      await new Promise((r) => setTimeout(r, 1500));
      stream.getTracks().forEach((t) => t.stop()); await ctx.close();
      out.D_mic_worklet = frames.slice(-2);
      out.D_frames = frames.length;
    }
    // E: 应用里的精确约束
    {
      const ctx = new AudioContext(); await ctx.resume();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
      const src = ctx.createMediaStreamSource(stream);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 60;
      const an = ctx.createAnalyser(); an.fftSize = 2048;
      src.connect(hp); hp.connect(an);
      out.E_exact = await rmsOf(ctx, an);
      out.E_settings = stream.getAudioTracks()[0].getSettings();
      stream.getTracks().forEach((t) => t.stop()); await ctx.close();
    }
    // F: 先建上下文（模拟应用启动时创建共享上下文），手势里再 resume + 采集
    {
      const early = new AudioContext();
      await new Promise((r) => setTimeout(r, 300));
      await early.resume();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const src = early.createMediaStreamSource(stream);
      const an = early.createAnalyser(); an.fftSize = 2048;
      src.connect(an);
      out.F_early_ctx = await rmsOf(early, an);
      stream.getTracks().forEach((t) => t.stop()); await early.close();
    }
    return out;
  })()`;
  const r = await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  console.log(JSON.stringify(r.result?.result?.value ?? r.result, null, 2));
} catch (e) {
  console.log(JSON.stringify({ fatal: String(e?.stack ?? e) }));
} finally {
  chrome.kill();
  process.exit(0);
}