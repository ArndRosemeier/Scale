/**
 * Pure rules of the aftermath (THREATS_PLAN §2 level 5, §3 "aftermath"; PLAYGROUND_PLAN §0 decision
 * 19 as amended), tested in selftest.ts — no three.js, no game:
 *
 *  - the last resort (response level 5): when the army has failed against a major threat deep in
 *    the city, a small tactical nuke is prepared; whether and when is deterministic (a seeded roll
 *    per incident, the army's state, how deep the monster is, how long level 4 has been fighting);
 *  - the strike's shock wave: buildings levelled in order of distance, a few per frame at most;
 *  - a defeated monster's carcass: a landmark for a few game hours, then crews take it away piece
 *    by piece (the order of the rig's bones: tail tip first … the trunk last);
 *  - how long smoke, cordons, the memorial, the news and the emergency services stay.
 */
import { deriveSeed, hashToFloat } from '../../core/rng';
import type { CityEvents } from '../threats/ThreatClock';
import type { BoneLayout } from '../threats/rig/skin';

export const LAST_RESORT = {
  /** Off: the ladder stops at 4 (dev.lastResort.enabled(false)). */
  enabled: true,
  /** Per major incident the share that may come to this at all (× the City events setting), a seeded roll. */
  chance: 0.45,
  settingK: { off: 0, rare: 0.5, normal: 1, frequent: 1.5 } as Record<CityEvents, number>,
  /** Level 4 at least this long (s) before it is considered. */
  minLevelT: 45,
  /** The army failing: this many lines broken, this many units lost, or level 4 this long (s) without a result. */
  brokenLines: 2, lost: 6, timeout: 150,
  /** Deep in the city: in downtown (its rampage), or this share of its route walked. */
  deep: 0.85,
  /** The monster still at least this strong (one nearly beaten: they wait). */
  minStrength: 0.45,
  /** The countdown (s), the strike radius (m), the player knocked out within radius × koK. */
  countdown: 180, radius: 380, koK: 1.1,
  /** The shock wave: its speed (m/s, shown slower than a real one), buildings levelled per frame at most. */
  shockSpeed: 140, perFrame: 6,
  /** Karma and reputation: the player drove it off / brought it down in time; the city lost. */
  karma: { saved: 150, lost: -40 }, rep: { saved: 15, lost: -20 },
  /** People who sheltered in the struck district's buildings instead of leaving (per m²). */
  stayedPerM2: 0.00012,
};

/** The seeded roll of an incident (0..1): below LAST_RESORT.chance × the setting, it may come to it. */
export function lastResortRoll(seed: number, incident: number): number {
  return hashToFloat(deriveSeed(seed, 'last-resort', incident));
}

/** What level 5 looks at (from the response, the army and the monster). */
export interface LastResortView {
  major: boolean;
  level: number;
  /** Seconds at the current level. */
  levelT: number;
  /** The monster's strength (hp share). */
  strength: number;
  /** Rampaging in downtown (the end of its route). */
  downtown: boolean;
  /** Share of its route walked (0..1). */
  progress: number;
  /** The army's squads whose line broke (or routed), and units lost. */
  broken: number;
  lost: number;
  roll: number;
  setting: CityEvents;
  /** Dev: force it (the army's state and the roll are not asked). */
  forced?: boolean;
}

/** Time to prepare the last resort (go up to level 5 from 4)? */
export function lastResortDue(v: LastResortView): boolean {
  if (!v.major || v.level < 4) return false;
  if (v.forced) return true;
  if (!LAST_RESORT.enabled || v.setting === 'off') return false;
  if (v.roll >= LAST_RESORT.chance * (LAST_RESORT.settingK[v.setting] ?? 1)) return false;
  if (v.levelT < LAST_RESORT.minLevelT || v.strength < LAST_RESORT.minStrength) return false;
  const deep = v.downtown || v.progress >= LAST_RESORT.deep;
  const failing = v.broken >= LAST_RESORT.brokenLines || v.lost >= LAST_RESORT.lost || v.levelT >= LAST_RESORT.timeout;
  return deep && failing;
}

/**
 * The shock wave of the strike: it reaches each item (a building, by its distance from ground zero)
 * at d / speed, and levels at most `perFrame` a frame (nearest first) — the rest wait for the
 * next frames. Pure: the game feeds it the buildings in range, it says which to level now.
 */
export class ShockWave {
  t = 0;
  private i = 0;
  /** Item indices, nearest first. */
  private order: number[];

  constructor(readonly dist: readonly number[], readonly speed = LAST_RESORT.shockSpeed, readonly perFrame = LAST_RESORT.perFrame) {
    this.order = dist.map((_, k) => k).sort((a, b) => dist[a] - dist[b] || a - b);
  }

  /** The wave front (m from ground zero). */
  get front(): number { return this.t * this.speed; }
  get done(): boolean { return this.i >= this.order.length; }
  get left(): number { return this.order.length - this.i; }

  /** Advance the wave; the items (indices) it reaches and levels this frame. */
  step(dt: number): number[] {
    this.t += dt;
    const out: number[] = [];
    const f = this.front;
    while (this.i < this.order.length && out.length < this.perFrame && this.dist[this.order[this.i]] <= f) out.push(this.order[this.i++]);
    return out;
  }
}

// ------------------------------------------------------------------ the carcass

export const CARCASS = {
  /** Game hours it lies as a landmark (cordoned, crowds gawking), then the cleanup takes this long. */
  landmarkH: 5, cleanupH: 6,
  /** The cordon round it (m) and how far the gawkers stand. */
  cordonR: 42, gawkR: 60,
};

export type CarcassStage = 'landmark' | 'cleanup' | 'gone';

/** Where the carcass is in its removal, `hours` game hours after it came down. */
export function carcassStage(hours: number): { stage: CarcassStage; removed: number } {
  const h = Math.max(0, hours);
  if (h < CARCASS.landmarkH) return { stage: 'landmark', removed: 0 };
  const removed = Math.min(1, (h - CARCASS.landmarkH) / CARCASS.cleanupH);
  return { stage: removed >= 1 ? 'gone' : 'cleanup', removed };
}

/**
 * The pieces the crews cut off and cart away, in order: the tail from its tip, the head and jaw, the
 * neck from the head down, each leg from the foot up, the trunk last. Bone indices of the layout.
 */
export function removalOrder(L: BoneLayout, counts: { tail: number; neck: number; spine: number; legs: number }): number[] {
  const out: number[] = [];
  for (let i = counts.tail - 1; i >= 0; i--) out.push(L.tail + i);
  out.push(L.jaw, L.head);
  for (let i = counts.neck - 1; i >= 0; i--) out.push(L.neck + i);
  for (let leg = 0; leg < counts.legs; leg++) out.push(L.legs + leg * 3 + 2, L.legs + leg * 3 + 1, L.legs + leg * 3);
  for (let i = counts.spine - 1; i >= 0; i--) out.push(L.spine + i);
  return out;
}

/**
 * Per-bone scale for a removal share (1 whole, 0 gone): the pieces before the current one are gone,
 * the current one shrinks while the crew works on it. `out` is indexed by bone (length ≥ L.count).
 * Returns the index of the piece being worked on (order.length: all gone).
 */
export function boneScales(removed: number, order: readonly number[], out: Float32Array): number {
  out.fill(1);
  const x = Math.max(0, Math.min(1, removed)) * order.length;
  const k = Math.min(order.length, Math.floor(x));
  for (let i = 0; i < k; i++) out[order[i]] = 0;
  if (k < order.length) out[order[k]] = 1 - (x - k);
  return k;
}

// ------------------------------------------------------------------ the aftermath

export const AFTERMATH = {
  /** Game hours a collapsed building / a burnt facade keeps smoking (a range, by how big it was). */
  smokeH: [3, 8] as [number, number],
  /** A levelled district smokes this long. */
  zoneSmokeH: 30,
  /** Game hours the cordon tape round the worst damage, the memorial, the news, the EMS stay. */
  cordonH: 10, memorialH: 48, newsH: 8, emsH: 1.2,
  /** Trapped people the crews have not reached are dug out within this long (game hours) after it is over. */
  crewDigH: [0.3, 1.5] as [number, number],
};
