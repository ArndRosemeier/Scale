/**
 * Save files: a save written to a file on the player's computer (to keep it safe, move it to
 * another browser or machine, or share it) and read back from one.
 *
 * A `.scale` file is `{ scale: 'save', meta, data }` as JSON, gzip-compressed when the browser
 * can (CompressionStream); reading takes either, and also a bare SaveData object (a save copied
 * out of the console). The data goes through `parseSave`, so an old save migrates and a damaged
 * one is sanitised; anything without a city is refused. No DOM here (round trip in selftest.ts).
 */
import { parseSave, serializeSave, type SaveData, type SaveMeta } from './model';

export const SAVE_FILE_EXT = '.scale';
const MARK = 'save';

interface FileBody { scale: typeof MARK; meta?: Partial<SaveMeta>; data: unknown }

/** The file's bytes (gzip when available, else plain JSON). */
export async function encodeSaveFile(d: SaveData, meta?: SaveMeta): Promise<Blob> {
  const body = `{"scale":"${MARK}","meta":${JSON.stringify(meta ?? null)},"data":${serializeSave(d)}}`;
  try {
    if (typeof CompressionStream !== 'undefined') {
      const gz = await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
      return new Blob([gz], { type: 'application/octet-stream' });
    }
  } catch { /* plain below */ }
  return new Blob([body], { type: 'application/json' });
}

/**
 * Read a save file. Throws an Error with a message for the player when it is not a save, is
 * broken, or comes from a newer version of the game.
 */
export async function decodeSaveFile(bytes: ArrayBuffer): Promise<{ data: SaveData; meta: Partial<SaveMeta> | null }> {
  const u = new Uint8Array(bytes);
  let text: string;
  try {
    if (u[0] === 0x1f && u[1] === 0x8b) {
      if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot read compressed save files.');
      text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    } else text = new TextDecoder().decode(u);
  } catch (e) { throw e instanceof Error && e.message.startsWith('This browser') ? e : new Error('The file is damaged.'); }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('This is not a Scale save file.'); }
  const o = raw && typeof raw === 'object' ? (raw as Partial<FileBody>) : null;
  const wrapped = o?.scale === MARK;
  const inner = wrapped ? o.data : raw;
  if (!inner || typeof inner !== 'object' || !('city' in inner || 'seed' in inner)) throw new Error('This is not a Scale save file.');
  let data: SaveData;
  try { data = parseSave(inner); } catch (e) {
    throw new Error(/newer/.test(String(e)) ? 'This save comes from a newer version of the game.' : 'The save in this file is damaged.');
  }
  const meta = wrapped && o.meta && typeof o.meta === 'object' ? o.meta : null;
  return { data, meta };
}

/**
 * The id a save read from a file is stored under: its own per save (its creation time and city),
 * so reading the same file twice replaces the earlier copy and never a save of the browser's own.
 */
export function importedId(d: SaveData): string {
  return `file-${Math.floor(d.created).toString(36)}-${(d.city.seed >>> 0).toString(36)}`;
}

/** "Scale - Lindenford - My save - Day 3 18-45.scale" (characters a file system refuses dropped). */
export function saveFileName(city: string, name: string, day: number, hour: number): string {
  const h = Math.floor(hour), m = Math.floor((hour - h) * 60);
  const time = `Day ${day + 1} ${String(h).padStart(2, '0')}-${String(m).padStart(2, '0')}`;
  // A default name ("Day 3 18:45", "Autosave") says nothing the time does not.
  const own = /^(day \d|autosave$|saved game$)/i.test(name.trim()) ? '' : name.trim();
  const base = ['Scale', city, own, time].filter(Boolean).join(' - ').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return `${base || 'Scale save'}${SAVE_FILE_EXT}`;
}
