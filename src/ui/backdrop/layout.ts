/**
 * The start screen's city: a small, made-up skyline for the backdrop (not the real city, which
 * takes far too long to build). Blocks on a grid, towers rising towards a downtown, setback tiers
 * on the tall ones, traffic on every street, beacons on the tallest roofs. Same seed, same skyline.
 */
import { Rng } from '../../core/rng';

/** Block pitch, half the block (without its streets) and the grid's reach in blocks. */
export const PITCH = 96;
export const BLOCK_HALF = 39;
export const REACH = 14;
/** The camera circles downtown on this ring; buildings near it stay low enough to fly over. */
export const ORBIT_R = 560;

/** Floats per box: centre x, centre z, width x, depth z, base y, height, style, seed. */
export const BOX_FLOATS = 8;
/** Floats per light: x, y, z, kind, then four parameters per kind (see the light shader). */
export const LIGHT_FLOATS = 8;

/** Light kinds, as the light shader reads them. */
export const enum LightKind { Car = 0, Beacon = 1, Plane = 2, Hero = 3 }

/** Building styles, as the building shader reads them (the last one is a park). */
export const STYLES = 7;
const PARK = 6;

export interface Skyline {
  boxes: Float32Array;
  boxCount: number;
  lights: Float32Array;
  lightCount: number;
  /** The tallest roof (the camera keeps its distance from it). */
  top: number;
}

/** Number of points in the hero's trail (the comet that crosses the skyline now and then). */
export const HERO_TRAIL = 48;

export function buildSkyline(seed: number): Skyline {
  const rng = new Rng(seed ^ 0x5ca1e);
  const boxes: number[] = [];
  const tall: { x: number; z: number; y: number }[] = [];
  // Downtown sits near the middle; a second, smaller cluster somewhere off to the side.
  const cx = rng.range(-60, 60), cz = rng.range(-60, 60);
  const a2 = rng.range(0, Math.PI * 2), r2 = rng.range(700, 950);
  const c2x = Math.cos(a2) * r2, c2z = Math.sin(a2) * r2;
  const peak = rng.range(200, 290);
  const box = (x: number, z: number, sx: number, sz: number, y0: number, h: number, style: number, s: number): void => {
    boxes.push(x, z, sx, sz, y0, h, style, s);
  };
  for (let i = -REACH; i <= REACH; i++) {
    for (let j = -REACH; j <= REACH; j++) {
      const bx = i * PITCH, bz = j * PITCH;
      const rr = Math.hypot(bx, bz);
      if (rr > REACH * PITCH + 20) continue;
      // Now and then a park.
      if (rng.chance(0.05)) { box(bx, bz, BLOCK_HALF * 2, BLOCK_HALF * 2, 0, 0.3, PARK, rng.float()); continue; }
      const nx = rng.int(1, 3), nz = rng.int(1, 3);
      const lw = (BLOCK_HALF * 2) / nx, ld = (BLOCK_HALF * 2) / nz;
      for (let a = 0; a < nx; a++) {
        for (let b = 0; b < nz; b++) {
          const x = bx - BLOCK_HALF + lw * (a + 0.5), z = bz - BLOCK_HALF + ld * (b + 0.5);
          const inset = rng.range(1, 4);
          const sx = lw - inset * 2, sz = ld - inset * 2;
          const d1 = Math.hypot(x - cx, z - cz), d2 = Math.hypot(x - c2x, z - c2z);
          const dt = Math.exp(-((d1 / 330) ** 2)), side = 0.45 * Math.exp(-((d2 / 220) ** 2));
          const f = Math.max(dt, side);
          let h = 10 + rng.float() * 22 + f * (30 + rng.float() ** 1.6 * peak);
          if (rng.chance(0.03)) h *= 1.8; // the odd tower among low houses
          // Keep the camera's ring free of anything it would fly into.
          const ring = Math.abs(Math.hypot(x, z) - ORBIT_R);
          h = Math.min(h, 30 + (ring / 100) ** 2 * 60);
          h = Math.round(h / 3.3) * 3.3 + 1.2;
          const style = f > 0.35 && h > 70 ? pickTower(rng) : pickLow(rng);
          const s = rng.float();
          if (h > 90 && sx > 14 && sz > 14) {
            // Setbacks: base, a slimmer middle, sometimes a crown.
            const h1 = h * rng.range(0.4, 0.62);
            box(x, z, sx, sz, 0, h1, style, s);
            const k = rng.range(0.62, 0.82);
            const h2 = h * (rng.chance(0.5) ? 1 : rng.range(0.8, 0.9));
            box(x, z, sx * k, sz * k, h1, h2 - h1, style, s);
            if (h2 < h) box(x, z, sx * k * 0.6, sz * k * 0.6, h2, h - h2, style, s);
            tall.push({ x, z, y: h });
          } else {
            box(x, z, sx, sz, 0, h, style, s);
            if (h > 70) tall.push({ x, z, y: h });
            // Roof clutter on the lower houses: stair heads, plant rooms.
            for (let q = rng.int(0, 2); q > 0; q--) {
              const w = rng.range(3, Math.min(9, sx * 0.4)), d = rng.range(3, Math.min(9, sz * 0.4));
              box(x + rng.range(-0.5, 0.5) * (sx - w), z + rng.range(-0.5, 0.5) * (sz - d), w, d, h, rng.range(2.5, 4.5), 2, rng.float());
            }
          }
        }
      }
    }
  }

  const lights: number[] = [];
  const light = (x: number, y: number, z: number, kind: LightKind, p0: number, p1: number, p2: number, p3: number): void => {
    lights.push(x, y, z, kind, p0, p1, p2, p3);
  };
  // Traffic: every street in both directions; cars drive on the right, the shader moves them.
  const len = (REACH + 0.5) * PITCH * 2;
  for (let k = -REACH; k < REACH; k++) {
    const line = (k + 0.5) * PITCH;
    for (let axis = 0; axis < 2; axis++) {
      for (const dir of [1, -1]) {
        const busy = 0.5 + 0.5 * Math.exp(-((line / 600) ** 2));
        const n = Math.round(42 * busy);
        for (let c = 0; c < n; c++) {
          // x/z: the lane (axis, line + lane offset); p0 start along the street, p1 speed, p2 street length.
          const lane = line + dir * rng.range(2.2, 4.4);
          light(axis, 0.7, lane, LightKind.Car, rng.float() * len, dir * rng.range(9, 17), len, rng.float());
        }
      }
    }
  }
  // Red beacons on the tallest roofs.
  tall.sort((p, q) => q.y - p.y);
  let top = 0;
  for (const t of tall.slice(0, 26)) {
    light(t.x, t.y + 2, t.z, LightKind.Beacon, rng.float() * 6.28, 0, 0, 0);
    top = Math.max(top, t.y);
  }
  // Two aircraft crossing high up.
  for (let p = 0; p < 2; p++) light(0, rng.range(420, 600), 0, LightKind.Plane, rng.float() * 6.28, rng.range(0.004, 0.008), rng.range(900, 1600), p);
  // The hero: a comet with its trail (each point is the same path a little earlier).
  for (let i = 0; i < HERO_TRAIL; i++) light(cx, 0, cz, LightKind.Hero, i / HERO_TRAIL, seed % 997, 0, 0);

  return { boxes: new Float32Array(boxes), boxCount: boxes.length / BOX_FLOATS, lights: new Float32Array(lights), lightCount: lights.length / LIGHT_FLOATS, top };
}

/** Downtown: glass, dark steel, white modern, now and then sandstone. */
function pickTower(rng: Rng): number {
  const r = rng.float();
  return r < 0.38 ? 3 : r < 0.62 ? 4 : r < 0.82 ? 5 : 1;
}

/** Elsewhere: brick, sandstone, concrete. */
function pickLow(rng: Rng): number {
  const r = rng.float();
  return r < 0.42 ? 0 : r < 0.7 ? 1 : r < 0.9 ? 2 : 5;
}
