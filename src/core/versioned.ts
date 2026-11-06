/**
 * Asset URLs with the game version attached (`?v=0.303`). Sounds and music keep fixed file names,
 * and the host's edge cache holds fixed-name files for hours: without the version a re-cut sound
 * stays old for players until the cache runs out. Every release changes the version, so every
 * release fetches fresh copies (and between releases the cache still works).
 */
import { VERSION } from '../version';

export function versioned(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}v=${VERSION}`;
}
