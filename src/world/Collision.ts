/**
 * Body collision against the destructible city: buildings are thin wall
 * panels (per floor) and floor slabs, so bodies can enter through holes or
 * doors, stand on intact floors inside, on roofs, rubble, bridges and streets.
 */
import type { WorldIndex, BuildingRef } from './WorldIndex';
import type { Destruction } from '../destruction/Destruction';
import type { CityStreamer } from '../stream/CityStreamer';
import { gridCell, stoopTop, buildingEntrance, STOOP_REACH, type Stoop } from '../build/buildingLayout';
import { roofSurface, roofEquipment } from '../build/buildingShell';
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
/** Scratch box for stoop steps. */
const box = { cyl: false, x: 0, z: 0, r: 0, hx: 0, hz: 0, ux: 1, uz: 0 };

export class Collision {
  /** Interior floors/stairs (ground) and walls (segments) supplied by the interiors manager. */
  interiorGround: ((x: number, z: number, yRef: number, step: number) => number) | null = null;
  interiorWalls: ((x: number, z: number, y: number, h: number, r: number, cb: (ax: number, az: number, bx: number, bz: number) => void) => void) | null = null;
  /** Street objects (props, vehicles): see Obstacle. */
  obstacleProviders: ObstacleProvider[] = [];
  /** Extra walkable surfaces (ice-path sheets): top height at (x, z) not above yRef + step, or -Infinity. */
  extraGround: ((x: number, z: number, yRef: number, step: number) => number) | null = null;

  /**
   * A sealed room off the map (the hospital's revival ward, game/defeat/HospitalWard): inside it
   * its own floor and ceiling count, nothing of the city above; it counts as underground (no water,
   * no sky). Its walls and furniture come through an obstacle provider. Null: none open.
   */
  room: { inside(x: number, y: number, z: number): boolean; floorAt(x: number, y: number, z: number): number | null; ceiling: number } | null = null;

  /** Underground volumes (metro, sewers) - supplied by the game. */
  under: {
    floorAt(x: number, y: number, z: number): number | null;
    inHole(x: number, z: number): boolean;
    contains(x: number, y: number, z: number, margin: number): boolean;
    ceilingAt(x: number, y: number, z: number): number;
  } | null = null;

  private refsG: BuildingRef[] = [];
  /** Entrance steps per building (refs die with their cell, so this frees itself). */
  private stoops = new WeakMap<BuildingRef, Stoop | null>();

  /** Roof surface height per building (null: flat), shared with the roof mesh's geometry. */
  private roofs = new WeakMap<BuildingRef, ((x: number, z: number) => number) | null>();

  /** Rooftop equipment of a building as obstacles (cached; rebuilt when the building's height changes). */
  private roofGear = new WeakMap<BuildingRef, { top: number; obs: Obstacle[] }>();

  /**
   * Obstacle provider for rooftop equipment (HVAC units, elevator housings, water tanks): walls
   * stop the walker, and the tops can be stood on (see the obstacle rules). Registered by the game.
   */
  roofEquipmentIn = (x0: number, z0: number, x1: number, z1: number, out: (o: Obstacle) => void): void => {
    for (const b of this.world.buildingsIn(x0, z0, x1, z1, this.refsR)) {
      if (!b.alive) continue;
      let e = this.roofGear.get(b);
      if (!e || Math.abs(e.top - b.top) > 0.05) {
        const L = this.destruction.layoutOf(b);
        const items = roofEquipment(b.desc, L.tiers[L.tiers.length - 1].poly, L.base + L.height);
        e = { top: b.top, obs: items.map((it) => ({ cyl: it.kind === 'tank', x: it.x, z: it.z, r: it.hx, hx: it.hx, hz: it.hz, ux: Math.cos(it.yaw), uz: -Math.sin(it.yaw), y0: it.y0, y1: Math.max(it.y1, it.y0 + 0.8) })) };
        // (Low units count 0.8 m high: lower ones would be stepped over and stood in, not on.)
        // A building cut lower (damage) loses what stood on the old roof.
        if (b.top < L.base + L.height - 0.5) e.obs = [];
        this.roofGear.set(b, e);
      }
      for (const o of e.obs) if (o.x + o.hx + o.hz >= x0 && o.x - o.hx - o.hz <= x1 && o.z + o.hx + o.hz >= z0 && o.z - o.hx - o.hz <= z1) out(o);
    }
  };
  private refsR: BuildingRef[] = [];

  private roofOf(b: BuildingRef, L: { base: number; height: number; tiers: { poly: number[] }[] }): ((x: number, z: number) => number) | null {
    let f = this.roofs.get(b);
    if (f === undefined) this.roofs.set(b, (f = roofSurface(b.desc, L.tiers[L.tiers.length - 1].poly, L.base + L.height)));
    return f;
  }

  private stoopOf(b: BuildingRef): Stoop | null {
    let s = this.stoops.get(b);
    if (s === undefined) this.stoops.set(b, (s = buildingEntrance(b.desc, this.world.terrain)));
    return s;
  }
  private refsC: BuildingRef[] = [];

  constructor(private world: WorldIndex, private destruction: Destruction, private streamer: CityStreamer) {}

  /** Feet at (x, y, z) inside an underground volume, below the ground (water above does not reach them). */
  underground(x: number, y: number, z: number): boolean {
    if (this.room?.inside(x, y, z)) return true;
    return !!this.under && y < this.world.terrain.height(x, z) - 1.0 && this.under.contains(x, y + 0.3, z, 0);
  }

  /** Ceiling over (x, z) for a body at y (underground halls and tunnels; Infinity in the open). */
  ceilingAt(x: number, z: number, y: number): number {
    if (this.room?.inside(x, y, z)) return this.room.ceiling;
    if (!this.under || y > this.world.terrain.height(x, z) - 1.0) return Infinity;
    return this.under.ceilingAt(x, y + 0.3, z);
  }

  /** Highest walkable surface under (x,z) not above yRef + step. */
  groundAt(x: number, z: number, yRef: number, step: number): number {
    if (this.room) { const f = this.room.floorAt(x, yRef, z); if (f !== null) return f; }
    let g = this.world.terrain.height(x, z) + this.world.surfaceOffset(x, z);
    if (this.under) {
      const uf = this.under.floorAt(x, yRef + 0.3, z);
      if (this.under.inHole(x, z)) return uf ?? g - 8;
      // Below the street only underground floors count; over none (track pit, gap, or a jump that
      // left the hall's volume) keep falling - never pop up to the street (a jump in a station
      // used to land the player on the street above).
      if (yRef < g - 1.0) return uf ?? yRef - 3;
    }
    const deck = this.world.bridgeDeck(x, z);
    if (deck > -Infinity && deck <= yRef + step) g = Math.max(g, deck);
    if (this.extraGround) { const e = this.extraGround(x, z, yRef, step); if (e > g) g = e; }
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
    const refs = this.world.buildingsIn(x - STOOP_REACH, z - STOOP_REACH, x + STOOP_REACH, z + STOOP_REACH, this.refsG);
    for (const b of refs) {
      const bb = b.bounds;
      const inBounds = x >= bb[0] && x <= bb[2] && z >= bb[1] && z <= bb[3];
      if (!inBounds || !pointInPoly(b.poly, x, z)) {
        // Entrance steps outside the footprint.
        const S = this.stoopOf(b);
        if (S) {
          const top = stoopTop(S, x, z);
          if (top > g && top <= yRef + step && this.streamer.isAlive(b.cell, b.elemBase)) g = top;
        }
        continue;
      }
      const L = this.destruction.layoutOf(b);
      const cs = b.cell;
      // Roof.
      const wallTop = L.base + L.height;
      if (b.alive && this.streamer.isAlive(cs, L.roof) && wallTop <= yRef + step) {
        const tp = L.tiers[L.tiers.length - 1].poly;
        if (pointInPoly(tp, x, z)) {
          // Pitched and mansard roofs: their actual surface (one walks up the slope; anyone who
          // ends up inside the roof volume - flying or jumping into it - is put on top of it).
          // Roofs (flat and pitched) break with the top storey's slab tiles.
          const tf = L.floors[L.floors.length - 1];
          const tc = tf ? gridCell(L.tiers[tf.tier].grid, x, z) : -1;
          const tileGone = tc >= 0 && tf.tiles[tc] >= 0 && this.destruction.isBroken(cs, tf.tiles[tc]);
          const surf = this.roofOf(b, L);
          if (tileGone) { /* a hole: fall into the storey below */ }
          else if (surf) {
            const rh = surf(x, z);
            if (rh <= yRef + step || yRef > wallTop - 0.3) g = Math.max(g, rh);
          } else g = Math.max(g, wallTop);
        }
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
        // Solid things down here too (train cars).
        if (this.obstacleProviders.length) this.collideObstacles(y, h, r, px, pz, 0);
        return res;
      }
    }
    const step = Math.max(0.35, h * 0.28);
    const refs = this.world.buildingsIn(x - r - STOOP_REACH, z - r - STOOP_REACH, x + r + STOOP_REACH, z + r + STOOP_REACH, this.refsC);
    for (const b of refs) {
      // Entrance steps: solid below the step height (one walks up them, a giant over them).
      const S = this.stoopOf(b);
      if (S && x + r >= S.bounds[0] && x - r <= S.bounds[2] && z + r >= S.bounds[1] && z - r <= S.bounds[3] && this.streamer.isAlive(b.cell, b.elemBase)) {
        const B = S.boxes;
        for (let k = 0; k < B.length; k += 5) {
          if (y >= B[k + 4] - step || y + h <= S.foot) continue;
          box.x = B[k]; box.z = B[k + 1]; box.hx = B[k + 2]; box.hz = B[k + 3]; box.ux = S.ux; box.uz = S.uz;
          const push = this.pushBox(box, r, px, pz);
          if (push > best) { best = push; res.nx = this.cn[0]; res.nz = this.cn[1]; res.building = null; res.cx = this.cn[2]; res.cz = this.cn[3]; }
        }
      }
      const bb = b.bounds;
      if (x + r + 1 < bb[0] || x - r - 1 > bb[2] || z + r + 1 < bb[1] || z - r - 1 > bb[3]) continue;
      if (y > b.top + 0.05 || y + h < b.low) continue;
      const L = this.destruction.layoutOf(b);
      const cs = b.cell;
      // Plinth under a raised ground floor: one cannot walk in under the floor (through the
      // door or a broken wall from the street below) - only up the entrance steps.
      if (b.alive && L.base > y + 0.25 && L.low < y + h && this.streamer.isAlive(cs, L.plinth)) {
        const P = b.poly, n = P.length >> 1;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const push = this.pushSeg(P[i * 2], P[i * 2 + 1], P[j * 2], P[j * 2 + 1], r, px, pz);
          if (push > best) { best = push; res.nx = this.cn[0]; res.nz = this.cn[1]; res.building = b; res.cx = this.cn[2]; res.cz = this.cn[3]; }
        }
      }
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
      const push = this.pushBox(o, r, px, pz);
      if (push > best) { best = push; res.nx = this.cn[0]; res.nz = this.cn[1]; res.cx = this.cn[2]; res.cz = this.cn[3]; res.building = null; }
    });
  }

  /** Contact of the last push: normal (x, z) and contact point (x, z). */
  private cn = [0, 0, 0, 0];

  /** Push the body (res.x, res.z, radius r) out of an obstacle's footprint; returns the push depth. */
  private pushBox(o: Pick<Obstacle, 'cyl' | 'x' | 'z' | 'r' | 'hx' | 'hz' | 'ux' | 'uz'>, r: number, px: number, pz: number): number {
    let nx = 0, nz = 0, push = 0, cx = 0, cz = 0;
    if (o.cyl) {
      const dx = res.x - o.x, dz = res.z - o.z;
      const d = Math.hypot(dx, dz), rr = r + o.r;
      if (d >= rr) return 0;
      if (d > 1e-5) { nx = dx / d; nz = dz / d; } else { const a = Math.hypot(px - o.x, pz - o.z) || 1; nx = (px - o.x) / a; nz = (pz - o.z) / a; }
      push = rr - d;
      cx = o.x + nx * o.r; cz = o.z + nz * o.r;
    } else {
      // Box frame: u along (ux, uz), w across.
      const dx = res.x - o.x, dz = res.z - o.z;
      const u = dx * o.ux + dz * o.uz, w = -dx * o.uz + dz * o.ux;
      if (Math.abs(u) >= o.hx + r || Math.abs(w) >= o.hz + r) return 0;
      const cu = Math.max(-o.hx, Math.min(o.hx, u)), cw = Math.max(-o.hz, Math.min(o.hz, w));
      let lu = 0, lw = 0;
      const d = Math.hypot(u - cu, w - cw);
      if (d > 1e-5) {
        if (d >= r) return 0;
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
    if (push <= 0) return 0;
    res.x += nx * push;
    res.z += nz * push;
    res.hit = true;
    this.cn[0] = nx; this.cn[1] = nz; this.cn[2] = cx; this.cn[3] = cz;
    return push;
  }

  /** Push the body out of a wall segment, staying on the side of its previous position (px, pz). */
  private pushSeg(ax: number, az: number, bx: number, bz: number, r: number, px: number, pz: number): number {
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz;
    if (l2 < 1e-6) return 0;
    const t = Math.max(0, Math.min(1, ((res.x - ax) * dx + (res.z - az) * dz) / l2));
    const qx = ax + dx * t, qz = az + dz * t;
    if ((res.x - qx) ** 2 + (res.z - qz) ** 2 >= r * r) return 0;
    const l = Math.sqrt(l2);
    let nx = dz / l, nz = -dx / l;
    if ((px - ax) * nx + (pz - az) * nz < 0) { nx = -nx; nz = -nz; }
    const push = r - ((res.x - qx) * nx + (res.z - qz) * nz);
    if (push <= 0) return 0;
    res.x += nx * push; res.z += nz * push;
    res.hit = true;
    this.cn[0] = nx; this.cn[1] = nz; this.cn[2] = qx; this.cn[3] = qz;
    return push;
  }
}

/** Is (x, z) inside an obstacle's footprint (grown by m)? */
export function insideObstacle(o: Obstacle, x: number, z: number, m: number): boolean {
  const dx = x - o.x, dz = z - o.z;
  if (o.cyl) return dx * dx + dz * dz < (o.r + m) * (o.r + m);
  const u = dx * o.ux + dz * o.uz, w = -dx * o.uz + dz * o.ux;
  return Math.abs(u) < o.hx + m && Math.abs(w) < o.hz + m;
}
