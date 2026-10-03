/**
 * Imported avatars persist in the browser (IndexedDB; the browser is asked to keep the
 * storage persistent). The selected avatar id lives in localStorage.
 */
export interface StoredAvatar {
  id: string;
  name: string;
  /** Original file name (extension decides the loader). */
  file: string;
  data: ArrayBuffer;
  size: number;
  created: number;
  /** Small PNG data URL rendered at import. */
  thumb?: string;
  /** What the mapper found: 'retarget' (full animation) | 'clips' | 'static', rig details. */
  info?: { mode: string; source: string; mapped: number; clips: number; note?: string };
  /** Play the model's own clips even if the rig could be retargeted. */
  forceClips?: boolean;
}

const DB = 'scale-avatars', STORE = 'avatars', SELECTED = 'scale.avatar';

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
    t.oncomplete = () => db.close();
  });
}

export const avatarStore = {
  async list(): Promise<StoredAvatar[]> {
    const all = await tx<StoredAvatar[]>('readonly', (s) => s.getAll() as IDBRequest<StoredAvatar[]>);
    return all.sort((a, b) => b.created - a.created);
  },
  get: (id: string) => tx<StoredAvatar | undefined>('readonly', (s) => s.get(id) as IDBRequest<StoredAvatar | undefined>),
  async put(a: StoredAvatar): Promise<void> {
    await tx('readwrite', (s) => s.put(a));
    // Ask the browser not to evict imported avatars under storage pressure.
    try { await navigator.storage?.persist?.(); } catch { /* optional */ }
  },
  async remove(id: string): Promise<void> {
    await tx('readwrite', (s) => s.delete(id));
    if (this.selected() === id) this.select(null);
  },
  selected(): string | null {
    try { return localStorage.getItem(SELECTED); } catch { return null; }
  },
  select(id: string | null): void {
    try { if (id) localStorage.setItem(SELECTED, id); else localStorage.removeItem(SELECTED); } catch { /* private mode */ }
  },
};
