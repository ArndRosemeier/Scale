/**
 * A city's villain groups and their turf (VILLAINS_PLAN §3.1, Phase 1): who the groups are (a
 * seeded name, colours and emblem per archetype) and how strongly each one holds every macro cell.
 *
 *   home        the cell the group wants most: archetype affinity for the district × the crime
 *               index (the gang likes rough cells, the Syndicate rich ones) × density (the
 *               Syndicate sits in the real centre) × seeded noise
 *   influence   per cell, 0..1: affinity × a smooth falloff from home over the archetype's reach
 *               (a share of the city radius) × a seeded field over ~700 m, so borders are ragged
 *   holder      the group with the most influence in a cell, if it reaches HOLD; -1: nobody's turf
 *               (today's anonymous street crime)
 *
 * Deterministic for (seed, plan, crime index); pure (no DOM, no three.js), tested in selftest.ts.
 *
 * Results move the turf (Phase 1 part 2, `shift`): stopping a group's operation costs it influence
 * in that cell and a little in the cells next to it, an operation that comes off (and a finished
 * tag) gains it some. The difference from the seeded influence is saved per city
 * (`saveFactions` / `restoreFactions`).
 *
 * Phase 2: rivals (`relation`) fight over shared borders, and the turf drifts by itself once per
 * game hour (`drift`, deterministic per seed and hour): every group grows back towards its seeded
 * hold scaled by how much of its turf it still has (a group the player has hurt regrows to less),
 * pushes into the cells next to its own where it could hold them, eats into a rival's hold there,
 * and a little seeded noise keeps the borders alive.
 */
import type { MacroPlan } from '../../plan/types';
import { Rng, deriveSeed } from '../../core/rng';
import { valueNoise2 } from '../crime/CrimeIndex';
import { hashToFloat } from '../../core/rng';
import { ARCHETYPES, PHASE1, type Archetype, type ArchetypeId, type Palette } from './archetypes';

/** Influence a group needs to hold a cell. */
export const HOLD = 0.3;

export interface Faction {
  /** Index in FactionMap.factions (the value in `holder`). */
  id: number;
  archetype: ArchetypeId;
  name: string;
  palette: Palette;
  emblem: string;
  /** Macro cell of its home ground. */
  home: number;
}

export interface FactionMap {
  factions: Faction[];
  /** Influence per faction per macro cell (0..1). */
  influence: Float32Array[];
  /** Holding faction per macro cell, -1 for none. */
  holder: Int8Array;
  /** The seeded influence (what `influence` started as; saves keep the difference). */
  base: Float32Array[];
  /** Neighbouring macro cells (sharing an arterial edge). */
  near: number[][];
  /** Per faction per cell: could it hold that cell at all (its archetype's affinity for the district > 0). */
  can: Uint8Array[];
  /** Cells each faction held at the start (how strong it still is: `strength`). */
  baseHeld: number[];
}

/** The city's groups and turf for a seed (crime index: CrimeIndex.crimeIndex of the same plan). */
export function planFactions(macro: MacroPlan, seed: number, index: Float32Array, archetypes: readonly ArchetypeId[] = PHASE1): FactionMap {
  const cells = macro.cells;
  const c0 = macro.centres[0];
  let R = 0;
  for (const c of cells) R = Math.max(R, Math.hypot(c.centroid[0] - c0.x, c.centroid[1] - c0.z));
  R = Math.max(500, R);
  const factions: Faction[] = [];
  const influence: Float32Array[] = [];
  const can: Uint8Array[] = [];
  for (const id of archetypes) {
    const A = ARCHETYPES[id];
    const rng = new Rng(deriveSeed(seed, 'faction', id));
    const home = pickHome(macro, index, A, rng, factions);
    if (home < 0) continue;
    const f: Faction = { id: factions.length, archetype: id, name: nameFor(A, rng, cells[home].district), palette: rng.pick(A.palettes), emblem: rng.pick(A.emblems), home };
    const inf = new Float32Array(cells.length);
    const [hx, hz] = cells[home].centroid;
    const reach = Math.max(450, A.reach * R);
    const nseed = deriveSeed(seed, 'faction-field', id);
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const aff = A.affinity[c.district];
      if (aff <= 0) continue;
      const t = 1 - Math.hypot(c.centroid[0] - hx, c.centroid[1] - hz) / reach;
      if (t <= 0) continue;
      const fall = t * t * (3 - 2 * t);
      const field = 0.7 + 0.6 * valueNoise2(nseed, c.centroid[0] / 700, c.centroid[1] / 700);
      inf[i] = Math.min(1, aff * fall * field * 1.6);
    }
    inf[home] = Math.max(inf[home], 0.9);
    factions.push(f);
    influence.push(inf);
    can.push(Uint8Array.from(cells, (c) => (A.affinity[c.district] > 0 ? 1 : 0)));
  }
  const holder = new Int8Array(cells.length).fill(-1);
  for (let i = 0; i < cells.length; i++) {
    let best = -1, bv = HOLD;
    for (let f = 0; f < factions.length; f++) if (influence[f][i] >= bv) { bv = influence[f][i]; best = f; }
    holder[i] = best;
  }
  // Neighbours: cells that share an arterial edge.
  const byEdge = new Map<number, number[]>();
  cells.forEach((c, i) => { for (const e of c.edges) { const l = byEdge.get(e); if (l) l.push(i); else byEdge.set(e, [i]); } });
  const near: number[][] = cells.map(() => []);
  for (const l of byEdge.values()) for (const a of l) for (const b of l) if (a !== b && !near[a].includes(b)) near[a].push(b);
  const baseHeld = factions.map((f) => holder.reduce((n, h) => n + (h === f.id ? 1 : 0), 0));
  return { factions, influence, holder, base: influence.map((f) => f.slice()), near, can, baseHeld };
}

/** The group with the most influence in a cell if it reaches HOLD, else -1. */
function holderOf(F: FactionMap, i: number): number {
  let best = -1, bv = HOLD;
  for (let f = 0; f < F.factions.length; f++) if (F.influence[f][i] >= bv) { bv = F.influence[f][i]; best = f; }
  return best;
}

/** How much results move the turf. */
export const SHIFT = {
  /** The player stopped one of its operations: lost in that cell, half of it next door. */
  stopped: -0.14,
  /** An operation came off (got away): gained in that cell. */
  succeeded: 0.05,
  /** A tag on the wall. */
  tag: 0.04,
  /** A ritual completed, a robot hijack gone through. */
  ritual: 0.07,
  /** A turf brawl: the winners gain the street, the losers lose it. */
  brawlWon: 0.08,
  brawlLost: -0.1,
  /** The player busted a hideout's stash: a big loss where it was. */
  bust: -0.32,
  /** …and its stash block drops at least this far below HOLD: lost outright. */
  bustBelow: 0.08,
  spread: 0.5,
  /** Never above this (a group can be driven out, but its grip never gets absolute). */
  max: 1,
};

/**
 * Move a group's influence in a cell (and `spread` × as much in the cells next to it, where it has
 * any); returns the cells whose holder changed, with the old and new holder.
 */
export function shift(F: FactionMap, cell: number, f: number, amount: number, spread = SHIFT.spread): { cell: number; from: number; to: number }[] {
  if (cell < 0 || !F.influence[f]) return [];
  const touched: [number, number][] = [[cell, amount]];
  for (const n of F.near[cell] ?? []) if (F.influence[f][n] > 0 || amount < 0) touched.push([n, amount * spread]);
  const out: { cell: number; from: number; to: number }[] = [];
  for (const [i, a] of touched) {
    F.influence[f][i] = Math.max(0, Math.min(SHIFT.max, F.influence[f][i] + a));
    const from = F.holder[i], to = holderOf(F, i);
    if (from !== to) { F.holder[i] = to; out.push({ cell: i, from, to }); }
  }
  return out;
}

/**
 * Saved turf: per group (by archetype), the cells whose influence differs from the seeded one, in
 * hundredths, and the cells it holds (drift's hysteresis lets a holder keep a cell a little below
 * HOLD, which the influence alone would not give back; older saves have no `held`).
 */
export interface SavedFactions { v: 1; groups: { archetype: string; cells: [number, number][]; held?: number[] }[]; stats: Record<string, number> }

export function saveFactions(F: FactionMap, stats: Record<string, number> = {}): SavedFactions {
  return {
    v: 1,
    groups: F.factions.map((f) => {
      const cells: [number, number][] = [];
      const I = F.influence[f.id], B = F.base[f.id];
      for (let i = 0; i < I.length; i++) { const d = Math.round((I[i] - B[i]) * 100); if (d !== 0) cells.push([i, d]); }
      const held: number[] = [];
      for (let i = 0; i < F.holder.length; i++) if (F.holder[i] === f.id) held.push(i);
      return { archetype: f.archetype, cells, held };
    }),
    stats: { ...stats },
  };
}

/** Put saved turf back (unknown groups or cells are skipped); returns the saved stats. */
export function restoreFactions(F: FactionMap, raw: unknown): Record<string, number> {
  const o = raw && typeof raw === 'object' ? (raw as Partial<SavedFactions>) : null;
  for (let f = 0; f < F.factions.length; f++) F.influence[f].set(F.base[f]);
  const stats: Record<string, number> = {};
  const held = new Int16Array(F.holder.length).fill(-1);
  if (o && Array.isArray(o.groups)) {
    for (const g of o.groups) {
      const f = F.factions.find((x) => x.archetype === g?.archetype);
      if (!f || !Array.isArray(g.cells)) continue;
      const I = F.influence[f.id], B = F.base[f.id];
      for (const c of g.cells) {
        if (!Array.isArray(c) || !Number.isInteger(c[0]) || !Number.isFinite(c[1]) || c[0] < 0 || c[0] >= I.length) continue;
        I[c[0]] = Math.max(0, Math.min(SHIFT.max, B[c[0]] + c[1] / 100));
      }
      if (Array.isArray(g.held)) for (const i of g.held) if (Number.isInteger(i) && i >= 0 && i < held.length) held[i] = f.id;
    }
    for (const [k, v] of Object.entries(o.stats ?? {})) if (Number.isFinite(v)) stats[k] = v as number;
  }
  // The saved holder keeps a cell as long as drift would let it (within the hysteresis below HOLD).
  for (let i = 0; i < F.holder.length; i++) {
    const h = held[i];
    F.holder[i] = h >= 0 && F.influence[h][i] >= HOLD - DRIFT.hysteresis - 0.005 ? h : holderOf(F, i);
  }
  return stats;
}

/** The cell a group wants most; away from the homes already taken. */
function pickHome(macro: MacroPlan, index: Float32Array, A: Archetype, rng: Rng, taken: readonly Faction[]): number {
  let best = -1, bs = 0;
  macro.cells.forEach((c, i) => {
    const aff = A.affinity[c.district];
    if (aff <= 0) return;
    let s = aff * Math.max(0.05, 1 + A.rough * (index[i] - 0.5)) * Math.pow(Math.max(0.05, c.density), A.dense) * (0.75 + 0.5 * rng.float());
    for (const f of taken) {
      const h = macro.cells[f.home].centroid;
      if (Math.hypot(c.centroid[0] - h[0], c.centroid[1] - h[1]) < 600) s *= 0.3;
    }
    if (s > bs) { bs = s; best = i; }
  });
  return best;
}

function nameFor(A: Archetype, rng: Rng, district: import('../../plan/types').District): string {
  const places = A.places?.[district];
  const a = places && rng.chance(0.6) ? rng.pick(places) : rng.pick(A.a);
  const b = A.b.length ? rng.pick(A.b) : '';
  const s = rng.pick(A.names).replace('{a}', a).replace('{b}', b);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Display name with "the" kept lower case inside a sentence ("stopped the Harbour Kings"). */
export function inSentence(f: Faction): string {
  return f.name.startsWith('The ') ? `the ${f.name.slice(4)}` : f.name;
}

/** How two groups get on: rivals fight (turf brawls, pressure on shared borders); others are wary. */
export function relation(F: FactionMap, a: number, b: number): 'self' | 'hostile' | 'wary' {
  if (a === b) return 'self';
  const A = F.factions[a], B = F.factions[b];
  if (!A || !B) return 'wary';
  return ARCHETYPES[A.archetype].rivals.includes(B.archetype) || ARCHETYPES[B.archetype].rivals.includes(A.archetype) ? 'hostile' : 'wary';
}

/** How much of its starting turf a group still holds (1: all of it; more after gains). */
export function strength(F: FactionMap, f: number): number {
  const held = F.holder.reduce((n, h) => n + (h === f ? 1 : 0), 0);
  return held / Math.max(1, F.baseHeld[f] ?? 1);
}

/** Off-screen drift per game hour. */
export const DRIFT = {
  /** Share of the gap to the target closed per hour. */
  rate: 0.03,
  /** A group's target is its seeded hold × (floor + (1 − floor) × strength): a weakened group holds less. */
  floor: 0.3,
  /** Next to its own turf, where it could hold a cell, the target is this much higher (× strength). */
  push: 0.12,
  /** In its own cell on a border with a rival, the target is this much lower (× the rival's strength). */
  clash: 0.08,
  /** Seeded noise per cell and hour (±). */
  noise: 0.012,
  /** Its home cell's target never drops below this (a beaten group comes back there). */
  home: 0.42,
  /** A cell changes hands only this far past HOLD (and past the holder): no flickering borders. */
  hysteresis: 0.03,
  /** Hours caught up at most after a jump in time. */
  maxCatchUp: 24,
};

/**
 * One game hour of drift (pure, deterministic for seed and hour): every group's influence moves a
 * step towards a target — its seeded hold scaled by its strength, raised next to its own turf where
 * it could hold the cell, lowered where a rival presses on its border — plus seeded noise. Cells
 * change hands with hysteresis. Returns the cells whose holder changed.
 */
export function drift(F: FactionMap, seed: number, hour: number): { cell: number; from: number; to: number }[] {
  const n = F.holder.length, D = DRIFT, nf = F.factions.length;
  const str = F.factions.map((f) => Math.min(1, Math.max(0, strength(F, f.id))));
  const next = F.influence.map((I) => I.slice());
  for (let f = 0; f < nf; f++) {
    const I = F.influence[f], B = F.base[f], s = str[f];
    for (let i = 0; i < n; i++) {
      let target = B[i] * (D.floor + (1 - D.floor) * s);
      // A group never quite dies: it keeps coming back to its home ground.
      if (i === F.factions[f].home) target = Math.max(target, D.home);
      let border = false, press = 0;
      for (const j of F.near[i]) {
        const h = F.holder[j];
        if (h === f) border = true;
        else if (h >= 0 && F.holder[i] === f && relation(F, f, h) === 'hostile') press = Math.max(press, str[h]);
      }
      if (border && F.holder[i] !== f && F.can[f][i]) target += D.push * s;
      if (press > 0) target -= D.clash * press;
      if (target <= 0 && I[i] <= 0) continue;
      let v = I[i] + (Math.max(0, target) - I[i]) * D.rate;
      if (I[i] > 0 || B[i] > 0) v += (hashToFloat(deriveSeed(seed, 'drift', hour, i, f)) - 0.5) * 2 * D.noise;
      next[f][i] = Math.max(0, Math.min(SHIFT.max, v));
    }
  }
  for (let f = 0; f < nf; f++) F.influence[f].set(next[f]);
  const out: { cell: number; from: number; to: number }[] = [];
  for (let i = 0; i < n; i++) {
    const from = F.holder[i];
    let to = holderOf(F, i);
    if (to !== from) {
      // Hysteresis: the holder keeps a cell until clearly below HOLD; a newcomer needs a clear lead.
      const cur = from >= 0 ? F.influence[from][i] : 0;
      const holds = from >= 0 && cur >= HOLD - D.hysteresis;
      const lead = to >= 0 ? F.influence[to][i] : 0;
      if (to < 0) { if (holds) to = from; }
      else if (lead < HOLD + D.hysteresis || (holds && lead < cur + D.hysteresis)) to = holds ? from : -1;
    }
    if (from !== to) { F.holder[i] = to; out.push({ cell: i, from, to }); }
  }
  return out;
}

/** The hostile groups with a hold on a cell or its neighbours (who could pick a fight there), strongest first. */
export function rivalsAt(F: FactionMap, cell: number, f: number): number[] {
  if (cell < 0) return [];
  const score = new Map<number, number>();
  for (const i of [cell, ...F.near[cell]]) {
    for (let g = 0; g < F.factions.length; g++) {
      if (relation(F, f, g) !== 'hostile') continue;
      const v = F.influence[g][i] * (i === cell ? 1.5 : 1);
      if (F.holder[i] === g || (i === cell && v >= 0.12 * 1.5)) score.set(g, Math.max(score.get(g) ?? 0, v));
    }
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
}
