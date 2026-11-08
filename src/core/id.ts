export function uid(prefix = 's'): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
      : Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `${prefix}_${rnd}`;
}

/** 稳定内容指纹（FNV-1a 32bit，够做去重） */
export function hashString(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export async function hashBytes(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', view.slice().buffer as ArrayBuffer);
    return Array.from(new Uint8Array(digest))
      .slice(0, 12)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < view.length; i += 7) {
    h ^= view[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}