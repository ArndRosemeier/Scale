/**
 * Pedestrian agents: the local, visible tier of the population.
 *
 * Buildings near the player are scanned (nearest first, time-budgeted). Each
 * citizen's day plan yields trips; walking legs that are under way now are
 * materialised as agents on their real sidewalk route at the right progress,
 * later departures are queued as events. Agents walk their route (sidewalk
 * side, crossings at junctions), avoid each other, enter buildings at the
 * door and despawn when far away — the abstract schedule continues unseen.
 */
import { pointInPoly, polylineLength } from '../core/geom2';
import type { RoadNet } from './RoadNet';
import { Population, type Citizen, type PlaceRef, type Trip, Mode, Role, doorOf } from './Population';
import type { CityStreamer } from '../stream/CityStreamer';
import type { WorldIndex, BuildingRef } from '../world/WorldIndex';
import type { Terrain } from '../world/terrain';
import type { MacroPlan } from '../plan/types';
import { MinHeap } from '../core/heap';
import { CURB_H } from '../build/ground';
import { hashToFloat, hash32 } from '../core/rng';
import { ACCIDENTS } from '../game/abilities/tuning';
import { statusOf } from '../shared/status';
import { type Actor, watchProgress } from './actors/Actor';
import { gawkFor } from '../game/people/behaviour';

export const enum PState { Walk = 0, Wait = 1, Idle = 2, Gawk = 3, Flee = 4, Down = 5, Enter = 6, Film = 7, Sit = 8, Sleep = 9 }

export interface PedAgent {
  id: number;
  cit: Citizen;
  x: number; z: number; y: number;
  heading: number;
  speed: number;
  /** Preferred walking speed. */
  pref: number;
  state: PState;
  /** Waypoints x,z,flags(1 = on road) */
  route: Float32Array;
  wp: number;
  /** Destination door (to enter) or null (despawn when done). */
  dest: { x: number; z: number } | null;
  fear: number;
  fearX: number; fearZ: number;
  lookX: number; lookZ: number; lookY: number;
  stateT: number;
  onRoad: boolean;
  /** Animation phase (for the crowd renderer). */
  phase: number;
  /** Visual seed (appearance). */
  look: number;
  /** Vertical velocity / knock-down physics. */
  vy: number;
  vx: number; vz: number;
  alive: boolean;
  /** Index into renderer slots (-1 none). */
  slot: number;
  /** Walking to a parked car: where the car will drive to. */
  carDest?: { x: number; z: number };
  /** Placed inside a building (interior): no street movement. */
  inside?: boolean;
  floorY?: number;
  /**
   * Indoors in a landmark one walks into (sim/LandmarkCrowds walks them): in plain view, so the
   * hero bumps into them and can hit them like anyone on the street.
   */
  hall?: boolean;
  /** Underground (a sewer hideout's crew): walks the tunnels' and rooms' floors (Pedestrians.underFloor), never the street. */
  under?: boolean;
  /** Why the agent is down (Down state): the player's doing, a collapse, an accident, other (cars). */
  downBy?: DownCause;
  /** Helped up by the player (thanks them: a wave while stateT is small). */
  helped?: boolean;
  /** Stepping aside for a robot: extra sideways velocity (m/s) for sideT more seconds. */
  sideX?: number; sideZ?: number; sideT?: number;
  /** Glancing at something (lookX/Y/Z) while going on: seconds left. */
  glance?: number;
  /** Actor layer (crimes, police, small deeds): driven by its owner, see sim/actors/Actor.ts. */
  actor?: Actor;
  /** A ragdoll owns the body (tumbling, lying or getting up: physics/ragdoll); no movement here. */
  ragdoll?: boolean;
  /** Walking: nearest distance yet to the current waypoint, and seconds without getting closer. */
  wpD?: number;
  stall?: number;
  /** Seconds spent gawking / filming lately (see gawkOver); it wears off while walking on. */
  gawkT?: number;
  /**
   * Evacuating (a civil-defence siren): walking its route to a metro entrance at this multiple
   * of the usual pace, vanishing down the stairs at the end (set by the city response).
   */
  evac?: number;
  /** Terrain height under the agent (`gh`) and where it was sampled (see Pedestrians.groundOf). */
  gx?: number; gz?: number; gh?: number;
  /**
   * In the air under its own power (the sidekick flying, game/sidekick/Companion; or carried off by
   * med drones): its owner moves it, no walking and no ground here. `fly` poses the body for flight
   * (the hero's flight pose: tilt 0…1 into the horizontal, bank into turns, boost).
   */
  airborne?: boolean;
  fly?: { tilt: number; bank: number; boost: number };
}

/** Gawkers per incident (people already standing and looking within GAWK_R m count). */
export const GAWK_CROWD = 24;
export const GAWK_R = 25;
/** Longest a gawker stays (s), whatever keeps happening; after that they walk on and are bored. */
export const GAWK_MAX = 40;
/** Bored of gawking (gawkT above this): new incidents no longer make them stop. */
export const GAWK_BORED = 20;

/** May this agent start gawking (not bored of it)? */
export function canGawk(a: PedAgent): boolean {
  return (a.gawkT ?? 0) < GAWK_BORED;
}

/**
 * Gawking / filming bookkeeping per step: true when the agent should walk on (looked long
 * enough for their curiosity and calm, or gawked GAWK_MAX s in all, re-triggered or not).
 */
export function gawkOver(a: PedAgent, dt: number): boolean {
  a.gawkT = (a.gawkT ?? 0) + dt;
  return (a.stateT > gawkFor(a.cit.curiosity, a.look) && a.fear < 0.3) || a.gawkT > GAWK_MAX;
}

/** Stopped-and-looking agents within r of a point. */
export function gawkersNear(peds: { neighbours(x: number, z: number, r: number, out: PedAgent[]): PedAgent[] }, x: number, z: number, r: number, tmp: PedAgent[]): number {
  let n = 0;
  for (const o of peds.neighbours(x, z, r, tmp)) if ((o.state === PState.Gawk || o.state === PState.Film) && Math.hypot(o.x - x, o.z - z) < r) n++;
  return n;
}

/** ('brush': a super speed runner brushed past, a stumble that is nobody's misdeed.) */
export type DownCause = 'player' | 'brush' | 'collapse' | 'accident' | 'threat' | 'police' | 'military' | 'other';

const MAX_AGENTS = 2600;
/** An agent's cached terrain height is reused within this distance (m) of where it was sampled. */
const GROUND_REUSE = 0.4;
/** Extra room above MAX_AGENTS for actors (crime, police, deeds: budget 40). */
const ACTOR_RESERVE = 48;
const SCAN_R = 480;
const DESPAWN_R = 620;
/** A remembered person's body appears at most this far from where they plausibly are (m). */
const PIN_R = 40;
/** Underground walkers never step down further than this (off a platform onto the tracks). */
const UNDER_DROP = 0.6;
const HASH = 1 << 14;

interface Pending { cit: Citizen; trip: Trip }

export class Pedestrians {
  readonly agents: PedAgent[] = [];
  private byId = new Map<number, PedAgent>();
  // Building → day scanned. Weak: refs die with their cell (a strong map kept every unloaded
  // cell - meshes, CPU geometry, plan - alive and ran big cities out of memory).
  private scanned = new WeakMap<BuildingRef, number>();
  private events = new MinHeap();
  private pending: Pending[] = [];
  private freePending: number[] = [];
  private scanQueue: BuildingRef[] = [];
  private lastScan = -100;
  private head = new Int32Array(HASH).fill(-1);
  private nextIdx = new Int32Array(4096);
  private frame = 0;
  private nextId = 1;
  private hours = 0;
  stats = { scannedBuildings: 0, citizens: 0, spawned: 0 };
  /** Share of walks that still happen (render/Weather: fewer people set out in the rain). */
  outdoorShare = 1;
  /** Walking pace factor (people hurry in the rain). */
  paceK = 1;

  constructor(
    readonly pop: Population,
    private net: RoadNet,
    private world: WorldIndex,
    private terrain: Terrain,
    private macro: MacroPlan,
    private streamer: CityStreamer,
  ) {}

  /** Absolute game time in hours. */
  update(dt: number, hours: number, px: number, pz: number, gameDt: number): void {
    this.hours = hours;
    // ---- scanning buildings (nearest first, budgeted)
    if (hours - this.lastScan > 0.02 || this.scanQueue.length === 0) {
      this.lastScan = hours;
      const day = Math.floor(hours / 24);
      const refs = this.world.buildingsIn(px - SCAN_R, pz - SCAN_R, px + SCAN_R, pz + SCAN_R);
      this.scanQueue = refs.filter((r) => this.scanned.get(r) !== day);
      this.scanQueue.sort((a, b) => dist2(a, px, pz) - dist2(b, px, pz));
    }
    // Budgeted per citizen (a tower can house hundreds), then spawning (path finding) per agent.
    const t0 = performance.now();
    const day = Math.floor(hours / 24);
    while (performance.now() - t0 < 2.0) {
      if (!this.citQueue.length) {
        if (!this.scanQueue.length) break;
        this.queueBuilding(this.scanQueue.shift()!, day);
        continue;
      }
      this.scanCitizen(this.citQueue.pop()!, day);
    }
    const t1 = performance.now();
    while (this.spawnQueue.length && performance.now() - t1 < 1.5) {
      const s = this.spawnQueue.shift()!;
      if (this.agents.length < MAX_AGENTS) this.materialise(s.cit, s.trip, s.progress, this.lastPx, this.lastPz);
    }
    // ---- departures due now
    while (this.events.size && this.events.peekPriority() <= hours) {
      const idx = this.events.pop();
      const p = this.pending[idx];
      this.freePending.push(idx);
      if (!p) continue;
      this.pending[idx] = undefined as unknown as Pending;
      if (this.agents.length < MAX_AGENTS) this.spawnQueue.push({ cit: p.cit, trip: p.trip, progress: 0 });
    }
    // ---- agents (distant ones update round-robin at a quarter of the rate)
    this.rebuildGrid();
    this.frame++;
    for (let i = this.agents.length - 1; i >= 0; i--) {
      const a = this.agents[i];
      const d = Math.hypot(a.x - px, a.z - pz);
      if (d > 160 && a.state !== PState.Flee && a.state !== PState.Down) {
        if ((i + this.frame) % 4 === 0) this.step(a, dt * 4, gameDt * 4);
      } else if (d > 160 && a.state === PState.Flee) {
        // A mass flight (a monster, an evacuation): the far runners at half the rate.
        if ((i + this.frame) % 2 === 0) this.step(a, dt * 2, gameDt * 2);
      } else this.step(a, dt, gameDt);
      if (!a.alive || (d > DESPAWN_R && !a.actor?.pinned)) this.remove(i);
    }
  }

  private citQueue: { c: Citizen; ref: BuildingRef }[] = [];
  private spawnQueue: { cit: Citizen; trip: Trip; progress: number }[] = [];
  /** Citizens never seen in the streets again (a sidekick who died: game/sidekick). */
  readonly absent = new Set<number>();

  private queueBuilding(ref: BuildingRef, day: number): void {
    this.scanned.set(ref, day);
    this.stats.scannedBuildings++;
    const cits = [...this.pop.residentsOf(ref.cell.id, ref.index, ref.desc), ...this.pop.workersOf(ref.cell.id, ref.index, ref.desc)];
    this.stats.citizens += cits.length;
    for (let i = cits.length - 1; i >= 0; i--) this.citQueue.push({ c: cits[i], ref });
  }

  private scanCitizen(q: { c: Citizen; ref: BuildingRef }, day: number): void {
    const { c, ref } = q;
    const h = this.hours;
    {
      // Trips of today and the next 6 hours of tomorrow.
      for (const d of [day, day + 1]) {
        const plan = this.pop.dayPlan(c, d);
        for (let i = 0; i < plan.trips.length; i++) {
          const tr = plan.trips[i];
          if (tr.mode !== Mode.Walk && tr.mode !== Mode.Metro && tr.mode !== Mode.Car) continue;
          const end = plan.stays[i + 1]?.from ?? tr.depart + 0.3;
          if (h >= tr.depart && h < end) {
            if (this.agents.length < MAX_AGENTS && !this.taken(c.id)) this.spawnQueue.push({ cit: c, trip: tr, progress: (h - tr.depart) / Math.max(1e-6, end - tr.depart) });
          } else if (tr.depart > h && tr.depart < h + 6) {
            const idx = this.freePending.length ? this.freePending.pop()! : this.pending.length;
            this.pending[idx] = { cit: c, trip: tr };
            this.events.push(tr.depart, idx);
          }
        }
      }
    }
  }

  private lastPx = 0;
  private lastPz = 0;
  setPlayer(x: number, z: number): void { this.lastPx = x; this.lastPz = z; }

  /** The agent of a citizen, while they are out and about near the player (or null). */
  agentOf(citId: number): PedAgent | null {
    return this.byId.get(citId) ?? null;
  }

  /** Has a body already, or never comes out again (`absent`). */
  private taken(citId: number): boolean {
    return this.byId.has(citId) || this.absent.has(citId);
  }

  /** Where a place is: its building's door while the cell is loaded, else the cell's centre (null: unknown cell). */
  placeSpot(p: PlaceRef): { x: number; z: number; exact: boolean } | null {
    const ref = this.resolve(p);
    if (ref) { const d = doorOf(ref.desc); return { x: d.x, z: d.z, exact: true }; }
    const c = this.macro.cells[p.cell]?.centroid;
    return c ? { x: c[0], z: c[1], exact: false } : null;
  }

  /** Resolve a place to a concrete building in a loaded cell (or null). */
  private resolve(p: PlaceRef): BuildingRef | null {
    const cs = this.streamer.cells.get(p.cell);
    if (!cs || !cs.plan || !cs.plan.buildings.length) return null;
    let b = p.b;
    if (b < 0) {
      const list = cs.plan.buildings;
      // Pick a suitable building by kind: shops/food → shopfront or retail, home → residential.
      const ok = list.map((d, i) => ({ d, i })).filter(({ d }) =>
        p.kind === 'home' ? d.units > 0 : p.kind === 'shop' || p.kind === 'food' ? d.shopfront || d.use === 'retail' : p.kind === 'leisure' ? d.shopfront || d.use === 'retail' || d.use === 'civic' : true);
      const pool = ok.length ? ok : list.map((d, i) => ({ d, i }));
      b = pool[p.pick % pool.length].i;
    }
    const refs = this.world.buildingsIn(cs.plan.buildings[b].poly[0] - 1, cs.plan.buildings[b].poly[1] - 1, cs.plan.buildings[b].poly[0] + 1, cs.plan.buildings[b].poly[1] + 1);
    return refs.find((r) => r.cell === cs && r.index === b) ?? null;
  }

  private materialise(c: Citizen, trip: Trip, progress: number, px: number, pz: number): void {
    if (this.taken(c.id)) return;
    const from = this.resolve(trip.from);
    const to = this.resolve(trip.to);
    // Walking legs: door to door. Metro: door ↔ nearest station. Car: door ↔ kerb (short walk).
    let ax: number, az: number, bx: number, bz: number;
    let dest: { x: number; z: number } | null = null;
    if (from) { const d = doorOf(from.desc); ax = d.x; az = d.z; }
    else { const cc = this.macro.cells[trip.from.cell]?.centroid; if (!cc) return; ax = cc[0]; az = cc[1]; }
    if (to) { const d = doorOf(to.desc); bx = d.x; bz = d.z; dest = { x: bx, z: bz }; }
    else { const cc = this.macro.cells[trip.to.cell]?.centroid; if (!cc) return; bx = cc[0]; bz = cc[1]; }
    if (trip.mode === Mode.Metro) {
      // Walk to/from the nearest station within 900 m of the loaded endpoint.
      const st = this.nearestStation(from ? ax : bx, from ? az : bz);
      if (!st) return;
      if (from) { bx = st.x; bz = st.z; dest = { x: bx, z: bz }; }
      else { ax = st.x; az = st.z; }
    } else if (trip.mode === Mode.Car) {
      // Short walk to a parked car / from it: model as walking to the nearest kerb then vanishing.
      const e = this.net.nearestEdge(from ? ax : bx, from ? az : bz, 60);
      if (!e) return;
      const o = { x: 0, z: 0, dx: 0, dz: 0 };
      this.net.pointAt(this.net.edges[e.e], e.s + (from ? 6 : -6), e.side * (this.net.edges[e.e].width / 2 - 1.2), o);
      if (from) { this.pendingCarDest = { x: bx, z: bz }; bx = o.x; bz = o.z; dest = null; } else { ax = o.x; az = o.z; }
      if (!from) progress = Math.max(progress, 0);
    }
    // Skip legs that never come near the player.
    if (distSegPoint(ax, az, bx, bz, px, pz) > DESPAWN_R * 0.9) return;
    // Bad weather: some walks are not made (taken by car or metro, or put off; unseen) and fewer
    // walk to the car or the station.
    if (this.outdoorShare < 1 && hashToFloat(hash32(c.seed * 31 + Math.floor(trip.depart * 60))) > (trip.mode === Mode.Walk ? this.outdoorShare : 1 - (1 - this.outdoorShare) * 0.5)) return;
    // Shelter in place: nobody sets out into a district under a civil-defence alert.
    if (this.shelter?.(ax, az, bx, bz)) return;
    const route = this.buildRoute(ax, az, bx, bz);
    if (!route) return;
    const a = this.walker(c, route, dest);
    // Place along the route by progress.
    if (this.pendingCarDest) { a.carDest = this.pendingCarDest; this.pendingCarDest = null; }
    // (A remembered person appears only near where they plausibly are, not where the schedule ran ahead to.)
    const pin = this.placeFor?.(c);
    if (pin) {
      const at = routeNearest(route, pin.x, pin.z);
      if (at.d > PIN_R) return;
      this.advanceAlong(a, at.along);
    } else if (progress > 0) this.advanceAlong(a, progress * polylineLength(route, 3));
    // (Already under way: not where an alert keeps people indoors either.)
    if (progress > 0 && this.shelter?.(a.x, a.z, a.x, a.z)) return;
    a.y = this.groundY(a.x, a.z, a.onRoad, a.heading);
    this.agents.push(a);
    this.byId.set(c.id, a);
    this.stats.spawned++;
  }

  /** A walker at the start of a route. */
  private walker(c: Citizen, route: Float32Array, dest: { x: number; z: number } | null): PedAgent {
    const r = hashToFloat(hash32(c.seed));
    // (Brisk or dawdling by their personality: game/people.)
    const pref = (c.role === Role.Child ? 1.25 + r * 0.3 : c.role === Role.Senior ? 0.9 + r * 0.3 : 1.25 + r * 0.35) * (this.paceOf?.(c) ?? 1);
    return {
      id: this.nextId++, cit: c, x: route[0], z: route[1], y: 0, heading: 0, speed: pref, pref, state: PState.Walk, route, wp: 1, dest,
      fear: 0, fearX: 0, fearZ: 0, lookX: 0, lookZ: 0, lookY: 0, stateT: 0, onRoad: false, phase: r * 10, look: c.seed, vy: 0, vx: 0, vz: 0, alive: true, slot: -1, gx: 1e9, gz: 1e9, gh: 0,
    };
  }

  /**
   * Put a remembered citizen back in the street where they plausibly are (x, z), walking on to a
   * place (their trip's end, or where they are staying). The schedule only offers each walk once a
   * day, so this is how you find them again after their body went out of range. Null: not now
   * (no walkway near there, already there, the street is full).
   */
  bringBack(c: Citizen, x: number, z: number, to: PlaceRef): PedAgent | null {
    if (this.taken(c.id) || this.agents.length >= MAX_AGENTS) return null;
    const ref = this.resolve(to);
    let bx: number, bz: number, dest: { x: number; z: number } | null = null;
    if (ref) { const d = doorOf(ref.desc); bx = d.x; bz = d.z; dest = { x: bx, z: bz }; }
    else { const cc = this.macro.cells[to.cell]?.centroid; if (!cc) return null; bx = cc[0]; bz = cc[1]; }
    if (Math.hypot(bx - x, bz - z) < 4) return null;
    const route = this.buildRoute(x, z, bx, bz);
    if (!route || Math.hypot(route[0] - x, route[1] - z) > PIN_R * 2) return null;
    const a = this.walker(c, route, dest);
    a.y = this.groundY(a.x, a.z, a.onRoad, a.heading);
    this.agents.push(a);
    this.byId.set(c.id, a);
    this.stats.spawned++;
    return a;
  }

  private pendingCarDest: { x: number; z: number } | null = null;
  /** At the end of its route: true when someone else takes the agent over (it is not removed). */
  onArrive?: (a: PedAgent) => boolean;
  /** Called when an agent reaches its parked car (trip continues by car). */
  onCarReady?: (a: PedAgent) => void;
  /**
   * Where a citizen plausibly is now (a remembered person: People keeps them moving at walking
   * pace), or null: wherever the schedule says. Their schedule's body only appears near it.
   */
  placeFor?: (c: Citizen) => { x: number; z: number } | null;
  /** A walker's pace multiplier by who they are (game/people: brisk or dawdling), 1 when unset. */
  paceOf?: (c: Citizen) => number;
  /** A trip from a to b is not started (people stay where they are: an alert over the district). */
  shelter?: (ax: number, az: number, bx: number, bz: number) => boolean;

  /** Street end (top of the stairs) of the nearest metro entrance within r, from the loaded cells. */
  entranceNear?: (x: number, z: number, r: number) => { x: number; z: number } | null;

  /** Where metro riders vanish into / come out of the station: a real entrance's stair top. (The
   *  station centre was used before; since halls follow the tracks it can lie inside a block, and
   *  riders coming out there piled up by the hundreds.) */
  private nearestStation(x: number, z: number): { x: number; z: number } | null {
    return this.entranceNear?.(x, z, 900) ?? null;
  }

  /** Sidewalk route between two points: along graph edges, offset to the sidewalk. */
  buildRoute(ax: number, az: number, bx: number, bz: number): Float32Array | null {
    const E = this.net.edges;
    const sideOff = (eid: number) => E[eid].width / 2 + E[eid].sidewalk * 0.5;
    const tmp = { x: 0, z: 0, dx: 0, dz: 0 };
    // Access street of each end: the nearest one whose door↔sidewalk connector does not
    // pass through a building. Without one, the end is the sidewalk itself (no wall walking).
    const access = (x: number, z: number) => {
      const cands = this.net.nearestEdges(x, z, 150, 5);
      for (const c of cands) {
        this.net.pointAt(E[c.e], c.s, c.side * sideOff(c.e), tmp);
        if (this.clearOfBuildings(x, z, tmp.x, tmp.z)) return { ...c, clear: true, px: tmp.x, pz: tmp.z };
      }
      const c = cands[0];
      if (!c) return null;
      this.net.pointAt(E[c.e], c.s, c.side * sideOff(c.e), tmp);
      return { ...c, clear: false, px: tmp.x, pz: tmp.z };
    };
    const ea = access(ax, az), eb = access(bx, bz);
    if (!ea || !eb) return null;
    if (!ea.clear) { ax = ea.px; az = ea.pz; }
    if (!eb.clear) { bx = eb.px; bz = eb.pz; }
    const out: number[] = [ax, az, 0];
    if (ea.e === eb.e) {
      // Same street: walk along it.
      const e = E[ea.e];
      const steps = Math.max(1, Math.ceil(Math.abs(eb.s - ea.s) / 6));
      for (let k = 0; k <= steps; k++) {
        this.net.pointAt(e, ea.s + ((eb.s - ea.s) * k) / steps, ea.side * sideOff(ea.e), tmp);
        out.push(tmp.x, tmp.z, 0);
      }
      if (ea.side !== eb.side) { this.net.pointAt(e, eb.s, eb.side * sideOff(eb.e), tmp); out.push(tmp.x, tmp.z, 1); }
      out.push(bx, bz, 0);
      return Float32Array.from(out);
    }
    // Route between the nearer ends.
    const startNode = this.net.edgeEndNear(ea.e, ea.s), endNode = this.net.edgeEndNear(eb.e, eb.s);
    const r = this.net.route(startNode, endNode, false, 6000);
    if (!r) return null;
    // Edge list: first edge (partial), route edges, last edge (partial).
    type Leg = { e: number; s0: number; s1: number };
    const legs: Leg[] = [];
    const ea0 = E[ea.e];
    legs.push({ e: ea.e, s0: ea.s, s1: startNode === ea0.a ? 0 : ea0.len });
    r.edges.forEach((eid, i) => legs.push({ e: eid, s0: r.fwd[i] ? 0 : E[eid].len, s1: r.fwd[i] ? E[eid].len : 0 }));
    const eb0 = E[eb.e];
    legs.push({ e: eb.e, s0: endNode === eb0.a ? 0 : eb0.len, s1: eb.s });
    // Side per leg: keep the walking side relative to travel direction where possible; final leg = destination side.
    let side = legs[0].s1 >= legs[0].s0 ? ea.side : -ea.side; // side relative to travel direction (+1 = right)
    for (let li = 0; li < legs.length; li++) {
      const L = legs[li];
      const e = E[L.e];
      const dirSign = L.s1 >= L.s0 ? 1 : -1;
      if (li === legs.length - 1) {
        const want = eb.side * dirSign;
        if (want !== side) {
          // Cross this street at its start (near the junction).
          this.net.pointAt(e, L.s0 + dirSign * Math.min(4, e.len / 2), side * dirSign * sideOff(L.e), tmp);
          out.push(tmp.x, tmp.z, 0);
          side = want;
          this.net.pointAt(e, L.s0 + dirSign * Math.min(4, e.len / 2), side * dirSign * sideOff(L.e), tmp);
          out.push(tmp.x, tmp.z, 1);
        }
      }
      const len = Math.abs(L.s1 - L.s0);
      const steps = Math.max(1, Math.ceil(len / 8));
      // Pull back from junction centres so corners are walked on the sidewalk, not across the road.
      const inset = Math.min(len / 2.2, e.width / 2 + 1);
      for (let k = 0; k <= steps; k++) {
        let s = L.s0 + ((L.s1 - L.s0) * k) / steps;
        if (k === 0 && li > 0) s = L.s0 + dirSign * inset;
        if (k === steps && li < legs.length - 1) s = L.s1 - dirSign * inset;
        this.net.pointAt(e, s, side * dirSign * sideOff(L.e), tmp);
        // A waypoint is "on road" if it connects across a carriageway (handled at corners below).
        out.push(tmp.x, tmp.z, 0);
      }
      // Corner: the next leg starts on the same side relative to travel; if the turn is toward the
      // walking side we round the block corner, otherwise we cross the side street.
      if (li < legs.length - 1) {
        const N = legs[li + 1];
        const en = E[N.e];
        const nd = N.s1 >= N.s0 ? 1 : -1;
        this.net.pointAt(en, N.s0 + nd * Math.min(en.len / 2.2, en.width / 2 + 1), side * nd * sideOff(N.e), tmp);
        // crossing check: the connector crosses a street if the straight line passes near either centreline end
        out.push(tmp.x, tmp.z, crossesStreet(out[out.length - 3], out[out.length - 2], tmp.x, tmp.z, this.net, L.e, N.e) ? 1 : 0);
      }
    }
    out.push(bx, bz, 0);
    return Float32Array.from(out);
  }

  /** Does the segment stay out of building footprints (ignoring 0.6 m at both ends: doors)? */
  private clearOfBuildings(x0: number, z0: number, x1: number, z1: number): boolean {
    const L = Math.hypot(x1 - x0, z1 - z0);
    if (L < 1.3) return true;
    const ux = (x1 - x0) / L, uz = (z1 - z0) / L;
    const ax = x0 + ux * 0.6, az = z0 + uz * 0.6, bx = x1 - ux * 0.6, bz = z1 - uz * 0.6;
    const refs = this.world.buildingsIn(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz));
    for (const r of refs) {
      const P = r.poly, n = P.length / 2;
      if (pointInPoly(P, (ax + bx) / 2, (az + bz) / 2) || pointInPoly(P, ax, az) || pointInPoly(P, bx, bz)) return false;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (segsCross(ax, az, bx, bz, P[i * 2], P[i * 2 + 1], P[j * 2], P[j * 2 + 1])) return false;
      }
    }
    return true;
  }

  private advanceAlong(a: PedAgent, dist: number): void {
    const R = a.route;
    while (dist > 0 && a.wp < R.length / 3) {
      const tx = R[a.wp * 3], tz = R[a.wp * 3 + 1];
      const d = Math.hypot(tx - a.x, tz - a.z);
      if (d <= dist) { a.x = tx; a.z = tz; dist -= d; a.onRoad = R[a.wp * 3 + 2] > 0.5; a.wp++; }
      else { a.x += ((tx - a.x) / d) * dist; a.z += ((tz - a.z) / d) * dist; dist = 0; }
    }
  }

  /**
   * Walking height: the street (or the kerb) — or a bridge deck when walking along the bridge or
   * already up on it (`heading`, `yRef`); a path on the bank passing under a bridge stays below.
   */
  private groundY(x: number, z: number, onRoad: boolean, heading = NaN, yRef = NaN): number {
    return this.groundOver(this.terrain.height(x, z), x, z, onRoad, heading, yRef);
  }

  /**
   * groundY for a walking agent: the terrain height is cached per agent while it stays within
   * GROUND_REUSE of where it was sampled (terrain.height — noise, rivers, coast — was the
   * single largest cost of stepping 2600 people, and most of the garbage).
   */
  private groundOf(a: PedAgent, heading = NaN, yRef = NaN): number {
    const dx = a.x - (a.gx ?? 1e9), dz = a.z - (a.gz ?? 1e9);
    if (!(dx * dx + dz * dz <= GROUND_REUSE * GROUND_REUSE)) { a.gx = a.x; a.gz = a.z; a.gh = this.terrain.height(a.x, a.z); }
    return this.groundOver(a.gh!, a.x, a.z, a.onRoad, heading, yRef);
  }

  private groundOver(terrainY: number, x: number, z: number, onRoad: boolean, heading: number, yRef: number): number {
    const g = terrainY + (onRoad ? 0 : CURB_H);
    const deck = this.world.bridgeDeck(x, z);
    if (deck === -Infinity || deck <= g) return g;
    if (Math.abs(yRef - deck) < 1.5) return deck;
    if (Number.isNaN(heading)) return g;
    return this.world.bridgeDeck(x, z, -Math.sin(heading), -Math.cos(heading)) > -Infinity ? deck : g;
  }

  private rebuildGrid(): void {
    this.head.fill(-1);
    if (this.nextIdx.length < this.agents.length) this.nextIdx = new Int32Array(this.agents.length * 2);
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      const h = hashCell(Math.floor(a.x / 4), Math.floor(a.z / 4));
      this.nextIdx[i] = this.head[h];
      this.head[h] = i;
    }
  }

  neighbours(x: number, z: number, r: number, out: PedAgent[]): PedAgent[] {
    out.length = 0;
    const i0 = Math.floor((x - r) / 4), i1 = Math.floor((x + r) / 4), j0 = Math.floor((z - r) / 4), j1 = Math.floor((z + r) / 4);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      let k = this.head[hashCell(i, j)];
      while (k >= 0) {
        const a = this.agents[k];
        if (a && Math.floor(a.x / 4) === i && Math.floor(a.z / 4) === j) out.push(a);
        k = this.nextIdx[k];
      }
    }
    return out;
  }

  private nb: PedAgent[] = [];

  /** Behaviour + movement of one agent. Reactions are applied by the Reactions module (fear, look). */
  private step(a: PedAgent, dt: number, _gameDt: number): void {
    a.stateT += dt;
    if (a.ragdoll) return;
    if (a.airborne) { a.phase += a.speed * dt; return; }
    if (a.inside) {
      // Indoors: stay put; frightened people stand up and look towards the danger.
      if (a.fear > 0.5 && (a.state === PState.Sit || a.state === PState.Sleep)) { a.state = PState.Idle; a.stateT = -1e9; }
      if (a.state === PState.Flee || a.state === PState.Gawk || a.state === PState.Film) { a.state = PState.Idle; a.stateT = -1e9; }
      if (a.state === PState.Down) { a.vy -= 9.81 * dt; a.y += a.vy * dt; a.x += a.vx * dt * 0.3; a.z += a.vz * dt * 0.3; if (a.vy < 0 && a.y < (a.floorY ?? a.y)) { a.y = a.floorY ?? a.y; a.vy = 0; } }
      return;
    }
    // Powers: frozen solid — held where it stands (the power layer keeps the pose).
    const st = statusOf(a);
    if (st && st.frozen > 0 && a.state !== PState.Down) { a.speed = 0; return; }
    if (a.state === PState.Down) {
      // Knocked down / flung: simple ballistic slide, then lie.
      a.vy -= 9.81 * dt;
      if (a.under) {
        // (Not through the walls: only onto floor there is.)
        const f = this.underFloor?.(a.x + a.vx * dt, a.y + 0.5, a.z + a.vz * dt) ?? null;
        const f0 = this.underFloor?.(a.x, a.y + 0.5, a.z) ?? f;
        if (f !== null && f <= a.y + 0.5 && (f0 ?? f) - f < UNDER_DROP) { a.x += a.vx * dt; a.z += a.vz * dt; } else { a.vx = a.vz = 0; }
      } else { a.x += a.vx * dt; a.z += a.vz * dt; }
      a.y += a.vy * dt;
      const g = a.under ? this.underFloor?.(a.x, a.y + 0.6, a.z) ?? a.y : this.groundOf(a, NaN, a.y);
      if (a.y < g) { a.y = g; a.vy = 0; a.vx *= 0.8; a.vz *= 0.8; }
      // Actors lie until their owner gets them up (or hands them back).
      if (!a.actor && a.stateT > (a.downBy === 'accident' ? ACCIDENTS.lieFor : 25) && a.fear < 100) a.alive = false;
      return;
    }
    if (a.glance) a.glance = Math.max(0, a.glance - dt);
    let tx: number, tz: number, desired: number;
    const act = a.actor;
    if (act) {
      // Driven by its owner: a goal and a speed (null: stand), staggering slows it down.
      if (act.goal) {
        tx = act.goal.x; tz = act.goal.z; desired = act.speed * (act.staggerT > 0 ? 0.35 : 1);
        // Arrive: ease off over the last half metre (at full pace on top of a point it overshot and
        // came back every frame: running in place).
        const gd = Math.hypot(tx - a.x, tz - a.z);
        if (gd < 0.7 && desired > gd * 7) desired = gd < 0.08 ? 0 : gd * 7;
      }
      else { tx = a.x; tz = a.z; desired = 0; }
      a.state = desired > 0.05 ? PState.Walk : PState.Idle;
      watchProgress(a, act, dt);
    } else if (a.state === PState.Flee) {
      // Run away from the danger, roughly along the sidewalk, with noise.
      const dx = a.x - a.fearX, dz = a.z - a.fearZ;
      const d = Math.hypot(dx, dz) || 1;
      const wob = Math.sin(a.stateT * 0.7 + a.phase) * 0.5;
      tx = a.x + (dx / d) * 10 + Math.cos(wob) * 2; tz = a.z + (dz / d) * 10 + Math.sin(wob) * 2;
      desired = a.pref * 3.2;
      if (a.fear < 0.15) { a.state = PState.Walk; this.rejoinRoute(a); }
    } else if (a.state === PState.Sit) {
      // Seated outdoors (a café terrace, sim/Terraces): stays put until its owner or a scare gets it up.
      a.speed = 0;
      return;
    } else if (a.state === PState.Gawk || a.state === PState.Film) {
      tx = a.x; tz = a.z; desired = 0;
      if (gawkOver(a, dt)) a.state = PState.Walk;
    } else if (a.state === PState.Idle) {
      tx = a.x; tz = a.z; desired = 0;
      if (a.stateT > 6 + (a.look % 7) && a.fear < 0.3) { a.state = PState.Walk; }
    } else if (a.state === PState.Wait) {
      tx = a.x; tz = a.z; desired = 0;
      if (a.stateT > 1.5 + (a.look % 3)) a.state = PState.Walk;
    } else {
      // Walk the route.
      if (a.wp >= a.route.length / 3) {
        if (this.onArrive?.(a)) return; // taken over at the end of the route (a café guest sits down)
        a.alive = false; // arrived (entered the building / reached the car or station)
        if (a.carDest) this.onCarReady?.(a);
        return;
      }
      if (a.gawkT) a.gawkT = Math.max(0, a.gawkT - dt * 0.5);
      tx = a.route[a.wp * 3]; tz = a.route[a.wp * 3 + 1];
      const d = Math.hypot(tx - a.x, tz - a.z);
      // Held up in a crowd: everyone bound for the same door or station entrance pressed
      // around one point that only one at a time could reach, and the crowd grew by hundreds.
      // No closer for 4 s near the waypoint counts as there (the last one: inside the crowd).
      const last = a.wp === a.route.length / 3 - 1;
      if (a.wpD === undefined || d < a.wpD - 0.3) { a.wpD = d; a.stall = 0; }
      else a.stall = (a.stall ?? 0) + dt;
      if (d < (last ? 1.2 : 0.6) || ((a.stall ?? 0) > 4 && d < (last ? 15 : 3))) {
        const nextRoad = a.route[a.wp * 3 + 2] > 0.5;
        a.wp++;
        a.wpD = undefined;
        // Before stepping onto a road, wait briefly at the kerb (traffic check done by the traffic module).
        if (!a.onRoad && nextRoad && this.crossCheck && !this.crossCheck(a)) { a.state = PState.Wait; a.stateT = 0; }
        a.onRoad = a.wp < a.route.length / 3 ? a.route[a.wp * 3 + 2] > 0.5 : false;
        return;
      }
      desired = a.pref * (a.evac ?? this.paceK);
    }
    // Shrunk: little legs, slower steps.
    if (st && st.scale < 1) desired *= Math.sqrt(st.scale);
    // Steering with separation from neighbours.
    let dx = tx - a.x, dz = tz - a.z;
    const dl = Math.hypot(dx, dz);
    if (dl > 1e-3) { dx /= dl; dz /= dl; }
    let sx = 0, sz = 0, behind = false;
    const nb = this.neighbours(a.x, a.z, 1.2, this.nb);
    for (const o of nb) {
      if (o === a || o.state === PState.Down) continue;
      const ox = a.x - o.x, oz = a.z - o.z;
      const d2 = ox * ox + oz * oz;
      if (d2 > 1.2 * 1.2 || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const w = (1.2 - d) / 1.2;
      sx += (ox / d) * w * 1.6; sz += (oz / d) * w * 1.6;
      // Slow down behind someone in front (once: compounded per neighbour a dense crowd froze).
      if (ox * dx + oz * dz < 0 && d < 0.9) behind = true;
    }
    if (behind) desired *= 0.7;
    if (a.sideT && a.sideT > 0) {
      // Making room for a robot (set by the robot, which sees who is in its way).
      a.sideT -= dt;
      sx += a.sideX ?? 0; sz += a.sideZ ?? 0;
    }
    const po = this.playerObstacle;
    if (po && po.h > 0.6) {
      const ox = a.x - po.x, oz = a.z - po.z;
      const d = Math.hypot(ox, oz);
      const rr = po.r + 0.5;
      if (d < rr * 2 && d > 1e-3) {
        const w = Math.max(0, (rr * 2 - d) / rr);
        sx += (ox / d) * w * 2.5; sz += (oz / d) * w * 2.5;
        if (d < rr) { a.x = po.x + (ox / d) * rr; a.z = po.z + (oz / d) * rr; }
      }
    }
    // Things people give a wide berth (a Warden walker on a square).
    for (const o of this.extraObstacles) {
      const ox = a.x - o.x, oz = a.z - o.z;
      const d = Math.hypot(ox, oz);
      if (d < o.r * 2 && d > 1e-3) {
        const w = Math.max(0, (o.r * 2 - d) / o.r);
        sx += (ox / d) * w * 2.5; sz += (oz / d) * w * 2.5;
        if (d < o.r) { a.x = o.x + (ox / d) * o.r; a.z = o.z + (oz / d) * o.r; }
      }
    }
    let vx = dx * desired + sx, vz = dz * desired + sz;
    const sp = Math.hypot(vx, vz);
    const maxSp = Math.max(desired, 0.3) * 1.3;
    if (sp > maxSp) { vx *= maxSp / sp; vz *= maxSp / sp; }
    a.speed += (Math.hypot(vx, vz) - a.speed) * Math.min(1, dt * 4);
    if (a.under) {
      // Underground: only where there is floor within a step up or down (else slide along the wall,
      // or stop): never off a ledge (a platform's edge onto the tracks).
      const ok = (x: number, z: number) => { const f = this.underFloor?.(x, a.y + 0.5, z) ?? null; return f !== null && f - a.y < 0.45 && a.y - f < UNDER_DROP; };
      if (ok(a.x + vx * dt, a.z + vz * dt)) { a.x += vx * dt; a.z += vz * dt; }
      else if (ok(a.x + vx * dt, a.z)) { a.x += vx * dt; vz = 0; }
      else if (ok(a.x, a.z + vz * dt)) { a.z += vz * dt; vx = 0; }
      else { vx = vz = 0; }
    } else if ((act || a.state === PState.Flee) && (vx !== 0 || vz !== 0) && this.wet(a.x + vx * dt, a.z + vz * dt) && !this.wet(a.x, a.z)) {
      // Above ground, someone driven by an owner (soldiers, police, a gang) or running off in a
      // panic heads straight for a point: never off the bank into a river, lake or the sea (slide
      // along the shore, or stop). Route walkers stay on the sidewalks anyway.
      if (!this.wet(a.x + vx * dt, a.z)) { a.x += vx * dt; vz = 0; }
      else if (!this.wet(a.x, a.z + vz * dt)) { a.z += vz * dt; vx = 0; }
      else { vx = vz = 0; }
    } else { a.x += vx * dt; a.z += vz * dt; }
    if (Math.hypot(vx, vz) > 0.1) {
      const h = Math.atan2(-vx, -vz);
      let d = h - a.heading;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      a.heading += d * Math.min(1, dt * 8);
    } else if (act?.face || a.state === PState.Gawk || a.state === PState.Film) {
      const h = act?.face ? Math.atan2(-(act.face.x - a.x), -(act.face.z - a.z)) : Math.atan2(-(a.lookX - a.x), -(a.lookZ - a.z));
      let d = h - a.heading;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      a.heading += d * Math.min(1, dt * 3);
    }
    a.phase += a.speed * dt;
    const gy = a.under ? this.underFloor?.(a.x, a.y + 0.5, a.z) ?? a.y : this.groundOf(a, a.heading, a.y);
    a.y += (gy - a.y) * Math.min(1, dt * 10);
  }

  /** After fleeing: new route from here to the destination (or vanish). */
  private rejoinRoute(a: PedAgent): void {
    const end = a.route.length / 3 - 1;
    const bx = a.route[end * 3], bz = a.route[end * 3 + 1];
    const r = this.buildRoute(a.x, a.z, bx, bz);
    if (r) { a.route = r; a.wp = 1; } else a.alive = false;
  }

  /** Open water at (x, z): a river, lake or the sea, not under a bridge deck. */
  wet(x: number, z: number): boolean {
    return this.world.wet(x, z);
  }

  /** The player as an obstacle (only when not tiny). */
  playerObstacle: { x: number; z: number; r: number; h: number } | null = null;

  /** More places people keep their distance from (a radius round each): set by the game each frame. */
  extraObstacles: { x: number; z: number; r: number }[] = [];

  /** Underground floor at a point (inside a tunnel, room or cave), else null: for `under` agents (set by the game). */
  underFloor: ((x: number, y: number, z: number) => number | null) | null = null;

  /** Optional callback: may this agent step onto the road now? */
  crossCheck: ((a: PedAgent) => boolean) | null = null;

  private remove(i: number): void {
    const a = this.agents[i];
    this.byId.delete(a.cit.id);
    this.agents[i] = this.agents[this.agents.length - 1];
    this.agents.pop();
    this.onRemove?.(a);
  }
  onRemove?: (a: PedAgent) => void;

  /** A citizen placed inside a building (sitting, sleeping or standing). */
  spawnInside(c: Citizen, x: number, y: number, z: number, yaw: number, pose: 'sit' | 'sleep' | 'stand'): PedAgent | null {
    if (this.taken(c.id)) return null;
    const pin = this.placeFor?.(c);
    if (pin && Math.hypot(pin.x - x, pin.z - z) > PIN_R * 2) return null;
    const a: PedAgent = {
      id: this.nextId++, cit: c, x, z, y, heading: yaw, speed: 0, pref: 1.3, state: pose === 'sit' ? PState.Sit : pose === 'sleep' ? PState.Sleep : PState.Idle,
      route: Float32Array.from([x, z, 0]), wp: 1, dest: null, fear: 0, fearX: 0, fearZ: 0, lookX: x, lookZ: z, lookY: y,
      stateT: -1e9, onRoad: false, phase: 0, look: c.seed, vy: 0, vx: 0, vz: 0, alive: true, slot: -1, gx: 1e9, gz: 1e9, gh: 0, inside: true, floorY: y,
    };
    this.agents.push(a);
    this.byId.set(c.id, a);
    return a;
  }

  /** Remove the indoor agents of a building footprint (interior unloaded). */
  removeInside(poly: number[]): void {
    for (let i = this.agents.length - 1; i >= 0; i--) {
      const a = this.agents[i];
      if (a.inside && !a.hall && pointInPoly(poly, a.x, a.z)) this.remove(i);
    }
  }

  /** A citizen standing at a point (actor layer: criminals, police officers, owners). Null when full. */
  spawnAt(c: Citizen, x: number, z: number, heading: number, onRoad = false): PedAgent | null {
    // Actors have a reserve above the population cap (a full street still gets its police).
    if (this.taken(c.id) || this.agents.length >= MAX_AGENTS + ACTOR_RESERVE) return null;
    const a: PedAgent = {
      id: this.nextId++, cit: c, x, z, y: this.groundY(x, z, onRoad, heading), heading, speed: 0, pref: 1.4, state: PState.Idle,
      route: Float32Array.from([x, z, 0]), wp: 1, dest: null, fear: 0, fearX: x, fearZ: z,
      lookX: x, lookZ: z, lookY: 0, stateT: 0, onRoad, phase: 0, look: c.seed, vy: 0, vx: 0, vz: 0, alive: true, slot: -1, gx: 1e9, gz: 1e9, gh: 0,
    };
    this.agents.push(a);
    this.byId.set(c.id, a);
    return a;
  }

  /** Spawn a pedestrian at a point fleeing (e.g. a driver abandoning a car). */
  spawnFleeing(c: Citizen, x: number, z: number, fromX: number, fromZ: number): void {
    if (this.taken(c.id) || this.agents.length >= MAX_AGENTS) return;
    const a: PedAgent = {
      id: this.nextId++, cit: c, x, z, y: this.groundY(x, z, true), heading: 0, speed: 0, pref: 1.4, state: PState.Flee,
      route: Float32Array.from([x, z, 0, x + 1, z, 0]), wp: 1, dest: null, fear: 1, fearX: fromX, fearZ: fromZ,
      lookX: fromX, lookZ: fromZ, lookY: 0, stateT: 0, onRoad: true, phase: 0, look: c.seed, vy: 0, vx: 0, vz: 0, alive: true, slot: -1, gx: 1e9, gz: 1e9, gh: 0,
    };
    this.agents.push(a);
    this.byId.set(c.id, a);
  }
}

function dist2(r: BuildingRef, x: number, z: number): number {
  const cx = (r.bounds[0] + r.bounds[2]) / 2, cz = (r.bounds[1] + r.bounds[3]) / 2;
  return (cx - x) ** 2 + (cz - z) ** 2;
}
function hashCell(i: number, j: number): number {
  return (Math.imul(i, 73856093) ^ Math.imul(j, 19349663)) & (HASH - 1);
}
/** The route point nearest (x, z): its distance and how far along the route it lies. */
export function routeNearest(r: Float32Array, x: number, z: number): { d: number; along: number } {
  let best = Math.hypot(r[0] - x, r[1] - z), along = 0, run = 0;
  for (let i = 3; i < r.length; i += 3) {
    const ax = r[i - 3], az = r[i - 2], dx = r[i] - ax, dz = r[i + 1] - az;
    const l = Math.hypot(dx, dz);
    const t = l > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (l * l))) : 0;
    const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
    if (d < best) { best = d; along = run + l * t; }
    run += l;
  }
  return { d: best, along };
}
function distSegPoint(ax: number, az: number, bx: number, bz: number, px: number, pz: number): number {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + dx * t - px, az + dz * t - pz);
}
/** Does the segment p→q cross the carriageway of either street near their shared junction? */
function crossesStreet(px: number, pz: number, qx: number, qz: number, net: RoadNet, e1: number, e2: number): boolean {
  for (const eid of [e1, e2]) {
    const e = net.edges[eid];
    for (let k = 0; k + 3 < e.pts.length; k += 2) {
      const ax = e.pts[k], az = e.pts[k + 1], bx = e.pts[k + 2], bz = e.pts[k + 3];
      // segment intersection test
      const d1 = (bx - ax) * (pz - az) - (bz - az) * (px - ax);
      const d2 = (bx - ax) * (qz - az) - (bz - az) * (qx - ax);
      const d3 = (qx - px) * (az - pz) - (qz - pz) * (ax - px);
      const d4 = (qx - px) * (bz - pz) - (qz - pz) * (bx - px);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  }
  return false;
}

function segsCross(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
