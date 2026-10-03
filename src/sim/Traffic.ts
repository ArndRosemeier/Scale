/**
 * Road traffic around the player.
 *
 *  - Vehicles follow lanes of the RoadNet (right- or left-hand traffic per
 *    city), turn through junctions on curved connectors, keep distance with
 *    the Intelligent Driver Model, obey signals (phase = pure function of
 *    time and junction) and give way to pedestrians.
 *  - Cars come from citizens' car trips near the player plus through traffic
 *    entering on arterials, with density following the time of day.
 *  - Drivers react: hard braking, U-turns away from danger, abandoning the
 *    car and running when a giant or a collapse is close.
 *  - Hit hard enough (giant feet, debris, punches) a car becomes a physical
 *    wreck (Rapier body) or is crushed flat.
 */
import type { RoadNet, REdge } from './RoadNet';
import type { Pedestrians, PedAgent } from './Pedestrians';
import type { Stimuli } from '../game/Stimuli';
import type { Terrain } from '../world/terrain';
import { Rng, hash32 } from '../core/rng';
import type { Citizen } from './Population';
import type { Obstacle, ObstacleProvider } from '../world/Collision';
import { statusOf } from '../shared/status';

export type VKind = 'sedan' | 'hatch' | 'wagon' | 'suv' | 'van' | 'pickup' | 'taxi' | 'police' | 'sports' | 'bus' | 'truck' | 'delivery' | 'shuttle';

export const enum VState { Drive = 0, Stopped = 1, Fleeing = 2, Abandoned = 3, Wreck = 4, Crushed = 5 }

export interface Vehicle {
  id: number;
  kind: VKind;
  variant: number;
  paint: [number, number, number];
  length: number;
  width: number;
  /** Current edge and direction. */
  edge: number;
  fwd: boolean;
  lane: number;
  s: number;
  /** Route (edges + directions) and the index of the current edge. */
  route: { edges: number[]; fwd: boolean[] };
  ri: number;
  speed: number;
  vmax: number;
  state: VState;
  /** World pose. */
  x: number; y: number; z: number; yaw: number;
  /** Turning connector (Bezier) when crossing a junction: progress 0..1, null when on an edge. */
  turn: { ax: number; az: number; cx: number; cz: number; bx: number; bz: number; len: number; t: number } | null;
  brake: number;
  indicator: number;
  headlights: number;
  damage: number;
  driver: Citizen | null;
  stateT: number;
  fear: number;
  wait: number;
  /** Physics wreck handle (index) or -1. */
  wreck: number;
  alive: boolean;
  /** Trip destination (citizens' cars), kept so routes survive road-network rebuilds. */
  dest?: { x: number; z: number };
  /** Body attitude on the road surface (rad): nose up +, right side up +. */
  pitch?: number;
  roll?: number;
}

const RANGE = 650;
const DESPAWN = 800;
const MAX_VEHICLES = 320;

const DIMS: Record<VKind, [number, number]> = {
  sedan: [4.7, 1.85], hatch: [4.1, 1.78], wagon: [4.8, 1.85], suv: [4.8, 1.95], van: [5.2, 2.0], pickup: [5.4, 2.0],
  taxi: [4.8, 1.85], police: [4.9, 1.9], sports: [4.4, 1.9], bus: [12, 2.55], truck: [8, 2.5], delivery: [6, 2.2], shuttle: [5.0, 2.06],
};

export class Traffic {
  private netVersion = -1;
  readonly vehicles: Vehicle[] = [];
  private nextId = 1;
  private t = 0;
  private spawnAcc = 0;
  private laneIndex = new Map<string, Vehicle[]>();
  private rng = new Rng(77);
  /** +1 right-hand traffic, −1 left-hand. */
  private hand: number;
  private px = 0;
  private pz = 0;
  private frame = 0;
  /**
   * Road surface height under a vehicle heading (hx, hz): terrain, or a bridge deck the car
   * drives along (set by the game; terrain only when absent).
   */
  surface: ((x: number, z: number, hx: number, hz: number) => number) | null = null;
  /**
   * Small things on the carriageway that cars stop for (robots crossing or lying on the road),
   * refilled every frame by their owner (the near-future layer).
   */
  readonly obstacles: { x: number; z: number; r: number }[] = [];
  onCrash?: (v: Vehicle, x: number, y: number, z: number, speed: number) => void;
  onHorn?: (v: Vehicle) => void;
  onAbandon?: (v: Vehicle) => void;

  constructor(private net: RoadNet, private peds: Pedestrians, private stimuli: Stimuli, private terrain: Terrain, rightHand: boolean, private seed: number) {
    this.hand = rightHand ? 1 : -1;
    peds.crossCheck = (a) => this.safeToCross(a);
  }

  /** Lane centre offset (positive = right of the edge's a→b direction). */
  get time(): number { return this.t; }

  laneOffset(e: REdge, fwd: boolean, lane: number): number {
    const median = e.cls === 0 ? 1.0 : 0;
    const usable = e.width / 2 - median - (e.cls === 2 ? 1.9 : 0.3); // streets keep a parking strip
    const lw = Math.max(2.6, usable / Math.max(1, e.lanes));
    const o = median + lw * (Math.min(lane, e.lanes - 1) + 0.5);
    return (fwd ? 1 : -1) * this.hand * o;
  }

  speedLimit(e: REdge): number {
    return e.cls === 0 ? 15 : e.cls === 1 ? 13 : e.cls === 2 ? 9 : 6;
  }

  /** Traffic signal state for an approach: green if the edge's axis belongs to the active phase. */
  signalGreen(node: number, e: REdge, t: number): boolean {
    const n = this.net.nodes[node];
    if (!n.signal) return true;
    const cycle = 56;
    const off = (hash32(node * 7919 + this.seed) % 1000) / 1000 * cycle;
    const ph = ((t + off) % cycle) / cycle;
    // Axis of the approach (direction mod π).
    const ex = e.pts[e.pts.length - 2] - e.pts[0], ez = e.pts[e.pts.length - 1] - e.pts[1];
    let ang = Math.atan2(ez, ex);
    if (ang < 0) ang += Math.PI;
    // Reference axis per node: the first edge.
    const r = this.net.edges[n.edges[0]];
    let ra = Math.atan2(r.pts[r.pts.length - 1] - r.pts[1], r.pts[r.pts.length - 2] - r.pts[0]);
    if (ra < 0) ra += Math.PI;
    let d = Math.abs(ang - ra);
    d = Math.min(d, Math.PI - d);
    const groupA = d < Math.PI / 4;
    // 0..0.45 A green, 0.45..0.5 amber/all red, 0.5..0.95 B green, 0.95..1 all red
    if (groupA) return ph < 0.45;
    return ph >= 0.5 && ph < 0.95;
  }

  update(dt: number, hours: number, px: number, pz: number): void {
    this.t += dt;
    this.px = px; this.pz = pz; this.frame++;
    if (!this.net.edges.length) return;
    if (this.net.version !== this.netVersion) { this.netVersion = this.net.version; this.remap(); }
    // ---- spawn through traffic to keep a realistic density
    const h = hours % 24;
    const rush = Math.exp(-((h - 8.3) ** 2) / 1.2) + Math.exp(-((h - 17.8) ** 2) / 2) * 1.1;
    const night = h < 5.5 || h > 23 ? 0.15 : h < 6.5 ? 0.4 : 1;
    const target = Math.min(MAX_VEHICLES, Math.round((70 + 160 * rush) * night));
    this.spawnAcc += dt * 3;
    while (this.spawnAcc > 1 && this.vehicles.length < target) {
      this.spawnAcc -= 1;
      this.spawnRandom(px, pz);
    }
    if (this.spawnAcc > 1) this.spawnAcc = 1;
    // ---- lane occupancy index
    this.laneIndex.clear();
    for (const v of this.vehicles) {
      if (v.turn || v.state >= VState.Wreck) continue;
      const k = `${v.edge}:${v.fwd ? 1 : 0}:${v.lane}`;
      let l = this.laneIndex.get(k);
      if (!l) this.laneIndex.set(k, (l = []));
      l.push(v);
    }
    for (const l of this.laneIndex.values()) l.sort((a, b) => (a.fwd ? a.s - b.s : b.s - a.s));
    // ---- reactions to world events
    for (const s of this.stimuli.recent) {
      if (this.t - 0 < 0) break;
      if (s.time < this.stimuli.time - 0.05) continue;
      if (s.kind !== 'collapse' && s.kind !== 'blast' && s.kind !== 'stomp' && s.kind !== 'sonic' && s.kind !== 'giant') continue;
      for (const v of this.vehicles) {
        const d = Math.hypot(v.x - s.x, v.z - s.z);
        if (d > s.radius) continue;
        v.fear = Math.min(2, v.fear + (1 - d / s.radius) * (s.kind === 'giant' ? 0.3 : 1.2));
        if (s.kind === 'stomp' && d < Math.max(3, s.intensity)) this.crush(v);
      }
    }
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i];
      this.step(v, dt);
      if (!v.alive || Math.hypot(v.x - px, v.z - pz) > DESPAWN) {
        this.vehicles[i] = this.vehicles[this.vehicles.length - 1];
        this.vehicles.pop();
      }
    }
  }

  private makeVehicle(kind: VKind, edge: number, fwd: boolean, s: number, driver: Citizen | null): Vehicle {
    const e = this.net.edges[edge];
    const r = new Rng(hash32(this.nextId * 2654435761 + this.seed));
    const [L, W] = DIMS[kind];
    const v: Vehicle = {
      id: this.nextId++, kind, variant: r.int(0, 3), paint: [0, 0, 0], length: L, width: W, edge, fwd, lane: r.int(0, Math.max(0, e.lanes - 1)), s,
      route: { edges: [edge], fwd: [fwd] }, ri: 0, speed: this.speedLimit(e) * 0.7, vmax: this.speedLimit(e) * r.range(0.85, 1.1),
      state: VState.Drive, x: 0, y: 0, z: 0, yaw: 0, turn: null, brake: 0, indicator: 0, headlights: 0, damage: 0, driver,
      stateT: 0, fear: 0, wait: 0, wreck: -1, alive: true,
    };
    if (kind === 'bus' || kind === 'truck') v.lane = 0;
    this.pose(v);
    return v;
  }

  /** Spawn on a random lane at the edge of the active area, heading somewhere plausible. */
  private spawnRandom(px: number, pz: number): void {
    const E = this.net.edges;
    for (let tries = 0; tries < 12; tries++) {
      const ei = this.rng.int(0, E.length - 1);
      const e = E[ei];
      if (e.cls > 2 || e.len < 20) continue;
      const mx = e.pts[e.pts.length >> 1 & ~1], mz = e.pts[(e.pts.length >> 1 & ~1) + 1];
      const d = Math.hypot(mx - px, mz - pz);
      // Prefer spawning out of sight (ring), occasionally closer to fill in.
      if (d > RANGE || (d < 180 && this.rng.chance(0.85))) continue;
      const fwd = this.rng.chance(0.5);
      const s = this.rng.range(5, e.len - 5);
      // Not on top of another car.
      const k = `${ei}:${fwd ? 1 : 0}:0`;
      if (this.laneIndex.get(k)?.some((o) => Math.abs(o.s - s) < 12)) continue;
      // Near future: a few driverless shuttles among the cars (main roads mostly).
      const kind = this.rng.weighted<VKind>(['sedan', 'hatch', 'wagon', 'suv', 'van', 'pickup', 'taxi', 'police', 'sports', 'bus', 'truck', 'delivery', 'shuttle'],
        (k2) => ({ sedan: 30, hatch: 18, wagon: 6, suv: 20, van: 5, pickup: 5, taxi: e.cls <= 1 ? 9 : 3, police: 1.2, sports: 2, bus: e.cls <= 1 ? 2.5 : 0, truck: 2, delivery: 4, shuttle: e.cls <= 1 ? 7 : 3 }[k2]));
      const v = this.makeVehicle(kind, ei, fwd, s, null);
      // Not on top of a robot on the road.
      if (this.obstacles.some((o) => Math.abs(o.x - v.x) < 12 && Math.abs(o.z - v.z) < 12)) continue;
      // Route: random walk of a few edges ahead, preferring straight on.
      v.route = this.randomRoute(ei, fwd, 12);
      this.vehicles.push(v);
      return;
    }
  }

  /** Spawn a citizen's car for a trip (from the kerb near a point to a destination point). */
  spawnTrip(driver: Citizen, ax: number, az: number, bx: number, bz: number): boolean {
    if (this.vehicles.length >= MAX_VEHICLES) return false;
    const ea = this.net.nearestEdge(ax, az, 80), eb = this.net.nearestEdge(bx, bz, 300);
    if (!ea) return false;
    const E = this.net.edges;
    const fwd = ea.side * this.hand > 0;
    const v = this.makeVehicle(driver.seed % 5 === 0 ? 'suv' : driver.seed % 7 === 0 ? 'hatch' : 'sedan', ea.e, fwd, ea.s, driver);
    if (this.obstacles.some((o) => Math.abs(o.x - v.x) < 8 && Math.abs(o.z - v.z) < 8)) return false;
    v.dest = { x: bx, z: bz };
    if (eb) {
      const startNode = fwd ? E[ea.e].b : E[ea.e].a;
      const endNode = this.net.edgeEndNear(eb.e, eb.s);
      const r = this.net.route(startNode, endNode, true, 5000);
      if (r) v.route = { edges: [ea.e, ...r.edges], fwd: [fwd, ...r.fwd] };
    }
    this.vehicles.push(v);
    return true;
  }

  /**
   * The road network is rebuilt as cells stream in and edge ids change: put
   * every vehicle back on the nearest edge in its current heading and re-route.
   */
  private remap(): void {
    const E = this.net.edges, tmp = { x: 0, z: 0, dx: 0, dz: 0 };
    for (const v of this.vehicles) {
      if (v.state === VState.Wreck || v.state === VState.Crushed || v.state === VState.Abandoned) continue;
      const ne = this.net.nearestEdge(v.x, v.z, 40);
      if (!ne) { v.alive = false; continue; }
      const e = E[ne.e];
      this.net.pointAt(e, ne.s, 0, tmp);
      const hx = -Math.sin(v.yaw), hz = -Math.cos(v.yaw);
      v.edge = ne.e;
      v.fwd = tmp.dx * hx + tmp.dz * hz >= 0;
      v.s = Math.max(0, Math.min(e.len, ne.s));
      v.lane = Math.min(v.lane, e.lanes - 1);
      v.turn = null;
      v.ri = 0;
      v.route = this.randomRoute(v.edge, v.fwd, 12);
      if (v.dest) {
        const eb = this.net.nearestEdge(v.dest.x, v.dest.z, 300);
        if (eb) {
          const r = this.net.route(v.fwd ? e.b : e.a, this.net.edgeEndNear(eb.e, eb.s), true, 5000);
          if (r) v.route = { edges: [v.edge, ...r.edges], fwd: [v.fwd, ...r.fwd] };
        }
      }
    }
  }

  private randomRoute(edge: number, fwd: boolean, n: number): { edges: number[]; fwd: boolean[] } {
    const edges = [edge], fw = [fwd];
    let cur = edge, f = fwd;
    for (let k = 0; k < n; k++) {
      const e = this.net.edges[cur];
      const node = f ? e.b : e.a;
      const opts = this.net.nodes[node].edges.filter((x) => x !== cur);
      if (!opts.length) break;
      // Prefer continuing straight and bigger roads.
      const dirIn = this.dirAtEnd(e, f);
      let best = opts[0], bs = -Infinity;
      for (const o of opts) {
        const oe = this.net.edges[o];
        const of = oe.a === node;
        const d = this.dirAtStart(oe, of);
        const straight = dirIn[0] * d[0] + dirIn[1] * d[1];
        const sc = straight * 1.5 + (oe.cls <= 1 ? 0.6 : 0) + this.rng.float() * 1.4;
        if (sc > bs) { bs = sc; best = o; }
      }
      const be = this.net.edges[best];
      f = be.a === node;
      cur = best;
      edges.push(cur);
      fw.push(f);
    }
    return { edges, fwd: fw };
  }

  private dirAtEnd(e: REdge, fwd: boolean): [number, number] {
    const p = e.pts, n = p.length;
    const dx = fwd ? p[n - 2] - p[n - 4] : p[0] - p[2], dz = fwd ? p[n - 1] - p[n - 3] : p[1] - p[3];
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  }
  private dirAtStart(e: REdge, fwd: boolean): [number, number] {
    const p = e.pts, n = p.length;
    const dx = fwd ? p[2] - p[0] : p[n - 4] - p[n - 2], dz = fwd ? p[3] - p[1] : p[n - 3] - p[n - 1];
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  }

  private tmp = { x: 0, z: 0, dx: 0, dz: 0 };

  /** World pose from lane position (or connector). */
  private pose(v: Vehicle, dt = 0): void {
    if (v.turn) {
      const T = v.turn, t = T.t, u = 1 - t;
      v.x = u * u * T.ax + 2 * u * t * T.cx + t * t * T.bx;
      v.z = u * u * T.az + 2 * u * t * T.cz + t * t * T.bz;
      const dx = 2 * u * (T.cx - T.ax) + 2 * t * (T.bx - T.cx), dz = 2 * u * (T.cz - T.az) + 2 * t * (T.bz - T.cz);
      v.yaw = Math.atan2(-dx, -dz);
    } else {
      const e = this.net.edges[v.edge];
      this.net.pointAt(e, v.s, this.laneOffset(e, v.fwd, v.lane), this.tmp);
      v.x = this.tmp.x; v.z = this.tmp.z;
      const dx = v.fwd ? this.tmp.dx : -this.tmp.dx, dz = v.fwd ? this.tmp.dz : -this.tmp.dz;
      v.yaw = Math.atan2(-dx, -dz);
    }
    this.settle(v, dt);
  }

  private roadY(x: number, z: number, hx: number, hz: number): number {
    return this.surface ? this.surface(x, z, hx, hz) : this.terrain.height(x, z);
  }

  /**
   * Height, pitch and roll on the road surface from its height under the axles and the
   * wheel tracks. Smoothed (dt > 0) so mesh seams and bridge joints do not make it twitch;
   * cars far from the player (not drawn in detail) refresh their attitude every other frame.
   */
  settle(v: Vehicle, dt = 0): void {
    const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
    const yc = this.roadY(v.x, v.z, fx, fz);
    const far = dt > 0 && (Math.abs(v.x - this.px) > 260 || Math.abs(v.z - this.pz) > 260);
    if (far && (v.id + this.frame) & 1) { v.y = yc; return; }
    const hb = v.length * 0.31, ht = v.width * 0.4;
    const yF = this.roadY(v.x + fx * hb, v.z + fz * hb, fx, fz), yB = this.roadY(v.x - fx * hb, v.z - fz * hb, fx, fz);
    // Right is (cos yaw, −sin yaw) for a vehicle facing (−sin yaw, −cos yaw).
    const rx = -fz, rz = fx;
    const yR = this.roadY(v.x + rx * ht, v.z + rz * ht, fx, fz), yL = this.roadY(v.x - rx * ht, v.z - rz * ht, fx, fz);
    const pitch = Math.atan2(yF - yB, hb * 2), roll = Math.atan2(yR - yL, ht * 2);
    const k = dt > 0 ? Math.min(1, dt * 10) : 1;
    v.pitch = (v.pitch ?? pitch) + (pitch - (v.pitch ?? pitch)) * k;
    v.roll = (v.roll ?? roll) + (roll - (v.roll ?? roll)) * k;
    // Wheels on the surface: over a crest the centre is the high point, in a dip the axles are.
    v.y = Math.max(yc, (yF + yB) / 2, (yL + yR) / 2);
  }

  private step(v: Vehicle, dt: number): void {
    v.stateT += dt;
    v.fear = Math.max(0, v.fear - dt * 0.05);
    if (v.state === VState.Wreck || v.state === VState.Crushed || v.state === VState.Abandoned) {
      if (v.stateT > 120) v.alive = false;
      return;
    }
    // Powers: frozen in place, or stalled by a lightning strike.
    const st = statusOf(v);
    if (st && (st.frozen > 0 || st.stunned > 0)) { v.speed = 0; v.brake = 1; return; }
    // Panic: some drivers abandon the car, others flee with a U-turn.
    if (v.fear > 0.8 && v.state === VState.Drive) {
      if (v.driver && (v.driver.nerve > 0.6 || v.speed < 2) && v.kind !== 'bus') {
        v.state = VState.Abandoned;
        v.speed = 0;
        v.brake = 1;
        v.indicator = 2; // hazards
        this.onAbandon?.(v);
        return;
      }
      v.state = VState.Fleeing;
      v.vmax *= 1.4;
      if (!v.turn) { v.fwd = !v.fwd; v.route = this.randomRoute(v.edge, v.fwd, 10); v.ri = 0; this.onHorn?.(v); }
    }
    if (v.turn) {
      // Junction connector at reduced speed (stopping for a robot in the way).
      let target = Math.min(v.vmax, 7);
      const og = this.obstacleAhead(v, 10);
      if (og < Infinity) target = Math.min(target, Math.sqrt(12 * Math.max(0, og - 0.3)));
      if (target < v.speed - 0.5) { v.speed = Math.max(target, v.speed - 9 * dt); v.brake = 1; }
      else v.speed += (target - v.speed) * Math.min(1, dt * 1.5);
      v.turn.t += (v.speed * dt) / v.turn.len;
      if (v.turn.t >= 1) {
        v.turn = null;
        v.ri++;
        v.edge = v.route.edges[v.ri];
        v.fwd = v.route.fwd[v.ri];
        const e = this.net.edges[v.edge];
        if (!e) { v.alive = false; return; }
        v.lane = Math.min(v.lane, e.lanes - 1);
        v.s = v.fwd ? junctionBack(e) : e.len - junctionBack(e);
        v.indicator = 0;
      }
      this.pose(v, dt);
      return;
    }
    const e = this.net.edges[v.edge];
    if (!e) { v.alive = false; return; }
    const along = v.fwd ? v.s : e.len - v.s; // distance travelled on this edge
    const remaining = e.len - along;
    // ---- leader: next car in the same lane, or the stop line, or a pedestrian on the road
    let gap = Infinity, leadV = 0;
    const lane = this.laneIndex.get(`${v.edge}:${v.fwd ? 1 : 0}:${v.lane}`);
    if (lane) {
      for (const o of lane) {
        if (o === v) continue;
        const oa = v.fwd ? o.s : e.len - o.s;
        if (oa > along) { const g = oa - along - (o.length + v.length) / 2; if (g < gap) { gap = g; leadV = o.speed; } break; }
      }
    }
    const node = v.fwd ? e.b : e.a;
    const hasNext = v.ri + 1 < v.route.edges.length;
    // Signals / yielding at the end of the edge.
    if (remaining < 45) {
      const stopAt = remaining - junctionBack(e) - v.length / 2 - 1.5;
      let mustStop = false;
      if (!this.signalGreen(node, e, this.t)) mustStop = true;
      else if (!this.net.nodes[node].signal && this.net.nodes[node].edges.length >= 3) {
        // Unsignalled junction: slow down; yield if something is in the box.
        if (this.junctionBusy(node, v)) mustStop = true;
      }
      if (!hasNext) mustStop = mustStop || false;
      if (mustStop && stopAt > -1 && stopAt < gap) { gap = Math.max(0, stopAt); leadV = 0; }
    }
    // Pedestrians on the road ahead (within the lane corridor).
    const pedGap = this.pedAhead(v, e);
    if (pedGap < gap) { gap = pedGap; leadV = 0; }
    // ---- IDM acceleration
    const a0 = v.state === VState.Fleeing ? 3.5 : 1.8, b0 = 3.5, T = 1.3, s0 = 2.2;
    const vmax = Math.min(v.vmax, this.speedLimit(e) * (v.state === VState.Fleeing ? 1.5 : 1)) * (remaining < 25 && hasNext ? 0.75 : 1);
    const sStar = s0 + Math.max(0, v.speed * T + (v.speed * (v.speed - leadV)) / (2 * Math.sqrt(a0 * b0)));
    let acc = a0 * (1 - Math.pow(v.speed / Math.max(0.1, vmax), 4) - (gap < Infinity ? (sStar / Math.max(0.1, gap)) ** 2 : 0));
    acc = Math.max(-9, Math.min(a0, acc));
    v.brake = acc < -0.5 ? Math.min(1, -acc / 4) : v.speed < 0.2 ? 0.6 : 0;
    v.speed = Math.max(0, v.speed + acc * dt);
    if (v.speed < 0.1) { v.wait += dt; if (v.wait > 25 && pedGap === Infinity) { this.onHorn?.(v); v.wait = 0; } } else v.wait = 0;
    // Advance.
    const ds = v.speed * dt;
    v.s += v.fwd ? ds : -ds;
    const remainingNow = v.fwd ? e.len - v.s : v.s;
    if (remainingNow <= junctionBack(e)) {
      if (!hasNext) {
        // Extend the route or vanish.
        const more = this.randomRoute(v.edge, v.fwd, 8);
        if (more.edges.length <= 1) { v.alive = false; return; }
        v.route = more;
        v.ri = 0;
      }
      this.beginTurn(v);
    }
    // Indicators before turning.
    if (remaining < 30 && hasNext && !v.turn) {
      const ne = this.net.edges[v.route.edges[v.ri + 1]];
      const di = this.dirAtEnd(e, v.fwd), dn = this.dirAtStart(ne, v.route.fwd[v.ri + 1]);
      const cross = di[0] * dn[1] - di[1] * dn[0];
      v.indicator = Math.abs(cross) > 0.4 ? (cross > 0 ? 1 : -1) : 0;
    }
    this.pose(v, dt);
  }

  private beginTurn(v: Vehicle): void {
    const e = this.net.edges[v.edge];
    const ne = this.net.edges[v.route.edges[v.ri + 1]];
    const nf = v.route.fwd[v.ri + 1];
    const a = { x: 0, z: 0, dx: 0, dz: 0 }, b = { x: 0, z: 0, dx: 0, dz: 0 };
    // Exit point (end of this edge, pulled back from the junction) and entry point of the next edge.
    const back = junctionBack(e);
    const fwdIn = junctionBack(ne);
    this.net.pointAt(e, v.fwd ? Math.min(v.s, e.len - back) : Math.max(v.s, back), this.laneOffset(e, v.fwd, v.lane), a);
    const lane = Math.min(v.lane, ne.lanes - 1);
    this.net.pointAt(ne, nf ? fwdIn : ne.len - fwdIn, this.laneOffset(ne, nf, lane), b);
    const node = v.fwd ? e.b : e.a;
    const n = this.net.nodes[node];
    // Control point: the node centre pulled towards the midpoint (smooth curve).
    const cx = (n.x * 2 + a.x + b.x) / 4, cz = (n.z * 2 + a.z + b.z) / 4;
    const len = Math.max(1, Math.hypot(cx - a.x, cz - a.z) + Math.hypot(b.x - cx, b.z - cz));
    v.turn = { ax: a.x, az: a.z, cx, cz, bx: b.x, bz: b.z, len, t: 0 };
    // Skip the part of the edges inside the junction.
    void fwdIn;
  }

  private junctionBusy(node: number, self: Vehicle): boolean {
    const n = this.net.nodes[node];
    for (const o of this.vehicles) {
      if (o === self || !o.turn) continue;
      if (Math.hypot(o.x - n.x, o.z - n.z) < 12) return true;
    }
    return false;
  }

  private pedAhead(v: Vehicle, e: REdge): number {
    const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
    let best = Infinity;
    const look = 6 + v.speed * 2.5;
    const nb = this.peds.neighbours(v.x + fx * look * 0.5, v.z + fz * look * 0.5, look * 0.6, this.nbTmp);
    for (const p of nb) {
      if (!p.onRoad && p.state !== 2) continue;
      const dx = p.x - v.x, dz = p.z - v.z;
      const along = dx * fx + dz * fz;
      const lat = Math.abs(dx * -fz + dz * fx);
      if (along < 0 || along > look || lat > v.width / 2 + 0.6) continue;
      const g = along - v.length / 2 - 0.5;
      if (g < best) best = g;
      // Too late to stop: the pedestrian is hit.
      if (g < 0.3 && v.speed > 4) this.hitPedestrian(v, p);
    }
    void e;
    best = Math.min(best, this.obstacleAhead(v, look));
    // The player counts as a pedestrian when on the road.
    if (this.player) {
      const dx = this.player.x - v.x, dz = this.player.z - v.z;
      const along = dx * fx + dz * fz;
      const lat = Math.abs(dx * -fz + dz * fx);
      if (along > 0 && along < look && lat < v.width / 2 + this.player.r && this.player.h > 0.25) best = Math.min(best, along - v.length / 2 - this.player.r);
    }
    return best;
  }
  /** Gap (m, from the front bumper) to the nearest obstacle in the lane corridor ahead. */
  private obstacleAhead(v: Vehicle, look: number): number {
    const O = this.obstacles;
    if (!O.length) return Infinity;
    const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
    const reach = look + v.length;
    let best = Infinity;
    for (const o of O) {
      const dx = o.x - v.x, dz = o.z - v.z;
      if (dx > reach || dx < -reach || dz > reach || dz < -reach) continue;
      const along = dx * fx + dz * fz;
      if (along < -v.length * 0.25 || along > look + v.length / 2 + o.r) continue;
      if (Math.abs(dx * -fz + dz * fx) > v.width / 2 + o.r + 0.35) continue;
      best = Math.min(best, along - v.length / 2 - o.r - 0.6);
    }
    return best;
  }
  private nbTmp: PedAgent[] = [];
  player: { x: number; z: number; r: number; h: number } | null = null;
  onHitPed?: (v: Vehicle, p: PedAgent) => void;

  private hitPedestrian(v: Vehicle, p: PedAgent): void {
    if (p.state === 5) return;
    this.onHitPed?.(v, p);
    v.speed *= 0.6;
    v.damage = Math.min(1, v.damage + 0.15);
  }

  /** Pedestrian wants to step on the road: wait if a car is close on that street. */
  safeToCross(a: PedAgent): boolean {
    for (const v of this.vehicles) {
      if (v.state !== VState.Drive && v.state !== VState.Fleeing) continue;
      const d = Math.hypot(v.x - a.x, v.z - a.z);
      if (d > 30) continue;
      // Approaching: moving towards the pedestrian.
      const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
      if ((a.x - v.x) * fx + (a.z - v.z) * fz > 0 && v.speed > 1.5) return false;
    }
    return true;
  }

  /** Flatten a car (giant foot, debris). */
  crush(v: Vehicle): void {
    if (v.state === VState.Crushed) return;
    v.state = VState.Crushed;
    v.stateT = 0;
    v.speed = 0;
    v.damage = 1;
    this.onCrash?.(v, v.x, v.y, v.z, 10);
  }

  /** A strong impulse turns the car into a physical wreck (handled by the renderer/physics). */
  wreckIt(v: Vehicle): void {
    if (v.state === VState.Wreck || v.state === VState.Crushed) return;
    v.state = VState.Wreck;
    v.stateT = 0;
    v.damage = Math.max(v.damage, 0.7);
  }

  near(x: number, z: number, r: number): Vehicle[] {
    return this.vehicles.filter((v) => Math.hypot(v.x - x, v.z - z) < r + v.length / 2);
  }
}

/** Distance from an edge end at which the junction box begins. */
export function junctionBack(e: REdge): number {
  return Math.min(e.len * 0.3, e.width * 0.55 + 2.5);
}

/**
 * Vehicles as player obstacles (oriented boxes): moving traffic, parked cars and wrecks.
 * A coarse grid is rebuilt at most every 30 ms; queries are then a few cell lookups.
 */
export class VehicleObstacles {
  private grid = new Map<number, Obstacle[]>();
  private built = -1e9;
  private pool: Obstacle[] = [];

  constructor(private list: () => Vehicle[]) {}

  readonly provider: ObstacleProvider = (x0, z0, x1, z1, out) => {
    const now = performance.now();
    if (now - this.built > 30) { this.built = now; this.rebuild(); }
    const i0 = Math.floor((x0 - 8) / 16), i1 = Math.floor((x1 + 8) / 16), j0 = Math.floor((z0 - 8) / 16), j1 = Math.floor((z1 + 8) / 16);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const l = this.grid.get((i + 32768) * 65536 + (j + 32768));
      if (!l) continue;
      for (const o of l) {
        const ext = Math.max(o.hx, o.hz);
        if (o.x + ext < x0 || o.x - ext > x1 || o.z + ext < z0 || o.z - ext > z1) continue;
        out(o);
      }
    }
  };

  private rebuild(): void {
    this.grid.clear();
    let n = 0;
    for (const v of this.list()) {
      if (!v.alive) continue;
      const o = this.pool[n] ?? (this.pool[n] = { cyl: false, x: 0, z: 0, r: 0, hx: 0, hz: 0, ux: 1, uz: 0, y0: 0, y1: 0 });
      n++;
      // Forward is (−sin yaw, −cos yaw) (see Traffic.pose).
      o.x = v.x; o.z = v.z; o.ux = -Math.sin(v.yaw); o.uz = -Math.cos(v.yaw);
      o.hx = v.length / 2; o.hz = v.width / 2;
      const h = v.state === VState.Crushed ? 0.5 : v.kind === 'bus' || v.kind === 'truck' ? 3.1 : v.kind === 'van' || v.kind === 'delivery' || v.kind === 'shuttle' ? 2.5 : v.kind === 'suv' || v.kind === 'pickup' ? 1.85 : 1.5;
      o.y0 = v.y - 0.2; o.y1 = v.y + h;
      const k = (Math.floor(v.x / 16) + 32768) * 65536 + (Math.floor(v.z / 16) + 32768);
      let l = this.grid.get(k);
      if (!l) this.grid.set(k, (l = []));
      l.push(o);
    }
  }
}
