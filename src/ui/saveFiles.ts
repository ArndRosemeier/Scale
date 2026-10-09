/**
 * Save files in the browser: write a save to a `.scale` file, pick one to read back (it is stored
 * among the saves, then loaded like any other). The format is in game/save/files.ts.
 *
 * Where the browser has the file system dialogs (showSaveFilePicker / showOpenFilePicker: Chrome,
 * Edge, Opera on the desktop) the player chooses where the file goes and which file to open;
 * elsewhere (Firefox, Safari, iPad) it is a plain download and the browser's file input. The
 * save dialog is opened first, straight from the click (it needs the click's user activation),
 * and the save is read and encoded after.
 */
import { saveStore } from '../game/save/SaveStore';
import { metaOf, type SaveData, type SaveMeta } from '../game/save/model';
import { SAVE_FILE_EXT, decodeSaveFile, encodeSaveFile, importedId, saveFileName } from '../game/save/files';
import { cityName } from '../plan/names';

interface PickerHandle { name: string; getFile(): Promise<File>; createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }
interface PickerWindow {
  showSaveFilePicker?: (o: unknown) => Promise<PickerHandle>;
  showOpenFilePicker?: (o: unknown) => Promise<PickerHandle[]>;
}
/** The dialogs (not inside a frame, where browsers refuse them). */
const picker = (): PickerWindow => (window.top === window ? (window as unknown as PickerWindow) : {});
export const hasSaveDialog = () => !!picker().showSaveFilePicker;
const TYPES = [{ description: 'Scale saved game', accept: { 'application/octet-stream': [SAVE_FILE_EXT] } }];
const ID = 'scale-saves';
const cancelled = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/**
 * Write a save to a file: the save dialog where there is one, else a download. `get` reads the
 * save once the place is chosen. Resolves to the file's name, or null when the player cancelled.
 */
export async function writeSaveFile(meta: SaveMeta, get: () => Promise<SaveData | null>): Promise<string | null> {
  const name = saveFileName(meta.city, meta.name, meta.day, meta.hour);
  const W = picker();
  if (W.showSaveFilePicker) {
    let h: PickerHandle | null = null;
    try { h = await W.showSaveFilePicker({ suggestedName: name, types: TYPES, id: ID, startIn: 'documents' }); }
    catch (e) { if (cancelled(e)) return null; console.warn('[saves] save dialog', e); }
    if (h) {
      const d = await get();
      if (!d) throw new Error('That save could not be read.');
      const w = await h.createWritable();
      await w.write(await encodeSaveFile(d, meta));
      await w.close();
      return h.name;
    }
  }
  const d = await get();
  if (!d) throw new Error('That save could not be read.');
  return download(await encodeSaveFile(d, meta), name);
}

export function download(blob: Blob, name: string): string {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return name;
}

/** A stored save to a file (null: cancelled; throws when it could not be read or written). */
export function writeStored(m: SaveMeta): Promise<string | null> {
  return writeSaveFile(m, () => saveStore.get(m.id));
}

/** Let the player choose a file: the open dialog where there is one, else a file input (null: cancelled). */
export async function pickSaveFile(): Promise<File | null> {
  const W = picker();
  if (W.showOpenFilePicker) {
    try {
      const [h] = await W.showOpenFilePicker({ types: TYPES, id: ID, startIn: 'documents', multiple: false });
      return h ? await h.getFile() : null;
    } catch (e) { if (cancelled(e)) return null; console.warn('[saves] open dialog', e); }
  }
  return new Promise((res) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = `${SAVE_FILE_EXT},.json,application/json,application/gzip`;
    inp.style.display = 'none';
    let done = false;
    const finish = (f: File | null) => { if (done) return; done = true; inp.remove(); res(f); };
    inp.onchange = () => finish(inp.files?.[0] ?? null);
    inp.addEventListener('cancel', () => finish(null));
    document.body.appendChild(inp);
    inp.click();
  });
}

/**
 * Read a save file and keep it among the player's saves (a named save, under an id of its own).
 * Throws an Error with a message for the player.
 */
export async function importSaveFile(f: File): Promise<SaveMeta> {
  if (f.size > 64 * 1024 * 1024) throw new Error('That file is far too big to be a save.');
  const { data, meta } = await decodeSaveFile(await f.arrayBuffer());
  data.id = importedId(data);
  data.kind = 'manual';
  if (data.name === 'Autosave' || !data.name.trim()) data.name = f.name.replace(/\.[^.]*$/, '').slice(0, 40) || 'From a file';
  const thumb = typeof meta?.thumb === 'string' && meta.thumb.startsWith('data:image/') ? meta.thumb : undefined;
  const karma = typeof meta?.karma === 'number' && Number.isFinite(meta.karma) ? meta.karma : 0;
  const m = metaOf(data, cityName(data.city.seed), thumb, karma);
  if (!(await saveStore.put(data, m))) throw new Error('The save could not be stored in this browser (storage full or unavailable).');
  return m;
}

/** Pick, read and store a save file; `onLoaded` gets it, `say` any message. */
export async function loadFromFile(onLoaded: (m: SaveMeta) => void, say: (text: string, err?: boolean) => void): Promise<void> {
  const f = await pickSaveFile();
  if (!f) return;
  say(`Reading "${f.name}"…`);
  try {
    const m = await importSaveFile(f);
    say(`Loading "${m.name}"…`);
    onLoaded(m);
  } catch (e) {
    console.warn('[saves] file', e);
    say(e instanceof Error ? e.message : 'That file could not be read.', true);
  }
}
