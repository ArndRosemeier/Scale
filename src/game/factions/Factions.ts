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
 * Turf does not move yet: drift and the player's effect on it come with saves (Phase 1, part 2).
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
  return { factions, influence, holder };
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
