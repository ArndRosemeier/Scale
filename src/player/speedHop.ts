/**
 * Super speed hops: a runner who would plough into someone (or a car, a bench) a little ahead
 * hops over them instead, when the arc is clear and the landing spot is free. Otherwise the
 * runner brushes past as before (game/Game.dashSweep: a stumble and a stern word, no reputation).
 *
 * The hop is a short, flat arc under a stronger pull than gravity (a deliberate, snappy hurdle,
 * not a float): it starts at the distance where the lowest arc clears what is ahead, takes in
 * everything else low enough that lies under it, and is refused when anything tall (a wall, a
 * bus, a tree) is in the way of the arc or the landing is not on about the same level.
 */
import type { Collision, Obstacle, ObstacleProvider } from '../world/Collision';

export const HOP = {
  /** The hop's pull, × g (a hurdle at 50 m/s carries ~35 m instead of ~110 m). */
  gMul: 3,
  /** Highest thing hopped over, above the feet (m at 1.8 m, × √k): people, cars, vans, benches. */
  maxTop: 2.6,
  /** Room above what is hopped over (m, × √k). */
  clear: 0.3,
  /** Slowest run that hops (m/s at 1.8 m, × √k); slower runners walk around like anyone. */
  minSpeed: 8,
  /** Free room around the landing spot (m, × √k, on top of the body's radius). */
  landFree: 0.9,
};

export interface HopPlan {
  /** Take-off speed upwards (m/s) and the pull while in the air (m/s²). */
  vy: number;
  g: number;
  /** Ground distance to the landing spot (m). */
  range: number;
}

interface Ahead { s0: number; s1: number; top: number }

const tmp: Ahead[] = [];

/**
 * Plan a hop for a runner with feet at (x, y, z), body height h and radius r (k = size factor),
 * running along the unit heading (dx, dz) at v m/s. `people` gives the people around as upright
 * cylinders (they are not in the collision). Null: no hop now (nothing ahead, not yet in reach,
 * too late, too tall, or the arc or the landing is not clear).
 */
export function planHop(c: Collision, people: ObstacleProvider | null, x: number, y: number, z: number, h: number, r: number, k: number, dx: number, dz: number, v: number): HopPlan | null {
  const sk = Math.sqrt(k);
  if (v < HOP.minSpeed * sk) return null;
  if (c.underground(x, y, z)) return null;
  const G = 9.81 * HOP.gMul * Math.max(1, sk);
  const step = Math.max(0.35, h * 0.28);
  const maxTop = HOP.maxTop * sk, clear = HOP.clear * sk;
  // The farthest a hop would start before what it clears (the lowest arc over the tallest thing).
  const reach = v * Math.sqrt((2 * (maxTop + clear)) / G) + r + 1;
  // What lies ahead, low enough to hop over, along the corridor the body sweeps.
  const L = reach + 2 * v * Math.sqrt((2 * (maxTop + clear)) / G) + 8;
  // (As wide as the runner brushes people aside: Game.dashSweep's reach, less a person's radius.)
  const half = r + 0.25 * h - 0.1;
  const x1 = x + dx * L, z1 = z + dz * L;
  const box = [Math.min(x, x1) - 4, Math.min(z, z1) - 4, Math.max(x, x1) + 4, Math.max(z, z1) + 4] as const;
  tmp.length = 0;
  const take = (o: Obstacle) => {
    if (o.y0 > y + h) return; // overhead
    const top = o.y1 - y;
    if (top < step) return; // stepped over anyway
    // Extent along the heading and distance across it.
    const ox = o.x - x, oz = o.z - z;
    const along = ox * dx + oz * dz, across = Math.abs(-ox * dz + oz * dx);
    let ea: number, ec: number;
    if (o.cyl) { ea = ec = o.r; }
    else {
      const cu = Math.abs(o.ux * dx + o.uz * dz), cw = Math.abs(-o.uz * dx + o.ux * dz);
      ea = o.hx * cu + o.hz * cw;
      ec = o.hx * cw + o.hz * cu;
    }
    if (across - ec > half || along + ea < 0) return;
    // Something tall in the corridor: the hop must land before it (see the arc check below).
    tmp.push({ s0: along - ea - r, s1: along + ea + r, top: top > maxTop ? Infinity : top });
  };
  for (const prov of c.obstacleProviders) prov(box[0], box[1], box[2], box[3], take);
  people?.(box[0], box[1], box[2], box[3], take);
  if (!tmp.length) return null;
  tmp.sort((a, b) => a.s0 - b.s0);
  const first = tmp[0];
  if (first.top === Infinity) return null; // a wall first: the autopilot's business
  // Not yet: wait until the lowest arc over it starts here. Too late: already on it.
  const H0 = first.top + clear;
  if (first.s0 > v * Math.sqrt((2 * H0) / G) + v * 0.04) return null;
  if (first.s0 < 0.1) return null;
  // Take-off speed clearing every point (s, H) of what lies under the arc: vy ≥ H·v/s + G·s/(2v).
  const need = (s: number, H: number) => (H * v) / Math.max(0.05, s) + (G * s) / (2 * v);
  let vy = 0, range = 0;
  for (let it = 0; it < 4; it++) {
    let want = 0;
    for (const a of tmp) {
      if (a !== first && a.s0 > range) break;
      if (a.top === Infinity) return null; // something tall under the arc
      want = Math.max(want, need(a.s0, a.top + clear), need(a.s1, a.top + clear));
    }
    vy = want;
    const nr = (2 * vy * v) / G;
    if (nr <= range + 0.01) break;
    range = nr;
  }
  range = (2 * vy * v) / G;
  if (vy > Math.sqrt(2 * G * (maxTop + clear)) * 1.25) return null;
  // Nothing low may sit where the feet come down (the landing and the stride after it).
  const free = r + HOP.landFree * sk;
  for (const a of tmp) if (a.s1 > range - free && a.s0 < range + free + v * 0.15) return null;
  // The arc itself: nothing tall in the way (a wall, a bus, a lamp post), nothing over the head.
  const n = Math.max(4, Math.ceil(range / Math.max(0.6, r * 1.5)));
  let px = x, pz = z;
  for (let i = 1; i <= n; i++) {
    const s = (range * i) / n, t = s / v;
    const qy = y + vy * t - 0.5 * G * t * t;
    const qx = x + dx * s, qz = z + dz * s;
    const res = c.collide(qx, qz, Math.max(y, qy), h, r, px, pz);
    if (res.hit) return null;
    if (c.ceilingAt(qx, qz, qy) < qy + h + 0.2) return null;
    px = qx; pz = qz;
  }
  // The landing: on about the same level (not off a bridge, into a hole or onto a roof).
  const lx = x + dx * range, lz = z + dz * range;
  const g = c.groundAt(lx, lz, y + step, step);
  if (g < y - 1.5 * sk || g > y + step) return null;
  if (c.under?.inHole(lx, lz)) return null;
  return { vy, g: G, range };
}
