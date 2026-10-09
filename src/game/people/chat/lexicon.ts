/**
 * Names the player may use (typed NPC chat): the people close to the one you talk to ("your
 * brother", "Tomas"), people you know, streets, neighbourhoods, landmarks and stations, villain
 * groups and their bosses, the big threats, the city's factions (police, army, Wardens …) and
 * things one can like or not (jazz, football, pizza …). `findMentions` finds them in a
 * normalised sentence, forgiving a typo in longer names.
 *
 * Pure.
 */

export type EntKind =
  | 'kin' // someone close to them, by the word ("your brother"): data = kin word
  | 'person' // someone by name (close to them, or known to the hero)
  | 'place' // a landmark or a station (data: x, z)
  | 'placeKind' // a kind of place ("a station", "the hospital", "somewhere to eat")
  | 'street' | 'hood'
  | 'group' | 'boss'
  | 'threat' // a big threat by kind
  | 'faction' // police, army, Wardens, heroes, gangs, monsters, the mayor …
  | 'thing' // something to like or not
  | 'city';

export interface Ent {
  kind: EntKind;
  /** Stable key ("kin:brother", "threat:worm", "thing:jazz", "place:3"). */
  id: string;
  /** How they say it ("the Rust Saints", "Linden Street", "jazz"). */
  label: string;
  /** Normalised names to look for (one or more words each). */
  names: readonly string[];
  x?: number;
  z?: number;
  /** Kind-specific detail (the kin word, the thing's category, the threat's kind …). */
  data?: string;
}

export interface Mention {
  ent: Ent;
  /** Word span in the normalised sentence. */
  from: number;
  to: number;
  /** Found with a typo forgiven. */
  fuzzy: boolean;
}

/** Common words that are also first names: only a capitalised one in the player's words counts. */
const COMMON = new Set(['will', 'may', 'rose', 'mark', 'grace', 'hope', 'faith', 'joy', 'bill', 'pat', 'sue', 'jack', 'ray', 'max', 'art', 'dawn', 'summer', 'june', 'april', 'august', 'rich', 'frank', 'guy', 'sky', 'star', 'river', 'lily', 'ivy', 'ruby', 'amber', 'hunter', 'mason', 'carter', 'young', 'long', 'white', 'black', 'brown', 'green', 'king', 'park', 'hill', 'wood', 'lane', 'love', 'sunny', 'chance', 'case', 'major', 'ben', 'don', 'van', 'can', 'mo', 'jo', 'al', 'ed', 'bo', 'li', 'jin']);

function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length, n = b.length;
  let prev = new Array<number>(n + 1), cur = new Array<number>(n + 1), pp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= n; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, pp[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [pp, prev, cur] = [prev, cur, pp];
  }
  return prev[n];
}

/** Typos forgiven by length: none below 5 letters, one up to 8, two beyond. */
function allowed(len: number): number {
  return len < 5 ? 0 : len < 9 ? 1 : 2;
}

/** "Linden St." → "linden street"; "The Rust Saints" → "rust saints". */
export function nameKey(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '').replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\bst\b/g, 'street').replace(/\brd\b/g, 'road').replace(/\bave\b/g, 'avenue').replace(/\bsq\b/g, 'square')
    .replace(/^(the|a|an) /, '').replace(/\s+/g, ' ').trim();
}

/**
 * Every mention in a normalised sentence: longest names first, no overlaps. `raw` (the player's
 * own words) tells a capitalised name ("Rose") from the word ("a rose").
 */
export function findMentions(words: readonly string[], raw: string, ents: readonly Ent[]): Mention[] {
  const index = new Map<string, Ent[]>();
  let maxLen = 1;
  for (const e of ents) for (const n of e.names) {
    const k = nameKey(n);
    if (!k) continue;
    const arr = index.get(k);
    if (arr) { if (!arr.includes(e)) arr.push(e); } else index.set(k, [e]);
    maxLen = Math.max(maxLen, k.split(' ').length);
  }
  const keys = [...index.keys()];
  const caps = new Set((raw.match(/\b\p{Lu}[\p{L}'-]*/gu) ?? []).map((w) => w.toLowerCase()));
  const taken = new Array<boolean>(words.length).fill(false);
  const out: Mention[] = [];
  for (let len = Math.min(maxLen, words.length); len >= 1; len--) {
    for (let i = 0; i + len <= words.length; i++) {
      if (taken.slice(i, i + len).some(Boolean)) continue;
      const span = words.slice(i, i + len).join(' ');
      let hit = index.get(span), fuzzy = false;
      if (!hit && span.length >= 5) {
        // A typo: the closest name within the allowance (first letter must match).
        let best: string | null = null, bd = allowed(span.length) + 1;
        for (const k of keys) {
          if (k[0] !== span[0] || Math.abs(k.length - span.length) > 2) continue;
          const d = editDistance(span, k, allowed(k.length));
          if (d < bd) { bd = d; best = k; }
        }
        if (best && bd <= allowed(best.length)) { hit = index.get(best); fuzzy = true; }
      }
      if (!hit) continue;
      // A single common word only as a capitalised name.
      const list = hit.filter((e) => !(len === 1 && (e.kind === 'person' || e.kind === 'boss') && COMMON.has(span) && !caps.has(span)));
      if (!list.length) continue;
      for (const e of list) out.push({ ent: e, from: i, to: i + len, fuzzy });
      for (let j = i; j < i + len; j++) taken[j] = true;
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

// ------------------------------------------------------------------ fixed vocabulary

/** Kin words the player may use, and the words they stand for. */
export const KIN_WORDS: Record<string, readonly string[]> = {
  mother: ['mother', 'mum', 'mom', 'mam'], father: ['father', 'dad', 'pa'], parents: ['parents', 'folks'],
  brother: ['brother', 'brothers'], sister: ['sister', 'sisters'], siblings: ['siblings'],
  husband: ['husband'], wife: ['wife'], partner: ['partner', 'boyfriend', 'girlfriend', 'spouse', 'other half'],
  son: ['son', 'sons', 'boy'], daughter: ['daughter', 'daughters', 'girl'], children: ['children', 'child', 'kids', 'little ones'],
  grandmother: ['grandmother', 'gran', 'nan', 'nana', 'granny'], grandfather: ['grandfather', 'grandad', 'granddad'],
  grandson: ['grandson'], granddaughter: ['granddaughter'], grandchildren: ['grandchildren', 'grandkids'],
  friend: ['friend', 'friends', 'best friend', 'mate', 'buddy', 'pal'], neighbour: ['neighbour', 'neighbours', 'neighbor', 'neighbors'],
  colleague: ['colleague', 'colleagues', 'coworker', 'co-worker', 'workmate', 'boss at work'], family: ['family', 'relatives', 'family members'],
};

/** The city's sides, as people call them. */
export const FACTIONS: readonly Ent[] = [
  { kind: 'faction', id: 'faction:police', label: 'the police', names: ['police', 'police officers', 'officers', 'cops', 'law', 'the law', 'policeman', 'policemen', 'policewoman'] },
  { kind: 'faction', id: 'faction:army', label: 'the army', names: ['army', 'soldiers', 'military', 'troops', 'tanks'] },
  { kind: 'faction', id: 'faction:wardens', label: 'the Wardens', names: ['wardens', 'warden', 'aliens', 'alien', 'ufo', 'ufos', 'saucer', 'saucers', 'flying saucer', 'nannies', 'discs', 'visitors'] },
  { kind: 'faction', id: 'faction:heroes', label: 'superheroes', names: ['superheroes', 'superhero', 'heroes', 'hero', 'super heroes', 'capes', 'vigilantes'] },
  { kind: 'faction', id: 'faction:gangs', label: 'the gangs', names: ['gangs', 'gang', 'criminals', 'crooks', 'thugs', 'villains', 'mafia', 'mob', 'bad guys', 'crime'] },
  { kind: 'faction', id: 'faction:mayor', label: 'the mayor', names: ['mayor', 'city council', 'council', 'government', 'politicians'] },
  { kind: 'faction', id: 'faction:monsters', label: 'the monsters', names: ['monsters', 'monster', 'creatures', 'creature', 'beasts', 'kaiju'] },
  { kind: 'faction', id: 'faction:robots', label: 'the robots', names: ['robots', 'robot', 'drones', 'drone', 'machines', 'service bots', 'bots'] },
  { kind: 'faction', id: 'faction:slimes', label: 'the slimes', names: ['slimes', 'slime', 'sewer slimes', 'lumen', 'murk', 'sewer people'] },
  { kind: 'faction', id: 'faction:paramedics', label: 'the paramedics', names: ['paramedics', 'ambulance', 'doctors', 'medics', 'hospital staff'] },
  { kind: 'faction', id: 'faction:firefighters', label: 'the fire brigade', names: ['firefighters', 'fire brigade', 'firemen', 'fire department'] },
];

/** The big threats, by the words people use (the ThreatDirector archetypes they stand for). */
export const THREATS: readonly Ent[] = [
  { kind: 'threat', id: 'threat:burrower', data: 'burrower', label: 'the giant worm', names: ['worm', 'giant worm', 'sandworm', 'burrower', 'sinkhole', 'sinkholes', 'the thing underground'] },
  { kind: 'threat', id: 'threat:leviathan', data: 'leviathan', label: 'the leviathan', names: ['leviathan', 'sea monster', 'river monster', 'sea serpent', 'serpent', 'the thing in the river', 'kraken'] },
  { kind: 'threat', id: 'threat:strider', data: 'strider', label: 'the Strider', names: ['strider', 'walker', 'tripod', 'giant walker', 'big walking thing', 'giant robot'] },
  { kind: 'threat', id: 'threat:roc', data: 'roc', label: 'the roc', names: ['roc', 'giant bird', 'big bird', 'thunderbird', 'monster bird'] },
  { kind: 'threat', id: 'threat:mech', data: 'mech', label: 'the mech', names: ['mech', 'battle mech', 'war machine', 'mecha'] },
  { kind: 'threat', id: 'threat:brood', data: 'brood', label: 'the swarm', names: ['swarm', 'bugs', 'insects', 'brood', 'critters', 'beetles', 'the swarm'] },
  { kind: 'threat', id: 'threat:robots', data: 'robots', label: 'the rogue robots', names: ['rogue robots', 'robot attack', 'malfunction', 'broken robots', 'crazy robots'] },
  { kind: 'threat', id: 'threat:tree', data: 'tree', label: 'the walking tree', names: ['walking tree', 'tree monster', 'awakened tree', 'angry tree', 'treant'] },
  { kind: 'threat', id: 'threat:giant', data: 'rampage', label: 'the rampaging giant', names: ['rampaging giant', 'the giant', 'giant'] },
];

/** Kinds of places to ask the way to (resolved to the nearest one there is). */
export const PLACE_KINDS: readonly Ent[] = [
  { kind: 'placeKind', id: 'pk:station', data: 'station', label: 'a metro station', names: ['station', 'metro', 'metro station', 'subway', 'underground', 'train station', 'tube', 'train'] },
  { kind: 'placeKind', id: 'pk:food', data: 'food', label: 'somewhere to eat', names: ['restaurant', 'cafe', 'coffee', 'food', 'something to eat', 'a bite', 'diner', 'snack', 'bakery', 'pub', 'bar'] },
  { kind: 'placeKind', id: 'pk:hospital', data: 'hospital', label: 'the hospital', names: ['hospital', 'doctor', 'clinic', 'medic'] },
  { kind: 'placeKind', id: 'pk:police', data: 'police', label: 'a police station', names: ['police station', 'precinct', 'police headquarters'] },
  { kind: 'placeKind', id: 'pk:park', data: 'park', label: 'a park', names: ['park', 'gardens'] },
  { kind: 'placeKind', id: 'pk:toilet', data: 'toilet', label: 'a toilet', names: ['toilet', 'bathroom', 'loo', 'restroom', 'wc'] },
  { kind: 'placeKind', id: 'pk:shop', data: 'shop', label: 'a shop', names: ['shop', 'store', 'supermarket', 'market', 'shopping'] },
  { kind: 'placeKind', id: 'pk:sewers', data: 'sewers', label: 'the sewers', names: ['sewers', 'sewer', 'manhole', 'tunnels'] },
];
