/**
 * The BERT word-piece tokenizer of the sentence model (all-MiniLM-L6-v2: lower case, accents
 * stripped, split at punctuation, then the longest pieces from vocab.txt, "##" for word middles).
 * The same ids as the reference tokenizer (tools/chatTest.ts checks a few sentences).
 *
 * Pure: no DOM.
 */

export const CLS = 101, SEP = 102, UNK = 100;
/** The longest input the model sees (tokens, with [CLS] and [SEP]); typed lines are far shorter. */
export const MAX_TOKENS = 64;

export class WordPiece {
  private ids = new Map<string, number>();

  constructor(vocab: string) {
    const lines = vocab.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const w = lines[i].replace(/\r$/, '');
      if (w) this.ids.set(w, i);
    }
  }

  /** [CLS] … [SEP] ids of a sentence. */
  encode(text: string): number[] {
    const out = [CLS];
    for (const w of basicTokens(text)) {
      for (const id of this.pieces(w)) {
        if (out.length >= MAX_TOKENS - 1) break;
        out.push(id);
      }
    }
    out.push(SEP);
    return out;
  }

  private pieces(w: string): number[] {
    if (w.length > 100) return [UNK];
    const out: number[] = [];
    let start = 0;
    while (start < w.length) {
      let end = w.length, id = -1;
      while (start < end) {
        const sub = (start > 0 ? '##' : '') + w.slice(start, end);
        const v = this.ids.get(sub);
        if (v !== undefined) { id = v; break; }
        end--;
      }
      if (id < 0) return [UNK];
      out.push(id);
      start = end;
    }
    return out;
  }
}

function isPunct(c: string): boolean {
  const cp = c.codePointAt(0)!;
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
  return /\p{P}/u.test(c);
}

/** BERT's basic tokenizer: clean, lower case, strip accents, split on spaces and punctuation. */
export function basicTokens(text: string): string[] {
  const s = text.replace(/[\u0000�]|\p{Cc}/gu, (m) => (/\s/.test(m) ? ' ' : '')).toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
  const out: string[] = [];
  let cur = '';
  for (const c of s) {
    if (/\s/.test(c)) { if (cur) out.push(cur); cur = ''; continue; }
    if (isPunct(c) || /[一-鿿㐀-䶿]/.test(c)) { if (cur) out.push(cur); cur = ''; out.push(c); continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}
