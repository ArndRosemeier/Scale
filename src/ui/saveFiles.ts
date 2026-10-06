/**
 * Save files in the browser: download a save as a `.scale` file, pick one to read back (it is
 * stored among the saves, then loaded like any other). The format is in game/save/files.ts.
 */
import { saveStore } from '../game/save/SaveStore';
import { metaOf, type SaveData, type SaveMeta } from '../game/save/model';
import { SAVE_FILE_EXT, decodeSaveFile, encodeSaveFile, importedId, saveFileName } from '../game/save/files';
import { cityName } from '../plan/names';

/** Hand a save to the browser as a download. */
export async function downloadSave(d: SaveData, meta: SaveMeta): Promise<string> {
  const blob = await encodeSaveFile(d, meta);
  const name = saveFileName(meta.city, meta.name, meta.day, meta.hour);
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

/** A stored save as a download (false: it could not be read). */
export async function downloadStored(m: SaveMeta): Promise<boolean> {
  const d = await saveStore.get(m.id);
  if (!d) return false;
  await downloadSave(d, m);
  return true;
}

/** Let the player choose a file (null: cancelled). */
export function pickSaveFile(): Promise<File | null> {
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
