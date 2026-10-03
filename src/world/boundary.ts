/**
 * The city's outline as a polar radius function (64 angle samples) and the extent of the
 * terrain around it. A pure function of the profile, so the terrain, the land use and the
 * macro plan all agree on where the city ends.
 */
import { Noise } from '../core/noise';
import { deriveSeed } from '../core/rng';
import { lerp } from '../core/math';
import type { WorldProfile } from './settings';

export function makeBoundary(p: WorldProfile): number[] {
  const n = new Noise(deriveSeed(p.seed, 'boundary'));
  const out: number[] = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    out.push(p.radius * (1 + 0.2 * n.fbm2(Math.cos(a) * 1.3, Math.sin(a) * 1.3, 3)));
  }
  return out;
}

/** Boundary radius in the direction of (x, z). */
export function boundaryAt(boundary: number[], x: number, z: number): number {
  const a = Math.atan2(z, x);
  const f = ((a / (Math.PI * 2)) + 1) % 1 * boundary.length;
  const i = Math.floor(f), t = f - i;
  return lerp(boundary[i % boundary.length], boundary[(i + 1) % boundary.length], t);
}

/** Root size of the terrain quadtree. */
export const TERRAIN_ROOT = 8192;

/** Half size of the streamed terrain square (a multiple of TERRAIN_ROOT). */
export function terrainExtent(boundary: number[]): number {
  return Math.ceil((boundary.reduce((a, b) => Math.max(a, b), 0) * 1.6 + 6000) / TERRAIN_ROOT) * TERRAIN_ROOT;
}
