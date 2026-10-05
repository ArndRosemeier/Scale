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
 * (`saveFactions` / `restoreFactions`). Drift over time and rivals moving into the gap are Phase 2.
 */
import type { MacroPlan } from '../../plan/types';
import { Rng, deriveSeed } from '../../core/rng';
import { valueNoise2 } from '../crime/CrimeIndex';
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
  return { factions, influence, holder, base: influence.map((f) => f.slice()), near };
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

/** Saved turf: per group (by archetype), the cells whose influence differs from the seeded one, in hundredths. */
export interface SavedFactions { v: 1; groups: { archetype: string; cells: [number, number][] }[]; stats: Record<string, number> }

export function saveFactions(F: FactionMap, stats: Record<string, number> = {}): SavedFactions {
  return {
    v: 1,
    groups: F.factions.map((f) => {
      const cells: [number, number][] = [];
      const I = F.influence[f.id], B = F.base[f.id];
      for (let i = 0; i < I.length; i++) { const d = Math.round((I[i] - B[i]) * 100); if (d !== 0) cells.push([i, d]); }
      return { archetype: f.archetype, cells };
    }),
    stats: { ...stats },
  };
}

/** Put saved turf back (unknown groups or cells are skipped); returns the saved stats. */
export function restoreFactions(F: FactionMap, raw: unknown): Record<string, number> {
  const o = raw && typeof raw === 'object' ? (raw as Partial<SavedFactions>) : null;
  for (let f = 0; f < F.factions.length; f++) F.influence[f].set(F.base[f]);
  const stats: Record<string, number> = {};
  if (o && Array.isArray(o.groups)) {
    for (const g of o.groups) {
      const f = F.factions.find((x) => x.archetype === g?.archetype);
      if (!f || !Array.isArray(g.cells)) continue;
      const I = F.influence[f.id], B = F.base[f.id];
      for (const c of g.cells) {
        if (!Array.isArray(c) || !Number.isInteger(c[0]) || !Number.isFinite(c[1]) || c[0] < 0 || c[0] >= I.length) continue;
        I[c[0]] = Math.max(0, Math.min(SHIFT.max, B[c[0]] + c[1] / 100));
      }
    }
    for (const [k, v] of Object.entries(o.stats ?? {})) if (Number.isFinite(v)) stats[k] = v as number;
  }
  for (let i = 0; i < F.holder.length; i++) F.holder[i] = holderOf(F, i);
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
