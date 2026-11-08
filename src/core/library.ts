import { openDB, type IDBPDatabase } from 'idb';
import type { ScoreDoc } from './types';

const DB_NAME = 'guitarflow';
const DB_VERSION = 1;

interface GFDB {
  scores: ScoreDoc;
  settings: { key: string; value: unknown };
}

let dbPromise: Promise<IDBPDatabase<GFDB>> | null = null;

function db() {
  if (!dbPromise) {
    dbPromise = openDB<GFDB>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains('scores')) {
          const store = database.createObjectStore('scores', { keyPath: 'id' });
          store.createIndex('openedAt', 'openedAt');
          store.createIndex('updatedAt', 'updatedAt');
          store.createIndex('title', 'title');
        }
        if (!database.objectStoreNames.contains('settings')) {
          database.createObjectStore('settings', { keyPath: 'key' });
        }
      },
    });
  }
  return dbPromise;
}

/** 内存缓存，避免重复读盘 */
const cache = new Map<string, ScoreDoc>();

export async function listScores(): Promise<ScoreDoc[]> {
  const all = await (await db()).getAll('scores');
  all.forEach((d) => cache.set(d.id, d));
  return all.sort((a, b) => (b.openedAt ?? b.updatedAt) - (a.openedAt ?? a.updatedAt));
}

export async function getScore(id: string): Promise<ScoreDoc | undefined> {
  if (cache.has(id)) return cache.get(id);
  const doc = await (await db()).get('scores', id);
  if (doc) cache.set(id, doc);
  return doc;
}

export async function putScore(doc: ScoreDoc): Promise<void> {
  cache.set(doc.id, doc);
  await (await db()).put('scores', doc);
}

export async function deleteScore(id: string): Promise<void> {
  cache.delete(id);
  await (await db()).delete('scores', id);
}

export async function touchScore(id: string): Promise<void> {
  const doc = await getScore(id);
  if (!doc) return;
  doc.openedAt = Date.now();
  await putScore(doc);
}

export async function toggleFavorite(id: string): Promise<boolean> {
  const doc = await getScore(id);
  if (!doc) return false;
  doc.favorite = !doc.favorite;
  doc.updatedAt = Date.now();
  await putScore(doc);
  return !!doc.favorite;
}

export async function findByHash(hash: string): Promise<ScoreDoc | undefined> {
  const all = await listScores();
  return all.find((d) => d.hash === hash);
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await (await db()).get('settings', key);
  return (row?.value as T) ?? fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await (await db()).put('settings', { key, value });
}

export async function clearAll(): Promise<void> {
  cache.clear();
  await (await db()).clear('scores');
}