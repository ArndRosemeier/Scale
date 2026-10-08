/**
 * Targeting (PLAYGROUND_PLAN §0 decisions 14 and 18): what the player's powers go for.
 *
 *  - Tab picks the target nearest the crosshair among people, cars, robots, drones and props
 *    in view; Tab again cycles outward from there, Shift+Tab goes back. Esc clears it, and so
 *    does Tab with nothing in view. A target that is gone, far away or long out of sight is
 *    dropped.
 *  - `probe` is the "what is in front" query every power uses without a target: the first
 *    thing a ray meets — a person, car, robot, drone, prop, a standing facade panel (holes let
 *    the ray through into the building), a roof or the ground.
 *  - `inSphere` lists everything within an area (area effects hit bystanders and cars too).
 *
 * The crime phase extends this with threat colours ("con") and health: see `TargetInfo`.
 * Big threats (a monster: ThreatActor) are a target kind of their own, `threat`, with body zones and
 * weak spots (TargetInfo.zones), targetable from much further off.
 */
import * as THREE from 'three';
import type { Pedestrians, PedAgent } from '../sim/Pedestrians';
import type { Traffic, Vehicle } from '../sim/Traffic';
import type { NearFuture } from '../future/NearFuture';
import type { Robot } from '../future/Robots';
import type { Drone } from '../future/Drones';
import type { PropRenderer, StreetProp } from '../props/PropRenderer';
import type { WorldIndex, BuildingRef } from '../world/WorldIndex';
import type { Destruction } from '../destruction/Destruction';
import type { CityStreamer } from '../stream/CityStreamer';
import type { Player } from '../player/Player';
import type { Input } from './Input';
import { statusOf } from '../shared/status';
import { onScreen, screenPoint, vecToScreen } from '../render/screen';
import { HUMANOID } from '../future/models';
import { Role } from '../sim/Population';
import { TARGET } from './abilities/tuning';
import type { ThreatActor } from './threats/ThreatEvent';

export type ServiceBot = NearFuture['service']['list'][number];

export type TargetKind = 'person' | 'car' | 'robot' | 'bot' | 'drone' | 'prop' | 'threat';
export type Target =
  | { kind: 'person'; obj: PedAgent }
  | { kind: 'car'; obj: Vehicle }
  | { kind: 'robot'; obj: Robot }
  | { kind: 'bot'; obj: ServiceBot }
  | { kind: 'drone'; obj: Drone }
  | { kind: 'prop'; obj: StreetProp }
  | { kind: 'threat'; obj: ThreatActor };

/** Big threats are targetable this many times further than people and cars. */
export const THREAT_RANGE = 3;

/** What a ray met first. */
export interface ProbeHit {
  what: 'target' | 'building' | 'roof' | 'ground' | 'none';
  target: Target | null;
  building: BuildingRef | null;
  t: number;
  x: number; y: number; z: number;
  /** Surface normal (facades: the panel's outward normal; ground and roofs: up). */
  nx: number; ny: number; nz: number;
}

/** For the target frame: name, kind, and the slots the crime phase fills in. */
export interface TargetInfo {
  name: string;
  kind: string;
  dist: number;
  /** Threat colour ("con") — null until the con system exists. */
  con: string | null;
  /** Health 0..1 — null until the combat model exists. */
  health: number | null;
  /** A threat's body zones (weak spots marked, glowing while exposed). */
  zones?: { x: number; y: number; z: number; r: number; name: string; weak: boolean; exposed: boolean; sel: boolean }[];
  /** The body part picked with Tab (powers aim there), null: the whole body. */
  zone?: { name: string; weak: boolean; exposed: boolean; armour: number } | null;
}

export interface TargetWorld {
  peds: Pedestrians;
  traffic: Traffic;
  parked: () => Vehicle[];
  future: NearFuture;
  props: PropRenderer;
  world: WorldIndex;
  destruction: Destruction;
  streamer: CityStreamer;
  player: Player;
  camera: THREE.PerspectiveCamera;
  /** Big threat bodies (the threat director's actors). */
  threats?: () => ThreatActor[];
  /** The deep realm's caves: first rock along a ray / a clear line (null: the point is not in the caves). */
  cave?: {
    ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number | null;
    line(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean | null;
  };
}

const VEH_H: Partial<Record<string, number>> = { bus: 3.1, truck: 3.1, van: 2.5, delivery: 2.5, shuttle: 2.5, suv: 1.85, pickup: 1.85 };
export const vehicleHeight = (v: Vehicle) => (v.state === 5 ? 0.5 : VEH_H[v.kind] ?? 1.5);
/** Robot body (delivery / cleaner): half width, height. */
const ROBOT_R = 0.45, ROBOT_H = 0.75;
const DRONE_R = 0.6;

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _s = screenPoint();
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
/** Click picking: how close (px) to a target's centre still counts as clicking it. */
const PICK_PX = 28;
const _hit: ProbeHit = { what: 'none', target: null, building: null, t: Infinity, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0 };

/** Ray (o, d unit) vs vertical cylinder: entry distance or Infinity. */
export function rayCylinder(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cz: number, y0: number, y1: number, r: number, maxT: number): number {
  const px = ox - cx, pz = oz - cz;
  const a = dx * dx + dz * dz;
  let t0 = -Infinity, t1 = Infinity;
  if (a < 1e-9) {
    if (px * px + pz * pz > r * r) return Infinity;
  } else {
    const b = px * dx + pz * dz, c = px * px + pz * pz - r * r;
    const disc = b * b - a * c;
    if (disc < 0) return Infinity;
    const s = Math.sqrt(disc);
    t0 = (-b - s) / a; t1 = (-b + s) / a;
  }
  // Slab in y.
  if (Math.abs(dy) < 1e-9) { if (oy < y0 || oy > y1) return Infinity; }
  else {
    let s0 = (y0 - oy) / dy, s1 = (y1 - oy) / dy;
    if (s0 > s1) { const k = s0; s0 = s1; s1 = k; }
    t0 = Math.max(t0, s0); t1 = Math.min(t1, s1);
  }
  if (t1 < t0 || t1 < 0) return Infinity;
  const t = Math.max(0, t0);
  return t <= maxT ? t : Infinity;
}

/** Ray vs an oriented box (centre x,z, yaw with forward (−sin, −cos), half length / width, y0..y1). */
export function rayBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cz: number, yaw: number, hl: number, hw: number, y0: number, y1: number, maxT: number): number {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const lx = ox - cx, lz = oz - cz;
  // Local frame: u along forward, w across.
  const ou = lx * fx + lz * fz, ow = lx * -fz + lz * fx;
  const du = dx * fx + dz * fz, dw = dx * -fz + dz * fx;
  let t0 = 0, t1 = maxT;
  const slab = (o: number, d: number, lo: number, hi: number) => {
    if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
    let a = (lo - o) / d, b = (hi - o) / d;
    if (a > b) { const k = a; a = b; b = k; }
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    return t0 <= t1;
  };
  if (!slab(ou, du, -hl, hl) || !slab(ow, dw, -hw, hw) || !slab(oy, dy, y0, y1)) return Infinity;
  return t0;
}

export class Targeting {
  current: Target | null = null;
  /** A big threat's body part picked with Tab (zone id), null: the whole body (powers go for an exposed weak spot). */
  zone: string | null = null;
  /** Seconds the current target has been out of view. */
  private unseen = 0;
  private cycle: Target[] = [];
  private cycleIdx = -1;
  private cycleT = -1e9;
  private time = 0;
  private checkT = 0;
  /** Called when the target changes (UI, sounds). */
  onChange: ((t: Target | null) => void) | null = null;
  /** The crime layer fills in con colour, health and actor names (decision 13). */
  describe: ((t: Target) => { name?: string; con: string | null; health: number | null }) | null = null;
  /** A person's name and what they do (game/people). */
  personLabel: ((a: PedAgent) => { name: string; kind: string; ours: boolean }) | null = null;
  /** Tab order bias (negative = earlier): hostiles first, then people of interest (decision 14). */
  priority: ((t: Target) => number) | null = null;

  constructor(private w: TargetWorld) {}

  // ------------------------------------------------------------------ basics per kind

  /** Body centre of a target. */
  centre(t: Target, out: THREE.Vector3): THREE.Vector3 {
    const s = statusOf(t.obj)?.scale ?? 1;
    switch (t.kind) {
      case 'person': { const a = t.obj; return out.set(a.x, a.y + (a.state === 5 ? 0.25 : 0.95) * s, a.z); }
      case 'car': { const v = t.obj; return out.set(v.x, v.y + vehicleHeight(v) * 0.5 * s, v.z); }
      case 'robot': { const r = t.obj; return out.set(r.x, r.y + ROBOT_H * 0.5 * s, r.z); }
      case 'bot': { const b = t.obj; return out.set(b.x, b.y + HUMANOID.height * 0.5 * s, b.z); }
      case 'drone': { const d = t.obj; return out.set(d.x, d.y, d.z); }
      case 'prop': { const p = t.obj; return out.set(p.x, p.y + p.height * 0.5, p.z); }
      case 'threat': return out.set(t.obj.x, t.obj.y, t.obj.z);
    }
  }

  /** Height of a target's body (for markers). */
  height(t: Target): number {
    const s = statusOf(t.obj)?.scale ?? 1;
    switch (t.kind) {
      case 'person': return (t.obj.state === 5 ? 0.5 : 1.75) * s;
      case 'car': return vehicleHeight(t.obj) * s;
      case 'robot': return ROBOT_H * s;
      case 'bot': return HUMANOID.height * s;
      case 'drone': return 0.5 * s;
      case 'prop': return Math.max(0.5, t.obj.height);
      case 'threat': return t.obj.height;
    }
  }

  /** Velocity (m/s) for leading the aim. */
  velocity(t: Target, out: THREE.Vector3): THREE.Vector3 {
    switch (t.kind) {
      case 'person': { const a = t.obj; return a.state === 5 ? out.set(a.vx, a.vy, a.vz) : out.set(-Math.sin(a.heading) * a.speed, 0, -Math.cos(a.heading) * a.speed); }
      case 'car': { const v = t.obj; return out.set(-Math.sin(v.yaw) * v.speed, 0, -Math.cos(v.yaw) * v.speed); }
      case 'drone': return out.set(t.obj.vx, t.obj.vy, t.obj.vz);
      default: return out.set(0, 0, 0);
    }
  }

  /** Still in the world (not despawned, crushed or broken away)? */
  alive(t: Target): boolean {
    switch (t.kind) {
      case 'person': return t.obj.alive && (!t.obj.inside || !!t.obj.hall);
      case 'car': return t.obj.alive;
      case 'robot': return t.obj.alive && !t.obj.crushed;
      case 'bot': return t.obj.alive && !t.obj.crushed;
      case 'drone': return t.obj.alive;
      case 'prop': return !t.obj.broken;
      case 'threat': return t.obj.targetable;
    }
  }

  /** The body part of this threat picked with Tab, or null. */
  zoneOf(obj: ThreatActor): ThreatActor['zones'][number] | null {
    if (!this.zone || this.current?.obj !== obj) return null;
    return obj.zones.find((z) => z.id === this.zone) ?? null;
  }

  /** Same target? */
  same(a: Target | null, b: Target | null): boolean { return !!a && !!b && a.obj === b.obj; }

  info(t: Target): TargetInfo {
    const dist = this.centre(t, _v).distanceTo(this.w.player.pos);
    const d = this.describe?.(t);
    const info: TargetInfo = { name: d?.name ?? this.name(t), kind: this.kindLabel(t), dist, con: d?.con ?? null, health: d?.health ?? null };
    // Everyone has a name (game/people): the crime layer's names (a gang member, a busker) come first.
    const l = t.kind === 'person' && this.personLabel ? this.personLabel(t.obj) : null;
    if (t.kind === 'person' && l && (!d?.name || l.ours)) {
      info.name = t.obj.state === 5 ? `${l.name} (down)` : l.name;
      info.kind = l.kind;
    }
    if (t.kind === 'threat') {
      info.health = d?.health ?? t.obj.hp / t.obj.maxHp;
      const sel = this.current?.obj === t.obj ? this.zone : null;
      info.zones = t.obj.zones.map((z) => ({ x: z.x, y: z.y, z: z.z, r: z.r, name: z.name, weak: z.weak, exposed: z.exposed, sel: z.id === sel }));
      const zs = sel ? t.obj.zones.find((z) => z.id === sel) : null;
      info.zone = zs ? { name: zs.name, weak: zs.weak, exposed: zs.exposed, armour: zs.armour } : null;
    }
    return info;
  }

  kindLabel(t: Target): string {
    switch (t.kind) {
      case 'person': return 'Person';
      case 'car': return 'Vehicle';
      case 'robot': case 'bot': return 'Robot';
      case 'drone': return 'Drone';
      case 'prop': return 'Object';
      case 'threat': return 'Threat';
    }
  }

  name(t: Target): string {
    switch (t.kind) {
      case 'person': {
        const c = t.obj.cit;
        const age = Math.round(c.age * 100);
        const who = c.role === Role.Child ? (c.gender < 0.5 ? 'Girl' : 'Boy') : age >= 66 ? (c.gender < 0.5 ? 'Elderly woman' : 'Elderly man') : (c.gender < 0.5 ? 'Woman' : 'Man');
        return t.obj.state === 5 ? `${who} (down)` : who;
      }
      case 'car': {
        const k = t.obj.kind;
        const n: Record<string, string> = { sedan: 'Sedan', hatch: 'Hatchback', wagon: 'Estate car', suv: 'SUV', van: 'Van', pickup: 'Pickup', taxi: 'Taxi', police: 'Police car', sports: 'Sports car', bus: 'Bus', truck: 'Truck', delivery: 'Delivery van', shuttle: 'Robo-shuttle' };
        const st = t.obj.state;
        return `${n[k] ?? 'Car'}${st === 4 ? ' (wrecked)' : st === 5 ? ' (crushed)' : t.obj.edge < 0 ? ' (parked)' : ''}`;
      }
      case 'robot': return t.obj.kind === 1 ? 'Street-cleaning robot' : 'Delivery robot';
      case 'bot': return 'Service robot';
      case 'drone': return t.obj.kind === 1 ? 'News drone' : t.obj.kind === 2 ? 'Police drone' : 'Delivery drone';
      case 'prop': {
        const k = t.obj.kind;
        if (k.startsWith('tree:')) { const sp = k.split(':')[1]; return `${sp[0].toUpperCase()}${sp.slice(1)} tree`; }
        if (k.startsWith('shrub')) return 'Shrub';
        const f = k.split(':')[1] ?? 'object';
        return f.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])/g, (_m, c: string) => ` ${c.toLowerCase()}`);
      }
      case 'threat': return t.obj.name;
    }
  }

  // ------------------------------------------------------------------ enumeration

  /** Every candidate near a point (coarse box r), in no particular order. */
  each(x: number, z: number, r: number, fn: (t: Target) => void, kinds: KindMask = ALL_KINDS): void {
    const w = this.w;
    if (kinds.person) {
      if (r < 60) { for (const a of w.peds.neighbours(x, z, r, this.nb)) if (a.alive && (!a.inside || a.hall)) fn({ kind: 'person', obj: a }); }
      else for (const a of w.peds.agents) if (a.alive && (!a.inside || a.hall) && Math.abs(a.x - x) < r && Math.abs(a.z - z) < r) fn({ kind: 'person', obj: a });
    }
    if (kinds.car) {
      for (const v of w.traffic.vehicles) if (v.alive && Math.abs(v.x - x) < r + 4 && Math.abs(v.z - z) < r + 4) fn({ kind: 'car', obj: v });
      for (const v of w.parked()) if (v.alive && Math.abs(v.x - x) < r + 4 && Math.abs(v.z - z) < r + 4) fn({ kind: 'car', obj: v });
    }
    if (kinds.robot) {
      for (const o of w.future.robots.list) if (o.alive && !o.crushed && Math.abs(o.x - x) < r && Math.abs(o.z - z) < r) fn({ kind: 'robot', obj: o });
      for (const o of w.future.service.list) if (o.alive && !o.crushed && Math.abs(o.x - x) < r && Math.abs(o.z - z) < r) fn({ kind: 'bot', obj: o });
    }
    if (kinds.drone) for (const o of w.future.drones.list) if (o.alive && Math.abs(o.x - x) < r && Math.abs(o.z - z) < r) fn({ kind: 'drone', obj: o });
    if (kinds.prop) w.props.query(x, z, r, (p) => { if (!p.broken) fn({ kind: 'prop', obj: p }); });
    // Big threats: their reach is their size.
    if (kinds.threat && w.threats) for (const a of w.threats()) if (Math.abs(a.x - x) < r * THREAT_RANGE + a.height * 2 && Math.abs(a.z - z) < r * THREAT_RANGE + a.height * 2) fn({ kind: 'threat', obj: a });
  }
  private nb: PedAgent[] = [];

  /**
   * Everything whose body is within r of (x, y, z) — what an area effect hits. `fn` gets the
   * target and its distance to the point.
   */
  inSphere(x: number, y: number, z: number, r: number, fn: (t: Target, d: number) => void, kinds: KindMask = ALL_KINDS): void {
    const z0 = z;
    this.each(x, z, r + 3, (t) => {
      const c = this.centre(t, _w);
      if (t.kind === 'threat') {
        // The nearest body surface.
        const z = t.obj.zoneAt(x, y, z0);
        if (z && z.d <= r) fn(t, Math.max(0, z.d));
        return;
      }
      const ext = t.kind === 'car' ? t.obj.length * 0.45 : t.kind === 'prop' ? t.obj.radius : 0.3;
      const hh = this.height(t) * 0.5;
      const dy = Math.max(0, Math.abs(c.y - y) - hh);
      const dh = Math.max(0, Math.hypot(c.x - x, c.z - z) - ext);
      const d = Math.hypot(dh, dy);
      if (d <= r) fn(t, d);
    }, kinds);
  }

  // ------------------------------------------------------------------ ray queries

  /**
   * First thing along the ray from o (unit d) within maxT. Targets in `skip` are ignored.
   * Returns a shared object (copy what you keep).
   */
  probe(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, skip: Target | null = null, kinds: KindMask = ALL_KINDS): ProbeHit {
    const h = _hit;
    h.what = 'none'; h.target = null; h.building = null; h.t = maxT; h.nx = 0; h.ny = 1; h.nz = 0;
    // World: terrain, roofs and standing facade panels.
    this.probeWorld(ox, oy, oz, dx, dy, dz, maxT, h);
    // Things: only those whose box lies near the segment.
    const ex = ox + dx * h.t, ez = oz + dz * h.t;
    const x0 = Math.min(ox, ex) - 6, x1 = Math.max(ox, ex) + 6, z0 = Math.min(oz, ez) - 6, z1 = Math.max(oz, ez) + 6;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, rr = Math.max(x1 - x0, z1 - z0) / 2;
    let best = h.t, bt: Target | null = null;
    this.each(cx, cz, rr, (t) => {
      if (skip && t.obj === skip.obj) return;
      const tt = this.rayTarget(t, ox, oy, oz, dx, dy, dz, best);
      if (tt < best) { best = tt; bt = t; }
    }, kinds);
    if (bt) {
      h.what = 'target'; h.target = bt; h.building = null; h.t = best;
      h.nx = -dx; h.ny = -dy; h.nz = -dz;
    }
    h.x = ox + dx * h.t; h.y = oy + dy * h.t; h.z = oz + dz * h.t;
    return h;
  }

  /** Ray vs one target's body: distance or Infinity. */
  rayTarget(t: Target, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
    const s = statusOf(t.obj)?.scale ?? 1;
    switch (t.kind) {
      case 'person': {
        const a = t.obj;
        if (a.state === 5) return rayCylinder(ox, oy, oz, dx, dy, dz, a.x, a.z, a.y, a.y + 0.45 * s, 0.75 * s, maxT);
        return rayCylinder(ox, oy, oz, dx, dy, dz, a.x, a.z, a.y, a.y + 1.8 * s, 0.38 * s, maxT);
      }
      case 'car': {
        const v = t.obj;
        return rayBox(ox, oy, oz, dx, dy, dz, v.x, v.z, v.yaw, v.length / 2 * s, v.width / 2 * s, v.y - 0.1, v.y + vehicleHeight(v) * s, maxT);
      }
      case 'robot': return rayCylinder(ox, oy, oz, dx, dy, dz, t.obj.x, t.obj.z, t.obj.y, t.obj.y + ROBOT_H * s, ROBOT_R * s, maxT);
      case 'bot': return rayCylinder(ox, oy, oz, dx, dy, dz, t.obj.x, t.obj.z, t.obj.y, t.obj.y + HUMANOID.height * s, 0.32 * s, maxT);
      case 'drone': { const d = t.obj; return rayCylinder(ox, oy, oz, dx, dy, dz, d.x, d.z, d.y - 0.3 * s, d.y + 0.3 * s, DRONE_R * s, maxT); }
      case 'prop': {
        const p = t.obj;
        const r = p.tree ? Math.max(0.25, p.radius * 1.5) : Math.max(0.15, p.radius * p.scale);
        return rayCylinder(ox, oy, oz, dx, dy, dz, p.x, p.z, p.y, p.y + Math.max(0.4, p.height), r, maxT);
      }
      case 'threat': return t.obj.ray(ox, oy, oz, dx, dy, dz, maxT)?.t ?? Infinity;
    }
  }

  /**
   * Terrain, roofs and facades: a coarse march finds the first building prism, then the
   * building's standing panels refine it (a hole lets the ray in; it then meets the inside of
   * the far wall). Writes into h (t, what, normal, building) when something is nearer.
   */
  probeWorld(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, h: ProbeHit): void {
    // In the caves: the rock.
    const ct = this.w.cave?.ray(ox, oy, oz, dx, dy, dz, maxT);
    if (ct !== null && ct !== undefined) {
      if (ct < h.t) { h.t = ct; h.what = 'ground'; h.building = null; h.nx = -dx; h.ny = -dy; h.nz = -dz; }
      return;
    }
    const W = this.w.world;
    const step = Math.min(1.5, Math.max(0.4, maxT / 120));
    let t = 0;
    let lastRef: BuildingRef | null = null;
    while (t < maxT) {
      t = Math.min(maxT, t + step);
      const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
      const g = W.terrain.height(x, z) + W.surfaceOffset(x, z);
      if (y < g) {
        // Refine the ground crossing.
        let a = Math.max(0, t - step), b = t;
        for (let k = 0; k < 8; k++) { const m = (a + b) / 2; const yy = oy + dy * m, xx = ox + dx * m, zz = oz + dz * m; if (yy < W.terrain.height(xx, zz) + W.surfaceOffset(xx, zz)) b = m; else a = m; }
        if (b < h.t) { h.t = b; h.what = 'ground'; h.building = null; h.nx = 0; h.ny = 1; h.nz = 0; }
        return;
      }
      const ref = W.buildingAt(x, z);
      if (!ref || ref === lastRef || !ref.alive || y > ref.top + 0.5 || y < ref.low) continue;
      lastRef = ref;
      const hit = this.facadeRay(ref, ox, oy, oz, dx, dy, dz, Math.max(0, t - step * 2), maxT);
      if (hit) {
        if (hit.t < h.t) { h.t = hit.t; h.what = 'building'; h.building = ref; h.nx = hit.nx; h.ny = 0; h.nz = hit.nz; }
        return;
      }
      // No panel: over the walls (a roof) unless the ray passed through a hole.
      if (y >= ref.top - 0.6) {
        if (t < h.t) { h.t = t; h.what = 'roof'; h.building = ref; h.nx = 0; h.ny = 1; h.nz = 0; }
        return;
      }
    }
  }

  /** Nearest standing wall panel of a building along a ray (both faces), from tMin. */
  facadeRay(ref: BuildingRef, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMin: number, maxT: number): { t: number; nx: number; nz: number } | null {
    const L = this.w.destruction.layoutOf(ref);
    const S = this.w.streamer, cs = ref.cell;
    let best = maxT, bn: { nx: number; nz: number } | null = null;
    for (const p of L.panels) {
      const dn = dx * p.nx + dz * p.nz;
      if (Math.abs(dn) < 1e-4) continue;
      const t = ((p.ax - ox) * p.nx + (p.az - oz) * p.nz) / dn;
      if (t < tMin || t >= best) continue;
      const y = oy + dy * t;
      if (y < p.y0 || y > p.y1) continue;
      const hx = ox + dx * t - p.ax, hz = oz + dz * t - p.az;
      const ux = p.bx - p.ax, uz = p.bz - p.az, L2 = ux * ux + uz * uz;
      const s = (hx * ux + hz * uz) / Math.max(1e-6, L2);
      if (s < -0.01 || s > 1.01) continue;
      if (!S.isAlive(cs, p.e)) continue;
      best = t;
      bn = dn < 0 ? { nx: p.nx, nz: p.nz } : { nx: -p.nx, nz: -p.nz };
    }
    return bn ? { t: best, nx: bn.nx, nz: bn.nz } : null;
  }

  /** As facadeRay, the distance only (Infinity: no standing panel) — the line-of-sight test's (no allocation). */
  facadeT(ref: BuildingRef, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMin: number, maxT: number): number {
    let L = this.layouts.get(ref);
    if (!L) { L = this.w.destruction.layoutOf(ref); this.layouts.set(ref, L); }
    const S = this.w.streamer, cs = ref.cell;
    let best = Infinity;
    for (const p of L.panels) {
      const dn = dx * p.nx + dz * p.nz;
      if (Math.abs(dn) < 1e-4) continue;
      const t = ((p.ax - ox) * p.nx + (p.az - oz) * p.nz) / dn;
      if (t < tMin || t >= maxT || t >= best) continue;
      const y = oy + dy * t;
      if (y < p.y0 || y > p.y1) continue;
      const hx = ox + dx * t - p.ax, hz = oz + dz * t - p.az;
      const ux = p.bx - p.ax, uz = p.bz - p.az, L2 = ux * ux + uz * uz;
      const s = (hx * ux + hz * uz) / Math.max(1e-6, L2);
      if (s < -0.01 || s > 1.01) continue;
      if (!S.isAlive(cs, p.e)) continue;
      best = t;
    }
    return best;
  }

  private layouts = new WeakMap<BuildingRef, ReturnType<Destruction['layoutOf']>>();

  /** The last time a targeted power could not fire (no line of sight / out of reach): the target frame says so for a moment. */
  blocked: { why: 'sight' | 'range'; t: number } | null = null;
  /** Mark a refused shot at the current target (the frame shows it ~1.5 s). */
  refuse(why: 'sight' | 'range'): void {
    if (this.blocked) { this.blocked.why = why; this.blocked.t = this.time; } else this.blocked = { why, t: this.time };
  }
  /** Why the current target cannot be shot right now (null: it can / nothing tried lately). */
  get refused(): 'sight' | 'range' | null { return this.blocked && this.time - this.blocked.t < 1.5 ? this.blocked.why : null; }

  // ------------------------------------------------------------------ Tab targeting

  /** Per frame (input already routed): Tab / Shift+Tab / Esc, validity, out-of-view timeout. */
  update(dt: number, input: Input | null): void {
    this.time += dt;
    if (input) {
      if (input.hit('Tab')) this.tab(input.shift || input.down('ShiftLeft') ? -1 : 1);
      if (input.hit('Escape')) this.set(null);
      // Left click on someone / something under the cursor targets it.
      const c = input.clicked & 1 ? input.cursorNdc() : null;
      const picked = c ? this.pickAt(c.x, c.y) : null;
      if (picked) { this.set(picked); input.clicked &= ~1; }
    }
    const t = this.current;
    if (!t) return;
    if (!this.alive(t)) { this.set(null); return; }
    // Despawned people / cars leave their arrays without a flag: check now and then.
    this.checkT -= dt;
    if (this.checkT <= 0) {
      this.checkT = 0.5;
      if (!this.listed(t)) { this.set(null); return; }
    }
    const k = Math.max(1, Math.sqrt(this.w.player.k));
    const c = this.centre(t, _v);
    if (c.distanceTo(this.w.player.pos) > TARGET.range * k * 1.6 * (t.kind === 'threat' ? THREAT_RANGE : 1)) { this.set(null); return; }
    this.unseen = this.onScreen(c) ? 0 : this.unseen + dt;
    if (this.unseen > TARGET.lostAfter) this.set(null);
  }

  set(t: Target | null): void {
    if (this.same(t, this.current) || (!t && !this.current)) return;
    this.current = t;
    this.zone = null;
    this.blocked = null;
    this.unseen = 0;
    this.checkT = 0.5;
    this.onChange?.(t);
  }

  /** Is the target still in its world list (people and cars despawn silently)? */
  private listed(t: Target): boolean {
    switch (t.kind) {
      case 'person': return this.w.peds.agents.includes(t.obj);
      case 'car': return this.w.traffic.vehicles.includes(t.obj) || this.w.parked().includes(t.obj);
      case 'robot': return this.w.future.robots.list.includes(t.obj);
      case 'bot': return this.w.future.service.list.includes(t.obj);
      case 'drone': return this.w.future.drones.list.includes(t.obj);
      case 'prop': return !t.obj.broken;
      case 'threat': return t.obj.targetable;
    }
  }

  private onScreen(c: THREE.Vector3): boolean {
    return onScreen(vecToScreen(c, this.w.camera, _s));
  }

  /**
   * The target under a screen point (NDC): what the camera ray meets first, else — forgiving
   * for small or moving things — the visible target whose centre is within a few pixels.
   */
  pickAt(nx: number, ny: number): Target | null {
    const cam = this.w.camera, p = this.w.player;
    const k = Math.max(1, Math.sqrt(p.k));
    const range = TARGET.range * k, propRange = TARGET.propRange * k;
    _ray.setFromCamera(_ndc.set(nx, ny), cam);
    const o = _ray.ray.origin, d = _ray.ray.direction;
    const reach = range * (this.w.threats?.().length ? THREAT_RANGE : 1) + cam.position.distanceTo(p.pos);
    const h = this.probe(o.x, o.y, o.z, d.x, d.y, d.z, reach);
    if (h.what === 'target' && h.target) {
      const t = h.target;
      const far = this.centre(t, _v).distanceTo(p.pos);
      if (far <= (t.kind === 'prop' ? propRange : t.kind === 'threat' ? range * THREAT_RANGE : range)) return { ...t } as Target;
    }
    // Near miss: closest projected centre within PICK_PX, in line of sight.
    const W = this.w.world, el = document.getElementById('view');
    const halfW = (el?.clientWidth || window.innerWidth) / 2, halfH = (el?.clientHeight || window.innerHeight) / 2;
    let best: Target | null = null, bestPx = PICK_PX;
    this.each(p.pos.x, p.pos.z, range, (t) => {
      const c = this.centre(t, _v);
      const dc = c.distanceTo(cam.position);
      if (c.distanceTo(p.pos) > (t.kind === 'prop' ? propRange : range)) return;
      if (!vecToScreen(c, cam, _s).front) return;
      const px = Math.hypot((_s.x - nx) * halfW, (_s.y - ny) * halfH);
      if (px >= bestPx) return;
      const cx = c.x - cam.position.x, cy = c.y - cam.position.y, cz = c.z - cam.position.z;
      const hit = W.raycast(cam.position.x, cam.position.y, cam.position.z, cx / dc, cy / dc, cz / dc, Math.max(0.1, dc - 1.5), Math.max(0.5, dc / 60));
      if (hit.t < dc - 2) return;
      bestPx = px; best = { ...t } as Target;
    });
    return best;
  }

  /** Tab (dir 1) / Shift+Tab (-1). On a giant creature: its body parts in turn (weak spots first), then the whole body again; Esc lets go. */
  tab(dir: number): void {
    if (this.current?.kind === 'threat') {
      const Z = this.current.obj.zones;
      const order = [...Z.filter((z) => z.weak), ...Z.filter((z) => !z.weak)].map((z) => z.id);
      const i = this.zone ? order.indexOf(this.zone) : -1;
      const n = order.length + 1, j = ((i + 1 + dir) % n + n) % n;
      this.zone = j === 0 ? null : order[j - 1];
      this.onChange?.(this.current);
      return;
    }
    // A fresh press (or a stale list): rank what is in view now.
    if (this.time - this.cycleT > 2.5 || !this.cycle.length) {
      this.cycle = this.inView();
      this.cycleIdx = -1;
      // Continue from the current target if it is in the list.
      if (this.current) this.cycleIdx = this.cycle.findIndex((c) => c.obj === this.current!.obj);
      if (this.cycleIdx >= 0 && this.cycleIdx !== 0) { /* keep */ } else if (this.current && this.cycleIdx < 0) this.cycleIdx = -1;
    }
    this.cycleT = this.time;
    if (!this.cycle.length) { this.set(null); return; }
    const n = this.cycle.length;
    this.cycleIdx = this.cycleIdx < 0 ? (dir > 0 ? 0 : n - 1) : (this.cycleIdx + dir + n) % n;
    this.set(this.cycle[this.cycleIdx]);
  }

  /**
   * Targets in view, nearest to the crosshair first (an angular measure, so a far target
   * right on the crosshair beats a near one at the edge), visible from the camera.
   */
  inView(): Target[] {
    const cam = this.w.camera, p = this.w.player;
    const k = Math.max(1, Math.sqrt(p.k));
    const range = TARGET.range * k, propRange = TARGET.propRange * k;
    const list: { t: Target; score: number }[] = [];
    const aspect = cam.aspect;
    this.each(p.pos.x, p.pos.z, range, (t) => {
      const c = this.centre(t, _v);
      const d = c.distanceTo(cam.position);
      if (d > (t.kind === 'prop' ? propRange : t.kind === 'threat' ? range * THREAT_RANGE : range)) return;
      if (!onScreen(vecToScreen(c, cam, _s), 0.95)) return;
      // Screen distance from the crosshair (aspect-corrected), with a slight preference for the
      // living and moving over furniture.
      const sx = _s.x * aspect, sy = _s.y;
      const score = Math.hypot(sx, sy) + (t.kind === 'prop' ? 0.12 : 0) + d * 0.0006 + (this.priority?.(t) ?? 0);
      list.push({ t, score });
    });
    list.sort((a, b) => a.score - b.score);
    // Line of sight for the best few (a coarse ray against buildings and terrain).
    const out: Target[] = [];
    const W = this.w.world, o = cam.position;
    for (const e of list) {
      if (out.length >= 16) break;
      const c = this.centre(e.t, _v);
      const dx = c.x - o.x, dy = c.y - o.y, dz = c.z - o.z, d = Math.hypot(dx, dy, dz);
      const cl = this.w.cave?.line(o.x, o.y, o.z, c.x, c.y, c.z);
      if (cl !== null && cl !== undefined) { if (cl) out.push(e.t); continue; }
      const hit = W.raycast(o.x, o.y, o.z, dx / d, dy / d, dz / d, Math.max(0.1, d - 1.5), Math.max(0.5, d / 60));
      if (hit.t < d - 2) continue;
      out.push(e.t);
    }
    return out;
  }

  /**
   * Where to aim at a target from a point: its centre (a threat's exposed weak spot), led by its
   * velocity for something travelling at `speed` m/s (Infinity: no lead).
   */
  aimPoint(t: Target, fromX: number, fromY: number, fromZ: number, speed: number, out: THREE.Vector3): THREE.Vector3 {
    // A big threat: an exposed weak spot if there is one (the soft lock goes for it).
    if (t.kind === 'threat') {
      const picked = this.zoneOf(t.obj);
      if (picked) return out.set(picked.x, picked.y, picked.z);
      const w = t.obj.zones.find((z) => z.weak && z.exposed);
      return w ? out.set(w.x, w.y, w.z) : this.centre(t, out);
    }
    this.centre(t, out);
    if (isFinite(speed) && speed > 0) {
      const d = Math.hypot(out.x - fromX, out.y - fromY, out.z - fromZ);
      this.velocity(t, _w).multiplyScalar(d / speed);
      out.add(_w);
    }
    return out;
  }
}

export const ALL_KINDS = { person: true, car: true, robot: true, drone: true, prop: true, threat: true } as const;
export type KindMask = { person?: boolean; car?: boolean; robot?: boolean; drone?: boolean; prop?: boolean; threat?: boolean };
