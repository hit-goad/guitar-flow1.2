/** 平台桥接：Web / Electron / Capacitor 三端统一入口。 */

export interface FilePayload {
  name: string;
  bytes: Uint8Array;
}

interface GFBridge {
  isElectron: true;
  platform: string;
  openFiles(): Promise<FilePayload[]>;
  saveFile(defaultName: string, bytes: Uint8Array): Promise<string | null>;
  httpGet(url: string, headers?: Record<string, string>): Promise<{ status: number; body: string }>;
  httpGetBinary(url: string, headers?: Record<string, string>): Promise<{ status: number; bytes: Uint8Array }>;
  /** Electron 下捕获系统/应用内录 */
  captureSystemAudio(): Promise<boolean>;
  version: string;
}

declare global {
  interface Window {
    gf?: GFBridge;
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  }
}

export const isElectron = typeof window !== 'undefined' && !!window.gf?.isElectron;

export const isCapacitor = typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();

export const platformName = (): string => {
  if (isElectron) return window.gf?.platform ?? 'electron';
  if (isCapacitor) return window.Capacitor?.getPlatform?.() ?? 'native';
  return 'web';
};

/** 是否为原生或桌面容器（本地文件、无 CORS 限制） */
export const isNativeShell = isElectron || isCapacitor;

export async function pickFiles(accept = ''): Promise<File[]> {
  if (isElectron && window.gf) {
    const payloads = await window.gf.openFiles();
    return payloads.map((p) => new File([p.bytes as unknown as BlobPart], p.name));
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (accept) input.accept = accept;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export async function saveBlob(filename: string, blob: Blob): Promise<string | null> {
  if (isElectron && window.gf) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return window.gf.saveFile(filename, bytes);
  }
  if (isCapacitor && navigator.share && navigator.canShare) {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return filename;
}

const CORS_PROXIES = [
  (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  (u: string) => `https://r.jina.ai/${u}`,
];

export interface HttpOptions {
  headers?: Record<string, string>;
  binary?: boolean;
  /** 允许走公共 CORS 代理（Web 端受限时） */
  allowProxy?: boolean;
  timeoutMs?: number;
}

export class HttpError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

/** 统一 GET：Electron 走主进程（无 CORS），原生/桌面直连，Web 端失败后回退代理。 */
export async function httpGet(url: string, opts: HttpOptions = {}): Promise<{ status: number; text: string; bytes: Uint8Array }> {
  const headers = opts.headers ?? {};
  const timeoutMs = opts.timeoutMs ?? 15000;

  if (isElectron && window.gf) {
    if (opts.binary) {
      const r = await window.gf.httpGetBinary(url, headers);
      return { status: r.status, text: '', bytes: r.bytes };
    }
    const r = await window.gf.httpGet(url, headers);
    return { status: r.status, text: r.body, bytes: new Uint8Array() };
  }

  const attempt = async (target: string) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(target, { headers, signal: ctrl.signal, credentials: 'omit' });
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, text: new TextDecoder().decode(bytes), bytes };
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await attempt(url);
  } catch (err) {
    if (opts.allowProxy === false) throw new HttpError(String(err));
    for (const wrap of CORS_PROXIES) {
      try {
        return await attempt(wrap(url));
      } catch {
        /* 换下一个代理 */
      }
    }
    throw new HttpError(`请求失败: ${url}`);
  }
}

export async function httpGetText(url: string, opts: HttpOptions = {}): Promise<string> {
  const r = await httpGet(url, opts);
  return r.text;
}

export async function httpGetJson<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  const text = await httpGetText(url, opts);
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // 代理会包一层，尽量抢救出 JSON
    const start = trimmed.search(/[[{]/);
    if (start >= 0) {
      try {
        return JSON.parse(trimmed.slice(start)) as T;
      } catch {
        /* ignore */
      }
    }
    throw new HttpError(`返回不是 JSON: ${trimmed.slice(0, 120)}`);
  }
}