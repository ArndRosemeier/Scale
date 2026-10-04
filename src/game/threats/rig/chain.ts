/**
 * Pure rig math for segmented creatures (THREATS_PLAN §4.3): no three.js, headless-testable.
 *
 *  - Chains are flat Float64Arrays of joints (x, y, z per joint) with fixed segment lengths.
 *  - `follow`: follow-the-leader — joint 0 has been moved; every next joint is pulled along the
 *    line to where it was, so a body bends along the path its head took (spines, tails, tentacles).
 *  - `reach`: FABRIK — the tip goes to a target while the root stays put (necks aiming the head).
 *  - `twoBone`: analytic two-bone IK with a pole (legs): the knee for a hip and a foot.
 */

/** Joint i of a chain. */
export function jx(c: Float64Array, i: number): number { return c[i * 3]; }
export function jy(c: Float64Array, i: number): number { return c[i * 3 + 1]; }
export function jz(c: Float64Array, i: number): number { return c[i * 3 + 2]; }

export function setJoint(c: Float64Array, i: number, x: number, y: number, z: number): void {
  c[i * 3] = x; c[i * 3 + 1] = y; c[i * 3 + 2] = z;
}

/** Lay a chain out straight from joint 0 along a direction (unit), with the given segment lengths. */
export function layStraight(c: Float64Array, lens: ArrayLike<number>, x: number, y: number, z: number, dx: number, dy: number, dz: number): void {
  setJoint(c, 0, x, y, z);
  for (let i = 0; i < lens.length; i++) setJoint(c, i + 1, c[i * 3] + dx * lens[i], c[i * 3 + 1] + dy * lens[i], c[i * 3 + 2] + dz * lens[i]);
}

/**
 * Follow the leader: joint 0 is where it should be; every following joint moves straight towards
 * its predecessor until the segment has its length again (it keeps the side it was on). `sag` pulls
 * each joint down by that many metres before the constraint (a tail's weight); `floor(x, z)` keeps
 * joints above a height.
 */
export function follow(c: Float64Array, lens: ArrayLike<number>, sag = 0, floor?: (x: number, z: number) => number): void {
  for (let i = 0; i < lens.length; i++) {
    const a = i * 3, b = a + 3;
    let x = c[b], y = c[b + 1] - sag, z = c[b + 2];
    if (floor) { const f = floor(x, z); if (y < f) y = f; }
    const dx = x - c[a], dy = y - c[a + 1], dz = z - c[a + 2];
    const d = Math.hypot(dx, dy, dz);
    const k = d > 1e-9 ? lens[i] / d : 0;
    if (k === 0) { c[b] = c[a]; c[b + 1] = c[a + 1] - lens[i]; c[b + 2] = c[a + 2]; continue; }
    c[b] = c[a] + dx * k; c[b + 1] = c[a + 1] + dy * k; c[b + 2] = c[a + 2] + dz * k;
  }
}

/**
 * FABRIK: move the chain's tip towards (tx, ty, tz) keeping joint 0 fixed and every segment's length.
 * A target out of reach stretches the chain straight towards it. Returns the tip's remaining distance.
 */
export function reach(c: Float64Array, lens: ArrayLike<number>, tx: number, ty: number, tz: number, iters = 4): number {
  const n = lens.length;
  const rx = c[0], ry = c[1], rz = c[2];
  let total = 0;
  for (let i = 0; i < n; i++) total += lens[i];
  const dT = Math.hypot(tx - rx, ty - ry, tz - rz);
  if (dT >= total) {
    const ux = (tx - rx) / (dT || 1), uy = (ty - ry) / (dT || 1), uz = (tz - rz) / (dT || 1);
    layStraight(c, lens, rx, ry, rz, ux, uy, uz);
    return dT - total;
  }
  for (let it = 0; it < iters; it++) {
    // Backward: tip on the target, pull towards the root.
    setJoint(c, n, tx, ty, tz);
    for (let i = n - 1; i >= 0; i--) pull(c, i + 1, i, lens[i]);
    // Forward: root back in place, pull towards the tip.
    setJoint(c, 0, rx, ry, rz);
    for (let i = 0; i < n; i++) pull(c, i, i + 1, lens[i]);
  }
  return Math.hypot(c[n * 3] - tx, c[n * 3 + 1] - ty, c[n * 3 + 2] - tz);
}

/** Put joint `b` at distance `len` from joint `a` along the line a → b. */
function pull(c: Float64Array, a: number, b: number, len: number): void {
  const ax = c[a * 3], ay = c[a * 3 + 1], az = c[a * 3 + 2];
  const dx = c[b * 3] - ax, dy = c[b * 3 + 1] - ay, dz = c[b * 3 + 2] - az;
  const d = Math.hypot(dx, dy, dz) || 1e-9;
  const k = len / d;
  c[b * 3] = ax + dx * k; c[b * 3 + 1] = ay + dy * k; c[b * 3 + 2] = az + dz * k;
}

export interface Vec3 { x: number; y: number; z: number }

/**
 * Two-bone IK: the knee for a hip at h and a foot target at f, bone lengths a (upper) and b (lower);
 * the knee bends towards the pole direction (p, need not be unit or perpendicular). When the target
 * is out of reach the leg straightens towards it; too close, it folds to the shortest reach. Writes
 * the knee and the reached foot (equal to f when reachable). Returns true if f was reachable.
 */
export function twoBone(h: Vec3, f: Vec3, a: number, b: number, p: Vec3, knee: Vec3, foot: Vec3): boolean {
  let dx = f.x - h.x, dy = f.y - h.y, dz = f.z - h.z;
  let d = Math.hypot(dx, dy, dz);
  if (d < 1e-6) { dx = 0; dy = -1; dz = 0; d = 1e-6; }
  const ux = dx / d, uy = dy / d, uz = dz / d;
  const dMax = a + b - 1e-6, dMin = Math.abs(a - b) + 1e-6;
  const ok = d <= dMax && d >= dMin;
  const dc = Math.min(dMax, Math.max(dMin, d));
  // Pole made perpendicular to the hip–foot axis.
  const pd = p.x * ux + p.y * uy + p.z * uz;
  let px = p.x - ux * pd, py = p.y - uy * pd, pz = p.z - uz * pd;
  let pl = Math.hypot(px, py, pz);
  if (pl < 1e-6) {
    // Pole along the axis: any perpendicular.
    px = -uz; py = 0; pz = ux; pl = Math.hypot(px, pz);
    if (pl < 1e-6) { px = 1; py = 0; pz = 0; pl = 1; }
  }
  px /= pl; py /= pl; pz /= pl;
  // Law of cosines: distance along the axis to the knee's foot point, and its height off the axis.
  const along = (a * a - b * b + dc * dc) / (2 * dc);
  const off = Math.sqrt(Math.max(0, a * a - along * along));
  knee.x = h.x + ux * along + px * off; knee.y = h.y + uy * along + py * off; knee.z = h.z + uz * along + pz * off;
  foot.x = h.x + ux * dc; foot.y = h.y + uy * dc; foot.z = h.z + uz * dc;
  return ok;
}

/** Segment lengths of a chain as it is now (tests). */
export function lengths(c: Float64Array): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < c.length / 3; i++) out.push(Math.hypot(c[i * 3 + 3] - c[i * 3], c[i * 3 + 4] - c[i * 3 + 1], c[i * 3 + 5] - c[i * 3 + 2]));
  return out;
}

/** Smooth 0..1 step. */
export function smooth01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/**
 * Gait phase of a leg: is it in the air (swing) at global phase `phase` with offset `off` and the
 * share `swing` of the cycle in the air? Returns the swing progress 0..1, or −1 when planted.
 */
export function swingOf(phase: number, off: number, swing: number): number {
  const p = phase + off;
  const q = p - Math.floor(p);
  return q < swing ? q / swing : -1;
}
