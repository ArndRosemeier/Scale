/**
 * The runaway teens' rules (ALIENS_PLAN §4–5, phase 2; pure, tested in tools/aliensTest.ts): how
 * long the Wardens need to see the stolen saucer before they have it, how its altitude hides it
 * (or does not, once its hover pods are out), the rewards for handing it over, the Warden regard
 * that counts the times the hero did, and what people say about it.
 */
import type { Temperament } from '../people/identity';

export const TEENS = {
  /** The first seconds out (finding cover after they come down the street): not seen yet. */
  graceT: 8,
  /** Seconds of being seen (open sky, the station's view) before a disc has it; in a cone, this much faster. */
  seeT: 2.4, coneK: 3,
  /** The meter drains this much slower than it fills (a moment in the open is forgiven). */
  forget: 1.8,
  /** Above the roofs round it by more than this (m): out in the open. */
  openBy: 3,
  /** Cover counted round the saucer (m) and the least cover a route point should have (m above the ground). */
  coverR: 34, routeCover: 9,
  /** Height over the street (m): a share of the cover, clamped; each pod out lifts it this much more. */
  hShare: 0.5, hMin: 6, hMax: 19, perPod: 8,
  /** All three pods out: it bobs up like a cork, this far over the roofs round it (m). */
  cork: 22,
  /** The hero right under it within this (m, horizontally): it pops up out of reach for a moment. */
  dodgeR: 9, dodgeH: 16, dodgeT: 3.5,
  /** Hit points of a hover pod (punches ~0.26 each at normal strength, a power takes one at once). */
  podHp: 1.5,
  /** Flight speeds (m/s): joyriding, fleeing, carrying something. */
  vJoy: 22, vFlee: 30, vCarry: 13,
  /** The hero this close (m) makes them flee. */
  fleeR: 38,
  /** How long they stay out (s) before they zoom off home on their own; the hero gone this far for this long: unseen end. */
  maxT: 420, farR: 800, farT: 35,
  /** The parent disc: comes down from this high over it (m), hangs this far above it, lifts it in this long (s). */
  parentFrom: 260, parentOver: 16, liftT: 4.5,
  /** Rewards (Normal mode). */
  karma: { pod: 4, caught: 25, herded: 15 },
  rep: { caught: 3, herded: 2 },
  /** The hero counts as having handed them over when this close (m) at the moment they were seen, or a pod down. */
  creditR: 90,
};

/**
 * How high the saucer wants to fly over the street (m): about half the cover round it, so the roofs
 * hide it from the station; each pod lost lifts it; with none left it bobs up into the open.
 */
export function teenHeight(cover: number, podsOut: number): number {
  if (podsOut >= 3) return cover + TEENS.cork;
  return Math.min(TEENS.hMax, Math.max(TEENS.hMin, cover * TEENS.hShare)) + podsOut * TEENS.perPod;
}

/** Out in the open: higher over the ground than the roofs round it (by TEENS.openBy). */
export function inOpen(heightOverGround: number, cover: number): boolean {
  return heightOverGround > cover + TEENS.openBy;
}

/**
 * The Wardens' seeing it, 0..1 (1: they have it): fills while it is in the open (faster in a
 * scan cone), drains slowly otherwise.
 */
export function seeStep(seen: number, dt: number, open: boolean, inCone: boolean): number {
  if (inCone) return Math.min(1, seen + (dt / TEENS.seeT) * TEENS.coneK);
  if (open) return Math.min(1, seen + dt / TEENS.seeT);
  return Math.max(0, seen - dt / (TEENS.seeT * TEENS.forget));
}

/** Hand-over credit: pods knocked out by the hero, the hero close when they were seen. */
export function teenReward(podsByHero: number, heroNear: boolean): { karma: number; rep: number; credit: 'caught' | 'herded' | null } {
  if (podsByHero > 0) return { karma: TEENS.karma.caught, rep: TEENS.rep.caught, credit: 'caught' };
  if (heroNear) return { karma: TEENS.karma.herded, rep: TEENS.rep.herded, credit: 'herded' };
  return { karma: 0, rep: 0, credit: null };
}

/**
 * Warden regard (ALIENS_PLAN §4): a quiet count of the problems the hero handed them. Nothing
 * visible yet; later it opens the station. A runaway saucer handed over is one.
 */
export interface Regard { v: 1; handed: number; regard: number }

export function freshRegard(): Regard { return { v: 1, handed: 0, regard: 0 }; }

export function handOver(r: Regard): Regard { return { v: 1, handed: r.handed + 1, regard: r.regard + 1 }; }

/** A saved regard, sanitised. */
export function readRegard(raw: unknown): Regard {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && isFinite(v) ? Math.max(-1e6, Math.min(1e6, Math.round(v))) : 0);
  return { v: 1, handed: Math.max(0, n(o.handed)), regard: n(o.regard) };
}

// ------------------------------------------------------------------ what people say

/** 'prank': the saucer up to something near; 'caught': a parent disc just took it. */
export type TeenMoment = 'prank' | 'caught';

const TEEN: Record<TeenMoment, Partial<Record<Temperament | 'any' | 'kid', readonly string[]>>> = {
  prank: {
    any: ['Is that… a kid driving that thing?', 'Somebody call their parents!', 'Not again. Not my car!', 'That saucer\'s stolen, look at the state of it.'],
    anxious: ['It\'s going to drop something on us!', 'Get under something, quick!'],
    grumpy: ['Where are the Nannies when you need them?', 'Joyriders. From space. Wonderful.'],
    nosy: ['Those are Warden kids, I bet. They\'ll be in so much trouble.', 'Whose kids are those?'],
    chatty: ['My neighbour says they nicked it from the station!'],
    cheerful: ['Ha! Look at them go!', 'Somebody\'s having fun.'],
    kind: ['I hope they get home all right.'],
    proud: ['Disgraceful. Somebody should do something.'],
    kid: ['Whoa! Can I have a go?', 'They\'re so cool!', 'Do it again! Do it again!'],
  },
  caught: {
    any: ['Busted!', 'Ooh, they\'re in trouble now.', 'Grounded for a thousand years.', 'Their mum came to pick them up.'],
    grumpy: ['About time.', 'Took them long enough.'],
    cheerful: ['Ha! Busted!', 'Bye-bye, little saucer!'],
    kind: ['Poor things. They\'re only kids.'],
    nosy: ['Did you hear that tone? Somebody\'s getting a lecture.'],
    kid: ['Aww, they took them away.', 'Did they get told off?'],
  },
};

/** A line about the runaway saucer (u in [0, 1)), or null (the shy keep quiet). */
export function teenLine(m: TeenMoment, temper: Temperament, child: boolean, u: number): string | null {
  if (temper === 'shy' && !child) return null;
  const L = TEEN[m];
  const own = child ? L.kid : L[temper];
  const pool = own && (u < 0.6 || !L.any) ? own : L.any ?? own;
  if (!pool?.length) return null;
  const k = u < 0.6 && own ? u / 0.6 : (u - 0.6) / 0.4;
  return pool[Math.min(pool.length - 1, Math.floor(Math.max(0, k) * pool.length))];
}

/** Every line (tests). */
export function allTeenLines(): string[] {
  const out: string[] = [];
  for (const m of Object.values(TEEN)) for (const l of Object.values(m)) if (l) out.push(...l);
  return out;
}
