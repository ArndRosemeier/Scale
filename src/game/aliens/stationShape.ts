/**
 * The Wardens' station as a solid thing in the world (pure, no three.js): where it hangs over the
 * city, its hull profile (one lathe shape, level, the same for both levels of detail), and the hull
 * as a solid for the hero: the top decks to land on, the belly as a ceiling, the rim as a wall.
 */
import { Rng, deriveSeed } from '../../core/rng';

/** Hull radius (m): the station is a little over a kilometre across. */
export const STATION_R = 520;
/** Height of the hull's rim over the ground below it (m). */
export const STATION_ALT = 2600;

/**
 * The hull's profile, bottom (the spindle's tip) to top (the crown), as [radius, height] in hull
 * radii: a spindle hanging below a wide shallow belly, a rim band, then the top in terraces (flat
 * rings with walls between them, so the decks can be walked on) up to a low central dome.
 */
export const PROFILE: readonly (readonly [number, number])[] = [
  [0, -0.62], [0.035, -0.6], [0.05, -0.55], [0.05, -0.43], [0.09, -0.41], [0.09, -0.375], [0.06, -0.355],
  [0.065, -0.27], [0.13, -0.22], [0.2, -0.165], [0.3, -0.125], [0.46, -0.097], [0.62, -0.082], [0.8, -0.066],
  [0.95, -0.038], [1.0, -0.02], [1.0, 0.02], [0.97, 0.042], [0.84, 0.07], [0.835, 0.074], [0.835, 0.096],
  [0.64, 0.1], [0.625, 0.1], [0.625, 0.142], [0.5, 0.148], [0.485, 0.148], [0.485, 0.18], [0.36, 0.186],
  [0.34, 0.236], [0.25, 0.276], [0.15, 0.302], [0, 0.314],
];

/** The flat decks on top: [inner, outer] radius and height, in hull radii. */
export const DECKS: readonly (readonly [number, number, number])[] = [
  [0.64, 0.835, 0.098], [0.5, 0.625, 0.145], [0.36, 0.485, 0.183],
];

/** Where the station hangs: a seeded bearing and elevation as seen from the city centre. */
export function stationSpot(seed: number): { x: number; z: number; yaw: number; el: number } {
  const r = new Rng(deriveSeed(seed, 'station'));
  const az = r.range(0, Math.PI * 2), el = r.range(0.62, 0.86);
  const yaw = r.range(0, Math.PI * 2);
  // Far enough out that from the middle of town it stands at that elevation.
  const d = STATION_ALT / Math.tan(el);
  return { x: Math.cos(az) * d, z: Math.sin(az) * d, yaw, el };
}

// ------------------------------------------------------------------ the hull as a solid

const N = 1024;
/** Lowest and highest hull height (hull radii) at each radius 0..1 (NaN outside). */
const LO = new Float32Array(N + 1), HI = new Float32Array(N + 1);
(() => {
  LO.fill(Infinity); HI.fill(-Infinity);
  for (let i = 0; i + 1 < PROFILE.length; i++) {
    const [r0, y0] = PROFILE[i], [r1, y1] = PROFILE[i + 1];
    const a = Math.floor(Math.min(r0, r1) * N), b = Math.ceil(Math.max(r0, r1) * N);
    for (let k = a; k <= b; k++) {
      const rr = k / N;
      let y: number;
      if (Math.abs(r1 - r0) < 1e-9) { LO[k] = Math.min(LO[k], y0, y1); HI[k] = Math.max(HI[k], y0, y1); continue; }
      const t = (rr - r0) / (r1 - r0);
      if (t < -1e-6 || t > 1 + 1e-6) continue;
      y = y0 + (y1 - y0) * Math.min(1, Math.max(0, t));
      LO[k] = Math.min(LO[k], y); HI[k] = Math.max(HI[k], y);
    }
  }
})();

/** The hull's vertical span at a radius (in hull radii) as [low, high], or null beyond the rim. */
export function hullSpan(rho: number): [number, number] | null {
  if (rho > 1) return null;
  const k = Math.max(0, Math.min(N, Math.round(rho * N)));
  return [LO[k], HI[k]];
}

/** A placed station (world metres). */
export interface StationBody { x: number; y: number; z: number; R: number }

/**
 * The span (m) the hull fills over a body of radius r standing at (x, z): the span at the body's
 * edge nearest the axis (the hull is fattest towards the middle), or null when clear of it.
 */
function spanAt(s: StationBody, x: number, z: number, r: number): [number, number] | null {
  const rho = Math.max(0, Math.hypot(x - s.x, z - s.z) - r) / s.R;
  const sp = hullSpan(rho);
  return sp ? [s.y + sp[0] * s.R, s.y + sp[1] * s.R] : null;
}

/** The top of the hull under (x, z) when the feet (yRef) are on or above it, else -Infinity. */
export function stationGround(s: StationBody, x: number, z: number, yRef: number, step: number): number {
  const sp = spanAt(s, x, z, 0);
  if (!sp || yRef + step < sp[1] || yRef < (sp[0] + sp[1]) / 2) return -Infinity;
  return sp[1];
}

/** The belly over a body whose feet are at y below it (Infinity: no ceiling). */
export function stationCeiling(s: StationBody, x: number, z: number, y: number, r: number): number {
  const sp = spanAt(s, x, z, r);
  if (!sp || y > (sp[0] + sp[1]) / 2) return Infinity;
  return sp[0];
}

/**
 * Push a body (feet y, height h, radius r) out sideways when it is in the hull's flank (the rim,
 * a terrace wall, the spindle): to the nearest radius where the hull clears it. Returns the new
 * (x, z) and the outward normal, or null when nothing is in the way.
 */
export function stationPush(s: StationBody, x: number, z: number, y: number, h: number, r: number, step: number): { x: number; z: number; nx: number; nz: number } | null {
  const dx = x - s.x, dz = z - s.z, d = Math.hypot(dx, dz);
  if (d - r > s.R) return null;
  const blocks = (rad: number): boolean => {
    const sp = hullSpan(Math.max(0, rad - r) / s.R);
    if (!sp) return false;
    const lo = s.y + sp[0] * s.R, hi = s.y + sp[1] * s.R;
    return y + h > lo && y < hi - step;
  };
  if (!blocks(d)) return null;
  let out = d;
  while (out - r <= s.R && blocks(out)) out += 0.25;
  const nx = d > 1e-6 ? dx / d : 1, nz = d > 1e-6 ? dz / d : 0;
  return { x: s.x + nx * out, z: s.z + nz * out, nx, nz };
}
