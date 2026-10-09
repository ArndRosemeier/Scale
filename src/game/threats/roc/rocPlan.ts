/**
 * Where the Roc goes (pure, headless-testable): the roof edges it perches on, where it comes in
 * from, the car it would snatch. Everything takes plain data (building footprints, positions), so
 * the tests run without a world.
 */
import { closestOnPoly, pointInPoly } from '../../../core/geom2';
import type { Rng } from '../../../core/rng';

/** What the planner needs of a building: footprint (x, z, …), roof height, foot, still standing. */
export interface PerchBuilding { poly: number[]; top: number; base: number; alive: boolean }

export interface Perch {
  /** Where its feet stand on the roof, facing out over the edge (yaw: forward = (sin, cos)). */
  x: number; y: number; z: number; yaw: number;
  /** Index into the list it was picked from. */
  i: number;
}

export const ROC_PLAN = {
  /** Least height of a building to perch on (m), how far in from the edge the feet stand (m). */
  minH: 20, inset: 3.2,
  /** Sought within this of the centre (m), never nearer the looker than (m). */
  range: 340, near: 25,
  /** Comes in from this far out (m), this high (m). */
  entry: 900, entryAlt: 120,
};

/**
 * A roof edge to perch on near (cx, cz), facing out towards (lx, lz) — the tallest few standing
 * buildings, one of them at random; edges already `used` (by index) are skipped. Null if none.
 */
export function pickPerch(list: readonly PerchBuilding[], cx: number, cz: number, lx: number, lz: number, rng: Rng, used: ReadonlySet<number> = new Set()): Perch | null {
  const P = ROC_PLAN;
  const cand: { i: number; h: number }[] = [];
  list.forEach((b, i) => {
    if (!b.alive || used.has(i) || b.top - b.base < P.minH || b.poly.length < 6) return;
    const c = centroid(b.poly);
    if (Math.hypot(c.x - cx, c.z - cz) > P.range) return;
    cand.push({ i, h: b.top - b.base });
  });
  if (!cand.length) return null;
  cand.sort((a, b) => b.h - a.h);
  const pick = cand[rng.int(0, Math.min(3, cand.length) - 1)];
  const b = list[pick.i], c = centroid(b.poly);
  // The edge facing the looker, the feet a few metres in from it (towards the middle of the roof).
  const e = closestOnPoly(b.poly, lx, lz);
  let ix = c.x - e.x, iz = c.z - e.z;
  const il = Math.hypot(ix, iz) || 1;
  ix /= il; iz /= il;
  const inset = Math.min(P.inset, il * 0.5);
  let x = e.x + ix * inset, z = e.z + iz * inset;
  if (!pointInPoly(b.poly, x, z)) { x = c.x; z = c.z; }
  if (Math.hypot(x - lx, z - lz) < P.near) return null;
  return { x, y: b.top, z, yaw: Math.atan2(-ix, -iz), i: pick.i };
}

/** Where it comes in from: far out on the side away from the centre, beyond the hero. */
export function entryPoint(cx: number, cz: number, hx: number, hz: number, rng: Rng): { x: number; y: number; z: number } {
  let a = Math.hypot(hx - cx, hz - cz) < 1 ? rng.range(0, Math.PI * 2) : Math.atan2(hz - cz, hx - cx);
  a += rng.range(-0.7, 0.7);
  return { x: hx + Math.cos(a) * ROC_PLAN.entry, y: ROC_PLAN.entryAlt, z: hz + Math.sin(a) * ROC_PLAN.entry };
}

/** Pick the car to snatch: within r of (x, z), a bus counts thrice, nearer is better. Index or −1. */
export function pickPrey(cars: readonly { x: number; z: number; bus: boolean; ok: boolean }[], x: number, z: number, r: number): number {
  let best = -1, bs = -Infinity;
  cars.forEach((c, i) => {
    if (!c.ok) return;
    const d = Math.hypot(c.x - x, c.z - z);
    if (d > r) return;
    const s = (c.bus ? 3 : 1) * (1 - d / r) + 0.05;
    if (s > bs) { bs = s; best = i; }
  });
  return best;
}

function centroid(p: number[]): { x: number; z: number } {
  let x = 0, z = 0;
  const n = p.length / 2;
  for (let i = 0; i < p.length; i += 2) { x += p[i]; z += p[i + 1]; }
  return { x: x / n, z: z / n };
}
