/**
 * Typed lines made regular before anything tries to understand them: lower case, contractions
 * written out ("where's" → "where is"), texting spelled out ("u" → "you"), common misspellings
 * fixed, punctuation dropped (a question mark is remembered). The sentence model gets the
 * player's own words (it copes with all of that); patterns and names get this.
 *
 * Pure.
 */

const CONTRACTIONS: [RegExp, string][] = [
  [/\bwon't\b/g, 'will not'], [/\bcan't\b/g, 'can not'], [/\bcannot\b/g, 'can not'], [/\bain't\b/g, 'is not'],
  [/\bshan't\b/g, 'shall not'], [/\blet's\b/g, 'let us'], [/\by'all\b/g, 'you all'],
  [/\b(\w+)n't\b/g, '$1 not'], [/\b(\w+)'re\b/g, '$1 are'], [/\b(\w+)'ve\b/g, '$1 have'], [/\b(\w+)'ll\b/g, '$1 will'],
  [/\b(\w+)'d\b/g, '$1 would'], [/\bi'm\b/g, 'i am'],
  [/\b(it|that|what|where|who|how|there|here|he|she|when|why|this|everything|nothing|something|everyone|nobody|somebody)'s\b/g, '$1 is'],
];

/** Texting, slang and misspellings, word for word. */
const WORDS: Record<string, string> = {
  u: 'you', ur: 'your', r: 'are', y: 'why', ya: 'you', yu: 'you', yo: 'hey', thx: 'thanks', thanx: 'thanks', ty: 'thank you', tnx: 'thanks',
  pls: 'please', plz: 'please', plez: 'please', wat: 'what', wut: 'what', whats: 'what is', wats: 'what is', wheres: 'where is', whos: 'who is', hows: 'how is',
  im: 'i am', ive: 'i have', id: 'i would', dont: 'do not', doesnt: 'does not', didnt: 'did not', isnt: 'is not', arent: 'are not', cant: 'can not',
  wont: 'will not', wouldnt: 'would not', couldnt: 'could not', shouldnt: 'should not', havent: 'have not', hasnt: 'has not', wasnt: 'was not',
  youre: 'you are', theyre: 'they are', thats: 'that is', theres: 'there is', lets: 'let us', its: 'it is',
  wanna: 'want to', gonna: 'going to', gotta: 'got to', kinda: 'kind of', sorta: 'sort of', dunno: 'do not know', lemme: 'let me', gimme: 'give me',
  idk: 'i do not know', dk: 'do not know', btw: 'by the way', imo: 'i think', tbh: 'honestly', omg: 'oh my god', lol: 'haha', lmao: 'haha', rofl: 'haha',
  nope: 'no', nah: 'no', yeah: 'yes', yea: 'yes', yep: 'yes', yup: 'yes', ye: 'yes', ok: 'okay', k: 'okay', kk: 'okay', okey: 'okay', alright: 'all right',
  hi: 'hi', hiya: 'hi', heya: 'hey', howdy: 'hello', helo: 'hello', hellow: 'hello', hallo: 'hello', bye: 'bye', byebye: 'bye', cya: 'see you', bb: 'bye',
  luv: 'love', cuz: 'because', coz: 'because', bc: 'because', 'b4': 'before', '2day': 'today', tmrw: 'tomorrow', tomorow: 'tomorrow', tonite: 'tonight',
  wich: 'which', becuase: 'because', becasue: 'because', beacuse: 'because', freind: 'friend', freinds: 'friends', familly: 'family', famliy: 'family',
  wierd: 'weird', thier: 'their', definately: 'definitely', recieve: 'receive', beleive: 'believe', untill: 'until', realy: 'really', reely: 'really',
  favorite: 'favourite', favourit: 'favourite', favorit: 'favourite', fav: 'favourite', fave: 'favourite', neighbor: 'neighbour', neighbors: 'neighbours',
  color: 'colour', colors: 'colours', mom: 'mum', mommy: 'mum', momma: 'mum', mama: 'mum', dad: 'dad', daddy: 'dad', papa: 'dad', ppl: 'people',
  cops: 'police', cop: 'police', '5o': 'police', coppers: 'police', fuzz: 'police', bro: 'brother', sis: 'sister', grandma: 'grandmother', granny: 'grandmother',
  grandpa: 'grandfather', gramps: 'grandfather', hubby: 'husband', bf: 'boyfriend', gf: 'girlfriend', kids: 'children', kid: 'child', job: 'job',
  everyting: 'everything', anyting: 'anything', somthing: 'something', nothin: 'nothing', somethin: 'something', goin: 'going', doin: 'doing',
  whatcha: 'what are you', watcha: 'what are you', whaddya: 'what do you', dya: 'do you', d: 'do', c: 'see', n: 'and', w: 'with', abt: 'about', bout: 'about',
  rn: 'right now', atm: 'right now', srsly: 'seriously', ofc: 'of course', np: 'no problem', nvm: 'never mind', jk: 'just kidding', ily: 'i love you',
  hru: 'how are you', wbu: 'what about you', hbu: 'how about you', wyd: 'what are you doing', wya: 'where are you', wtf: 'what the hell', stfu: 'shut up',
};

export interface Normal {
  /** The player's words, trimmed. */
  raw: string;
  /** Lower case, written out, without punctuation. */
  text: string;
  words: string[];
  question: boolean;
  exclaim: boolean;
}

export function normalise(input: string): Normal {
  const raw = input.trim().slice(0, 200);
  let s = raw.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '').replace(/[’‘`´]/g, '\'');
  for (const [re, to] of CONTRACTIONS) s = s.replace(re, to);
  // Possessives stay ("mara's" → "mara s" would split a name): drop the 's.
  s = s.replace(/(\w)'s\b/g, '$1');
  const question = /\?/.test(raw) || /^(who|what|where|when|why|how|which|do|does|did|are|is|can|could|would|will|have|has|should)\b/.test(s);
  const exclaim = /!/.test(raw);
  s = s.replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/(^|\s)-+|-+(\s|$)/g, ' ');
  const words: string[] = [];
  for (const w0 of s.split(/\s+/)) {
    if (!w0) continue;
    // Stretched words: "heyyyy", "sooo" (but not real double letters).
    const w = w0.replace(/(\p{L})\1{2,}/gu, '$1$1');
    const to = WORDS[w] ?? WORDS[w.replace(/(\p{L})\1/gu, '$1')] ?? w;
    for (const p of to.split(' ')) words.push(p);
  }
  return { raw, text: words.join(' '), words, question, exclaim };
}
