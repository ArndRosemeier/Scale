/**
 * Airfield of a big city: a flat, open rectangle out in the countryside beyond the protected
 * zone around the city (so the city's terrain stays bit for bit the same), away from rivers and
 * the coast. The terrain grades it level (`Terrain.height`), the land use keeps forests and
 * fields off it (`LandUse.sample`) and the landmark planner lays the airport out on it
 * (plan/landmarks, plan/landmarkParts).
 *
 * A pure function of the natural terrain (picked once in the Terrain constructor, before the
 * grading applies), so every worker and the main thread agree on it.
 */
import { Rng, deriveSeed } from '../core/rng';
import { clamp } from '../core/math';
import type { Terrain } from './terrain';
import { makeBoundary, boundaryAt } from './boundary';

/** Cities from this radius (m) get an airport (size ≈ 0.5 and up: big cities and metropolises). */
export const AIRPORT_MIN_RADIUS = 3500;
/** Width of the embankment band around the levelled rectangle (m). */
export const AIRFIELD_BLEND = 90;

export interface Airfield {
  /** Centre, runway direction (u = (cos, sin)), half sizes along u and across (v). */
  x: number;
  z: number;
  angle: number;
  hu: number;
  hv: number;
  /** Ground level of the field. */
  level: number;
  /** Runway length (m) and count (1, or 2 parallel ones for the largest cities). */
  runwayLen: number;
  runways: number;
  /** Which side of the runway the terminal stands on (+1: +v, -1: -v): the side facing the city. */
  side: number;
}

/** Is (x, z) on the levelled field (grown by m)? */
export function inAirfield(a: Airfield, x: number, z: number, m = 0): boolean {
  const dx = x - a.x, dz = z - a.z;
  const c = Math.cos(a.angle), s = Math.sin(a.angle);
  return Math.abs(dx * c + dz * s) < a.hu + m && Math.abs(-dx * s + dz * c) < a.hv + m;
}

/** Distance outside the field's rectangle (negative inside). */
export function airfieldEdge(a: Airfield, x: number, z: number): number {
  const dx = x - a.x, dz = z - a.z;
  const c = Math.cos(a.angle), s = Math.sin(a.angle);
  return Math.max(Math.abs(dx * c + dz * s) - a.hu, Math.abs(-dx * s + dz * c) - a.hv);
}

/**
 * Pick the airfield: candidates around the city just beyond the protected zone, runway radial
 * or tangential; flat (smallest height range), dry and close to town wins.
 */
export function pickAirfield(t: Terrain): Airfield | null {
  const p = t.profile;
  if (p.radius < AIRPORT_MIN_RADIUS) return null;
  const rng = new Rng(deriveSeed(p.seed, 'airfield'));
  const boundary = makeBoundary(p);
  const runways = p.radius > 7500 ? 2 : 1;
  const runwayLen = Math.round(clamp(2300 + (p.radius - AIRPORT_MIN_RADIUS) * 0.22, 2300, 3600) / 50) * 50 + rng.int(-2, 2) * 50;
  const hu = runwayLen / 2 + 180;
  const hv = runways === 2 ? 520 : 360;
  const minR = t.protectR + AIRFIELD_BLEND + 60;
  const maxR = t.worldExtent - 2500;
  const phase = rng.range(0, Math.PI * 2);
  let best: Airfield | null = null, bestScore = Infinity;
  const DIRS = 28;
  for (let k = 0; k < DIRS; k++) {
    const dir = phase + (k / DIRS) * Math.PI * 2;
    const dx = Math.cos(dir), dz = Math.sin(dir);
    for (const radial of [true, false]) {
      const angle = radial ? dir : dir + Math.PI / 2;
      // Nearest distance of the rectangle to the origin along dir: half its extent that way.
      const along = radial ? hu : hv;
      for (const extra of [0, 400, 900]) {
        const d = minR + along + extra;
        if (d + along > maxR) continue;
        const x = dx * d, z = dz * d;
        const c = Math.cos(angle), s = Math.sin(angle);
        // The corners must all be outside the protected zone.
        let ok = true;
        for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const cx = x + c * hu * su - s * hv * sv, cz = z + s * hu * su + c * hv * sv;
          if (Math.hypot(cx, cz) < minR) { ok = false; break; }
        }
        if (!ok) continue;
        // Flatness and water on a grid over the field plus a margin.
        let lo = Infinity, hi = -Infinity, sum = 0, n = 0;
        for (let i = 0; i <= 8 && ok; i++) for (let j = 0; j <= 4; j++) {
          const u = (i / 8 - 0.5) * 2 * (hu + 120), v = (j / 4 - 0.5) * 2 * (hv + 120);
          const px = x + c * u - s * v, pz = z + s * u + c * v;
          if (t.isWater(px, pz, 160) || (p.coastal && t.coastDistance(px, pz) < 350)) { ok = false; break; }
          const h = t.height(px, pz);
          lo = Math.min(lo, h); hi = Math.max(hi, h); sum += h; n++;
        }
        if (!ok) continue;
        const range = hi - lo;
        if (range > 30) continue;
        // Flat first, then close to the city (an airport 3 km further out is a long drive).
        const edge = d - along - boundaryAt(boundary, x, z);
        const score = range + edge * 0.01 + (radial ? 0 : 1.5);
        if (score < bestScore) {
          bestScore = score;
          // The terminal faces the city: the side of the runway nearer the origin.
          const side = -Math.sign(-x * s + z * c) || 1;
          best = { x, z, angle, hu, hv, level: sum / n, runwayLen, runways, side };
        }
      }
    }
  }
  return best;
}
