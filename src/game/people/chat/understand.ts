/**
 * Understanding a typed line (typed NPC chat): what the player means (an intent, intents.ts) and
 * what they name (lexicon.ts). Three passes, the first that is sure wins:
 *
 *  1. patterns over the normalised text (the clear-cut lines: "hi", "thanks", "my name is …");
 *  2. the sentence model (all-MiniLM-L6-v2 in a worker, embedCore.ts): the line's meaning
 *     compared with every intent's examples; names found in the line are swapped for the ones
 *     the examples use ("do you know Vera" reads like "do you know Mara"), so the model compares
 *     shapes, not names;
 *  3. while the model is still loading (or not available), word overlap with the examples.
 *
 * Pure but for the embedder passed in.
 */
import { INTENTS, type Intent } from './intents';
import { normalise, type Normal } from './normalise';
import { findMentions, type Ent, type Mention } from './lexicon';
import { DIM } from './embedCore';

export const UNDERSTAND = {
  /** The model's similarity (cosine) that settles an intent outright, and the lowest it may be at all. */
  sure: 0.66, least: 0.5,
  /** Below `sure`, the best intent must beat the next one by this much. */
  margin: 0.04,
  /** Word overlap (cosine of word and pair counts) needed without the model. */
  words: 0.42,
} as const;

/** Turns sentences into unit vectors (DIM floats each); null while it can't. */
export interface Embedder {
  embed(texts: readonly string[]): Promise<Float32Array | null>;
}

export interface Parse {
  intent: Intent;
  /** How sure (1 for a pattern, the similarity for the model, the overlap for words). */
  score: number;
  via: 'pattern' | 'model' | 'words' | 'none';
  /** The runner-up and its score (the misunderstanding log shows it). */
  second?: { intent: Intent; score: number };
  norm: Normal;
  mentions: Mention[];
  /** What a "do you like …" / "I like …" / "what do you think of …" line is about, as typed. */
  thing?: string;
  /** The name in "my name is …", "call me …". */
  name?: string;
}

/**
 * Example words standing for each kind of proper name (what a found name is swapped for). Plain
 * words (things, kinds of places, threats) stay: the model knows what "work" or "rain" means.
 */
const STAND_IN: Partial<Record<Ent['kind'], string>> = {
  person: 'mara', boss: 'viktor', place: 'the museum', street: 'linden street', hood: 'the old town', group: 'the gang',
};

const STOP_TAIL = /\b(at all|very much|so much|a lot|too|then|though|anyway|really|honestly|please|now|right now|here|lately|these days)$/;

/** The object of "do you like X", "I hate X", "what do you think of X". */
export function thingOf(text: string): string | undefined {
  const m = /\b(?:like|love|enjoy|adore|hate|dislike|detest|stand|into|fan of|think of|think about|feel about|opinion of|opinion on|opinion about|play|watch|follow|listen to|eat|drink|make of)\s+(.+)$/.exec(text);
  if (!m) return undefined;
  let t = m[1].trim();
  for (let k = 0; k < 3; k++) t = t.replace(STOP_TAIL, '').trim();
  t = t.replace(/^(the|a|an|some|any|your|my)\s+/, '');
  if (!t || /^(me|you|it|that|this|them|him|her|doing|to)$/.test(t) || t.split(' ').length > 5) return undefined;
  return t;
}

function nameOfIntro(norm: Normal): string | undefined {
  const m = /^(?:my name is|i am called|call me|people call me|they call me|the name is|my names|you can call me|i am|im)\s+([a-z][a-z-]*(?:\s[a-z][a-z-]*)?)$/.exec(norm.text);
  if (!m) return undefined;
  // "I am X" only for a capitalised X (else "I am tired" would be a name).
  if (/^(i am|im)\b/.test(norm.text) && !new RegExp(`\\b(?:I'?m|I am)\\s+\\p{Lu}`, 'u').test(norm.raw)) return undefined;
  const n = m[1].split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return n.length > 24 ? undefined : n;
}

// ------------------------------------------------------------------ word overlap

function bag(text: string): Map<string, number> {
  const w = text.split(' ').filter(Boolean);
  const m = new Map<string, number>();
  for (const x of w) m.set(x, (m.get(x) ?? 0) + 1);
  for (let i = 0; i + 1 < w.length; i++) { const k = `${w[i]}_${w[i + 1]}`; m.set(k, (m.get(k) ?? 0) + 1.5); }
  return m;
}

function cosBag(a: Map<string, number>, b: Map<string, number>, idf: Map<string, number>): number {
  let dot = 0, na = 0, nb = 0;
  for (const [k, v] of a) { const w = (idf.get(k) ?? 3) * v; na += w * w; const o = b.get(k); if (o) dot += w * o * (idf.get(k) ?? 3); }
  for (const [k, v] of b) { const w = (idf.get(k) ?? 3) * v; nb += w * w; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// ------------------------------------------------------------------ the understander

interface Example { intent: Intent; text: string; bag: Map<string, number> }

export class Understander {
  private ex: Example[] = [];
  private idf = new Map<string, number>();
  private vecs: Float32Array | null = null;
  private preparing: Promise<boolean> | null = null;

  constructor(private embedder: Embedder | null = null) {
    for (const d of INTENTS) for (const e of d.ex) {
      const n = normalise(e);
      this.ex.push({ intent: d.id, text: n.text, bag: bag(n.text) });
    }
    const df = new Map<string, number>();
    for (const e of this.ex) for (const k of e.bag.keys()) df.set(k, (df.get(k) ?? 0) + 1);
    for (const [k, n] of df) this.idf.set(k, Math.log((this.ex.length + 1) / n) + 0.5);
  }

  /** The model is ready (example vectors made). */
  get modelReady(): boolean { return !!this.vecs; }

  /** Make the example vectors (once; true when the model is in use). */
  prepare(): Promise<boolean> {
    if (!this.embedder) return Promise.resolve(false);
    this.preparing ??= this.embedder.embed(this.ex.map((e) => e.text)).then((v) => {
      this.vecs = v && v.length === this.ex.length * DIM ? v : null;
      return !!this.vecs;
    }).catch(() => false);
    return this.preparing;
  }

  /** Patterns and names only (instant). */
  quick(text: string, ents: readonly Ent[]): Parse {
    const norm = normalise(text);
    const mentions = findMentions(norm.words, norm.raw, ents);
    const base = { norm, mentions, thing: thingOf(norm.text), name: nameOfIntro(norm) };
    if (!norm.words.length) return { ...base, intent: 'unclear', score: 0, via: 'none' };
    if (base.name) return { ...base, intent: 'tell_name', score: 1, via: 'pattern' };
    for (const d of INTENTS) if (d.re?.some((re) => re.test(norm.text))) return { ...base, intent: d.id, score: 1, via: 'pattern' };
    return { ...base, intent: 'unclear', score: 0, via: 'none' };
  }

  /** The full reading: patterns, then the model (or word overlap while it isn't ready). */
  async parse(text: string, ents: readonly Ent[]): Promise<Parse> {
    const q = this.quick(text, ents);
    if (q.via === 'pattern' || !q.norm.words.length) return q;
    const masked = maskedText(q.norm, q.mentions);
    if (this.vecs && this.embedder) {
      const v = await this.embedder.embed([masked]).catch(() => null);
      if (v && v.length === DIM) return { ...q, ...this.byModel(v) };
    }
    return { ...q, ...this.byWords(masked) };
  }

  /** Similarity per intent: the best example, nudged by the second best (one lucky example is not enough). */
  private byModel(v: Float32Array): Pick<Parse, 'intent' | 'score' | 'via' | 'second'> {
    const best = new Map<Intent, [number, number]>();
    const V = this.vecs!;
    for (let i = 0; i < this.ex.length; i++) {
      let s = 0;
      const o = i * DIM;
      for (let d = 0; d < DIM; d++) s += V[o + d] * v[d];
      const b = best.get(this.ex[i].intent) ?? [-1, -1];
      if (s > b[0]) { b[1] = b[0]; b[0] = s; } else if (s > b[1]) b[1] = s;
      best.set(this.ex[i].intent, b);
    }
    const ranked = [...best].map(([k, [a, b]]) => ({ intent: k, score: a * 0.85 + Math.max(a - 0.1, b) * 0.15 })).sort((x, y) => y.score - x.score);
    const [top, next] = ranked;
    const U = UNDERSTAND;
    const ok = top.score >= U.sure || (top.score >= U.least && top.score - next.score >= U.margin);
    return { intent: ok ? top.intent : 'unclear', score: top.score, via: ok ? 'model' : 'none', second: ok ? next : top };
  }

  private byWords(text: string): Pick<Parse, 'intent' | 'score' | 'via' | 'second'> {
    const b = bag(text);
    const best = new Map<Intent, number>();
    for (const e of this.ex) best.set(e.intent, Math.max(best.get(e.intent) ?? 0, cosBag(b, e.bag, this.idf)));
    const ranked = [...best].map(([intent, score]) => ({ intent, score })).sort((x, y) => y.score - x.score);
    const [top, next] = ranked;
    const ok = top.score >= UNDERSTAND.words;
    return { intent: ok ? top.intent : 'unclear', score: top.score, via: ok ? 'words' : 'none', second: ok ? next : top };
  }
}

/** The normalised line with found names swapped for the example words of their kind. */
export function maskedText(norm: Normal, mentions: readonly Mention[]): string {
  const w = norm.words.slice();
  let last = -1;
  for (const m of [...mentions].sort((a, b) => b.from - a.from)) {
    if (m.from === last) continue;
    last = m.from;
    const s = STAND_IN[m.ent.kind];
    if (s) w.splice(m.from, m.to - m.from, s);
  }
  return w.join(' ') + (norm.question ? '?' : '');
}
