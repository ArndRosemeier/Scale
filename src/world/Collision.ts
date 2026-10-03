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
    return res;
  }
}
