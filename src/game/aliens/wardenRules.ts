/**
 * The Wardens' rules (ALIENS_PLAN phase 1, pure and seeded; tested in tools/aliensTest.ts): how many
 * discs are over the city when (random, unexplained: usually a handful, some stretches none, now
 * and then a swarm of a hundred or more, then nothing), when a walker is set down on a square, when
 * a disc hangs over a landmark for hours, and what people say about them.
 *
 * Everything follows from the city seed and the game clock, so nothing here is saved: a loaded
 * game sees the same sky it would have seen.
 */
import { Rng, deriveSeed, hash32, hashToFloat } from '../../core/rng';
import type { Temperament } from '../people/identity';

export const WARDENS = {
  /** Game hours per disc slot: the number of discs is rolled anew every slot. */
  slot: 1 / 3,
  /** Share of quiet slots with no disc at all. */
  emptyP: 0.15,
  /** Discs in an ordinary slot (picked evenly). */
  counts: [1, 2, 3, 3, 4, 4, 5, 5, 6, 7] as readonly number[],
  /** Chance a swarm starts in a slot (~3 % an hour), its size and length in slots. */
  swarmP: 0.01,
  swarm: [90, 150] as const,
  swarmSlots: [2, 9] as const,
  /** Some swarms stay for the best part of a day. */
  longSwarmP: 0.06,
  longSwarmSlots: [24, 60] as const,
  /** Slots of empty sky right after a swarm. */
  afterSwarm: 3,
  /** A walker set down on a square: chance per game hour, how long it stays (game hours). */
  walkerP: 0.22,
  walkerStay: [0.33, 0.9] as const,
  /** A disc hanging over a landmark: chance per game day, how long (game hours). */
  stareP: 0.35,
  stareHours: [2, 6] as const,
  /** Discs gathering over an incident (by its response level 0..5). */
  watchers: [0, 1, 2, 2, 3, 3] as readonly number[],
};

export interface DiscPlan {
  /** Discs that should be over the city now. */
  count: number;
  /** A swarm is on (when it started and ends, game hours). */
  swarm: { start: number; end: number } | null;
  /** The slot index (changes every WARDENS.slot game hours). */
  slot: number;
}

/** A swarm starting in this slot (its length in slots), or 0. */
export function swarmStart(seed: number, slot: number): number {
  const h = hash32(deriveSeed(seed, 'swarm') ^ Math.imul(slot, 0x9e3779b1));
  if (hashToFloat(h) >= WARDENS.swarmP) return 0;
  const r = new Rng(deriveSeed(seed, 'swarmLen', slot));
  return r.chance(WARDENS.longSwarmP) ? r.int(...WARDENS.longSwarmSlots) : r.int(...WARDENS.swarmSlots);
}

/** How many discs are over the city at this game time, and whether a swarm is on. */
export function discPlan(seed: number, hoursAbs: number): DiscPlan {
  const slot = Math.floor(hoursAbs / WARDENS.slot);
  const back = WARDENS.longSwarmSlots[1] + WARDENS.afterSwarm;
  // The latest swarm that started within reach (a later one wins; overlapping ones merge).
  for (let s = slot; s >= slot - back; s--) {
    const len = swarmStart(seed, s);
    if (!len) continue;
    const end = s + len;
    if (slot < end) {
      const r = new Rng(deriveSeed(seed, 'swarmSize', s));
      return { count: r.int(...WARDENS.swarm), swarm: { start: s * WARDENS.slot, end: end * WARDENS.slot }, slot };
    }
    // Then nothing: an empty sky for a while.
    if (slot < end + WARDENS.afterSwarm) return { count: 0, swarm: null, slot };
    break;
  }
  const r = new Rng(deriveSeed(seed, 'discs', slot));
  if (r.chance(WARDENS.emptyP)) return { count: 0, swarm: null, slot };
  return { count: r.pick(WARDENS.counts), swarm: null, slot };
}

/** A walker's visit in this game hour (start and end, game hours), or null. */
export function walkerVisit(seed: number, hour: number): { start: number; end: number; seed: number } | null {
  const r = new Rng(deriveSeed(seed, 'walker', hour));
  if (!r.chance(WARDENS.walkerP)) return null;
  const start = hour + r.float() * 0.6;
  return { start, end: start + r.range(...WARDENS.walkerStay), seed: r.int(1, 0x7fffffff) };
}

/** A disc hanging over a landmark this game day (start and end, game hours; `pick` chooses the landmark), or null. */
export function stareVisit(seed: number, day: number): { start: number; end: number; pick: number } | null {
  const r = new Rng(deriveSeed(seed, 'stare', day));
  if (!r.chance(WARDENS.stareP)) return null;
  const start = day * 24 + r.range(7, 20);
  return { start, end: start + r.range(...WARDENS.stareHours), pick: r.int(0, 1 << 20) };
}

// ------------------------------------------------------------------ what people say

/** What there is to talk about: a swarm, a walker close by, a disc hanging or scanning near, nothing special. */
export type NannyMoment = 'swarm' | 'walker' | 'disc' | 'sky';

/** Lines by moment; `kid` for children, the rest by temperament (a missing one falls back to `any`). */
const NANNY: Record<NannyMoment, Partial<Record<Temperament | 'any' | 'kid', readonly string[]>>> = {
  swarm: {
    any: ['There must be a hundred of them up there.', 'What are they all doing here?', 'Is it some kind of festival?', 'Nobody knows why. They never say.'],
    anxious: ['Oh no. Oh no, why so many?', 'I\'m staying indoors until they\'re gone.'],
    grumpy: ['A hundred Nannies and not one of them explains.', 'Great. Now they\'re bringing friends.'],
    nosy: ['My cousin says it\'s their new year.', 'I heard it\'s a wedding. Or a funeral. Something.'],
    chatty: ['The news says it\'s a festival. The news says that every time.'],
    cheerful: ['It\'s actually kind of pretty.', 'Look at the lights on them!'],
    dreamy: ['Like a flock of silver birds…'],
    kid: ['Mum, look! Look at all of them!', 'I counted forty and then I lost count!'],
  },
  walker: {
    any: ['Don\'t stare at it. It\'s staring enough for both of us.', 'They just stand there for hours.', 'Is it looking at me?', 'Keep walking.'],
    anxious: ['Don\'t make eye contact, don\'t make eye contact…', 'Why is it here? Why here?'],
    grumpy: ['Inspecting us again. Charming.', 'Go stand on your own planet.'],
    nosy: ['What is it looking at? What did they do?', 'I bet somebody\'s in trouble.'],
    kind: ['Hello… Warden. Nice day for it.'],
    cheerful: ['Morning, Nanny!'],
    proud: ['I refuse to be impressed.'],
    kid: ['It\'s so tall!', 'Can I touch it? Please?', 'Hi! Hi! It didn\'t wave back.'],
  },
  disc: {
    any: ['The Nannies are watching again.', 'Don\'t look up. It only encourages them.', 'What are they scanning for now?', 'One of theirs, right over us.'],
    anxious: ['Is it scanning us? It\'s scanning us.', 'I hate it when they hang there like that.'],
    grumpy: ['Tsk. Nannies.', 'As if we can\'t look after ourselves.', 'Twenty years and still no manners.'],
    nosy: ['Somebody\'s in trouble with the Nannies.', 'What do you think they\'re looking for?'],
    kind: ['They mean well. I think.'],
    cheerful: ['Wave! Maybe it waves back.'],
    dreamy: ['I wonder what we look like from up there.'],
    kid: ['A saucer! A saucer!', 'Do they have kids too?'],
  },
  sky: {
    any: ['Another disc. Bet it\'s off to nowhere again.', 'The Nannies are busy today.'],
    grumpy: ['Look at them. Watching. Always watching.'],
    nosy: ['Where do you think they go all day?'],
    kid: ['There\'s one! I saw one first!'],
  },
};

/** A line about the Wardens for someone (u: a number in [0, 1)), or null (the shy keep quiet). */
export function nannyLine(m: NannyMoment, temper: Temperament, child: boolean, u: number): string | null {
  if (temper === 'shy' && !child) return null;
  const L = NANNY[m];
  const own = child ? L.kid : L[temper];
  // Their own words most of the time, the common ones otherwise.
  const pool = own && (u < 0.65 || !L.any) ? own : L.any ?? own;
  if (!pool?.length) return null;
  const k = u < 0.65 && own ? u / 0.65 : (u - 0.65) / 0.35;
  return pool[Math.min(pool.length - 1, Math.floor(Math.max(0, k) * pool.length))];
}

/** Every line (tests: lengths, no tokens left over). */
export function allNannyLines(): string[] {
  const out: string[] = [];
  for (const m of Object.values(NANNY)) for (const l of Object.values(m)) if (l) out.push(...l);
  return out;
}
