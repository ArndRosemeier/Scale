/**
 * Line of sight: the one rule for everybody who shoots or fires a directed attack — police and
 * SWAT, armed criminals, the army's direct fire (rifles, autocannons, tanks, helicopter rockets),
 * officers against the Strider, and the player's directed powers (laser eyes, fire wave, chain
 * lightning, whirlwind on a target, hydrokinesis, the shrink ray).
 *
 * A line from a to b (ending `pad` m short of b: the target's own body) is blocked by
 *   - buildings: the prism of a footprint between its low and top; with `panel` (the game: the
 *     building's standing facade panels) a hole blasted in a wall lets the line through;
 *   - the landmarks' solid parts (town hall, stadium, attractions);
 *   - terrain (hills, embankments);
 *   - vehicles, parked and moving, wrecks too (oriented boxes, by kind: a bus stands 3.1 m, a
 *     sedan 1.5 m — a round at chest height over a car does not pass, one up at a drone does).
 * People never block a line: who stands in the way is the shooters' business (officers hold fire,
 * Firearms.clear); props are left out (street furniture is thin).
 *
 * The rules built on it (shot.ts): a targeted attack fires only with a clear line and then always
 * hits; an untargeted one goes along its ray and hits whatever is there.
 *
 * Pure (no three.js, no game): the world comes in through `LosWorld` (tests use boxes). Cost: a
 * march of 1.2 m steps against the building grid (terrain every 3rd step), cars from a grid round
 * the segment, results cached for a moment per quantised segment (512 slots, no allocation).
 */

export interface LosBuilding {
  readonly low: number; readonly top: number;
  /** Its ground floor (on a slope the footprint reaches down to `low`: the plinth below is solid). */
  readonly base?: number;
}

export interface LosCar {
  readonly x: number; readonly y: number; readonly z: number; readonly yaw: number;
  readonly length: number; readonly width: number;
  readonly kind: string;
  /** Traffic VState (5 crushed: a flat wreck). */
  readonly state: number;
  readonly alive: boolean;
}

export interface LosWorld {
  /** The building whose footprint holds (x, z), or null. */
  building(x: number, z: number): LosBuilding | null;
  /** Ground height at (x, z). */
  ground(x: number, z: number): number;
  /**
   * The first standing wall panel of a building along a ray (o, unit d) from tMin to maxT: its
   * distance, or Infinity (none: a hole lets the line through). Optional (tests: solid prisms).
   */
  panel?(b: LosBuilding, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMin: number, maxT: number): number;
  /** Other solid structure at a point (the landmarks: town hall, stadium, attractions). Optional. */
  solid?(x: number, y: number, z: number): boolean;
  /** Vehicles near the box x0..x1, z0..z1 (written to `out` from 0; the count is returned). */
  cars(x0: number, z0: number, x1: number, z1: number, out: LosCar[]): number;
}

export type LosBlock = 'building' | 'terrain' | 'car' | null;

export const LOS = {
  /** March step (m) and how often the terrain is sampled (every n-th step). */
  step: 1.2, terrainEvery: 3,
  /** Default: the line ends this far short of the target point (its body). */
  pad: 0.6,
  /** A grazing tolerance under the terrain (m). */
  groundTol: 0.3,
  /** Seconds a result is reused for the same (quantised) segment; 0: no cache. */
  cacheT: 0.2,
};

/** Height of a vehicle's body by kind (VehicleObstacles' table): what a line has to clear. */
export function carHeight(kind: string, state: number): number {
  if (state === 5) return 0.5;
  switch (kind) {
    case 'bus': case 'truck': case 'army_truck': return 3.1;
    case 'apc': case 'tank': case 'van': case 'delivery': case 'shuttle': return 2.5;
    case 'suv': case 'pickup': return 1.85;
    default: return 1.5;
  }
}

/**
 * Segment (o + u·t, t in [t0, t1], u unit) against an oriented box (centre cx, cz, yaw with forward
 * (−sin, −cos), half length hl / width hw, y0..y1): entry t, or Infinity.
 */
export function segBox(ox: number, oy: number, oz: number, ux: number, uy: number, uz: number, cx: number, cz: number, yaw: number, hl: number, hw: number, y0: number, y1: number, t0: number, t1: number): number {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const lx = ox - cx, lz = oz - cz;
  const ou = lx * fx + lz * fz, ow = -lx * fz + lz * fx;
  const du = ux * fx + uz * fz, dw = -ux * fz + uz * fx;
  // Three slabs (along, across, up), inline (no closures).
  if (Math.abs(du) < 1e-9) { if (ou < -hl || ou > hl) return Infinity; }
  else { let a = (-hl - ou) / du, b = (hl - ou) / du; if (a > b) { const k = a; a = b; b = k; } if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) return Infinity; }
  if (Math.abs(dw) < 1e-9) { if (ow < -hw || ow > hw) return Infinity; }
  else { let a = (-hw - ow) / dw, b = (hw - ow) / dw; if (a > b) { const k = a; a = b; b = k; } if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) return Infinity; }
  if (Math.abs(uy) < 1e-9) { if (oy < y0 || oy > y1) return Infinity; }
  else { let a = (y0 - oy) / uy, b = (y1 - oy) / uy; if (a > b) { const k = a; a = b; b = k; } if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) return Infinity; }
  return t0;
}

/** Is (x, y, z) inside a car's box (a shooter in it, a target that is the car)? */
function inBox(c: LosCar, x: number, y: number, z: number, h: number): boolean {
  const fx = -Math.sin(c.yaw), fz = -Math.cos(c.yaw), lx = x - c.x, lz = z - c.z;
  return Math.abs(lx * fx + lz * fz) <= c.length / 2 + 0.05 && Math.abs(-lx * fz + lz * fx) <= c.width / 2 + 0.05 && y >= c.y - 0.2 && y <= c.y + h + 0.05;
}

const CACHE = 512;

export class LineOfSight {
  /** What blocked the last line (null: clear) and where (m from a). */
  last: LosBlock = null;
  lastT = Infinity;
  stats = { rays: 0, cached: 0, blocked: 0, byBuilding: 0, byTerrain: 0, byCar: 0, holes: 0, ms: 0, raysPerS: 0, msPerS: 0, cachedPerS: 0 };
  private carBuf: LosCar[] = [];
  private ck = new Int32Array(CACHE);
  private cAt = new Float64Array(CACHE).fill(-1e9);
  private cT = new Float64Array(CACHE);
  private cBy = new Uint8Array(CACHE);
  private secT = 0;
  private secRays = 0;
  private secMs = 0;
  private secCached = 0;

  /** `clock`: seconds (the cache's time base). */
  constructor(private w: LosWorld, private clock: () => number = () => performance.now() / 1000) {}

  /** A clear line from a to b (ending `pad` short of b)? `skip`, `skip2`: vehicles that do not count (the shooter's car, the target car). */
  clear(ax: number, ay: number, az: number, bx: number, by: number, bz: number, pad = LOS.pad, skip: object | null = null, skip2: object | null = null): boolean {
    return this.block(ax, ay, az, bx, by, bz, pad, skip, skip2) === Infinity;
  }

  /** Distance from a to the first thing in the line (Infinity: clear); `last` says what. */
  block(ax: number, ay: number, az: number, bx: number, by: number, bz: number, pad = LOS.pad, skip: object | null = null, skip2: object | null = null): number {
    const now = this.clock();
    // Cache: the segment quantised to 0.5 m (and the pad to 0.25 m); a direct-mapped slot.
    let key = 0;
    if (LOS.cacheT > 0) {
      key = hashSeg(ax, ay, az, bx, by, bz, pad);
      const i = key & (CACHE - 1);
      if (this.ck[i] === key && now - this.cAt[i] < LOS.cacheT) {
        this.stats.cached++;
        this.secCached++;
        this.last = BY[this.cBy[i]];
        this.lastT = this.cT[i];
        return this.lastT;
      }
    }
    const t0 = performance.now();
    const t = this.trace(ax, ay, az, bx, by, bz, pad, skip, skip2);
    const ms = performance.now() - t0;
    this.stats.rays++;
    this.stats.ms += ms;
    this.secRays++;
    this.secMs += ms;
    if (t !== Infinity) {
      this.stats.blocked++;
      if (this.last === 'building') this.stats.byBuilding++; else if (this.last === 'terrain') this.stats.byTerrain++; else this.stats.byCar++;
    }
    if (LOS.cacheT > 0) {
      const i = key & (CACHE - 1);
      this.ck[i] = key; this.cAt[i] = now; this.cT[i] = t; this.cBy[i] = BY.indexOf(this.last);
    }
    // Per-second figures (dev panel, the report).
    if (now - this.secT >= 1) {
      const span = Math.max(1, now - this.secT);
      this.stats.raysPerS = Math.round(this.secRays / span);
      this.stats.msPerS = +(this.secMs / span).toFixed(3);
      this.stats.cachedPerS = Math.round(this.secCached / span);
      this.secT = now; this.secRays = 0; this.secMs = 0; this.secCached = 0;
    }
    return t;
  }

  /** The uncached test. */
  private trace(ax: number, ay: number, az: number, bx: number, by: number, bz: number, pad: number, skip: object | null, skip2: object | null): number {
    const W = this.w;
    this.last = null;
    this.lastT = Infinity;
    const dx = bx - ax, dy = by - ay, dz = bz - az, L = Math.hypot(dx, dy, dz);
    const end = L - pad;
    if (end <= 0.3) return Infinity;
    const ux = dx / L, uy = dy / L, uz = dz / L;
    // ---- the world: buildings (holes let it through) and terrain
    const step = LOS.step, n = Math.ceil(end / step);
    let wall = Infinity, by_: LosBlock = null;
    let lastB: LosBuilding | null = null;
    for (let i = 1; i <= n; i++) {
      const t = Math.min(end, i * step);
      const x = ax + ux * t, y = ay + uy * t, z = az + uz * t;
      const b = W.building(x, z);
      if (b && b !== lastB && y < b.top && y > b.low) {
        if (!W.panel) { wall = t; by_ = 'building'; break; }
        lastB = b;
        const tp = W.panel(b, ax, ay, az, ux, uy, uz, Math.max(0, t - step * 2), end);
        if (tp < end) { wall = tp; by_ = 'building'; break; }
        // No standing panel in the way: over the walls is the roof, under the ground floor the
        // plinth (a slope), else a hole lets it in.
        if (y >= b.top - 0.6 || y < (b.base ?? b.low) + 0.2) { wall = t; by_ = 'building'; break; }
        this.stats.holes++;
      }
      if (W.solid?.(x, y, z)) { wall = t; by_ = 'building'; break; }
      if ((i % LOS.terrainEvery === 0 || i === n) && y < W.ground(x, z) - LOS.groundTol) { wall = t; by_ = 'terrain'; break; }
    }
    // ---- vehicles up to the wall (or the end)
    const reach = Math.min(wall, end);
    const ex = ax + ux * reach, ez = az + uz * reach;
    const cars = this.carBuf;
    const nc = W.cars(Math.min(ax, ex) - 4, Math.min(az, ez) - 4, Math.max(ax, ex) + 4, Math.max(az, ez) + 4, cars);
    let best = reach, hitCar = false;
    for (let k = 0; k < nc; k++) {
      const c = cars[k];
      if (!c.alive || c === skip || c === skip2) continue;
      const h = carHeight(c.kind, c.state);
      // A shooter in the car, or a target that is the car: it does not hide itself.
      if (inBox(c, ax, ay, az, h) || inBox(c, bx, by, bz, h)) continue;
      const t = segBox(ax, ay, az, ux, uy, uz, c.x, c.z, c.yaw, c.length / 2, c.width / 2, c.y - 0.2, c.y + h, 0.2, best);
      if (t < best) { best = t; hitCar = true; }
    }
    for (let k = 0; k < nc; k++) cars[k] = NONE;
    if (hitCar) { this.last = 'car'; this.lastT = best; return best; }
    if (wall !== Infinity) { this.last = by_; this.lastT = wall; return wall; }
    return Infinity;
  }
}

const BY: LosBlock[] = [null, 'building', 'terrain', 'car'];
const NONE: LosCar = { x: 0, y: 0, z: 0, yaw: 0, length: 0, width: 0, kind: '', state: 0, alive: false };

function hashSeg(ax: number, ay: number, az: number, bx: number, by: number, bz: number, pad: number): number {
  let h = 2166136261;
  h = Math.imul(h ^ Math.round(ax * 2), 16777619);
  h = Math.imul(h ^ Math.round(ay * 2), 16777619);
  h = Math.imul(h ^ Math.round(az * 2), 16777619);
  h = Math.imul(h ^ Math.round(bx * 2), 16777619);
  h = Math.imul(h ^ Math.round(by * 2), 16777619);
  h = Math.imul(h ^ Math.round(bz * 2), 16777619);
  h = Math.imul(h ^ Math.round(pad * 4), 16777619);
  return h | 0;
}
