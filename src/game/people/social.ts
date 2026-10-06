/**
 * The social web (NPC_PERSONALITY_PLAN phase 4): who knows whom, what people need, and the
 * favours they ask of the hero. Like everything else about a person, all of it is a pure function
 * of the citizens' seeds and the time: nothing is stored for people you never met.
 *
 *  - Bonds: people who share a home are family or neighbours, people who live in the same block
 *    may be neighbours who know each other, people who work in the same building are colleagues,
 *    and a few pairs of about the same age are friends. Two people with a bond who pass each
 *    other in the street stop for a chat (Social.ts).
 *  - Word gets round: what you did to someone is known to the people close to them; their
 *    opinion of you moves a little with it, and they say so.
 *  - Needs (The Sims, small): hunger since the last meal, tiredness since waking, wanting company
 *    after a long time alone. They colour mood and small talk, and send hungry passers-by to a
 *    snack.
 *  - Favours: someone who likes you may ask you to look in on a friend or relative (go and find
 *    them: their dot is on the map) or to clear the gang off their street (stop a crime nearby).
 *    No quest log: the one who asked remembers it, and so does their dot.
 *
 * Pure: no DOM, no three.js.
 */
import { hashCombine, hashToFloat, hashString, Rng, deriveSeed } from '../../core/rng';
import { Role, type Citizen, type PlaceRef } from '../../sim/Population';
import type { Traits } from './identity';

export type Bond = 'family' | 'friend' | 'neighbour' | 'colleague';

export const SOCIAL = {
  /** Of two people under one roof: family (else neighbours who know each other). */
  family: 0.3,
  /** Of two people living in the same block: neighbours who know each other. */
  block: 0.12,
  /** Of any two grown-ups (or two children) of about the same age: friends. */
  friend: 0.006,
  /** Friends are at most this many years apart. */
  friendYears: 18,
  /** How much of a deed's weight in the opinion reaches someone through each bond. */
  hearsay: { family: 0.5, friend: 0.4, neighbour: 0.25, colleague: 0.25 } as Record<Bond, number>,
  /** The most hearsay moves an opinion. */
  hearsayMax: 35,
  /** Street chats: how near two people pass (m), how long they talk (s, by extraversion). */
  meetR: 3.5, chatMin: 5, chatMax: 16,
  /** The same two people stop for a chat at most once per this many seconds. */
  meetEvery: 900,
  /** Favours: opinion needed, met at least this often, chance per conversation, game hours to do it in. */
  favourOp: 15, favourMet: 2, favourChance: 0.45, favourHours: 48,
  /** Opinion for a favour done / one forgotten. */
  favourDone: 15, favourLost: -8,
  /** Clearing the street: a crime stopped within this many metres of where they asked. */
  streetsR: 300,
} as const;

function samePlace(a: PlaceRef, b: PlaceRef): boolean {
  return a.cell === b.cell && a.b === b.b && (a.b >= 0 || a.pick === b.pick);
}

/** A number in 0..1 for a pair of people (the same both ways round). */
export function pairU(a: Citizen, b: Citizen, salt: string): number {
  const lo = Math.min(a.seed, b.seed), hi = Math.max(a.seed, b.seed);
  return hashToFloat(hashCombine(hashCombine(lo, hi), hashString(salt)));
}

/** How two people are connected, or null (strangers). */
export function bondOf(a: Citizen, b: Citizen): Bond | null {
  if (a.id === b.id) return null;
  if (samePlace(a.home, b.home)) return pairU(a, b, 'family') < SOCIAL.family ? 'family' : 'neighbour';
  if (a.work && b.work && a.work.cell === b.work.cell && a.work.b === b.work.b) return 'colleague';
  if (a.home.cell === b.home.cell && pairU(a, b, 'block') < SOCIAL.block) return 'neighbour';
  const kidA = a.role === Role.Child, kidB = b.role === Role.Child;
  if (kidA !== kidB || Math.abs(a.age - b.age) * 100 > SOCIAL.friendYears) return null;
  return pairU(a, b, 'friend') < SOCIAL.friend ? 'friend' : null;
}

/** "my neighbour", "my friend", "my colleague"; family by age: "my mother", "my son" … */
export function bondWord(bond: Bond, other: Citizen, me: Citizen): string {
  if (bond !== 'family') return bond;
  const f = other.gender < 0.5, d = (other.age - me.age) * 100;
  if (d > 45) return f ? 'grandmother' : 'grandfather';
  if (d > 16) return f ? 'mother' : 'father';
  if (d < -45) return f ? 'granddaughter' : 'grandson';
  if (d < -16) return f ? 'daughter' : 'son';
  if (other.role !== Role.Child && me.role !== Role.Child && Math.abs(d) < 12 && hashToFloat(hashCombine(Math.min(me.seed, other.seed), 77)) < 0.5) return f ? 'wife' : 'husband';
  return f ? 'sister' : 'brother';
}

// ------------------------------------------------------------------ word gets round

export interface Told {
  /** Who told them (first name), how they are connected, what you did to them. */
  name: string;
  bond: Bond;
  word: string;
  deed: 'helped' | 'saved' | 'hurt';
}

/** What a deed weighs (the memory's opinion weights). */
export interface DeedWeights { helped: number; saved: number; hurt: number }

/**
 * What someone heard about the hero from the people close to them (the ones you know): the
 * strongest story, and how much it moves their opinion (bounded).
 */
export function hearsay(me: Citizen, known: readonly { cit: Citizen; name: string; helped: number; saved: number; hurt: number; deed: Told['deed'] | null }[], w: DeedWeights): { told: Told | null; op: number } {
  let op = 0, best: Told | null = null, bw = 0;
  for (const k of known) {
    if (k.cit.id === me.id || !k.deed) continue;
    const bond = bondOf(me, k.cit);
    if (!bond) continue;
    const s = SOCIAL.hearsay[bond];
    const v = (k.helped * w.helped + k.saved * w.saved + k.hurt * w.hurt) * s;
    op += v;
    if (Math.abs(v) > bw) { bw = Math.abs(v); best = { name: k.name.split(' ')[0], bond, word: bondWord(bond, k.cit, me), deed: k.deed }; }
  }
  return { told: best, op: Math.max(-SOCIAL.hearsayMax, Math.min(SOCIAL.hearsayMax, Math.round(op))) };
}

// ------------------------------------------------------------------ needs

export interface Needs {
  /** 0 full … 1 starving. */
  hunger: number;
  /** 0 fresh … 1 exhausted. */
  tired: number;
  /** 0 had company … 1 lonely (extraverts feel it sooner). */
  lonely: number;
}

/**
 * Their needs at an hour of the day: meals at breakfast (after waking), lunch (12–13:30) and
 * dinner (18:30–20), tiredness from waking to bed, loneliness by extraversion and time spent
 * at home alone (`homeH`: hours at home since the last outing).
 */
export function needsOf(c: Citizen, t: Traits, hour: number, homeH: number): Needs {
  const r = new Rng(deriveSeed(c.seed, 'needs'));
  const lunch = 12 + r.float() * 1.5, dinner = 18.5 + r.float() * 1.5, breakfast = c.wake + 0.4;
  const h = ((hour % 24) + 24) % 24;
  const meals = [breakfast, lunch, dinner].filter((m) => m <= h);
  const since = meals.length ? h - meals[meals.length - 1] : h + 24 - dinner;
  const hunger = Math.max(0, Math.min(1, (since - 1) / 5.5));
  const awake = h >= c.wake ? h - c.wake : h + 24 - c.wake;
  const day = Math.max(1, c.sleep - c.wake);
  const tired = Math.max(0, Math.min(1, (awake / day) * 0.85 + (h < 5 ? 0.3 : 0)));
  const lonely = Math.max(0, Math.min(1, homeH / (3 + (1 - t.e) * 9)));
  return { hunger, tired, lonely };
}

/** The need that matters most now, if any is pressing. */
export function pressing(n: Needs): 'hunger' | 'tired' | 'lonely' | null {
  const top = Math.max(n.hunger, n.tired, n.lonely);
  if (top < 0.7) return null;
  return n.hunger === top ? 'hunger' : n.tired === top ? 'tired' : 'lonely';
}

/** Mood: pressing needs pull it down a little. */
export function needsMood(n: Needs): number {
  return -0.25 * Math.max(0, n.hunger - 0.5) * 2 - 0.2 * Math.max(0, n.tired - 0.6) * 2.5 - 0.15 * Math.max(0, n.lonely - 0.6) * 2.5;
}

// ------------------------------------------------------------------ favours

export type FavourKind = 'visit' | 'streets';

export interface Favour {
  kind: FavourKind;
  /** Game hours: asked, and the end of the time they give you. */
  asked: number;
  until: number;
  /** Visit: the person to look in on (their citizen record, name, and how they are connected to the asker). */
  who?: Citizen;
  whoName?: string;
  word?: string;
  /** Where the one to look in on was last placed (on their way at a walking pace, as known people are). */
  wx?: number;
  wz?: number;
  /** Streets: where (x, z) and which group (null: any crime). */
  x?: number;
  z?: number;
  group?: string | null;
  /** Done (game hours), or lost (time ran out). */
  done?: number;
  lost?: boolean;
  /** Thanked for it already (the next conversation does). */
  thanked?: boolean;
}

/**
 * Someone they would like you to look in on: a friend or relative living elsewhere in the city
 * (a citizen made from their seed, so the same person every time).
 */
export function visitTarget(me: Citizen, make: (seed: number) => Citizen, day: number): { cit: Citizen; word: string } {
  const r = new Rng(deriveSeed(me.seed, 'visit', day));
  for (let k = 0; k < 6; k++) {
    const c = make(r.nextU32() | 1);
    if (c.role === Role.Child) continue;
    const old = me.age < 0.45 && c.age > 0.6;
    return { cit: c, word: old ? (c.gender < 0.5 ? 'grandmother' : 'grandfather') : r.chance(0.6) ? 'friend' : c.gender < 0.5 ? 'sister' : 'brother' };
  }
  const c = make(deriveSeed(me.seed, 'visit-fallback'));
  return { cit: { ...c, role: Role.Adult, age: Math.max(0.25, c.age) }, word: 'friend' };
}

/** Does this person ask a favour now (they like you, know you, have none open, and the dice say so)? */
export function asksFavour(op: number, met: number, open: boolean, u: number): boolean {
  return !open && op >= SOCIAL.favourOp && met >= SOCIAL.favourMet && u < SOCIAL.favourChance;
}

// ------------------------------------------------------------------ street chats

const MEET: Record<Bond, { hi: readonly string[]; back: readonly string[] }> = {
  family: { hi: ['There you are, {first}!', '{first}! What are you doing here?', 'Oh, {first}! Did you eat?'], back: ['Hi! Just on my way.', 'Don\'t worry, I\'m fine!', 'Oh, hi! I was going to call you.'] },
  friend: { hi: ['{first}! Long time!', 'Hey, {first}!', 'No way, {first}! How are you?'], back: ['Hey! Good to see you!', 'Oh my god, hi!', 'Ha, I was just thinking of you!'] },
  neighbour: { hi: ['Morning, {first}.', 'Hello, neighbour!', 'Oh, hi {first}. Did you hear the noise last night?'], back: ['Hello! All well?', 'Hi there!', 'Don\'t get me started.'] },
  colleague: { hi: ['Oh, hi {first}! Day off?', '{first}! Escaping the office too?', 'Hey, {first}. See you tomorrow?'], back: ['Ha, I wish.', 'Shh, don\'t tell the boss.', 'Yeah, see you!'] },
};
const BYE = ['See you!', 'Bye, take care!', 'Say hello to everyone!', 'Talk soon!', 'Right, I must dash.'];

/** What two people say when they meet ({first}: the other's first name). */
export function meetLines(bond: Bond, u: number): { hi: string; back: string; bye: string } {
  const m = MEET[bond];
  const at = <T>(l: readonly T[], v: number) => l[Math.floor(v * l.length) % l.length];
  return { hi: at(m.hi, u), back: at(m.back, (u * 7.31) % 1), bye: at(BYE, (u * 13.7) % 1) };
}

/** Do two people with a bond stop to talk (the outgoing more often; family always)? */
export function stopsToChat(bond: Bond, eA: number, eB: number, u: number): boolean {
  return bond === 'family' || u < 0.25 + (eA + eB) * 0.35;
}

/** How long they talk (s). */
export function chatFor(eA: number, eB: number, u: number): number {
  return SOCIAL.chatMin + (SOCIAL.chatMax - SOCIAL.chatMin) * Math.min(1, (eA + eB) / 2 * 0.7 + u * 0.3);
}

// ------------------------------------------------------------------ a snack on the way

const SNACK: Record<'hunger' | 'tired', readonly string[]> = {
  hunger: ['Mmh. Finally.', 'Starving…', 'Lunch on the go again.', 'Just a quick bite.'],
  tired: ['Coffee. I need coffee.', 'Ahh, that\'s better.', 'Long day…', 'Need to wake up.'],
};

export function snackLine(need: 'hunger' | 'tired', u: number): string {
  const l = SNACK[need];
  return l[Math.floor(u * l.length) % l.length];
}
