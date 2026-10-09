/**
 * When a typed line is not understood (typed NPC chat): the safety net, in this order.
 *
 *  1. A name in the line: talk about that (a relative, a place, a threat, a side of the city).
 *  2. A shape we recognise: a question "do you …" / "can you …" gets an in-character dodge.
 *  3. Now and then, Eliza's old trick: the player's words turned round and asked back
 *     ("You think the canal is haunted? Why?"). Sparingly; it gets old fast.
 *  4. Steer back to what they can talk about (doubles as a hint for the player).
 *
 * Pure.
 */
import type { Parse } from './understand';
import type { ChatTopic } from './answers';
import type { ChatWorld } from './respond';

type Say = (t: ChatTopic, flags?: readonly string[], tok?: Record<string, string>) => string;

const SWAP: Record<string, string> = {
  i: 'you', me: 'you', my: 'your', mine: 'yours', myself: 'yourself', am: 'are', was: 'were',
  you: 'I', your: 'my', yours: 'mine', yourself: 'myself', are: 'am', we: 'you', us: 'you', our: 'your',
};

/** "I think the canal is haunted" → "you think the canal is haunted" */
export function reflect(words: readonly string[]): string {
  const out = words.map((w, i) => {
    // "you" after a verb is the object: "me".
    if (w === 'you' && i > 0 && !/^(and|or|but|that|if|when|because|so)$/.test(words[i - 1])) return 'me';
    return SWAP[w] ?? w;
  });
  return out.join(' ');
}

const DODGE: Record<string, readonly string[]> = {
  do: ['Do I? Hmm. Sometimes.', 'Not really, no.', 'Do I what? Funny question.'],
  can: ['Can I? I doubt it. I\'m no hero.', 'Me? No, no.'],
  have: ['Have I? Not that I remember.', 'Hmm, no, I don\'t think so.'],
  are: ['Am I? I don\'t think so.', 'Me? Ha. No.'],
  would: ['I might. Depends.', 'Would I? Probably not.'],
  will: ['We\'ll see.', 'Maybe. Who knows.'],
  what: ['Good question. I don\'t know.', 'No idea, honestly.', 'Ask me something easier.'],
  why: ['Why? Ask the city.', 'I wish I knew.'],
  how: ['How? No idea.', 'Beats me.'],
  where: ['Couldn\'t tell you.', 'Not sure, sorry.'],
  who: ['No idea who that is.', 'Couldn\'t say.'],
  when: ['Some time, I suppose.', 'No idea.'],
};

export function fallback(p: Parse, w: ChatWorld, say: Say, u: number, misses: number): string {
  const words = p.norm.words;
  // 2. A shape: the first word of a question.
  const first = words[0] ?? '';
  const key = first === 'does' || first === 'did' ? 'do' : first === 'could' ? 'can' : first === 'is' ? 'are' : first;
  const dodges = DODGE[key];
  if (dodges && (p.norm.question || key !== 'do') && words.length > 1 && misses < 3) return dodges[Math.floor(u * dodges.length) % dodges.length];
  // 3. Eliza: a statement about the player, turned round (once in a while).
  // ("I think …" / "I believe …" is an opinion put to them: that one always gets turned round.)
  const opinion = /^(think|believe|reckon|guess|feel)$/.test(words[1] ?? '');
  if (first === 'i' && words.length >= 3 && words.length <= 10 && (u < 0.45 || opinion) && misses < 3) {
    const r = reflect(words);
    const tails = ['? Why?', '? Tell me more.', '? Really?', '? How come?'];
    return `${r.charAt(0).toUpperCase()}${r.slice(1)}${tails[Math.floor(u * 40) % tails.length]}`;
  }
  void w;
  // 4. Steer back.
  return say('unclear');
}
