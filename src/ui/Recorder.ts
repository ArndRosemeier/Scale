/**
 * Clip recorder: the Record key (Print, or F9) starts and stops recording the game picture with
 * its sound, at most 30 s. The HUD is not in it (only the 3D canvas is recorded). One clip is
 * kept in IndexedDB; a new one replaces it. The pause menu shows it and exports it as a file.
 *
 * Windows often keeps the Print key's keydown for itself (screenshots, Snipping Tool) and the
 * browser only gets the keyup, so a Print key whose keydown never came counts on its keyup.
 */
import type { Game } from '../game/Game';
import { isAction } from '../game/keybinds';
import { download } from './saveFiles';
import { withWebmDuration } from './webmDuration';

export const CLIP_MAX_S = 30;
const FPS = 60;
const BITRATE = 12_000_000;
const DB = 'scale-clip';
const STORE = 'clip';
const KEY = 'last';

export interface StoredClip {
  blob: Blob;
  mime: string;
  /** Length in ms. */
  ms: number;
  /** When it was recorded (Date.now()). */
  at: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((res, rej) => {
      const t = db.transaction(STORE, mode);
      const r = f(t.objectStore(STORE));
      t.oncomplete = () => res(r.result as T);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  } finally { db.close(); }
}

export const clipStore = {
  get: (): Promise<StoredClip | undefined> => tx('readonly', (s) => s.get(KEY)),
  put: (c: StoredClip): Promise<unknown> => tx('readwrite', (s) => s.put(c, KEY)),
};

const MIMES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];

function pickMime(): string {
  for (const m of MIMES) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

/** "0:07" */
export function clipTime(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function clipFileName(c: StoredClip): string {
  const d = new Date(c.at), p = (n: number) => String(n).padStart(2, '0');
  const ext = c.mime.includes('mp4') ? 'mp4' : 'webm';
  return `scale-clip-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

/** Saves the stored clip to a file; false when there is none. */
export async function exportClip(): Promise<boolean> {
  const c = await clipStore.get();
  if (!c) return false;
  download(c.blob, clipFileName(c));
  return true;
}

export class Recorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private t0 = 0;
  /** Length of the clip being finished. */
  private ms = 0;
  private tick = 0;
  private limit = 0;
  private tap: MediaStreamAudioDestinationNode | null = null;
  private stream: MediaStream | null = null;
  private readonly el: HTMLDivElement;
  /** Keys whose keydown arrived (their keyup is then not a press of its own). */
  private down = new Set<string>();
  /** Called when a clip was stored (the pause menu refreshes). */
  onSaved: (() => void) | null = null;

  constructor(private game: Game, private canvas: HTMLCanvasElement) {
    this.el = document.createElement('div');
    this.el.id = 'recDot';
    document.body.appendChild(this.el);
    window.addEventListener('keydown', (e) => {
      if (!isAction(e, 'record') || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      if (e.repeat) return;
      this.down.add(e.code);
      this.toggle();
    });
    window.addEventListener('keyup', (e) => {
      if (e.code !== 'PrintScreen' || !isAction(e, 'record')) return;
      if (this.down.delete(e.code)) return;
      if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      this.toggle();
    });
  }

  get recording(): boolean { return this.rec !== null; }

  toggle(): void {
    if (this.rec) this.stop();
    else this.start();
  }

  start(): void {
    if (this.rec) return;
    const toast = (m: string, k: 'info' | 'warn' = 'info') => this.game.powerHud?.toast(m, k, 5000);
    if (typeof MediaRecorder === 'undefined' || typeof this.canvas.captureStream !== 'function') {
      toast('This browser cannot record the game.', 'warn');
      return;
    }
    const stream = this.canvas.captureStream(FPS);
    this.tap = this.game.audio.tap();
    for (const t of this.tap?.stream.getAudioTracks() ?? []) stream.addTrack(t);
    const mime = pickMime();
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: BITRATE, audioBitsPerSecond: 160_000 });
    } catch {
      this.release(stream);
      toast('This browser cannot record the game.', 'warn');
      return;
    }
    this.stream = stream;
    this.chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    rec.onstop = () => void this.finish(rec.mimeType || mime || 'video/webm');
    rec.start(1000);
    this.rec = rec;
    this.t0 = performance.now();
    // Auto graphics would change the resolution mid-clip.
    this.game.graphics.hold = true;
    this.limit = window.setTimeout(() => this.stop(), CLIP_MAX_S * 1000);
    this.tick = window.setInterval(() => this.show(), 250);
    this.show();
  }

  stop(): void {
    const rec = this.rec;
    if (!rec) return;
    this.rec = null;
    clearTimeout(this.limit);
    clearInterval(this.tick);
    this.game.graphics.hold = false;
    this.el.classList.remove('on');
    this.ms = performance.now() - this.t0;
    rec.stop();
  }

  private async finish(mime: string): Promise<void> {
    if (this.stream) this.release(this.stream);
    this.stream = null;
    let blob = new Blob(this.chunks, { type: mime.split(';')[0] });
    this.chunks = [];
    if (mime.includes('webm')) blob = await withWebmDuration(blob, this.ms);
    const toast = (m: string, k: 'info' | 'warn' = 'info') => this.game.powerHud?.toast(m, k, 7000);
    if (!blob.size) { toast('Nothing was recorded.', 'warn'); return; }
    try {
      await clipStore.put({ blob, mime, ms: this.ms, at: Date.now() });
      toast(`Clip saved (${clipTime(this.ms)}). Export it from the <b>Esc</b> menu. The next recording replaces it.`);
      this.onSaved?.();
    } catch {
      // Storage full or blocked: hand it out right away rather than lose it.
      download(blob, clipFileName({ blob, mime, ms: this.ms, at: Date.now() }));
      toast('The clip could not be stored in the browser, so it was saved as a file.', 'warn');
    }
  }

  private release(stream: MediaStream): void {
    for (const t of stream.getTracks()) t.stop();
    if (this.tap) this.game.audio.untap(this.tap);
    this.tap = null;
  }

  private show(): void {
    const ms = performance.now() - this.t0;
    this.el.classList.add('on');
    this.el.textContent = `REC ${clipTime(Math.min(ms, CLIP_MAX_S * 1000))} / ${clipTime(CLIP_MAX_S * 1000)}`;
  }
}
