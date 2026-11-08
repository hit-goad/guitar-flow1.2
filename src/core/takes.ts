import { openDB, type IDBPDatabase } from 'idb';
import type { TakeKind, TakeRecord } from './library';
import { uid } from './id';

/**
 * 录音库：把每次录音（麦克风 / 实时应用内录 / 系统内录 / 混录 / 离线内录）存到本机 IndexedDB，
 * 支持回放、音高曲线分析、改名、导出（WAV/MP3）、删除。
 */

interface TakesSchema {
  takes: TakeRecord;
}

let dbPromise: Promise<IDBPDatabase<TakesSchema>> | null = null;

function db() {
  if (!dbPromise) {
    dbPromise = openDB<TakesSchema>('guitarflow', 2, {
      upgrade(database) {
        if (!database.objectStoreNames.contains('takes')) database.createObjectStore('takes', { keyPath: 'id' });
      },
    });
  }
  return dbPromise;
}

export async function addTake(input: {
  title: string;
  kind: TakeKind;
  blob: Blob;
  durationSec: number;
  scoreId?: string;
  scoreTitle?: string;
  pitchRange?: string;
}): Promise<TakeRecord> {
  const record: TakeRecord = {
    id: uid('take'),
    title: input.title,
    kind: input.kind,
    blob: input.blob,
    mime: input.blob.type || 'audio/wav',
    durationSec: input.durationSec,
    size: input.blob.size,
    createdAt: Date.now(),
    scoreId: input.scoreId,
    scoreTitle: input.scoreTitle,
    pitchRange: input.pitchRange,
  };
  await (await db()).put('takes', record);
  return record;
}

export async function listTakes(): Promise<TakeRecord[]> {
  const all = await (await db()).getAll('takes');
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getTake(id: string): Promise<TakeRecord | undefined> {
  return (await db()).get('takes', id);
}

export async function renameTake(id: string, title: string): Promise<void> {
  const t = await getTake(id);
  if (!t) return;
  await (await db()).put('takes', { ...t, title });
}

export async function updateTakePitchRange(id: string, pitchRange: string): Promise<void> {
  const t = await getTake(id);
  if (!t) return;
  await (await db()).put('takes', { ...t, pitchRange });
}

export async function deleteTake(id: string): Promise<void> {
  await (await db()).delete('takes', id);
}

export async function clearTakes(): Promise<void> {
  await (await db()).clear('takes');
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}