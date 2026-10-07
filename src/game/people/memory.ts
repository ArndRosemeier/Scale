/**
 * What people remember of the hero (NPC_PERSONALITY_PLAN §3.3). Only the people you met are
 * kept, and only a few of them (CAP): when a new acquaintance would be one too many, the one with
 * the lowest keep score is forgotten (met least, longest ago, no strong feelings). Everybody else
 * is a pure function of the seed.
 *
 * A record keeps the citizen itself (seed, home, workplace, rhythm), so the person can be found
 * again on their day plan wherever they are, and the map can show where they are now.
 *
 * Pure: no DOM, no three.js. Saved per city in the browser and in the save game.
 */
import type { Citizen, PlaceRef } from '../../sim/Population';
import { SOCIAL, type Favour } from './social';

export const PEOPLE = {
  /** People remembered at most (the map's faint dots). */
  cap: 24,
  /** A new meeting counts once this many game hours have passed since the last one. */
  newMeeting: 1,
  /** Notes kept per person (dated, newest last; what a language model would be told). */
  notes: 8,
  /** Line keys remembered per person (they don't repeat themselves). */
  said: 24,
  /** Opinion: per conversation (up to talkMax), helped up, saved, knocked down. */
  talk: 2, talkMax: 10, helped: 25, saved: 40, hurt: -30,
  /** Reputation's weight in the opinion: base + agreeableness × this. */
  repBase: 0.15, repAgree: 0.35,
  /**
   * Out of sight, a known person heads for where their day plan has them at a walking pace (m/s,
   * real time; the plan itself runs at the day's speed, many times faster), or riding (car, metro,
   * taxi) when both they and that place are this far from you (m).
   */
  walk: 1.5, ride: 9, rideFrom: 400,
  /** Out of their body's range but this near you (m), they are put back in the street, tried every backEvery s. */
  backR: 300, backEvery: 8,
} as const;

/**
 * One step (dt real seconds) of a known person out of sight, from (x, z) towards their day plan's
 * place (tx, tz), with the hero at (px, pz): never faster than a walk anywhere near you.
 */
export function onTheirWay(x: number, z: number, tx: number, tz: number, px: number, pz: number, dt: number): { x: number; z: number } {
  const dx = tx - x, dz = tz - z, d = Math.hypot(dx, dz);
  if (d < 1e-3 || !(dt > 0)) return { x, z };
  const R = PEOPLE.rideFrom;
  const ride = d > R && Math.hypot(x - px, z - pz) > R && Math.hypot(tx - px, tz - pz) > R;
  const step = Math.min(d, (ride ? PEOPLE.ride : PEOPLE.walk) * dt);
  return { x: x + (dx / d) * step, z: z + (dz / d) * step };
}

export type Deed = 'talked' | 'helped' | 'saved' | 'hurt';

export interface Known {
  cit: Citizen;
  name: string;
  /** Game hours (Sky.hoursAbs) of the first and the latest meeting. */
  first: number;
  last: number;
  /** Separate meetings (a new one after PEOPLE.newMeeting game hours). */
  met: number;
  talks: number;
  helped: number;
  saved: number;
  hurt: number;
  /** The deed that mattered last (not a chat), and the street where it happened. */
  deed: 'helped' | 'saved' | 'hurt' | null;
  deedStreet: string | null;
  /** Where they were last seen (x, z) and on which street. */
  x: number;
  z: number;
  street: string | null;
  /** Line keys they already said to you. */
  said: string[];
  /** Met last as something other than their own job (a busker, an officer …): what the map calls them. */
  title?: string;
  notes: { t: number; text: string }[];
  /** Favours done for them, and ones you let them down on (phase 4). */
  favours: number;
  letDown: number;
  /** The favour they asked of you (open, or done/lost and not yet talked about). */
  favour?: Favour;
}

export function newKnown(cit: Citizen, name: string, now: number, x: number, z: number, street: string | null): Known {
  return { cit, name, first: now, last: now, met: 1, talks: 0, helped: 0, saved: 0, hurt: 0, deed: null, deedStreet: null, x, z, street, said: [], notes: [], favours: 0, letDown: 0 };
}

/**
 * How they feel about the hero: what you did to them (and favours done or forgotten), what they
 * heard about you from the people close to them (`heard`, social.ts hearsay), plus your
 * reputation, weighted by how agreeable they are.
 */
export function opinionOf(k: (Pick<Known, 'talks' | 'helped' | 'saved' | 'hurt'> & { favours?: number; letDown?: number }) | null, rep: number, agree: number, heard = 0): number {
  const own = k ? Math.min(PEOPLE.talkMax, k.talks * PEOPLE.talk) + k.helped * PEOPLE.helped + k.saved * PEOPLE.saved + k.hurt * PEOPLE.hurt
    + (k.favours ?? 0) * SOCIAL.favourDone + (k.letDown ?? 0) * SOCIAL.favourLost : 0;
  return Math.max(-100, Math.min(100, Math.round(own + heard + rep * (PEOPLE.repBase + PEOPLE.repAgree * agree))));
}

/** Higher: kept longer when the list is full. */
export function keepScore(k: Known, now: number): number {
  // (Someone waiting on a favour is not forgotten while it is open.)
  return k.met * 2 + k.talks + (k.helped + k.saved + k.favours) * 6 + k.hurt * 4 - Math.max(0, now - k.last) / 24 + (k.favour && !k.favour.done && !k.favour.lost ? 50 : 0);
}

/** A dated note ("Day 3: helped them up on Linden Street"), bounded. */
export function addNote(k: Known, now: number, text: string): void {
  k.notes.push({ t: now, text });
  if (k.notes.length > PEOPLE.notes) k.notes.splice(0, k.notes.length - PEOPLE.notes);
}

/** Record a deed (talked, helped, saved, hurt) on a record. */
export function applyDeed(k: Known, d: Deed, now: number, street: string | null): void {
  if (d === 'talked') k.talks++;
  else {
    k[d]++;
    k.deed = d;
    k.deedStreet = street;
  }
  if (now - k.last >= PEOPLE.newMeeting) k.met++;
  k.last = now;
}

/** Remember the line keys a person said ("h3#1"), bounded. */
export function addSaid(k: Known, ids: string): void {
  for (const id of ids.split(' ')) if (id && !k.said.includes(id)) k.said.push(id);
  if (k.said.length > PEOPLE.said) k.said.splice(0, k.said.length - PEOPLE.said);
}

/**
 * Add a record to the list; when that makes one too many, forget the one with the lowest keep
 * score (never the one just added). Returns the forgotten record, if any.
 */
export function remember(list: Known[], k: Known, now: number, cap: number = PEOPLE.cap): Known | null {
  list.push(k);
  if (list.length <= cap) return null;
  let wi = -1, ws = Infinity;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === k) continue;
    const s = keepScore(list[i], now);
    if (s < ws) { ws = s; wi = i; }
  }
  return wi >= 0 ? list.splice(wi, 1)[0] : null;
}

// ------------------------------------------------------------------ saving

export interface SavedPeople { v: 1; people: Known[] }

export function savePeople(list: readonly Known[]): SavedPeople {
  return { v: 1, people: list.map((k) => ({ ...k, said: [...k.said], notes: k.notes.map((n) => ({ ...n })), ...(k.favour ? { favour: { ...k.favour } } : {}) })) };
}

const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const str = (v: unknown, max = 80): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const KINDS = ['home', 'work', 'shop', 'food', 'park', 'school', 'leisure'] as const;

function place(v: unknown): PlaceRef | null {
  const o = obj(v);
  if (!Number.isInteger(o.cell) || !Number.isInteger(o.b)) return null;
  return { cell: o.cell as number, b: o.b as number, pick: Math.floor(num(o.pick, 0, 0)), kind: KINDS.includes(o.kind as never) ? (o.kind as PlaceRef['kind']) : 'home' };
}

function citizen(v: unknown): Citizen | null {
  const o = obj(v);
  const home = place(o.home);
  if (!home || !Number.isFinite(o.seed) || !Number.isFinite(o.id)) return null;
  return {
    id: o.id as number, seed: o.seed as number, role: Math.round(num(o.role, 1, 0, 3)), gender: num(o.gender, 0.5, 0, 1), age: num(o.age, 0.4, 0, 1),
    home, work: o.work ? place(o.work) : null, ownsCar: o.ownsCar === true,
    wake: num(o.wake, 7), sleep: num(o.sleep, 23), workStart: num(o.workStart, 8.5), workLen: num(o.workLen, 8.5),
    nerve: num(o.nerve, 0.5, 0, 1), curiosity: num(o.curiosity, 0.5, 0, 1),
  };
}

function favour(v: unknown): Favour | undefined {
  const o = obj(v);
  if (o.kind !== 'visit' && o.kind !== 'streets') return undefined;
  const f: Favour = { kind: o.kind, asked: num(o.asked, 0), until: num(o.until, 0) };
  if (f.kind === 'visit') {
    const who = citizen(o.who);
    if (!who) return undefined;
    f.who = who; f.whoName = str(o.whoName) ?? 'my friend'; f.word = str(o.word, 20) ?? 'friend';
    if (Number.isFinite(o.wx) && Number.isFinite(o.wz)) { f.wx = o.wx as number; f.wz = o.wz as number; }
  } else {
    f.x = num(o.x, 0); f.z = num(o.z, 0); f.group = str(o.group);
  }
  if (Number.isFinite(o.done)) f.done = o.done as number;
  if (o.lost === true) f.lost = true;
  if (o.thanked === true) f.thanked = true;
  return f;
}

/** Sanitise a saved list (a damaged entry is dropped, never the whole list). */
export function restorePeople(raw: unknown): Known[] {
  const o = obj(raw);
  const out: Known[] = [];
  const seen = new Set<number>();
  for (const e of Array.isArray(o.people) ? o.people : []) {
    const k = obj(e), cit = citizen(k.cit);
    if (!cit || seen.has(cit.id)) continue;
    seen.add(cit.id);
    const deed = k.deed === 'helped' || k.deed === 'saved' || k.deed === 'hurt' ? k.deed : null;
    out.push({
      cit, name: str(k.name) ?? 'Someone', first: num(k.first, 0), last: num(k.last, 0), met: Math.floor(num(k.met, 1, 1)),
      talks: Math.floor(num(k.talks, 0, 0)), helped: Math.floor(num(k.helped, 0, 0)), saved: Math.floor(num(k.saved, 0, 0)), hurt: Math.floor(num(k.hurt, 0, 0)),
      deed, deedStreet: str(k.deedStreet), x: num(k.x, 0), z: num(k.z, 0), street: str(k.street),
      ...(str(k.title, 40) ? { title: str(k.title, 40)! } : {}),
      said: (Array.isArray(k.said) ? k.said : []).filter((s): s is string => typeof s === 'string').slice(-PEOPLE.said).map((s) => s.slice(0, 24)),
      notes: (Array.isArray(k.notes) ? k.notes : []).map(obj).filter((n) => typeof n.text === 'string').slice(-PEOPLE.notes).map((n) => ({ t: num(n.t, 0), text: str(n.text, 160)! })),
      favours: Math.floor(num(k.favours, 0, 0)), letDown: Math.floor(num(k.letDown, 0, 0)),
      ...(favour(k.favour) ? { favour: favour(k.favour) } : {}),
    });
    if (out.length >= PEOPLE.cap) break;
  }
  return out;
}
