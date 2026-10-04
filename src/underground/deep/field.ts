/**
 * The deep realm's rock and air as one signed distance field (pure: used by the planner, the
 * mesher worker, collision and the slimes alike, so what is drawn is exactly what is walked on).
 *
 * Air is the smooth union of air shapes (caverns, galleries, shafts); rock shapes (terraced
 * floors, pillars, the helix ramp, bridges) are carved back out of it with a smooth subtraction,
 * and two octaves of 3D noise roughen every surface by the nearest shape's roughness.
 *
 *   sdf < 0  air (−sdf ≈ the distance to the nearest rock)
 *   sdf > 0  rock
 *
 * Queries for walkers: `floorAt` (sphere-traced down), `ceilingAt` (up), `contains` (air with a
 * margin, no climbing up steep faces, closed membranes are solid), `lineClear` (line of sight).
 */
import { Noise } from '../../core/noise';

export type PrimKind = 'ell' | 'cap' | 'cyl' | 'helix' | 'bowl' | 'box';

/**
 * A shape. Parameter layouts (`a`):
 *  - ell:   cx, cy, cz, rx, ry, rz, yaw, floorY (air only above it; −1e9: none)
 *  - cap:   ax, ay, az, bx, by, bz, ra, rb, flat (a flat floor `flat × r` below the axis; 0: round)
 *  - cyl:   cx, cz, y0, y1, r (vertical, flat caps)
 *  - helix: cx, cz, rc (centreline radius), hw (half width), thick, yTop0, slope (dy per m of arc), a0, len
 *  - bowl:  cx, cz, yaw, ru, rv, y0, q0 (start, share of the radius), steps, stepH, ramp (share of a step):
 *           rock below a terraced floor rising outwards (q = elliptical radius 0..1)
 *  - box:   cx, cy, cz, hx, hy, hz, yaw
 */
export interface Prim {
  t: PrimKind;
  rock: boolean;
  /** Smoothing against what came before (m). */
  k: number;
  /** Roughness (noise amplitude scale, 0 smooth … ~1.5 craggy). */
  n: number;
  a: number[];
  /** Region tag (lighting, ownership): 0 roads/colony side, 1 the Glow (Lumen), 2 the front, 3 the Deep (Murk). */
  reg: number;
}

/** A membrane across a passage: solid for walkers while closed. */
export interface Barrier { x: number; y: number; z: number; nx: number; nz: number; r: number; closed: boolean }

const CELL = 16;
/** Grid cells with no shape nearby: solid rock (every shape is listed in the cells round it, with a margin). */
const FAR = 50;

export class DeepField {
  readonly prims: Prim[];
  readonly bounds: [number, number, number, number, number, number];
  barriers: Barrier[] = [];
  private grid = new Map<number, number[]>();
  private noise: Noise;
  /** Last evaluated point's dominant shape (region / roughness lookups right after an sdf call). */
  lastPrim = -1;
  /** Evaluations (profiling). */
  evals = 0;

  constructor(prims: Prim[], seed: number) {
    this.prims = prims;
    this.noise = new Noise(seed ^ 0x5e1d);
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    prims.forEach((p, i) => {
      const b = primBounds(p);
      const m = p.k + 3.5;
      x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); z0 = Math.min(z0, b[2]);
      x1 = Math.max(x1, b[3]); y1 = Math.max(y1, b[4]); z1 = Math.max(z1, b[5]);
      for (let a = Math.floor((b[0] - m) / CELL); a <= Math.floor((b[3] + m) / CELL); a++) for (let c = Math.floor((b[2] - m) / CELL); c <= Math.floor((b[5] + m) / CELL); c++) {
        const key = (a + 32768) * 65536 + (c + 32768);
        let l = this.grid.get(key);
        if (!l) this.grid.set(key, (l = []));
        l.push(i);
      }
    });
    this.bounds = [x0, y0, z0, x1, y1, z1];
  }

  /** Inside the realm's bounding box (with a margin)? Cheap pre-test for every query. */
  near(x: number, y: number, z: number, m = 2): boolean {
    const b = this.bounds;
    return x > b[0] - m && x < b[3] + m && y > b[1] - m && y < b[4] + m && z > b[2] - m && z < b[5] + m;
  }

  /** Signed distance (m): < 0 air, > 0 rock. */
  sdf(x: number, y: number, z: number): number {
    this.evals++;
    const l = this.grid.get((Math.floor(x / CELL) + 32768) * 65536 + (Math.floor(z / CELL) + 32768));
    if (!l) { this.lastPrim = -1; return FAR; }
    let d = 1e5, best = -1, bd = Infinity, wsum = 0, nsum = 0;
    const P = this.prims;
    for (let i = 0; i < l.length; i++) {
      const p = P[l[i]];
      const e = primDist(p, x, y, z);
      // Rock is carved out of the air (smooth subtraction).
      d = p.rock ? smaxk(d, -e, p.k) : smink(d, e, p.k);
      const ae = Math.abs(e);
      if (ae < bd) { bd = ae; best = l[i]; }
      // Roughness: a smooth blend over the shapes near the point (a hard switch between shapes
      // would make the noise jump and raise phantom rock). Rock shapes count more (ramps,
      // terraces, bridges are walked on); floors stay gentle, walls and vaults rough.
      if (ae < 6) {
        let n = p.n;
        if (n > 0) {
          const fy = primFloor(p, x, y, z);
          if (fy > -1e8) { const t = Math.max(0, Math.min(1, (y - fy - 0.3) / 2.8)); n *= 0.12 + 0.88 * t * t * (3 - 2 * t); }
        }
        const w = (p.rock ? 4 : 1) / (ae * ae + 0.3);
        wsum += w; nsum += w * n;
      }
    }
    this.lastPrim = best;
    const n = wsum > 0 ? nsum / wsum : 0;
    if (n > 0 && d < 4 && d > -4) {
      const N = this.noise;
      d += n * (N.n3(x * 0.065, y * 0.08, z * 0.065) * 1.25 + N.n3(x * 0.21 + 17, y * 0.24, z * 0.21 - 9) * 0.35);
    }
    return d;
  }

  /** Region of the shape nearest the last evaluated point (call after sdf). */
  regionOfLast(): number { return this.lastPrim >= 0 ? this.prims[this.lastPrim].reg : 0; }

  air(x: number, y: number, z: number, margin = 0): boolean {
    return this.sdf(x, y, z) < -margin;
  }

  /** Unit normal of the surface near a point (gradient of the field, pointing into air). */
  normal(x: number, y: number, z: number, out: { x: number; y: number; z: number }, e = 0.35): { x: number; y: number; z: number } {
    // Tetrahedral differences (4 evaluations).
    const a = this.sdf(x + e, y - e, z - e), b = this.sdf(x - e, y - e, z + e), c = this.sdf(x - e, y + e, z - e), d = this.sdf(x + e, y + e, z + e);
    let nx = a - b - c + d, ny = -a - b + c + d, nz = -a + b - c + d;
    // The field grows into rock: the normal into the air is its negative gradient.
    nx = -nx; ny = -ny; nz = -nz;
    const L = Math.hypot(nx, ny, nz) || 1;
    out.x = nx / L; out.y = ny / L; out.z = nz / L;
    return out;
  }

  /**
   * Floor under a point: the first rock surface going down from (x, y, z) within `drop` m, or null
   * (inside rock, or nothing below in reach).
   */
  floorAt(x: number, y: number, z: number, drop = 80): number | null {
    let d = this.sdf(x, y, z);
    if (d >= 0) return null;
    let t = 0, prev = 0;
    for (let i = 0; i < 96; i++) {
      if (-d < 0.03) break;
      prev = t;
      t += Math.max(0.03, -d * 0.8);
      if (t > drop) return null;
      d = this.sdf(x, y - t, z);
      if (d >= 0) {
        // Overshot into rock: bisect back to the surface.
        let lo = prev, hi = t;
        for (let k = 0; k < 6; k++) { const m = (lo + hi) / 2; if (this.sdf(x, y - m, z) >= 0) hi = m; else lo = m; }
        return y - (lo + hi) / 2;
      }
    }
    return y - t;
  }

  /** Ceiling over a point: the first rock surface going up within `rise` m (Infinity: none; inside rock: y). */
  ceilingAt(x: number, y: number, z: number, rise = 90): number {
    let d = this.sdf(x, y, z);
    if (d >= 0) return y;
    let t = 0, prev = 0;
    for (let i = 0; i < 96; i++) {
      if (-d < 0.03) break;
      prev = t;
      t += Math.max(0.03, -d * 0.8);
      if (t > rise) return Infinity;
      d = this.sdf(x, y + t, z);
      if (d >= 0) {
        let lo = prev, hi = t;
        for (let k = 0; k < 6; k++) { const m = (lo + hi) / 2; if (this.sdf(x, y + m, z) >= 0) hi = m; else lo = m; }
        return y + (lo + hi) / 2;
      }
    }
    return y + t;
  }

  /**
   * A walker's probe (feet + 0.3) may stand here: in air (margin), not inside a closed membrane,
   * and not climbing a steep face (the floor under it is not more than a step above the feet
   * unless the slope is walkable).
   */
  contains(x: number, y: number, z: number, margin: number): boolean {
    if (this.sdf(x, y, z) >= -Math.max(0.02, margin)) return false;
    for (const b of this.barriers) {
      if (!b.closed) continue;
      const dx = x - b.x, dz = z - b.z;
      const along = dx * b.nx + dz * b.nz;
      if (Math.abs(along) < 0.35 && Math.hypot(dx - along * b.nx, y - b.y, dz - along * b.nz) < b.r) return false;
    }
    const f = this.floorAt(x, y, z, 1.2);
    if (f !== null && f > y - 0.22) {
      const n = this.normal(x, f + 0.05, z, _n);
      if (n.y < 0.5) return false;
    }
    return true;
  }

  /** Is the straight line a → b through air (pad m short of b)? */
  lineClear(ax: number, ay: number, az: number, bx: number, by: number, bz: number, pad = 0): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az, L = Math.hypot(dx, dy, dz);
    if (L < 1e-3) return true;
    const end = L - pad;
    let t = 0;
    for (let i = 0; i < 400 && t < end; i++) {
      const d = this.sdf(ax + (dx * t) / L, ay + (dy * t) / L, az + (dz * t) / L);
      if (d > 0.05) return false;
      t += Math.max(0.25, -d * 0.9);
    }
    return true;
  }

  /** First rock along a ray (unit d) within maxT, or Infinity. */
  ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
    let t = 0;
    let d = this.sdf(ox, oy, oz);
    if (d > 0) return 0;
    for (let i = 0; i < 300 && t < maxT; i++) {
      const step = Math.max(0.08, -d * 0.85);
      const t2 = t + step;
      d = this.sdf(ox + dx * t2, oy + dy * t2, oz + dz * t2);
      if (d > 0) {
        let lo = t, hi = t2;
        for (let k = 0; k < 6; k++) { const m = (lo + hi) / 2; if (this.sdf(ox + dx * m, oy + dy * m, oz + dz * m) > 0) hi = m; else lo = m; }
        return (lo + hi) / 2;
      }
      t = t2;
    }
    return Infinity;
  }
}

const _n = { x: 0, y: 0, z: 0 };

function smink(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b + (a - b) * h - k * h * (1 - h);
}

function smaxk(a: number, b: number, k: number): number {
  return -smink(-a, -b, k);
}

/** Distance to a shape's surface (negative inside it). */
export function primDist(p: Prim, x: number, y: number, z: number): number {
  const a = p.a;
  switch (p.t) {
    case 'ell': {
      const dx = x - a[0], dy = y - a[1], dz = z - a[2];
      const c = Math.cos(a[6]), s = Math.sin(a[6]);
      const u = dx * c + dz * s, v = -dx * s + dz * c;
      const k0 = Math.hypot(u / a[3], dy / a[4], v / a[5]);
      const k1 = Math.hypot(u / (a[3] * a[3]), dy / (a[4] * a[4]), v / (a[5] * a[5]));
      let d = k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(a[3], a[4], a[5]);
      if (a[7] > -1e8) d = Math.max(d, a[7] - y);
      return d;
    }
    case 'cap': {
      const bax = a[3] - a[0], bay = a[4] - a[1], baz = a[5] - a[2];
      const pax = x - a[0], pay = y - a[1], paz = z - a[2];
      const L2 = bax * bax + bay * bay + baz * baz;
      const h = L2 > 0 ? Math.max(0, Math.min(1, (pax * bax + pay * bay + paz * baz) / L2)) : 0;
      const r = a[6] + (a[7] - a[6]) * h;
      let d = Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - r;
      if (a[8] > 0) d = Math.max(d, a[1] + bay * h - r * a[8] - y);
      return d;
    }
    case 'cyl': {
      const dr = Math.hypot(x - a[0], z - a[1]) - a[4];
      const dy = Math.max(a[2] - y, y - a[3]);
      return Math.min(Math.max(dr, dy), 0) + Math.hypot(Math.max(dr, 0), Math.max(dy, 0));
    }
    case 'helix': {
      // cx, cz, rc, hw, thick, yTop0, slope, a0, len
      const dx = x - a[0], dz = z - a[1];
      const rr = Math.hypot(dx, dz);
      const rc = a[2], slope = a[6], len = a[8];
      const ang = Math.atan2(dz, dx);
      // Arc position of this angle on the winding whose top is nearest the point's height.
      const base = wrap(ang - a[7]) * rc;
      const turn = Math.PI * 2 * rc;
      let s = base, best = Infinity;
      for (let w = -1; w < Math.ceil(len / turn) + 1; w++) {
        const sw = base + w * turn;
        const sc = Math.max(0, Math.min(len, sw));
        const dyw = Math.abs(y - (a[5] + slope * sc));
        if (dyw + Math.abs(sw - sc) < best) { best = dyw + Math.abs(sw - sc); s = sw; }
      }
      const sc = Math.max(0, Math.min(len, s));
      const top = a[5] + slope * sc;
      const qr = Math.abs(rr - rc) - a[3];
      const qy = Math.abs(y - (top - a[4] / 2)) - a[4] / 2;
      const qs = Math.abs(s - sc);
      const ox = Math.max(qr, 0), oy = Math.max(qy, 0);
      return Math.min(Math.max(qr, qy, qs > 0 ? qs : -1e9), 0) + Math.hypot(ox, oy, qs);
    }
    case 'bowl': {
      // cx, cz, yaw, ru, rv, y0, q0, steps, stepH, ramp
      const dx = x - a[0], dz = z - a[1];
      const c = Math.cos(a[2]), s = Math.sin(a[2]);
      const u = dx * c + dz * s, v = -dx * s + dz * c;
      const q = Math.hypot(u / a[3], v / a[4]);
      let fl = a[5];
      if (q > a[6]) {
        const tt = ((q - a[6]) / (1 - a[6])) * a[7];
        const i = Math.floor(tt), f = tt - i;
        const r0 = 1 - a[9];
        const sm = f <= r0 ? 0 : ((f - r0) / a[9]) ** 2 * (3 - 2 * ((f - r0) / a[9]));
        fl += i >= a[7] ? a[8] * a[7] : a[8] * (i + sm);
      }
      // Rock below the floor (vertical distance, damped for slopes), a slab within the ellipse only.
      return Math.max((y - fl) * 0.75, a[5] - 6 - y, (q - 1.12) * Math.min(a[3], a[4]));
    }
    case 'box': {
      const dx = x - a[0], dy = y - a[1], dz = z - a[2];
      const c = Math.cos(a[6]), s = Math.sin(a[6]);
      const u = Math.abs(dx * c + dz * s) - a[3], v = Math.abs(-dx * s + dz * c) - a[5], w = Math.abs(dy) - a[4];
      return Math.min(Math.max(u, v, w), 0) + Math.hypot(Math.max(u, 0), Math.max(v, 0), Math.max(w, 0));
    }
  }
}

/** Height of a shape's floor under (x, z) (flat-floored caverns and galleries, shafts, terraces), or −1e9. */
export function primFloor(p: Prim, x: number, y: number, z: number): number {
  const a = p.a;
  switch (p.t) {
    case 'ell': return a[7];
    case 'cyl': return a[2];
    case 'cap': {
      if (a[8] <= 0) return -1e9;
      const bax = a[3] - a[0], baz = a[5] - a[2], L2 = bax * bax + baz * baz;
      const h = L2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * bax + (z - a[2]) * baz) / L2)) : 0;
      return a[1] + (a[4] - a[1]) * h - (a[6] + (a[7] - a[6]) * h) * a[8];
    }
    case 'bowl': return bowlFloor(a, x, z);
    case 'helix': return helixTop(a, x, y, z);
    default: return -1e9;
  }
}

/** Top of the helix ramp's winding nearest a point. */
function helixTop(a: number[], x: number, y: number, z: number): number {
  const rc = a[2], turn = Math.PI * 2 * rc, len = a[8];
  const base = wrap(Math.atan2(z - a[1], x - a[0]) - a[7]) * rc;
  let best = -1e9, bd = Infinity;
  for (let w = -1; w < Math.ceil(len / turn) + 1; w++) {
    const sc = Math.max(0, Math.min(len, base + w * turn));
    const top = a[5] + a[6] * sc;
    if (Math.abs(y - top) < bd) { bd = Math.abs(y - top); best = top; }
  }
  return best;
}

function bowlFloor(a: number[], x: number, z: number): number {
  const dx = x - a[0], dz = z - a[1];
  const c = Math.cos(a[2]), s = Math.sin(a[2]);
  const q = Math.hypot((dx * c + dz * s) / a[3], (-dx * s + dz * c) / a[4]);
  let fl = a[5];
  if (q > a[6]) {
    const tt = ((q - a[6]) / (1 - a[6])) * a[7];
    const i = Math.floor(tt), f = tt - i, r0 = 1 - a[9];
    const w = f <= r0 ? 0 : (f - r0) / a[9];
    fl += i >= a[7] ? a[8] * a[7] : a[8] * (i + w * w * (3 - 2 * w));
  }
  return fl;
}

function wrap(a: number): number {
  const t = Math.PI * 2;
  return ((a % t) + t) % t;
}

/** Axis-aligned bounds of a shape [x0, y0, z0, x1, y1, z1]. */
export function primBounds(p: Prim): [number, number, number, number, number, number] {
  const a = p.a;
  switch (p.t) {
    case 'ell': { const r = Math.max(a[3], a[5]); return [a[0] - r, a[1] - a[4], a[2] - r, a[0] + r, a[1] + a[4], a[2] + r]; }
    case 'cap': { const r = Math.max(a[6], a[7]); return [Math.min(a[0], a[3]) - r, Math.min(a[1], a[4]) - r, Math.min(a[2], a[5]) - r, Math.max(a[0], a[3]) + r, Math.max(a[1], a[4]) + r, Math.max(a[2], a[5]) + r]; }
    case 'cyl': return [a[0] - a[4], a[2], a[1] - a[4], a[0] + a[4], a[3], a[1] + a[4]];
    case 'helix': { const r = a[2] + a[3]; const yb = a[5] + a[6] * a[8]; return [a[0] - r, Math.min(a[5], yb) - a[4], a[1] - r, a[0] + r, Math.max(a[5], yb), a[1] + r]; }
    case 'bowl': { const r = Math.max(a[3], a[4]); return [a[0] - r, a[5] - 4, a[1] - r, a[0] + r, a[5] + a[8] * (a[7] + 2) + 1, a[1] + r]; }
    case 'box': { const r = Math.hypot(a[3], a[5]); return [a[0] - r, a[1] - a[4], a[2] - r, a[0] + r, a[1] + a[4], a[2] + r]; }
  }
}
