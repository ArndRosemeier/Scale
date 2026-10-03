/**
 * Body collision against the destructible city: buildings are thin wall
 * panels (per floor) and floor slabs, so bodies can enter through holes or
 * doors, stand on intact floors inside, on roofs, rubble, bridges and streets.
 */
import type { WorldIndex, BuildingRef } from './WorldIndex';
import type { Destruction } from '../destruction/Destruction';
import type { CityStreamer } from '../stream/CityStreamer';
import { gridCell } from '../build/buildingLayout';
import { pointInPoly } from '../core/geom2';

/**
 * A solid street object for the player: a vertical cylinder (trees, poles, bins) or an
 * oriented box (cars, benches, bus shelters), standing from y0 to y1.
 */
export interface Obstacle {
  cyl: boolean;
  x: number; z: number;
  /** Cylinder radius. */
  r: number;
  /** Box half extents along (ux, uz) and across it. */
  hx: number; hz: number;
  ux: number; uz: number;
  y0: number; y1: number;
}

/** Fills obstacles overlapping the box (x0,z0)-(x1,z1); `out` may reuse its argument. */
export type ObstacleProvider = (x0: number, z0: number, x1: number, z1: number, out: (o: Obstacle) => void) => void;

export interface CollideResult {
  x: number;
  z: number;
  /** Contact normal of the strongest contact (or null). */
  nx: number;
  nz: number;
  hit: boolean;
  /** Building and contact point of the strongest wall contact. */
  building: BuildingRef | null;
  cx: number; cz: number;
}

const res: CollideResult = { x: 0, z: 0, nx: 0, nz: 0, hit: false, building: null, cx: 0, cz: 0 };

export class Collision {
  /** Interior floors/stairs (ground) and walls (segments) supplied by the interiors manager. */
  interiorGround: ((x: number, z: number, yRef: number, step: number) => number) | null = null;
  interiorWalls: ((x: number, z: number, y: number, h: number, r: number, cb: (ax: number, az: number, bx: number, bz: number) => void) => void) | null = null;
  /** Street objects (props, vehicles): see Obstacle. */
  obstacleProviders: ObstacleProvider[] = [];

  /** Underground volumes (metro, sewers) - supplied by the game. */
  under: {
    floorAt(x: number, y: number, z: number): number | null;
    inHole(x: number, z: number): boolean;
    contains(x: number, y: number, z: number, margin: number): boolean;
  } | null = null;

  constructor(private world: WorldIndex, private destruction: Destruction, private streamer: CityStreamer) {}

  /** Highest walkable surface under (x,z) not above yRef + step. */
  groundAt(x: number, z: number, yRef: number, step: number): number {
    let g = this.world.terrain.height(x, z) + this.world.surfaceOffset(x, z);
    if (this.under) {
      const uf = this.under.floorAt(x, yRef + 0.3, z);
      if (this.under.inHole(x, z)) return uf ?? g - 8;
      // Below the street: only underground floors count.
      if (uf !== null && yRef < g - 1.0) return uf;
      // Inside a tunnel or station but over no floor (track pit, gap): keep falling, never pop up to the street.
      if (yRef < g - 1.0 && this.under.contains(x, yRef + 0.3, z, 0)) return yRef - 3;
    }
    const deck = this.world.bridgeDeck(x, z);
    if (deck > -Infinity && deck <= yRef + step) g = Math.max(g, deck);
    const rub = this.destruction.rubbleHeight(x, z);
    if (rub > g && rub <= yRef + step + 1) g = rub;
    if (this.interiorGround) g = Math.max(g, this.interiorGround(x, z, yRef, step));
    // Tops of solid objects one can stand on (car roofs, benches) — only those that are
    // substantial for the walker (step ≈ 0.28 × height): a giant does not stand on cars.
    if (this.obstacleProviders.length && step > 0) {
      const minH = step * 1.4;
      for (const prov of this.obstacleProviders) prov(x - 0.01, z - 0.01, x + 0.01, z + 0.01, (o) => {
        if (o.y1 - o.y0 < minH || o.y1 > yRef + step || o.y1 <= g) return;
        if (insideObstacle(o, x, z, 0)) g = o.y1;
      });
    }
    const refs = this.world.buildingsIn(x - 0.5, z - 0.5, x + 0.5, z + 0.5);
    for (const b of refs) {
      if (!pointInPoly(b.poly, x, z)) continue;
      const L = this.destruction.layoutOf(b);
      const cs = b.cell;
      // Roof.
      if (b.alive && this.streamer.isAlive(cs, L.roof) && L.base + L.height <= yRef + step) {
        const tp = L.tiers[L.tiers.length - 1].poly;
        // Flat roofs break with the top storey's slab tiles.
        const tf = L.floors[L.floors.length - 1];
        const tc = tf ? gridCell(L.tiers[tf.tier].grid, x, z) : -1;
        const tileGone = b.desc.roof === 'flat' && tc >= 0 && tf.tiles[tc] >= 0 && this.destruction.isBroken(cs, tf.tiles[tc]);
        if (pointInPoly(tp, x, z) && !tileGone) g = Math.max(g, L.base + L.height);
      }
      // Slabs (floors inside).
      for (const fl of L.floors) {
        if (fl.y0 > yRef + step) break;
        if (fl.y0 <= g) continue;
        if (!pointInPoly(L.tiers[fl.tier].poly, x, z)) continue;
        // The slab tile under this point must still be there.
        const cell = gridCell(L.tiers[fl.tier].grid, x, z);
        const te = cell >= 0 ? fl.tiles[cell] : -1;
        if (te < 0 || !this.streamer.isAlive(cs, te)) continue;
        g = fl.y0;
      }
      // Terrace caps of lower tiers.
      for (let t = 0; t + 1 < L.tiers.length; t++) {
        const fl = L.floors.find((f) => f.f === L.tiers[t + 1].fromFloor);
        if (!fl || fl.y0 > yRef + step || fl.y0 <= g) continue;
        if (pointInPoly(L.tiers[t].poly, x, z) && !pointInPoly(L.tiers[t + 1].poly, x, z)) g = fl.y0;
      }
    }
    return g;
  }

  /**
   * Push a vertical cylinder (centre x,z, feet y, height h, radius r) out of intact wall panels.
   * Works from outside and inside buildings.
   */
  collide(x: number, z: number, y: number, h: number, r: number, px: number, pz: number): CollideResult {
    res.x = x; res.z = z; res.hit = false; res.building = null; res.nx = 0; res.nz = 0;
    let best = 0;
    // Underground: stay inside the tunnels / stations / passages.
    if (this.under) {
      const surf = this.world.terrain.height(px, pz);
      if (y < surf - 1.0 && this.under.contains(px, y + 0.3, pz, 0)) {
        if (!this.under.contains(x, y + 0.3, z, r * 0.5)) {
          if (this.under.contains(x, y + 0.3, pz, r * 0.5)) { res.z = pz; }
          else if (this.under.contains(px, y + 0.3, z, r * 0.5)) { res.x = px; }
          else { res.x = px; res.z = pz; }
          res.hit = true;
        }
        return res;
      }
    }
    const refs = this.world.buildingsIn(x - r - 1, z - r - 1, x + r + 1, z + r + 1);
    for (const b of refs) {
      if (y > b.top + 0.05 || y + h < b.low) continue;
      const L = this.destruction.layoutOf(b);
      const cs = b.cell;
      for (const fl of L.floors) {
        if (fl.y1 <= y + 0.25 || fl.y0 >= y + h) continue; // floor not overlapping the body (allow stepping onto low ledges)
        for (let k = fl.panelStart; k < fl.panelStart + fl.panelCount; k++) {
          const p = L.panels[k];
          const dx = p.bx - p.ax, dz = p.bz - p.az;
          const l2 = dx * dx + dz * dz;
          let t = ((res.x - p.ax) * dx + (res.z - p.az) * dz) / l2;
          if (t < -0.1 || t > 1.1) continue;
          t = Math.max(0, Math.min(1, t));
          const qx = p.ax + dx * t, qz = p.az + dz * t;
          const ex = res.x - qx, ez = res.z - qz;
          const d = Math.hypot(ex, ez);
          if (d >= r) continue;
          if (!this.streamer.isAlive(cs, p.e)) continue;
          // The entrance door is passable (ground floor, front edge, within the door span).
          if (p.floor === 0 && p.edge === L.door.edge && L.tiers[0].poly === b.desc.poly) {
            const sAlong = p.u0 + t * Math.hypot(dx, dz);
            if (sAlong > L.door.s0 - 0.05 && sAlong < L.door.s1 + 0.05 && y < p.y0 + 2.3) continue;
          }
          // Which side: use the previous position (body stays on its side of the wall).
          const side = (px - p.ax) * p.nx + (pz - p.az) * p.nz >= 0 ? 1 : -1;
          const nx = p.nx * side, nz = p.nz * side;
          const along = (res.x - qx) * nx + (res.z - qz) * nz;
          const push = r - along;
          if (push <= 0) continue;
          res.x += nx * push;
          res.z += nz * push;
          if (push > best) { best = push; res.nx = nx; res.nz = nz; res.building = b; res.cx = qx; res.cz = qz; }
          res.hit = true;
        }
      }
    }
    // Interior walls.
    if (this.interiorWalls) {
      this.interiorWalls(res.x, res.z, y, h, r, (ax, az, bx, bz) => {
        const dx = bx - ax, dz = bz - az;
        const l2 = dx * dx + dz * dz;
        if (l2 < 1e-6) return;
        let t = ((res.x - ax) * dx + (res.z - az) * dz) / l2;
        t = Math.max(0, Math.min(1, t));
        const qx = ax + dx * t, qz = az + dz * t;
        const ex = res.x - qx, ez = res.z - qz;
        const d = Math.hypot(ex, ez);
        const rr = r + 0.06;
        if (d >= rr) return;
        const L = Math.sqrt(l2);
        let nx = -dz / L, nz = dx / L;
        if ((px - ax) * nx + (pz - az) * nz < 0) { nx = -nx; nz = -nz; }
        const along = (res.x - qx) * nx + (res.z - qz) * nz;
        const push = rr - along;
        if (push > 0) { res.x += nx * push; res.z += nz * push; res.hit = true; }
      });
    }
    if (this.obstacleProviders.length) this.collideObstacles(y, h, r, px, pz, best);
    return res;
  }

  /**
   * Street objects: trees, poles, furniture, vehicles. They block only when they matter
   * for the walker's size (taller than ~0.4 × body height: a giant wades through cars and
   * lamps, which the stomp logic crushes) and only below the step height over the feet
   * (one can step over a low curb-like object or stand on a roof).
   */
  private collideObstacles(y: number, h: number, r: number, px: number, pz: number, bestIn: number): void {
    const step = Math.max(0.35, h * 0.28);
    const minH = h * 0.4;
    let best = bestIn;
    const R = r + 6;
    for (const prov of this.obstacleProviders) prov(res.x - R, res.z - R, res.x + R, res.z + R, (o) => {
      if (o.y1 - o.y0 < minH) return;
      if (y >= o.y1 - step || y + h <= o.y0) return;
      let nx = 0, nz = 0, push = 0, cx = 0, cz = 0;
      if (o.cyl) {
        const dx = res.x - o.x, dz = res.z - o.z;
        const d = Math.hypot(dx, dz), rr = r + o.r;
        if (d >= rr) return;
        if (d > 1e-5) { nx = dx / d; nz = dz / d; } else { const a = Math.hypot(px - o.x, pz - o.z) || 1; nx = (px - o.x) / a; nz = (pz - o.z) / a; }
        push = rr - d;
        cx = o.x + nx * o.r; cz = o.z + nz * o.r;
      } else {
        // Box frame: u along (ux, uz), w across.
        const dx = res.x - o.x, dz = res.z - o.z;
        const u = dx * o.ux + dz * o.uz, w = -dx * o.uz + dz * o.ux;
        if (Math.abs(u) >= o.hx + r || Math.abs(w) >= o.hz + r) return;
        const cu = Math.max(-o.hx, Math.min(o.hx, u)), cw = Math.max(-o.hz, Math.min(o.hz, w));
        let lu = 0, lw = 0;
        const d = Math.hypot(u - cu, w - cw);
        if (d > 1e-5) {
          if (d >= r) return;
          lu = (u - cu) / d; lw = (w - cw) / d;
          push = r - d;
        } else {
          // Inside: leave on the side we came from (previous position), least penetration.
          const pu = (px - o.x) * o.ux + (pz - o.z) * o.uz, pw = -(px - o.x) * o.uz + (pz - o.z) * o.ux;
          const penU = o.hx + r - Math.abs(u), penW = o.hz + r - Math.abs(w);
          const outsideU = Math.abs(pu) >= o.hx, outsideW = Math.abs(pw) >= o.hz;
          if ((outsideU && !outsideW) || (!outsideW && penU <= penW)) { lu = Math.sign(pu || u) || 1; push = penU; }
          else { lw = Math.sign(pw || w) || 1; push = penW; }
        }
        nx = lu * o.ux - lw * o.uz; nz = lu * o.uz + lw * o.ux;
        cx = o.x + cu * o.ux - cw * o.uz; cz = o.z + cu * o.uz + cw * o.ux;
      }
      if (push <= 0) return;
      res.x += nx * push;
      res.z += nz * push;
      res.hit = true;
      if (push > best) { best = push; res.nx = nx; res.nz = nz; res.cx = cx; res.cz = cz; res.building = null; }
    });
  }
}

/** Is (x, z) inside an obstacle's footprint (grown by m)? */
export function insideObstacle(o: Obstacle, x: number, z: number, m: number): boolean {
  const dx = x - o.x, dz = z - o.z;
  if (o.cyl) return dx * dx + dz * dz < (o.r + m) * (o.r + m);
  const u = dx * o.ux + dz * o.uz, w = -dx * o.uz + dz * o.ux;
  return Math.abs(u) < o.hx + m && Math.abs(w) < o.hz + m;
}
