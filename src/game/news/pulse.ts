/**
 * The city's pulse (pure: no DOM, no three.js; tested in selftest.ts). The city does not revolve
 * around the player: crime happens everywhere, the police stop some of it, the neighbourhoods get
 * better or worse, and the player hears about it from people in the street and the billboards.
 *
 *   neighbourhoods   macro cells grouped round seeds about HOODS.spacing apart, each with a name
 *                    (plan/names districtName): the "zones" the index, the news and the map speak of
 *   live index       per cell, 0..1: starts at the seeded index (crime/CrimeIndex) and moves —
 *                    crimes that come off push it up, crimes stopped pull it down, a group holding
 *                    the street keeps it higher, and it relaxes back toward that target over time
 *   police presence  the other side of the index: many patrol cars and officers on the beat where
 *                    it is low, hardly any where it is high (policePresence)
 *   off-screen       every PULSE.tick seconds of play the city rolls crimes away from the player, by
 *                    the neighbourhoods' live index; the police stop them by their presence
 *   fresh start      a new game puts the hero in the calmest neighbourhood near the centre, its
 *                    index held down at LIVE.startCap (it drifts back slowly)
 */
import type { MacroPlan, District } from '../../plan/types';
import { districtName } from '../../plan/names';
import { Rng, deriveSeed, hash32 } from '../../core/rng';
import { hourFactor, SETTING_RATE, type CrimeSetting } from '../crime/CrimeIndex';
import { kindWeights, groupWeights, pickKind } from '../crime/CrimeDirector';
import type { CrimeKind } from '../crime/Crime';

// ------------------------------------------------------------------ neighbourhoods

export const HOODS = { spacing: 720 };

export interface Hood {
  id: number;
  name: string;
  /** Member macro cells. */
  cells: number[];
  x: number; z: number;
  /** Area (m²) of the member cells. */
  area: number;
  /** The district most of its area is. */
  district: District;
}

export interface Hoods {
  list: Hood[];
  /** Neighbourhood per macro cell (-1: water). */
  of: Int16Array;
  /** Cells sharing an arterial edge. */
  near: number[][];
}

/** Cells sharing an arterial edge. */
export function cellNeighbours(macro: MacroPlan): number[][] {
  const byEdge = new Map<number, number[]>();
  macro.cells.forEach((c, i) => { for (const e of c.edges) { const l = byEdge.get(e); if (l) l.push(i); else byEdge.set(e, [i]); } });
  const near: number[][] = macro.cells.map(() => []);
  for (const l of byEdge.values()) for (const a of l) for (const b of l) if (a !== b && !near[a].includes(b)) near[a].push(b);
  return near;
}

/** The city's neighbourhoods (deterministic for the plan and seed). */
export function planHoods(macro: MacroPlan, seed: number): Hoods {
  const cells = macro.cells;
  const land = cells.map((c, i) => i).filter((i) => cells[i].district !== 'water');
  // Seeds: cells in a seeded order, each one far enough from the ones taken (a Poisson-disc pick).
  const order = land.slice().sort((a, b) => hash32(seed ^ (a * 2654435761)) - hash32(seed ^ (b * 2654435761)));
  const seeds: number[] = [];
  const S2 = HOODS.spacing * HOODS.spacing;
  for (const i of order) {
    const [x, z] = cells[i].centroid;
    if (seeds.every((s) => { const [sx, sz] = cells[s].centroid; return (sx - x) ** 2 + (sz - z) ** 2 >= S2; })) seeds.push(i);
  }
  const of = new Int16Array(cells.length).fill(-1);
  for (const i of land) {
    const [x, z] = cells[i].centroid;
    let best = 0, bd = Infinity;
    seeds.forEach((s, k) => { const d = (cells[s].centroid[0] - x) ** 2 + (cells[s].centroid[1] - z) ** 2; if (d < bd) { bd = d; best = k; } });
    of[i] = best;
  }
  const used = new Set<string>();
  const list: Hood[] = seeds.map((s, k) => {
    let name = districtName(seed, k);
    for (let t = 1; used.has(name) && t < 50; t++) name = districtName(seed, k + t * 1000);
    used.add(name);
    return { id: k, name, cells: [], x: 0, z: 0, area: 0, district: cells[s].district };
  });
  const byDistrict = list.map(() => new Map<District, number>());
  for (const i of land) {
    const h = list[of[i]], c = cells[i];
    h.cells.push(i);
    h.x += c.centroid[0] * c.area; h.z += c.centroid[1] * c.area; h.area += c.area;
    const m = byDistrict[h.id];
    m.set(c.district, (m.get(c.district) ?? 0) + c.area);
  }
  for (const h of list) {
    if (h.area > 0) { h.x /= h.area; h.z /= h.area; }
    let best = 0;
    for (const [d, a] of byDistrict[h.id]) if (a > best) { best = a; h.district = d; }
  }
  return { list, of, near: cellNeighbours(macro) };
}

// ------------------------------------------------------------------ police presence

/**
 * Police presence for a crime index (0..1): about 0.95 in the calmest streets, 0.5 at index 0.3,
 * nearly none from 0.6 on.
 */
export function policePresence(index: number): number {
  return Math.max(0.03, Math.min(0.96, 1.05 - 1.75 * index));
}

/** Patrol cars' share in traffic (Traffic spawn weight; ordinary cars weigh about 110 together). */
export function policeCarWeight(presence: number): number {
  return 0.25 + 7.5 * presence * presence;
}

/** Pairs of officers walking the beat around the player. */
export function beatPairs(presence: number): number {
  return presence > 0.78 ? 3 : presence > 0.55 ? 2 : presence > 0.35 ? 1 : 0;
}

/** How much longer (or shorter) the police take to come to a call. */
export function responseFactor(presence: number): number {
  return 1.8 - 1.25 * presence;
}

export type Safety = 'safe' | 'quiet' | 'mixed' | 'rough' | 'dangerous';
export function safetyOf(index: number): Safety {
  return index < 0.18 ? 'safe' : index < 0.32 ? 'quiet' : index < 0.48 ? 'mixed' : index < 0.65 ? 'rough' : 'dangerous';
}
export const SAFETY_LABEL: Record<Safety, string> = { safe: 'Very low', quiet: 'Low', mixed: 'Moderate', rough: 'High', dangerous: 'Very high' };
export function presenceLabel(p: number): string {
  return p > 0.78 ? 'heavy' : p > 0.55 ? 'strong' : p > 0.35 ? 'some' : p > 0.15 ? 'thin' : 'hardly any';
}

// ------------------------------------------------------------------ the live index

export const LIVE = {
  /** Half-life (seconds of play) of the pull back toward the target. */
  halfLife: 1500,
  /** A villain group holding a street keeps its index this much higher. */
  held: 0.08,
  /** A fresh game: the start neighbourhood's cells at most this. */
  startCap: 0.06,
  /** How far a change spreads to the next cells (share). */
  spread: 0.35,
  /** Changes by what happened: near the player (crime system) and off-screen (the pulse). */
  escaped: 0.035, arrested: -0.03, heroStopped: -0.055, offEscaped: 0.012, offStopped: -0.01,
  /** A boss jailed: their group's streets calm down. */
  bossJailed: -0.06,
  min: 0.02, max: 1,
};

export class LiveIndex {
  readonly live: Float32Array;
  constructor(readonly base: Float32Array, readonly near: number[][]) {
    this.live = base.slice();
  }

  /** Where a cell's index tends to (the seeded one, higher in a group's turf). */
  target(i: number, held: boolean): number {
    return this.base[i] <= 0 ? 0 : Math.min(LIVE.max, this.base[i] + (held ? LIVE.held : 0));
  }

  /** Relax toward the targets over `dt` seconds of play. */
  relax(dt: number, held: (i: number) => boolean): void {
    const k = 1 - Math.pow(0.5, dt / LIVE.halfLife);
    const L = this.live;
    for (let i = 0; i < L.length; i++) {
      if (this.base[i] <= 0) { L[i] = 0; continue; }
      L[i] += (this.target(i, held(i)) - L[i]) * k;
    }
  }

  /** Change a cell's index (and a share of it in the cells next door). */
  bump(cell: number, d: number): void {
    if (cell < 0 || cell >= this.live.length) return;
    this.add(cell, d);
    for (const n of this.near[cell] ?? []) this.add(n, d * LIVE.spread);
  }

  private add(i: number, d: number): void {
    if (this.base[i] <= 0) return;
    this.live[i] = Math.max(LIVE.min, Math.min(LIVE.max, this.live[i] + d));
  }

  /** Area-weighted mean over cells. */
  mean(cells: readonly number[], area: (i: number) => number): number {
    let s = 0, w = 0;
    for (const i of cells) { const a = area(i); s += this.live[i] * a; w += a; }
    return w > 0 ? s / w : 0;
  }

  /** For a save: the differences from the seeded index (thousandths; zeros elided as a sparse list). */
  save(): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; i < this.live.length; i++) {
      const d = Math.round((this.live[i] - this.base[i]) * 1000);
      if (d !== 0) out.push([i, d]);
    }
    return out;
  }

  /** Back from a save (null / junk: the seeded index). */
  restore(d: unknown): void {
    this.live.set(this.base);
    if (!Array.isArray(d)) return;
    for (const r of d) {
      if (!Array.isArray(r) || r.length < 2) continue;
      const i = r[0], v = r[1];
      if (!Number.isInteger(i) || i < 0 || i >= this.live.length || !Number.isFinite(v) || this.base[i] <= 0) continue;
      this.live[i] = Math.max(LIVE.min, Math.min(LIVE.max, this.base[i] + v / 1000));
    }
  }
}

// ------------------------------------------------------------------ the fresh start

/**
 * The cell a new game starts in: the calmest land cell near the main centre (a neighbourhood
 * nobody's gang holds), scoring index plus a little for the distance out.
 */
export function safeStart(macro: MacroPlan, index: Float32Array, held?: (i: number) => boolean): number {
  const c0 = macro.centres[0];
  let R = 500;
  for (const c of macro.cells) R = Math.max(R, Math.hypot(c.centroid[0] - c0.x, c.centroid[1] - c0.z));
  let best = -1, bs = Infinity;
  macro.cells.forEach((c, i) => {
    if (c.district === 'water' || c.district === 'park' || c.district === 'industrial' || c.district === 'port' || index[i] <= 0) return;
    if (held?.(i)) return;
    const r = Math.hypot(c.centroid[0] - c0.x, c.centroid[1] - c0.z) / R;
    const s = index[i] + 0.22 * r;
    if (s < bs) { bs = s; best = i; }
  });
  return best;
}

// ------------------------------------------------------------------ off-screen crime

export const PULSE = {
  /** Seconds of play between two rolls. */
  tick: 20,
  /** Crimes per tick across the city at a mean index of 0.4 (setting normal). */
  perTick: 0.55,
  /** Not within this of the player (that is the crime director's ground). */
  clearR: 450,
  /** The police stop one with this chance at presence 0 … 1. */
  stopLo: 0.12, stopHi: 0.85,
};

export interface OffCrime {
  kind: CrimeKind;
  cell: number;
  hood: number;
  stopped: boolean;
  /** The group behind it (an index into the factions), or -1. */
  faction: number;
}

/** Crime kinds that make the news off-screen (hideouts and sewer dens are places, not events). */
const NEWS_KINDS = new Set<CrimeKind>(['snatch', 'mugging', 'robbery', 'racket', 'tagging', 'brawl', 'hijack', 'ritual', 'bomber', 'sabotage', 'raising', 'procession']);

/**
 * One tick's crimes away from the player (seeded by `tick`, the play tick counter). `holder(i)`:
 * the group holding a cell (-1: nobody) and its operations' weights.
 */
export function rollOffScreen(
  seed: number, tick: number, hoods: Hoods, live: LiveIndex, macro: MacroPlan, hour: number, setting: CrimeSetting,
  px: number, pz: number, holder: (i: number) => { faction: number; ops: Record<CrimeKind, number> } | null,
): OffCrime[] {
  const mul = SETTING_RATE[setting];
  if (mul <= 0) return [];
  const r = new Rng(deriveSeed(seed, 'pulse', tick));
  const cells = macro.cells;
  // Candidate cells (land, away from the player), weighted by index and hour.
  const cand: number[] = [], w: number[] = [];
  let total = 0, mean = 0, area = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (hoods.of[i] < 0) continue;
    mean += live.live[i] * c.area; area += c.area;
    if (Math.hypot(c.centroid[0] - px, c.centroid[1] - pz) < PULSE.clearR) continue;
    const x = Math.pow(live.live[i], 1.6) * hourFactor(c.district, hour) * Math.sqrt(c.area);
    if (x <= 0) continue;
    cand.push(i); w.push(x); total += x;
  }
  if (!cand.length || area <= 0) return [];
  mean /= area;
  const expect = PULSE.perTick * Math.pow(mean / 0.4, 1.35) * mul;
  // Poisson count (small).
  let n = 0;
  for (let L = Math.exp(-expect), p = r.float(); p > L && n < 6; p *= r.float()) n++;
  const out: OffCrime[] = [];
  for (let k = 0; k < n; k++) {
    let t = r.float() * total, cell = cand[cand.length - 1];
    for (let j = 0; j < cand.length; j++) { t -= w[j]; if (t < 0) { cell = cand[j]; break; } }
    const hold = holder(cell);
    const kw = groupWeights(kindWeights(cells[cell].district, hour), hold?.ops ?? null);
    for (const k2 of Object.keys(kw) as CrimeKind[]) if (!NEWS_KINDS.has(k2)) kw[k2] = 0;
    const kind = pickKind(kw, r.float());
    const stopP = PULSE.stopLo + (PULSE.stopHi - PULSE.stopLo) * policePresence(live.live[cell]);
    out.push({ kind, cell, hood: hoods.of[cell], stopped: r.chance(stopP), faction: hold && kind !== 'snatch' ? hold.faction : -1 });
  }
  return out;
}
