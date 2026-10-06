/**
 * Super speed autopilot: the runner looks ahead along where the player steers and, when that is
 * blocked (a wall, a car, a pole, a hole in the street), turns to the nearest clear heading on
 * the side it last turned to; when nothing ahead is clear it brakes so it can stop in time.
 *
 * Probes are the body's own collision test (Collision.collide) marched along a heading with a
 * slightly fatter cylinder: a contact that pushes the probe back against the heading blocks it,
 * one beside it (running along a facade) does not.
 */
import type { Collision } from '../world/Collision';

/** Headings tried when straight ahead is blocked (radians off the steered direction, one side). */
const FAN = [0.2, 0.4, 0.62, 0.85, 1.1, 1.4];

export interface SpeedSteer {
  /** Heading to run (unit, horizontal). */
  dx: number;
  dz: number;
  /** Highest speed (m/s) from which the runner can still stop before what is ahead. */
  max: number;
}

export class SpeedNav {
  /** Side of the last turn (+1 left, -1 right, 0 none): kept so the runner does not dither. */
  private side = 0;
  /** A turn found by the fan, reused for a few frames (the fan is the expensive part). */
  private hold = 0;
  private readonly out: SpeedSteer = { dx: 0, dz: 0, max: Infinity };
  private holdA = 0;

  /**
   * Steer the runner at (x, y, z), body height h and radius r (k = size factor), who wants to
   * run along the unit heading (wx, wz) and moves at speed v; decel = how hard it can brake (m/s²).
   */
  steer(c: Collision, x: number, y: number, z: number, h: number, r: number, k: number, wx: number, wz: number, v: number, decel: number, dt: number): SpeedSteer {
    const sk = Math.sqrt(k), o = this.out;
    // Look as far as it takes to stop from this speed, plus a margin.
    const L = Math.min(110 * sk, v * v / (2 * decel) + 5 * sk + v * 0.15);
    const margin = 3 * sk;
    const stop = (d: number) => Math.sqrt(2 * decel * Math.max(0, d - margin));
    const d0 = this.clear(c, x, y, z, h, r, sk, wx, wz, L);
    this.hold -= dt;
    if (d0 >= L) {
      this.hold = 0;
      this.side *= Math.max(0, 1 - dt * 2);
      if (Math.abs(this.side) < 0.05) this.side = 0;
      o.dx = wx; o.dz = wz; o.max = Infinity;
      return o;
    }
    let best = 0, bestD = d0;
    if (this.hold > 0) {
      best = this.holdA;
      bestD = this.clear(c, x, y, z, h, r, sk, ...rot(wx, wz, best), L);
      if (bestD < L * 0.6) this.hold = 0;
    }
    if (this.hold <= 0) {
      const first = this.side !== 0 ? Math.sign(this.side) : 1;
      search: for (const a of FAN) {
        for (const s of [first, -first]) {
          const d = this.clear(c, x, y, z, h, r, sk, ...rot(wx, wz, a * s), L);
          if (d > bestD + 0.5 * sk) { best = a * s; bestD = d; }
          if (d >= L) break search;
        }
      }
      this.holdA = best;
      this.hold = 0.12;
    }
    if (best !== 0) this.side = Math.sign(best);
    const [dx, dz] = rot(wx, wz, best);
    o.dx = dx; o.dz = dz;
    // Brake so the runner can stop before what is ahead: on the new heading, but while it turns
    // it still carries on along the old one (a sharp turn counts mostly the blocked way).
    const eff = d0 + (bestD - d0) * Math.max(0, Math.cos(best));
    o.max = Math.max(6 * sk, stop(eff));
    return o;
  }

  /**
   * Free run (m) along (dx, dz) up to L: the first contact that pushes the probe back (mostly
   * against the heading), or a hole in the street. The probe widens with distance (a cone), so
   * a few dozen steps reach far without stepping over a thin wall.
   */
  private clear(c: Collision, x: number, y: number, z: number, h: number, r: number, sk: number, dx: number, dz: number, L: number): number {
    const r0 = r + 0.45 * sk;
    const under = c.under;
    const street = !c.underground(x, y, z);
    // (The first probe is close: a wall the body already touches must not be stepped over.)
    let d = -r0, px = x, pz = z;
    while (d < L) {
      const pr = r0 + Math.max(0, d) * 0.03;
      d = Math.min(L, d + pr * 1.6);
      const qx = x + dx * d, qz = z + dz * d;
      const res = c.collide(qx, qz, y, h, pr, px, pz);
      if (res.hit) {
        const ex = res.x - qx, ez = res.z - qz, back = -(ex * dx + ez * dz);
        if (back > 0.05 * pr && back > 0.25 * Math.hypot(ex, ez)) return Math.max(0, d - pr);
      }
      if (street && under && under.inHole(qx, qz)) return Math.max(0, d - pr);
      px = qx; pz = qz;
    }
    return L;
  }
}

function rot(x: number, z: number, a: number): [number, number] {
  const c = Math.cos(a), s = Math.sin(a);
  // Positive a turns to the left of the heading (counter-clockwise seen from above, y up).
  return [x * c + z * s, -x * s + z * c];
}
