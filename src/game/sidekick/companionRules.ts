/**
 * The sidekick around the hero (docs/SIDEKICK_PLAN.md phase 2): the numbers, how they go into a
 * fight by their character, what they say, whether a revival works, where their grave goes. Pure
 * (no game state): Companion.ts acts on it, tools/sidekickTest.ts checks it.
 */
import type { Temperament, Traits } from '../people/identity';
import type { CellPlan } from '../../plan/cell';
import { PropType } from '../../plan/cell';
import { pointInPoly } from '../../core/geom2';
import { deriveSeed, hashToFloat } from '../../core/rng';

export const MATE = {
  /** Health (an ordinary adult has 40; the shard makes them tough, not the hero's equal). */
  hp: 150,
  strength: 1.35,
  /** Health back per second when nothing is going on. */
  heal: 3,
  /** Where they hang about round the hero (m), and how often they pick a new spot (s). */
  ringMin: 4, ringMax: 11, spotEvery: [7, 14] as const,
  /** Walking pace, and running to catch up within walking range. */
  walk: 1.6, run: 5.2,
  /** Farther than this from where they want to be (or stuck on the way): they fly. */
  flyFrom: 28,
  /** Flight: cruising speed, the most they ever go (keeping up with the hero), climb rate, margin over roofs. */
  cruise: 16, top: 70, climb: 9, clear: 5,
  /** Coming down: within this (horizontally) of where they land. */
  landR: 10,
  /** Next to a flying hero: this far off to the side and behind. */
  wing: 7,
  /** Farther than this and out of sight: they make up the distance off-screen and fly in from here. */
  lostR: 170, catchUp: 105,
  /** A fight within this of the hero draws them in; who they go for. */
  joinR: 80, punchR: 1.6, hitR: 1.8, attackCd: [0.95, 1.45] as const, windup: 0.32,
  /** A counter-blow from whoever they hit, now and then. */
  counterChance: 0.5, counterJ: 300,
  /** Their power (a fireball): cooldown, range, and nobody but the bad guys this close to where it lands. */
  powerCd: 9, powerMin: 6, powerMax: 24, safeR: 4.6, heroSafe: 6.5,
  /** The careful ones get people clear first (s). */
  clearFor: 3.2,
  /** Wanted and officers this close to the hero: they keep out of it, this far off. */
  policeR: 60, keepOff: 32,
  /** Called (K): seconds of coming at full speed and staying close. */
  calledFor: 25,
  /** Seconds between their own bubbles (fights say more). */
  barkGap: 14, idleGap: 75,
  /** Knocked out: drones come after (s); the ward takes this long; most make it. */
  dronesAfter: 3, wardTime: 45, survive: 0.8,
  /** After a death, the next shard turns up this many game hours later. */
  nextShardHours: 36,
} as const;

export type FightStyle = 'brave' | 'careful' | 'boss';

/** How they go into a fight: the proud and hard go for the boss, the nervous get people clear first, everyone else jumps in. */
export function fightStyle(temper: Temperament, t: Traits): FightStyle {
  if (temper === 'proud' || (t.c > 0.62 && t.a < 0.4)) return 'boss';
  if (temper === 'anxious' || temper === 'shy' || t.n > 0.72) return 'careful';
  return 'brave';
}

export interface FoeInfo {
  /** Distance from the sidekick (m). */
  d: number;
  maxHp: number;
  /** A boss or a lieutenant. */
  lead: boolean;
  /** Already fighting the hero up close. */
  onHero: boolean;
}

/** Which foe (index; -1: none). The boss-minded weigh toughness; everyone prefers the one near them and the one on the hero. */
export function pickFoe(style: FightStyle, foes: FoeInfo[]): number {
  let best = -1, bs = -Infinity;
  foes.forEach((f, i) => {
    let s = -f.d / 10 + (f.onHero ? 1.5 : 0);
    if (style === 'boss') s += (f.lead ? 4 : 0) + f.maxHp / 60;
    if (s > bs) { bs = s; best = i; }
  });
  return best;
}

/** Does the revival work this time (the k-th time they were taken in)? Same answer for the same city and count. */
export function revives(seed: number, who: number, k: number): boolean {
  return hashToFloat(deriveSeed(seed, `revive:${who}:${k}`)) < MATE.survive;
}

export type MateSay = 'join' | 'careful' | 'boss' | 'won' | 'police' | 'called' | 'coming' | 'back' | 'idle' | 'hurt';
type Pool = string[];

const LINES: Record<MateSay, { any: Pool } & Partial<Record<Temperament, Pool>>> = {
  join: {
    any: ['I\'ve got this one!', 'Right behind you!', 'Leave some for me!', 'Hey! Pick on someone your own size!'],
    kind: ['Stop it! Nobody gets hurt today!', 'I\'m here. Let\'s end this.'],
    grumpy: ['Fine. Let\'s get this over with.', 'You picked the wrong street.'],
    cheerful: ['Ooh, my turn!', 'Let\'s go!'],
    chatty: ['Okay okay okay, here we go!', 'Watch this, watch this!'],
    steady: ['On it.', 'I\'ll take the left.'],
    dreamy: ['The light wants out. Here it comes.'],
    nosy: ['So who started it? Never mind!'],
  },
  careful: {
    any: ['Everyone, get back! Go!', 'Get clear! Move, move!', 'Off the street, quick!'],
    anxious: ['Get away from here, please! Go!', 'Oh no oh no. Everyone, back! Back!'],
    shy: ['Um, please, get back! It\'s not safe!'],
  },
  boss: {
    any: ['You! You\'re the one in charge, aren\'t you?', 'The big one\'s mine.'],
    proud: ['The leader is mine. Don\'t argue.', 'I don\'t waste time on the small ones.'],
  },
  won: {
    any: ['That\'s that.', 'Is everyone all right?', 'Nice work.', 'Phew.'],
    cheerful: ['We make a good team!', 'Ha! Did you see that?'],
    grumpy: ['Amateurs.', 'Could have been quicker.'],
    kind: ['Is anyone hurt? Let me see.'],
    proud: ['As expected.'],
    chatty: ['Did you see my fireball? Tell me you saw my fireball.'],
  },
  police: {
    any: ['Not the police. I\'m out.', 'I won\'t fight the police. Sort this out yourself.'],
    kind: ['I can\'t help you with the police. Please, give it up.'],
    grumpy: ['The police? You\'re on your own.'],
    anxious: ['The police! No, no, I\'m not getting involved.'],
  },
  called: {
    any: ['Coming!', 'On my way!', 'I hear you!', 'Hold on, I\'m coming!'],
    grumpy: ['Yes, yes. Coming.'],
    proud: ['You need me? Of course you do.'],
    shy: ['C-coming!'],
  },
  coming: {
    any: ['Wait for me!', 'Hey, slow down!', 'There you are.'],
    cheerful: ['Race you!'],
    grumpy: ['You could wait, you know.'],
  },
  back: {
    any: ['I\'m back. That was too close.', 'They patched me up. I\'m fine. Mostly.'],
    anxious: ['I nearly didn\'t wake up. I\'m… I\'m all right. I think.'],
    grumpy: ['Don\'t ask. I\'m back.'],
    cheerful: ['Back again! Did you miss me?'],
    proud: ['It takes more than that.'],
  },
  idle: {
    any: ['Quiet day.', 'I can feel this whole street.', 'Still getting used to this.', 'I could get used to this.'],
    nosy: ['See the man by the bakery? He\'s up to something.', 'I wonder what\'s going on over there.'],
    dreamy: ['The city hums when it\'s quiet.', 'Look at the sky. Just look at it.'],
    grumpy: ['Are we just going to stand here?'],
    chatty: ['So, do you ever sleep? I don\'t think I\'ve slept since the shard.'],
    kind: ['That woman looks lost. Maybe later.'],
    anxious: ['Is it always this… loud? In the head, I mean.'],
  },
  hurt: {
    any: ['Ugh! That hurt.', 'Okay. Ow.'],
    grumpy: ['You\'ll pay for that.'],
  },
};

/** What they say (u in 0…1 picks the line). */
export function mateLine(what: MateSay, temper: Temperament, u: number): string {
  const L = LINES[what];
  const own = L[temper];
  // Their own lines most of the time, the general ones now and then.
  const pool = own && (u * 13.7) % 1 < 0.7 ? own : L.any;
  return pool[Math.floor(u * pool.length) % pool.length];
}

/** A grave in a cemetery of this plan: a free spot by a path, facing the gate (null: no cemetery or no room). */
export function graveSpot(plan: CellPlan, seed: number): { x: number; z: number; yaw: number } | null {
  const P = plan.props;
  for (const cem of plan.cemeteries) {
    const poly = cem.outer;
    // The main tomb gives the way in (its front faces the gate).
    let yaw = 0, tx = NaN, tz = NaN;
    for (let i = 0; i < P.length; i += 6) {
      if (P[i] !== PropType.Tomb || !pointInPoly(poly, P[i + 1], P[i + 2])) continue;
      tx = P[i + 1]; tz = P[i + 2]; yaw = P[i + 3];
      if (P[i + 5] === 0) break;
    }
    if (!Number.isFinite(tx)) continue;
    // Spots on rings round the tomb, nearest first, turned by the seed.
    const r0 = hashToFloat(deriveSeed(seed, 'grave')) * Math.PI * 2;
    for (let ring = 4; ring <= 22; ring += 1.5) {
      const n = Math.max(8, Math.round(ring * 1.6));
      for (let k = 0; k < n; k++) {
        const a = r0 + (k / n) * Math.PI * 2;
        const x = tx + Math.cos(a) * ring, z = tz + Math.sin(a) * ring;
        if (!pointInPoly(poly, x, z) || nearEdge(poly, x, z, 2.2)) continue;
        if (plan.cemPaths.some((s) => pointInPoly(s.outer, x, z))) continue;
        let free = true;
        for (let i = 0; i < P.length && free; i += 6) if (Math.hypot(P[i + 1] - x, P[i + 2] - z) < 1.6) free = false;
        if (free) return { x, z, yaw };
      }
    }
  }
  return null;
}

/** Within m of the polygon's outline. */
function nearEdge(poly: number[], x: number, z: number, m: number): boolean {
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const ax = poly[i * 2], az = poly[i * 2 + 1], bx = poly[((i + 1) % n) * 2], bz = poly[((i + 1) % n) * 2 + 1];
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    if (Math.hypot(ax + dx * t - x, az + dz * t - z) < m) return true;
  }
  return false;
}
