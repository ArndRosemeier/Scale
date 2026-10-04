/**
 * What a shot (a round, a directed power) does — the rules on top of the line of sight (los.ts):
 *
 *  - Targeted (the player's Tab / click target; an NPC's chosen target): out of reach or without a
 *    clear line it does not fire at all (`why`: 'range' / 'sight' — the player is told, nothing is
 *    spent); with a clear line it always hits the target (people in between are not hit: a shooter
 *    with a target picks the moment — NPCs also hold fire while someone is in the line).
 *  - Untargeted (the player aiming freely): it goes out along its ray and hits whatever is there
 *    first — a bystander, a car, a drone, a facade, the ground; it can "miss" only in the sense
 *    that what it meets is not what was meant.
 *
 * Pure (tests in tools/selftest.ts); the game passes the shared LineOfSight and Targeting.probe.
 */

/** The line-of-sight test a shot needs (LineOfSight.clear). */
export interface ShotSight {
  clear(ax: number, ay: number, az: number, bx: number, by: number, bz: number, pad?: number, skip?: object | null, skip2?: object | null): boolean;
}

/** The first body or surface along a ray (o, unit d) within maxT: distance (Infinity: nothing) and the body (null: a surface). */
export interface ShotTrace<B> {
  trace(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): { t: number; body: B | null };
}

export interface ShotTarget<B> {
  body: B;
  /** The point aimed at, and how far short of it the line may end (its body's radius). */
  x: number; y: number; z: number;
  pad: number;
  /** A vehicle that is the target (it does not block the line to itself). */
  car?: object | null;
}

export interface ShotResult<B> {
  fired: boolean;
  /** Why it did not fire. */
  why: 'sight' | 'range' | null;
  /** What it hit (null: a surface, or nothing within range) and where (t along the unit direction). */
  body: B | null;
  t: number;
  dx: number; dy: number; dz: number;
}

export function newShot<B>(): ShotResult<B> {
  return { fired: false, why: null, body: null, t: 0, dx: 0, dy: 0, dz: 1 };
}

/**
 * Resolve one shot from o: at `target` (targeted) or along the unit direction `aim` (untargeted),
 * within `range`. `shooterCar`: the vehicle the shooter is in / beside (never in its own way).
 */
export function resolveShot<B>(sight: ShotSight, tr: ShotTrace<B>, ox: number, oy: number, oz: number, target: ShotTarget<B> | null, ax: number, ay: number, az: number, range: number, out: ShotResult<B>, shooterCar: object | null = null): ShotResult<B> {
  out.why = null; out.body = null;
  if (target) {
    const dx = target.x - ox, dy = target.y - oy, dz = target.z - oz, L = Math.hypot(dx, dy, dz) || 1e-6;
    out.dx = dx / L; out.dy = dy / L; out.dz = dz / L;
    if (L - target.pad > range) { out.fired = false; out.why = 'range'; out.t = 0; return out; }
    if (!sight.clear(ox, oy, oz, target.x, target.y, target.z, target.pad, target.car ?? null, shooterCar)) { out.fired = false; out.why = 'sight'; out.t = 0; return out; }
    out.fired = true; out.body = target.body; out.t = Math.max(0.1, L - target.pad);
    return out;
  }
  out.dx = ax; out.dy = ay; out.dz = az;
  const h = tr.trace(ox, oy, oz, ax, ay, az, range);
  out.fired = true;
  out.body = h.body;
  out.t = h.t === Infinity ? range : h.t;
  return out;
}
