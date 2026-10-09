/**
 * The misunderstanding log (typed NPC chat): every typed line the chat did not understand, or
 * understood only by its last fallback, is kept in this browser (newest last, bounded) with what
 * it guessed. dev.chat.log() shows it; the feedback form attaches it, so lines players really
 * type end up as patterns, examples and test lines (corpus.ts).
 */
import type { Parse } from './understand';

export interface Missed {
  /** When (ms since 1970). */
  at: number;
  text: string;
  /** The best guess and its score, and how sure the reader was. */
  guess: string;
  score: number;
  via: string;
  /** Who was asked (temperament) and what answered. */
  who: string;
  answer: string;
}

const KEY = 'scale.chat.missed.v1';
const CAP = 200;

export function readMissed(): Missed[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

export function logMissed(p: Parse, who: string, answer: string): void {
  const list = readMissed();
  list.push({ at: Date.now(), text: p.norm.raw, guess: p.second?.intent ?? p.intent, score: Math.round((p.second?.score ?? p.score) * 100) / 100, via: p.via, who, answer });
  if (list.length > CAP) list.splice(0, list.length - CAP);
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
}

export function clearMissed(): void {
  try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}

/** The last lines, for the feedback form ("text → guess (score)"). */
export function missedReport(n = 40): string {
  const list = readMissed().slice(-n);
  if (!list.length) return '';
  return list.map((m) => `${m.text} → ${m.guess} ${m.score} (${m.via}, ${m.who}): ${m.answer}`).join('\n');
}
