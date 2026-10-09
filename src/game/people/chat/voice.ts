/**
 * A light touch of how someone talks on top of a chat line (typed NPC chat): the shy hesitate,
 * the grumpy drop the exclamation marks, the anxious start with a jolt, the chatty add a word.
 * Used sparingly (u: the moment's random number), so the line still reads as written.
 *
 * Pure.
 */
import type { Temperament } from '../identity';

const CHATTY_TAIL = [' Anyway!', ' Where was I?', ' Ha!', ' Isn\'t it funny how things are?'];

export function voiced(line: string, t: Temperament, child: boolean, u: number): string {
  if (!line || line.startsWith('(')) return line;
  switch (t) {
    case 'shy':
      if (u < 0.3 && !/^(Um|Oh|Uh)\b/.test(line)) return `Um… ${line.charAt(0).toLowerCase()}${line.slice(1)}`;
      return line;
    case 'grumpy':
      return u < 0.7 ? line.replace(/!+/g, '.').replace(/\.\./g, '.') : line;
    case 'anxious':
      return u < 0.2 && !/^(Oh|Um)\b/.test(line) ? `Oh! ${line}` : line;
    case 'chatty':
      return u < 0.18 && !child && /[.!]$/.test(line) && !line.includes('?') ? line + CHATTY_TAIL[Math.floor(u * 100) % CHATTY_TAIL.length] : line;
    default:
      return line;
  }
}
