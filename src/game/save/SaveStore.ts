/**
 * Where saves live: IndexedDB (`scale-saves`: a small `meta` store for the lists and a `data`
 * store with the save itself, gzip-compressed when the browser can), localStorage only as a
 * fallback (no IndexedDB, e.g. some private modes) and for the synchronous last-moment save on
 * page hide (`putSync`, folded into IndexedDB on the next start by `recover`).
 *
 * Every call is wrapped: a failure resolves to an empty list / null / false and is logged, it
 * never throws into the game. A save is written as one transaction over both stores, so an
 * interrupted write leaves the previous version intact.
 */
import { parseSave, serializeSave, type SaveData, type SaveMeta } from './model';

const DB = 'scale-saves', META = 'meta', DATA = 'data';
const LS_INDEX = 'scale.saves.index', LS_DATA = 'scale.save.data.', LS_EMERGENCY = 'scale.save.emergency';

interface DataRecord { id: string; json?: string; gz?: ArrayBuffer }

let dbP: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  dbP ??= new Promise((res) => {
    try {
      if (typeof indexedDB === 'undefined') { res(null); return; }
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA, { keyPath: 'id' });
      };
      r.onsuccess = () => {
        const db = r.result;
        db.onversionchange = () => { db.close(); dbP = null; };
        res(db);
      };
      r.onerror = () => { console.warn('[saves] IndexedDB unavailable, using localStorage', r.error); res(null); };
      r.onblocked = () => res(null);
    } catch (e) { console.warn('[saves] IndexedDB unavailable', e); res(null); }
  });
  return dbP;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

function done(t: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error ?? new Error('aborted')); });
}

async function gzip(s: string): Promise<ArrayBuffer | null> {
  try {
    if (typeof CompressionStream === 'undefined') return null;
    const stream = new Blob([s]).stream().pipeThrough(new CompressionStream('gzip'));
    return await new Response(stream).arrayBuffer();
  } catch { return null; }
}

async function gunzip(b: ArrayBuffer): Promise<string> {
  const stream = new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}

function lsIndex(): SaveMeta[] {
  try { const a = JSON.parse(localStorage.getItem(LS_INDEX) ?? '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

export const saveStore = {
  /** Bytes of the last write (data + meta), for the report / console. */
  lastBytes: 0,
  lastRawBytes: 0,

  /** Every save's index entry, newest first. */
  async list(): Promise<SaveMeta[]> {
    let out: SaveMeta[] = [];
    try {
      const db = await openDb();
      if (db) out = await req(db.transaction(META, 'readonly').objectStore(META).getAll() as IDBRequest<SaveMeta[]>);
    } catch (e) { console.warn('[saves] list failed', e); }
    // Saves that only made it to localStorage (no IndexedDB, or a failed write).
    for (const m of lsIndex()) if (!out.some((o) => o.id === m.id)) out.push(m);
    return out.sort((a, b) => b.created - a.created);
  },

  async latest(): Promise<SaveMeta | null> {
    return (await this.list())[0] ?? null;
  },

  async get(id: string): Promise<SaveData | null> {
    try {
      const db = await openDb();
      if (db) {
        const r = await req(db.transaction(DATA, 'readonly').objectStore(DATA).get(id) as IDBRequest<DataRecord | undefined>);
        if (r) return parseSave(r.gz ? await gunzip(r.gz) : r.json ?? '');
      }
    } catch (e) { console.warn('[saves] read failed', id, e); }
    try {
      const s = localStorage.getItem(LS_DATA + id);
      if (s) return parseSave(s);
    } catch (e) { console.warn('[saves] read (localStorage) failed', id, e); }
    return null;
  },

  /** Write a save and its index entry (one transaction). Resolves to false on failure. */
  async put(d: SaveData, meta: SaveMeta): Promise<boolean> {
    const json = serializeSave(d);
    this.lastRawBytes = json.length;
    try {
      const db = await openDb();
      if (db) {
        const gz = await gzip(json);
        const rec: DataRecord = gz ? { id: d.id, gz } : { id: d.id, json };
        const bytes = (gz ? gz.byteLength : json.length) + (meta.thumb?.length ?? 0);
        meta = { ...meta, bytes };
        const t = db.transaction([META, DATA], 'readwrite');
        t.objectStore(DATA).put(rec);
        t.objectStore(META).put(meta);
        await done(t);
        this.lastBytes = bytes;
        this.removeLs(d.id);
        return true;
      }
    } catch (e) { console.warn('[saves] IndexedDB write failed, trying localStorage', e); }
    return this.putLs(json, meta);
  },

  async remove(id: string): Promise<void> {
    try {
      const db = await openDb();
      if (db) {
        const t = db.transaction([META, DATA], 'readwrite');
        t.objectStore(DATA).delete(id);
        t.objectStore(META).delete(id);
        await done(t);
      }
    } catch (e) { console.warn('[saves] delete failed', id, e); }
    this.removeLs(id);
  },

  /**
   * Synchronous last-moment save (page hide / unload, where an IndexedDB write may not finish):
   * localStorage, folded into IndexedDB by `recover` on the next start. False when it does not fit.
   */
  putSync(d: SaveData, meta: SaveMeta): boolean {
    try {
      localStorage.setItem(LS_EMERGENCY, JSON.stringify({ meta: { ...meta, thumb: meta.thumb && meta.thumb.length < 60000 ? meta.thumb : undefined }, data: d }));
      return true;
    } catch {
      // Too big with the city damage: keep everything else.
      try { localStorage.setItem(LS_EMERGENCY, JSON.stringify({ meta: { ...meta, thumb: undefined }, data: { ...d, damage: null } })); return true; } catch { return false; }
    }
  },

  /** Start-up: move a last-moment save into IndexedDB when it is newer than what is stored. */
  async recover(): Promise<void> {
    let raw: string | null = null;
    try { raw = localStorage.getItem(LS_EMERGENCY); } catch { return; }
    if (!raw) return;
    try {
      const o = JSON.parse(raw) as { meta: SaveMeta; data: unknown };
      const d = parseSave(o.data);
      const all = await this.list();
      const have = all.find((m) => m.id === d.id);
      if (!have || have.created < d.created) {
        // Too big to keep the city damage: take it from the latest save of that city (better than none).
        const same = !d.damage ? all.find((m) => m.seed === d.city.seed && m.size === d.city.size && m.mode === d.mode) : null;
        const prev = same ? await this.get(same.id) : null;
        if (prev?.damage) d.damage = prev.damage;
        if (!(await this.put(d, { ...o.meta, thumb: o.meta.thumb ?? have?.thumb }))) return;
      }
      localStorage.removeItem(LS_EMERGENCY);
    } catch (e) {
      console.warn('[saves] could not recover the last-moment save', e);
      try { localStorage.removeItem(LS_EMERGENCY); } catch { /* ignore */ }
    }
  },

  putLs(json: string, meta: SaveMeta): boolean {
    try {
      localStorage.setItem(LS_DATA + meta.id, json);
      const idx = lsIndex().filter((m) => m.id !== meta.id);
      idx.push({ ...meta, bytes: json.length });
      try { localStorage.setItem(LS_INDEX, JSON.stringify(idx)); }
      catch { localStorage.setItem(LS_INDEX, JSON.stringify(idx.map((m) => ({ ...m, thumb: undefined })))); }
      this.lastBytes = json.length;
      return true;
    } catch (e) {
      console.warn('[saves] localStorage write failed', e);
      return false;
    }
  },

  removeLs(id: string): void {
    try {
      if (localStorage.getItem(LS_DATA + id) === null) return;
      localStorage.removeItem(LS_DATA + id);
      localStorage.setItem(LS_INDEX, JSON.stringify(lsIndex().filter((m) => m.id !== id)));
    } catch { /* ignore */ }
  },
};
