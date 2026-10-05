/**
 * Hideouts (VILLAINS_PLAN §3.1, Phase 2): every group keeps its stash behind a door in its turf — a
 * back room of an ordinary building in its strongest cell (its home ground to begin with). Guards
 * loiter outside (crime/HideoutGuard). The player finds a hideout by walking past it (or a cuffed
 * member gives it up); it is marked on the map from then on. Busting the stash (E at the door with
 * the guards out of the way) costs the group a big piece of its turf; it lies low for a while and
 * then sets up again somewhere else in its turf.
 *
 * Placement is deterministic for (seed, group, move count) over the doors of the cell (`pickDoor`);
 * the chosen door is saved, so a hideout stays where it was even if the city around it changes.
 * Pure (no DOM, no three.js).
 */
import { hash32 } from '../../core/rng';
import type { FactionMap } from './Factions';

export const HIDEOUTS = {
  /** Look for the door once the player is this close to the cell (m from its centroid + radius). */
  placeR: 260,
  /** Spotted when the player passes within this distance (and it is in view). */
  spotR: 28,
  /** Guards are posted when the player comes this close (not closer than `guardMin` in view: no popping up); they stand down beyond `leaveR`. */
  guardR: 110,
  guardMin: 60,
  leaveR: 170,
  /** E at the door within this distance. */
  useR: 2.6,
  /** Game hours the group lies low after a bust before it sets up again. */
  lieLow: 36,
  /** Chance a cuffed member gives the hideout away. */
  tellChance: 0.3,
};

export interface Hideout {
  /** Faction id. */
  faction: number;
  /** The door (outside point, outward normal); null until placed (or after a bust, until it moves). */
  door: { x: number; z: number; nx: number; nz: number } | null;
  /** The macro cell it is in. */
  cell: number;
  /** The player knows where it is (map marker). */
  found: boolean;
  /** Busted: empty until this game hour (absolute). */
  bustedUntil: number;
  /** How many times it has moved (picks a different door each time). */
  moves: number;
}

/** One per group, nothing placed yet. */
export function planHideouts(F: FactionMap): Hideout[] {
  return F.factions.map((f) => ({ faction: f.id, door: null, cell: f.home, found: false, bustedUntil: -1, moves: 0 }));
}

/** The cell a group keeps its stash in: its home while it holds it, else its strongest held cell (-1: none). */
export function hideoutCell(F: FactionMap, f: number): number {
  const home = F.factions[f]?.home ?? -1;
  if (home >= 0 && F.holder[home] === f) return home;
  let best = -1, bv = 0;
  for (let i = 0; i < F.holder.length; i++) if (F.holder[i] === f && F.influence[f][i] > bv) { bv = F.influence[f][i]; best = i; }
  return best;
}

/** A door for the stash among the cell's doors: seeded by group and move count, nearest the cell's middle half preferred. */
export function pickDoor<T extends { x: number; z: number }>(doors: readonly T[], seed: number, f: number, moves: number, cx: number, cz: number, r: number): T | null {
  if (!doors.length) return null;
  let best: T | null = null, bs = Infinity;
  for (const d of doors) {
    const h = hash32(seed ^ Math.imul(f + 1, 0x9e3779b1) ^ Math.imul(moves + 1, 0x85ebca6b) ^ Math.imul(Math.round(d.x * 2) | 0, 0x27d4eb2f) ^ Math.imul(Math.round(d.z * 2) | 0, 0x165667b1));
    // Not on the cell's outer edge (an arterial): a quieter street inside it.
    const edge = Math.hypot(d.x - cx, d.z - cz) / Math.max(1, r);
    const s = (h / 2 ** 32) + (edge > 0.75 ? 1 : 0);
    if (s < bs) { bs = s; best = d; }
  }
  return best;
}

export interface SavedHideout { archetype: string; door: [number, number, number, number] | null; cell: number; found: boolean; bustedUntil: number; moves: number }

export function saveHideouts(F: FactionMap, list: readonly Hideout[]): SavedHideout[] {
  return list.map((h) => ({ archetype: F.factions[h.faction].archetype, door: h.door ? [h.door.x, h.door.z, h.door.nx, h.door.nz] : null, cell: h.cell, found: h.found, bustedUntil: h.bustedUntil, moves: h.moves }));
}

/** Saved hideouts back over a fresh plan (unknown groups and broken entries are skipped). */
export function restoreHideouts(F: FactionMap, raw: unknown): Hideout[] {
  const out = planHideouts(F);
  if (!Array.isArray(raw)) return out;
  for (const r of raw as Partial<SavedHideout>[]) {
    if (!r || typeof r !== 'object') continue;
    const f = F.factions.find((x) => x.archetype === r.archetype);
    if (!f) continue;
    const h = out[f.id];
    const d = r.door;
    h.door = Array.isArray(d) && d.length === 4 && d.every(Number.isFinite) ? { x: d[0], z: d[1], nx: d[2], nz: d[3] } : null;
    h.cell = Number.isInteger(r.cell) && (r.cell as number) >= 0 && (r.cell as number) < F.holder.length ? (r.cell as number) : f.home;
    h.found = !!r.found && !!h.door;
    h.bustedUntil = Number.isFinite(r.bustedUntil) ? (r.bustedUntil as number) : -1;
    h.moves = Number.isInteger(r.moves) && (r.moves as number) >= 0 ? (r.moves as number) : 0;
  }
  return out;
}
