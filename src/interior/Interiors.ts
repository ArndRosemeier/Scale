/**
 * Builds real interiors for the building the player is in or about to enter
 * (storeys around the player), swaps them in for the shell's slabs, opens the
 * windows, supplies collision (floors, stairs, interior walls) and lights,
 * and places the citizens who are in that building right now.
 */
import * as THREE from 'three';
import type { WorldIndex, BuildingRef } from '../world/WorldIndex';
import type { Destruction } from '../destruction/Destruction';
import type { CityStreamer, CellState } from '../stream/CityStreamer';
import type { Collision } from '../world/Collision';
import { planFloor, shopKindOf, planCores, liftRect, coreFits, coreRect, type FloorPlan, type LiftShaft, type StairCore, type Furn } from './InteriorGen';
import { Elevator } from './Elevator';
import { PanelManager } from '../ui3d/PanelManager';
import { buildFloorMeshes, wallCollisionSegments, furnitureCollision } from './InteriorBuilder';
import { pointInPoly, distSqPointSeg, distPointPolyEdge } from '../core/geom2';
import { offset } from '../core/clip';
import { gridCell, type BuildingLayout } from '../build/buildingLayout';
import type { Population } from '../sim/Population';
import type { Pedestrians } from '../sim/Pedestrians';
import { G } from '../render/materials/globals';

interface ActiveFloor {
  plan: FloorPlan;
  group: THREE.Group;
  walls: number[];
  poly: number[];
  /** Full slab outline of the storey (to the facade): walkable up to the walls and the door sill. */
  outline: number[];
  /** The opening in this storey's slab where the stairs come up from below (null: none). */
  stairPoly: number[] | null;
  /** Solid furniture: [ax, az, bx, bz, top] per edge. */
  furn: number[];
}

interface ActiveBuilding {
  ref: BuildingRef;
  L: BuildingLayout;
  floors: Map<number, ActiveFloor>;
  hidden: Set<number>;
  opened: Set<number>;
  lastNear: number;
  peopleFloors: Set<number>;
  /** Real entrance door (swings inward when someone comes close). */
  door: EntranceDoor | null;
  lift: LiftShaft | null;
  elevator: Elevator | null;
  /** The building's stair core (InteriorGen.planStair), or null. */
  stair: StairCore | null;
}

interface EntranceDoor {
  pivot: THREE.Group;
  /** Hinge point, edge direction (along the facade) and inward normal. */
  hx: number; hz: number; ex: number; ez: number; ix: number; iz: number;
  /** Door centre (for proximity). */
  cx: number; cz: number; y: number;
  angle: number;
}

const DOOR_COLORS = [0x47291a, 0x14332a, 0x721410, 0x2a2420, 0x1c2433];

export class Interiors {
  readonly group = new THREE.Group();
  /** Clickable world panels (elevators); the game routes the crosshair through it. */
  readonly panels = new PanelManager();
  private active = new Map<BuildingRef, ActiveBuilding>();
  private lights: THREE.PointLight[] = [];
  private t = 0;
  private lastCheck = -1;

  constructor(
    private world: WorldIndex,
    private destruction: Destruction,
    private streamer: CityStreamer,
    private collision: Collision,
    private pop: Population,
    private peds: Pedestrians,
  ) {
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffe4c0, 0, 11, 2);
      this.lights.push(l);
      this.group.add(l);
    }
    collision.interiorGround = (x, z, yRef, step) => this.ground(x, z, yRef, step);
    // Slabs hidden by an open interior still carry load (destruction asks).
    destruction.interiorHidden = (cs, e) => {
      for (const a of this.active.values()) if (a.ref.cell === cs && a.hidden.has(e)) return true;
      return false;
    };
    collision.interiorWalls = (x, z, y, h, r, cb) => this.walls(x, z, y, h, r, cb);
  }

  /** Saves: was this element's window opened by an active interior (not shattered)? */
  opened(cs: CellState, e: number): boolean {
    for (const a of this.active.values()) if (a.ref.cell === cs && a.opened.has(e)) return true;
    return false;
  }

  /** Is (x,z,y) inside a building whose interior is active? */
  insideAt(x: number, y: number, z: number): ActiveBuilding | null {
    for (const a of this.active.values()) {
      if (y < a.L.base - 0.5 || y > a.L.base + a.L.height) continue;
      if (pointInPoly(a.ref.poly, x, z)) return a;
    }
    return null;
  }

  update(dt: number, px: number, py: number, pz: number, ph: number, hours: number): void {
    this.t += dt;
    if (this.t - this.lastCheck > 0.25) {
      this.lastCheck = this.t;
      // Candidate buildings: the one containing the player, and those whose door / broken walls are close.
      const cands = this.world.buildingsIn(px - 14, pz - 14, px + 14, pz + 14);
      for (const ref of cands) {
        if (!ref.alive || ph > 6) continue;
        const L = this.destruction.layoutOf(ref);
        const inside = pointInPoly(ref.poly, px, pz) && py > L.base - 1 && py < L.base + L.height;
        const nearDoor = Math.hypot(L.door.x - px, L.door.z - pz) < 9 && py < L.base + 4;
        let nearHole = false;
        if (!inside && !nearDoor) {
          for (const p of L.panels) {
            if (Math.abs((p.y0 + p.y1) / 2 - py) > 6) continue;
            if (distSqPointSeg(px, pz, p.ax, p.az, p.bx, p.bz) > 64) continue;
            if (!this.streamer.isAlive(ref.cell, p.e)) { nearHole = true; break; }
          }
        }
        if (!inside && !nearDoor && !nearHole) continue;
        let a = this.active.get(ref);
        if (!a) {
          a = { ref, L, floors: new Map(), hidden: new Set(), opened: new Set(), lastNear: this.t, peopleFloors: new Set(), door: null, lift: null, elevator: null, stair: null };
          this.active.set(ref, a);
          const cores = planCores(ref.desc, this.floorPoly(a, 0), Math.max(...L.floors.map((q) => q.y1 - q.y0)), L.door);
          a.lift = cores.lift;
          this.makeElevator(a);
          a.stair = cores.stair;
        }
        a.lastNear = this.t;
        // Storeys around the player.
        const want: number[] = [];
        for (const fl of L.floors) if (fl.y1 > py - 3.5 && fl.y0 < py + ph + 3.5) want.push(fl.f);
        for (const f of want) if (!a.floors.has(f)) this.buildFloor(a, f, hours);
      }
      // Drop interiors the player left.
      for (const [ref, a] of this.active) if (this.t - a.lastNear > 6 || !ref.alive) this.drop(a);
    }
    this.updateLights(px, py, pz);
    this.updateDoors(dt, px, py, pz);
    for (const a of this.active.values()) a.elevator?.update(dt);
  }

  /** Doors open for the player and for pedestrians walking through, then fall shut. */
  private updateDoors(dt: number, px: number, py: number, pz: number): void {
    for (const a of this.active.values()) {
      const d = a.door;
      if (!d) continue;
      let want = Math.hypot(px - d.cx, pz - d.cz) < 2.6 && Math.abs(py - d.y) < 2.5;
      if (!want) for (const ag of this.peds.agents) if (Math.hypot(ag.x - d.cx, ag.z - d.cz) < 1.6) { want = true; break; }
      const target = want ? 1.5 : 0;
      d.angle += Math.sign(target - d.angle) * Math.min(Math.abs(target - d.angle), dt * (want ? 2.6 : 1.4));
      // Leaf direction: along the facade when shut, turning inwards when open.
      const c = Math.cos(d.angle), sn = Math.sin(d.angle);
      const dx = d.ex * c + d.ix * sn, dz = d.ez * c + d.iz * sn;
      d.pivot.rotation.y = Math.atan2(-dz, dx);
    }
  }

  /** Interior outline of a storey (its tier, inset from the facade). */
  private floorPoly(a: ActiveBuilding, f: number): number[] {
    const fl = a.L.floors.find((x) => x.f === f);
    const tierPoly = a.L.tiers[fl ? fl.tier : 0].poly;
    const inner = offset([tierPoly], -0.2, 'miter');
    return inner.length ? inner[0].outer : tierPoly;
  }

  /** Does the building's elevator shaft reach storey f (inside that storey's outline)? */
  private serves(a: ActiveBuilding, f: number): boolean {
    if (!a.lift || f < 0 || f >= a.ref.desc.floors) return false;
    const poly = this.floorPoly(a, f), r = liftRect(a.lift, 0.05);
    for (let k = 0; k < r.length; k += 2) if (!pointInPoly(poly, r[k], r[k + 1])) return false;
    return true;
  }

  /** Does the stair core reach storey f (inside its outline)? */
  private stairs(a: ActiveBuilding, f: number): boolean {
    return !!a.stair && f >= 0 && f < a.ref.desc.floors && !!a.L.floors.find((x) => x.f === f) && coreFits(a.stair, this.floorPoly(a, f));
  }

  /** Lift for a newly active building (planned on the ground floor, levels per storey). */
  private makeElevator(a: ActiveBuilding): void {
    if (!a.lift) return;
    const levels: (number | null)[] = [];
    for (let f = 0; f < a.ref.desc.floors; f++) {
      const fl = a.L.floors.find((x) => x.f === f);
      levels.push(fl && this.serves(a, f) ? fl.y0 + 0.04 : null);
    }
    if (levels.filter((l) => l !== null).length < 2) { a.lift = null; return; }
    a.elevator = new Elevator(a.lift, levels, this.panels);
    this.group.add(a.elevator.group);
  }

  /** Build the entrance door leaf of an active building (in the facade's door opening). */
  private makeDoor(a: ActiveBuilding): void {
    const L = a.L, P = a.ref.poly, n = P.length / 2;
    if (L.tiers[0].poly !== a.ref.desc.poly) return;
    const i = L.door.edge, j = (i + 1) % n;
    const ax = P[i * 2], az = P[i * 2 + 1], bx = P[j * 2], bz = P[j * 2 + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.5) return;
    const ex = (bx - ax) / len, ez = (bz - az) / len;
    // Outward normal of the CCW footprint is (ez, -ex): inward is the opposite.
    const ix = -ez, iz = ex;
    const fl0 = L.floors.find((f) => f.f === 0);
    if (!fl0) return;
    // Same opening as the facade shader: centred in the door bay, ≤1.3 m wide, ≤2.45 m high.
    const p0 = L.panels.find((p) => p.floor === 0 && p.edge === i && L.door.s0 >= p.u0 - 0.01 && L.door.s0 < p.u0 + p.bayW);
    const bay = p0 ? p0.bayW : L.door.s1 - L.door.s0;
    const w = Math.min(1.3, bay * 0.62), h = Math.min(2.45, fl0.y1 - fl0.y0 - 0.35);
    const sMid = p0 ? p0.u0 + bay / 2 : (L.door.s0 + L.door.s1) / 2;
    const s0 = sMid - w / 2;
    const hx = ax + ex * s0 + ix * 0.04, hz = az + ez * s0 + iz * 0.04;
    const pivot = new THREE.Group();
    pivot.position.set(hx, fl0.y0, hz);
    const col = DOOR_COLORS[a.ref.desc.seed % DOOR_COLORS.length];
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(w - 0.02, h - 0.01, 0.05).translate(w / 2, h / 2, 0), doorMaterials().leaf(col));
    leaf.castShadow = leaf.receiveShadow = true;
    const pane = new THREE.Mesh(new THREE.BoxGeometry(w * 0.6, h * 0.3, 0.06).translate(w / 2, h * 0.77, 0), doorMaterials().glass);
    const knob = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.14).translate(w * 0.88, h * 0.43, 0), doorMaterials().brass);
    pivot.add(leaf, pane, knob);
    this.group.add(pivot);
    a.door = { pivot, hx, hz, ex, ez, ix, iz, cx: hx + ex * w / 2, cz: hz + ez * w / 2, y: fl0.y0, angle: 0 };
    pivot.rotation.y = Math.atan2(-ez, ex);
  }

  private buildFloor(a: ActiveBuilding, f: number, hours: number): void {
    const L = a.L;
    const fl = L.floors.find((x) => x.f === f);
    if (!fl) return;
    const poly = this.floorPoly(a, f);
    // Cafés and restaurants (plan/eatery.ts) get the café layout (shopKind % 3 == 0), other shops never do.
    const shopKind = shopKindOf(a.ref.desc);
    // Stairs up from this storey, and arriving from the one below.
    const up = this.stairs(a, f) && this.stairs(a, f + 1);
    const below = f > 0 && this.stairs(a, f) && this.stairs(a, f - 1);
    const plan = planFloor(a.ref.desc, poly, f, fl.y0, fl.y1 - fl.y0, shopKind, a.lift, a.stair, up, below, f === 0 ? L.door : null);
    // Nothing standing in the way just inside the entrance (furniture is solid).
    if (f === 0) plan.furniture = plan.furniture.filter((q) => q.kind === 'rug' || q.kind === 'painting' || q.use === 'dress' || Math.hypot(q.x - L.door.x, q.z - L.door.z) > 2.4 + Math.max(q.w, q.d) / 2);
    // The elevator shaft runs through the slabs between floors it serves; the stairs cut their well.
    const shaft = a.lift ? liftRect(a.lift) : null;
    const floorHoles: number[][] = [], ceilHoles: number[][] = [];
    if (shaft && f > 0 && this.serves(a, f) && this.serves(a, f - 1)) floorHoles.push(shaft);
    if (shaft && f < a.ref.desc.floors - 1 && this.serves(a, f) && this.serves(a, f + 1)) ceilHoles.push(shaft);
    const well = below && a.stair ? coreRect(a.stair, a.stair.near - 0.02) : null;
    if (well) floorHoles.push(well);
    if (plan.stairHole) ceilHoles.push(plan.stairHole);
    const group = buildFloorMeshes(plan, poly, floorHoles, ceilHoles, L.tiers[fl.tier].poly);
    this.group.add(group);
    a.floors.set(f, { plan, group, walls: wallCollisionSegments(plan), poly, outline: L.tiers[fl.tier].poly, stairPoly: well, furn: furnitureCollision(plan) });
    if (a.elevator && plan.lift) a.elevator.addLanding(f);
    // Hide the shell slab of this storey and open its windows (real interior visible both ways).
    for (const t of [fl.slab, ...Array.from(fl.tiles)]) {
      if (t >= 0 && this.streamer.isAlive(a.ref.cell, t)) { this.streamer.setElement(a.ref.cell, t, false); a.hidden.add(t); }
    }
    for (let k = fl.panelStart; k < fl.panelStart + fl.panelCount; k++) {
      const e = L.panels[k].e;
      a.opened.add(e);
      this.streamer.setOpen(a.ref.cell, e, 1, true);
    }
    this.placePeople(a, plan, hours);
    if (f === 0 && !a.door) this.makeDoor(a);
  }

  /** Citizens whose schedule puts them in this building now, at plausible spots on this floor. */
  private placePeople(a: ActiveBuilding, plan: FloorPlan, hours: number): void {
    const ref = a.ref;
    const all = [...this.pop.residentsOf(ref.cell.id, ref.index, ref.desc), ...this.pop.workersOf(ref.cell.id, ref.index, ref.desc)];
    const here = all.filter((c) => {
      const s = this.pop.stateAt(c, hours);
      return s.stay && s.stay.place.cell === ref.cell.id && (s.stay.place.b === ref.index || s.stay.place.b < 0);
    });
    // Spread people over the storeys deterministically.
    const floors = ref.desc.floors;
    const mine = here.filter((c) => (c.seed >>> 3) % floors === plan.floor).slice(0, 24);
    const hour = hours % 24;
    const night = hour < 6.5 || hour > 23;
    const spots: { x: number; z: number; yaw: number; use?: string }[] = plan.furniture.filter((f) => f.use && f.use !== 'dress'); // (the fitting mirror is the hero's)
    // Fallback standing spots: random free points in the rooms (not on the stairs).
    if (spots.length < mine.length) {
      let seed = ref.desc.seed ^ (plan.floor * 7919);
      const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
      for (const room of plan.rooms) {
        if (room.type === 'stairs') continue;
        const bb = bboxOf(room.poly);
        for (let k = 0; k < 6 && spots.length < mine.length + 4; k++) {
          const x = bb[0] + rnd() * (bb[2] - bb[0]), z = bb[1] + rnd() * (bb[3] - bb[1]);
          const inLift = plan.lift && pointInPoly(liftRect(plan.lift, 0.6), x, z);
          if (!inLift && pointInPoly(room.poly, x, z) && plan.furniture.every((f) => Math.hypot(f.x - x, f.z - z) > 0.9)) spots.push({ x, z, yaw: rnd() * 6.28, use: 'stand' });
        }
      }
    }
    let k = 0;
    for (const c of mine) {
      const sleepers = spots.filter((s) => s.use === 'sleep');
      const pool = night && sleepers.length ? sleepers : spots.filter((s) => s.use !== 'sleep');
      const s = pool[k++ % Math.max(1, pool.length)];
      if (!s) break;
      const pose = s.use === 'sleep' && night ? 'sleep' : s.use === 'sit' || s.use === 'work' ? 'sit' : 'stand';
      this.peds.spawnInside(c, s.x, plan.y + 0.04, s.z, s.yaw + Math.PI, pose);
    }
  }

  private drop(a: ActiveBuilding): void {
    if (a.elevator) {
      this.group.remove(a.elevator.group);
      a.elevator.dispose();
      a.elevator = null;
    }
    if (a.door) {
      this.group.remove(a.door.pivot);
      a.door.pivot.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
      a.door = null;
    }
    for (const f of a.floors.values()) {
      this.group.remove(f.group);
      f.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    }
    if (a.ref.alive) {
      // Restore hidden slab tiles, except those that broke meanwhile.
      for (const e of a.hidden) if (!this.destruction.isBroken(a.ref.cell, e)) this.streamer.setElement(a.ref.cell, e, true);
      // Close windows of intact panels only (broken walls stay open).
      for (const e of a.opened) if (this.streamer.isAlive(a.ref.cell, e)) this.streamer.setOpen(a.ref.cell, e, 1, false);
    }
    this.peds.removeInside(a.ref.poly);
    this.active.delete(a.ref);
  }

  private ground(x: number, z: number, yRef: number, step: number): number {
    let g = -Infinity;
    for (const a of this.active.values()) {
      if (!pointInPoly(a.ref.poly, x, z)) continue;
      // Elevator shaft: the cabin floor if it is below the feet (riding), else the pit.
      if (a.elevator && a.elevator.inShaft(x, z)) {
        const cy = a.elevator.cabinY;
        if (cy <= yRef + step + 0.05) g = Math.max(g, cy);
        else g = Math.max(g, a.L.base - 1.5);
        continue;
      }
      for (const f of a.floors.values()) {
        const y = f.plan.y + 0.04;
        if (y > yRef + step) continue;
        // Stairs: a ramp along each flight; the landing between them.
        let onStairs = false;
        for (const st of f.plan.flights) {
          const dx = x - st.x, dz = z - st.z;
          const along = dx * st.dx + dz * st.dz, lat = Math.abs(-dx * st.dz + dz * st.dx);
          if (along >= -0.05 && along <= st.run + 0.05 && lat <= st.width / 2 + 0.07) {
            const ys = st.y0 + Math.max(0, Math.min(1, along / st.run)) * (st.y1 - st.y0);
            if (ys <= yRef + step + 0.05) { g = Math.max(g, ys); onStairs = true; }
          }
        }
        for (const l of f.plan.landings) if (l.y <= yRef + step + 0.05 && pointInPoly(l.poly, x, z)) { g = Math.max(g, l.y); onStairs = true; }
        if (onStairs) continue;
        // The stairwell coming up from below, or a slab tile that broke.
        if (pointInPoly(f.outline, x, z) && !(f.stairPoly && pointInPoly(f.stairPoly, x, z)) && !this.tileBroken(a, f.plan.floor, x, z)) g = Math.max(g, y);
      }
    }
    return g;
  }

  private tileBroken(a: ActiveBuilding, f: number, x: number, z: number): boolean {
    const fl = a.L.floors.find((q) => q.f === f);
    if (!fl || f === 0) return false;
    const c = gridCell(a.L.tiers[fl.tier].grid, x, z);
    return c >= 0 && fl.tiles[c] >= 0 && this.destruction.isBroken(a.ref.cell, fl.tiles[c]);
  }

  private walls(x: number, z: number, y: number, h: number, r: number, cb: (ax: number, az: number, bx: number, bz: number) => void): void {
    for (const a of this.active.values()) {
      const b = a.ref.bounds;
      if (x < b[0] - 2 || x > b[2] + 2 || z < b[1] - 2 || z > b[3] + 2) continue;
      for (const f of a.floors.values()) {
        if (f.plan.y + f.plan.height < y + 0.3 || f.plan.y > y + h) continue;
        const w = f.walls;
        for (let i = 0; i < w.length; i += 4) {
          if (distSqPointSeg(x, z, w[i], w[i + 1], w[i + 2], w[i + 3]) < (r + 0.2) ** 2) cb(w[i], w[i + 1], w[i + 2], w[i + 3]);
        }
        // Solid furniture (not once one stands on top of it).
        const fu = f.furn;
        for (let i = 0; i < fu.length; i += 5) {
          if (y > f.plan.y + fu[i + 4] - 0.1) continue;
          if (distSqPointSeg(x, z, fu[i], fu[i + 1], fu[i + 2], fu[i + 3]) < (r + 0.2) ** 2) cb(fu[i], fu[i + 1], fu[i + 2], fu[i + 3]);
        }
        // Closed elevator doors close the doorway (from the landing and from the cabin).
        if (a.elevator && f.plan.lift && a.elevator.landingBlocked(f.plan.floor)) {
          const [ax, az, bx, bz] = a.elevator.doorSegment();
          if (distSqPointSeg(x, z, ax, az, bx, bz) < (r + 0.2) ** 2) cb(ax, az, bx, bz);
        }
      }
    }
  }

  /** Room lights of other insides (the landmarks') when the player is in none of the buildings: nearest first. */
  extraLights: ((x: number, y: number, z: number) => { x: number; y: number; z: number; d: number }[]) | null = null;

  private updateLights(px: number, py: number, pz: number): void {
    // Warm room lights near the player when inside (always on at night, dimmer by day).
    const inside = this.insideAt(px, py + 1, pz);
    let cand: { x: number; y: number; z: number; d: number }[] = [];
    if (!inside && this.extraLights) cand = this.extraLights(px, py + 1, pz);
    if (inside) {
      for (const f of inside.floors.values()) {
        const L = f.plan.lights;
        for (let i = 0; i < L.length; i += 2) {
          const y = f.plan.y + f.plan.height - 0.7;
          const d = Math.hypot(L[i] - px, y - py, L[i + 1] - pz);
          cand.push({ x: L[i], y, z: L[i + 1], d });
        }
      }
      cand.sort((p, q) => p.d - q.d);
    }
    const level = 2.2 + 7 * G.uNight.value;
    this.lights.forEach((l, i) => {
      const c = cand[i];
      if (!c || c.d > 14) { l.intensity = 0; return; }
      l.position.set(c.x, c.y, c.z);
      l.intensity = level;
    });
  }

  /** Camera solidity while inside an active building: outside the shell, near interior walls, below the floor or above the ceiling. */
  solidIndoors(a: ActiveBuilding, x: number, y: number, z: number): boolean {
    // The outer wall has a thickness: a camera inside it would look out through its back faces.
    if (!pointInPoly(a.ref.poly, x, z) || distPointPolyEdge(a.ref.poly, x, z) < OUTER_WALL) return true;
    for (const f of a.floors.values()) {
      if (y < f.plan.y || y > f.plan.y + f.plan.height) continue;
      if (y < f.plan.y + 0.1 || y > f.plan.y + f.plan.height - 0.08) return true;
      const w = f.walls;
      for (let i = 0; i < w.length; i += 4) if (distSqPointSeg(x, z, w[i], w[i + 1], w[i + 2], w[i + 3]) < 0.12 * 0.12) return true;
      // Arcade cabinets are as tall as a person and more: the camera stays out of them.
      for (const fu of f.plan.furniture) {
        if (fu.kind !== 'arcade' || y > f.plan.y + fu.h) continue;
        const c = Math.cos(fu.yaw), sn = Math.sin(fu.yaw), dx = x - fu.x, dz = z - fu.z;
        if (Math.abs(dx * c - dz * sn) < fu.w / 2 + 0.1 && Math.abs(dx * sn + dz * c) < fu.d / 2 + 0.1) return true;
      }
      return false;
    }
    return true;
  }

  /** Video game cabinets of the open arcades (game/Arcade): a stable key, the piece and its floor height. */
  arcadeCabinets(): { key: string; f: Furn; y: number }[] {
    const out: { key: string; f: Furn; y: number }[] = [];
    for (const a of this.active.values()) for (const fl of a.floors.values()) {
      fl.plan.furniture.forEach((fu, i) => { if (fu.kind === 'arcade') out.push({ key: `${a.ref.cell.id}:${a.ref.index}:${fl.plan.floor}:${i}`, f: fu, y: fl.plan.y }); });
    }
    return out;
  }

  /** Fitting mirrors of the active interiors: centre, floor height and facing (yaw; the glass faces local +z). */
  dressMirrors(): { x: number; z: number; y: number; yaw: number }[] {
    const out: { x: number; z: number; y: number; yaw: number }[] = [];
    for (const a of this.active.values()) for (const f of a.floors.values()) for (const fu of f.plan.furniture) if (fu.use === 'dress') out.push({ x: fu.x, z: fu.z, y: f.plan.y, yaw: fu.yaw });
    return out;
  }

  /** The fitting mirror of a clothes shop within reach of (x, y, z), or null. */
  dressMirrorNear(x: number, y: number, z: number, r = 1.5): { x: number; z: number } | null {
    for (const a of this.active.values()) {
      if (!pointInPoly(a.ref.poly, x, z)) continue;
      for (const f of a.floors.values()) {
        if (Math.abs(f.plan.y - y) > 0.6) continue;
        for (const fu of f.plan.furniture) if (fu.use === 'dress' && Math.hypot(fu.x - x, fu.z - z) < r) return { x: fu.x, z: fu.z };
      }
    }
    return null;
  }

  /**
   * A free seat within reach (chairs, sofas, benches of an active interior) for a walker at
   * (x, y, z): where to sit and which way to face. Sofas offer one place per cushion.
   */
  seatNear(x: number, y: number, z: number, r = 1.3): { x: number; z: number; yaw: number } | null {
    let best: { x: number; z: number; yaw: number } | null = null, bd = r;
    for (const a of this.active.values()) {
      if (!pointInPoly(a.ref.poly, x, z)) continue;
      for (const f of a.floors.values()) {
        if (Math.abs(f.plan.y - y) > 0.6) continue;
        for (const fu of f.plan.furniture) {
          if (fu.use !== 'sit') continue;
          const c = Math.cos(fu.yaw), s = Math.sin(fu.yaw);
          const n = fu.kind === 'sofa' ? Math.max(1, Math.round(fu.w / 0.7)) : 1;
          for (let k = 0; k < n; k++) {
            const lx = n > 1 ? -fu.w / 2 + (k + 0.5) * (fu.w / n) : 0, lz = fu.kind === 'sofa' || fu.kind === 'armchair' ? 0.08 : 0;
            const sx = fu.x + lx * c + lz * s, sz = fu.z - lx * s + lz * c;
            const d = Math.hypot(sx - x, sz - z);
            if (d < bd && !this.peds.agents.some((p) => p.inside && Math.hypot(p.x - sx, p.z - sz) < 0.35)) { bd = d; best = { x: sx, z: sz, yaw: fu.yaw + Math.PI }; }
          }
        }
      }
    }
    return best;
  }

  /** Drop everything (e.g. when the building collapses). */
  clear(): void {
    for (const a of [...this.active.values()]) this.drop(a);
  }
}

/** Thickness of a building's outer wall for the indoor camera (m). */
const OUTER_WALL = 0.25;

function bboxOf(p: number[]): [number, number, number, number] {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]); }
  return [x0, z0, x1, z1];
}

let doorMats: { leaf: (c: number) => THREE.Material; glass: THREE.Material; brass: THREE.Material } | null = null;
const leafCache = new Map<number, THREE.Material>();
function doorMaterials() {
  if (!doorMats) doorMats = {
    leaf: (c: number) => {
      let m = leafCache.get(c);
      if (!m) leafCache.set(c, (m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.55 })));
      return m;
    },
    glass: new THREE.MeshStandardMaterial({ color: 0x0b0f12, roughness: 0.05, metalness: 0.2 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xb08d4a, roughness: 0.3, metalness: 1 }),
  };
  return doorMats;
}
