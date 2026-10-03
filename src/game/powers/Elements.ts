/**
 * The elemental powers in the world (PLAYGROUND_PLAN §0 decisions 17, 18): laser eyes, fire
 * wave, frost nova, ice path, chain lightning, seismic stomp, whirlwind, hydrokinesis and the
 * shrink ray.
 *
 * Every power works on every kind of target — people, cars, robots, drones, props and
 * buildings. With a target selected (Targeting) it goes for it; with none it goes out along
 * the crosshair and hits whatever is there. Area effects hit everything in the area, and
 * everything the player does to someone or something is recorded (Consequences).
 *
 * Effects reuse the world's own reactions: destruction impacts (facades), debris and dust,
 * props.hit (toppling), traffic wrecks, reactions.knockDown, the near-future layer's knock
 * (robots, drones). Temporary states (frozen, shrunk, burning, stunned, wet) live in the
 * shared status registry (src/shared/status.ts) that the renderers read.
 *
 * Idle cost: one early-out per frame when no power, state or effect is running.
 */
import * as THREE from 'three';
import { aimDir } from '../aimRay';
import type { Player } from '../../player/Player';
import type { CameraRig } from '../../player/CameraRig';
import type { Targeting, Target, ProbeHit } from '../Targeting';
import { vehicleHeight } from '../Targeting';
import { ElementFx, BeamStyle, DecalKind } from './ElementFx';
import type { PowerSynth, SynthHandle } from '../../audio/PowerSynth';
import type { Destruction } from '../../destruction/Destruction';
import type { Debris } from '../../destruction/Debris';
import type { Dust } from '../../destruction/Dust';
import type { WorldIndex } from '../../world/WorldIndex';
import type { Collision } from '../../world/Collision';
import { PState, type Pedestrians, type PedAgent } from '../../sim/Pedestrians';
import type { Reactions } from '../../sim/Reactions';
import { VState, type Traffic, type Vehicle } from '../../sim/Traffic';
import type { VehicleRenderer } from '../../sim/VehicleRenderer';
import type { NearFuture } from '../../future/NearFuture';
import type { PropRenderer } from '../../props/PropRenderer';
import type { Stimuli } from '../Stimuli';
import type { Consequences, HarmEffect, HarmTarget } from '../Consequences';
import type { AbilityId } from '../abilities/defs';
import { statusFor, statusOf, statusList, statusCount, tickStatus, type TargetStatus } from '../../shared/status';
import { WallMat } from '../../plan/building';
import {
  LASER, LASER_RANGE, LASER_DOSE, FIRE, FIRE_RANGE, FIRE_HEAT, FIRE_BURN, NOVA, NOVA_RADIUS, NOVA_FREEZE, ICE, ICE_WIDTH, ICE_LIFE,
  BOLT, BOLT_JUMPS, BOLT_JUMP_RANGE, BOLT_REACH, BOLT_STUN, QUAKE, QUAKE_LENGTH, QUAKE_IMPULSE, GUST, GUST_RADIUS, GUST_TIME, GUST_LIFT,
  HYDRO_RANGE, HYDRO_FORCE, SHRINK, SHRINK_FACTOR, SHRINK_TIME,
} from '../abilities/tuning';

export interface PowerWorld {
  player: Player;
  camera: THREE.PerspectiveCamera;
  camRig: CameraRig;
  targeting: Targeting;
  synth: PowerSynth;
  destruction: Destruction;
  debris: Debris;
  dust: Dust;
  world: WorldIndex;
  collision: Collision;
  peds: Pedestrians;
  reactions: Reactions;
  traffic: Traffic;
  vehicles: VehicleRenderer;
  parked: () => Vehicle[];
  future: NearFuture;
  props: PropRenderer;
  stimuli: Stimuli;
  consequences: Consequences;
  /** Clip sound at a point (Audio.play). */
  sound: (id: string, x: number, y: number, z: number, gain: number, pitch?: number, ref?: number) => void;
}

/** The power being held this frame (from the AbilitySystem). */
export interface Channel { id: AbilityId; rank: number; t: number }

interface Aim {
  ox: number; oy: number; oz: number;
  dx: number; dy: number; dz: number;
  /** Distance to what was hit (or the reach). */
  t: number;
  hit: ProbeHit;
}

interface Bolt { pts: number[]; t: number; life: number; jit: number; seed: number }
interface FireBurst { ox: number; oy: number; oz: number; dx: number; dy: number; dz: number; range: number; rank: number; t: number; cand: { t: Target; d: number }[]; walls: { x: number; y: number; z: number; nx: number; ny: number; nz: number; d: number; building: boolean }[]; k: number }
interface Quake { x0: number; z0: number; dx: number; dz: number; len: number; t: number; done: number; rank: number; k: number; hit: Set<object> }
interface Vortex { air: boolean; x: number; y: number; z: number; dx: number; dz: number; r: number; t: number; life: number; rank: number; k: number; tick: number; hitT: Map<object, number>; loop: SynthHandle | null }
interface Nova { x: number; y: number; z: number; r: number; t: number }
interface Beam { ax: number; ay: number; az: number; bx: number; by: number; bz: number; t: number; life: number; w: number }
interface IcePatch { x: number; y: number; z: number; r: number; until: number }
interface IceTile { x: number; y: number; z: number; yaw: number; pitch: number; len: number; wid: number; born: number; life: number }

const C = (r: number, g: number, b: number) => new THREE.Color(r, g, b);
const FIRE_HOT = C(2.2, 1.05, 0.25), FIRE_MID = C(1.8, 0.5, 0.06), FIRE_END = C(0.55, 0.08, 0.01);
const SMOKE = C(0.16, 0.15, 0.14), SMOKE_LIGHT = C(0.45, 0.44, 0.43);
const SPARK = C(4, 2.4, 0.8), SPARK_END = C(1.5, 0.4, 0.05);
const BOLT_C = C(3, 3.6, 5), BOLT_END = C(0.6, 0.8, 1.6);
const ICE_C = C(1.6, 2.0, 2.4), ICE_END = C(0.5, 0.7, 0.9), SNOW = C(0.92, 0.96, 1.0), SNOW_END = C(0.8, 0.88, 0.95);
const WATER = C(0.72, 0.84, 0.95), WATER_END = C(0.55, 0.7, 0.85), STEAM = C(0.9, 0.92, 0.94);
const DUST_C = C(0.55, 0.5, 0.44), DUST_END = C(0.45, 0.42, 0.38), LEAF = C(0.32, 0.38, 0.16), LEAF_END = C(0.4, 0.33, 0.15);
const SHRINK_C = C(2.4, 0.9, 3.0), SHRINK_END = C(0.6, 0.3, 1.2);
const CHARRED: [number, number, number] = [0.05, 0.045, 0.04];
const ICE_PAINT: [number, number, number] = [0.8, 0.9, 0.98];

const _v = new THREE.Vector3();
const _eyeL = new THREE.Vector3(), _eyeR = new THREE.Vector3();
const _w = new THREE.Vector3();
const _d = new THREE.Vector3();
const _nb: PedAgent[] = [];

export class Elements {
  readonly fx = new ElementFx();
  /** Object → its target record (kind), for everything with a state on it. */
  private kinds = new WeakMap<object, Target>();
  private time = 0;
  // ---- held powers
  private laserLoop: SynthHandle | null = null;
  private waterLoop: SynthHandle | null = null;
  private laserTick = 0;
  private laserFxT = 0;
  private laserSpots = new Map<number, { acc: number; t: number }>();
  private laserLastScorch = new THREE.Vector3(1e9, 0, 0);
  private dose = new Map<object, number>();
  private hydroTick = 0;
  private hydroPuddleT = 0;
  private hydroAcc = new Map<object, { acc: number; t: number }>();
  private iceEnd: { x: number; y: number; z: number } | null = null;
  private iceFxT = 0;
  // ---- effects in flight
  private bolts: Bolt[] = [];
  private fires: FireBurst[] = [];
  private quakes: Quake[] = [];
  private vortices: Vortex[] = [];
  private novas: Nova[] = [];
  private beams: Beam[] = [];
  private patches: IcePatch[] = [];
  private tiles: IceTile[] = [];
  private tileBox = { x0: 0, z0: 0, x1: 0, z1: 0 };
  private slipT = 0;
  private squeakT = 0;
  private lastChannel: AbilityId | null = null;
  /** Debug counters (window.game.elements.stats). */
  readonly stats = { impacts: 0, knocked: 0, frozen: 0, wrecked: 0, shrunk: 0, broken: 0 };

  constructor(private w: PowerWorld) {
    w.collision.extraGround = (x, z, yRef, step) => this.iceGround(x, z, yRef, step);
  }

  // ================================================================== frame

  /**
   * Per frame, after traffic and people moved (so frozen things can be held in place):
   * the held power (if any), effects in flight, states.
   */
  update(dt: number, channel: Channel | null): void {
    this.time += dt;
    this.w.consequences.update(dt);
    const busy = channel || this.lastChannel || this.bolts.length || this.fires.length || this.quakes.length || this.vortices.length
      || this.novas.length || this.beams.length || this.patches.length || this.tiles.length || statusCount() || this.fx.active;
    if (!busy) { this.w.player.onIce = false; this.fx.update(dt); return; }
    // ---- held power
    if (channel?.id !== this.lastChannel) this.endChannel(this.lastChannel);
    this.lastChannel = channel?.id ?? null;
    if (channel) {
      switch (channel.id) {
        case 'laser': this.laser(dt, channel.rank, channel.t); break;
        case 'icePath': this.icePath(dt, channel.rank, channel.t); break;
        case 'hydro': this.hydro(dt, channel.rank, channel.t); break;
        default: break;
      }
    }
    // ---- effects in flight
    if (this.bolts.length) this.updateBolts(dt);
    if (this.fires.length) this.updateFires(dt);
    if (this.quakes.length) this.updateQuakes(dt);
    if (this.vortices.length) this.updateVortices(dt);
    if (this.novas.length) this.updateNovas(dt);
    if (this.beams.length) this.updateBeams(dt);
    if (this.patches.length || this.tiles.length) this.updateIce(dt);
    else this.w.player.onIce = false;
    if (statusCount()) this.updateStatus(dt);
  }

  /** After the near-future layer moved: hold frozen robots in place. */
  postFuture(): void {
    if (!statusCount()) return;
    for (const o of statusList()) {
      const t = this.kinds.get(o);
      if (!t || (t.kind !== 'robot' && t.kind !== 'bot')) continue;
      const s = statusOf(o);
      if (!s || s.frozen <= 0) continue;
      const r = t.obj;
      if (r.body) continue;
      r.x = s.hx; r.z = s.hz; r.yaw = s.hyaw;
      if (t.kind === 'robot') t.obj.speed = 0;
    }
  }

  /** Effects to the GPU (after everything moved). */
  render(dt: number): void {
    this.fx.update(dt);
  }

  private endChannel(id: AbilityId | null): void {
    if (!id) return;
    if (id === 'laser') { this.laserLoop?.stop(); this.laserLoop = null; this.laserSpots.clear(); this.dose.clear(); }
    if (id === 'hydro') { this.waterLoop?.stop(); this.waterLoop = null; this.hydroAcc.clear(); }
    if (id === 'icePath') this.iceEnd = null;
  }

  // ================================================================== tap powers

  /** A tap power: true if it went off (the AbilitySystem then charges energy and cooldown). */
  fire(id: AbilityId, rank: number): boolean {
    switch (id) {
      case 'frostNova': return this.frostNova(rank);
      case 'fireWave': return this.fireWave(rank);
      case 'lightning': return this.lightning(rank);
      case 'stomp': return this.stomp(rank);
      case 'gust': return this.gust(rank);
      case 'shrink': return this.shrinkRay(rank);
      default: return false;
    }
  }

  // ================================================================== aiming

  private get sk(): number { return Math.sqrt(this.w.player.k); }
  /** Reach scale: √k, but never below half (a tiny hero's powers still reach a little). */
  private get reachK(): number { return Math.max(0.5, this.sk); }

  /** Eye or hand position of the player. */
  private origin(where: 'eyes' | 'hands', out: THREE.Vector3): THREE.Vector3 {
    const p = this.w.player, h = p.height;
    if (where === 'eyes' && p.eyePositions(_eyeL, _eyeR)) return out.addVectors(_eyeL, _eyeR).multiplyScalar(0.5);
    const yaw = this.w.camRig.yaw, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    if (p.flying) return out.set(p.pos.x + fx * 0.5 * h, p.pos.y + 0.6 * h, p.pos.z + fz * 0.5 * h);
    return where === 'eyes'
      ? out.set(p.pos.x + fx * 0.07 * h, p.pos.y + 0.93 * h, p.pos.z + fz * 0.07 * h)
      : out.set(p.pos.x + fx * 0.38 * h, p.pos.y + 0.7 * h, p.pos.z + fz * 0.38 * h);
  }

  /**
   * Where a power goes: at the target (led by `lead` m/s; Infinity: instant), or through the
   * cursor to whatever is there. The probe then runs from the origin, so something in the
   * way is what gets hit.
   */
  private aim(where: 'eyes' | 'hands', range: number, lead: number, out: Aim): Aim {
    const T = this.w.targeting, p = this.w.player;
    const o = this.origin(where, _v);
    out.ox = o.x; out.oy = o.y; out.oz = o.z;
    const tgt = T.current;
    let dx: number, dy: number, dz: number;
    let lock = -1;
    if (tgt && T.alive(tgt) && T.centre(tgt, _w).distanceTo(o) < range * 1.15) {
      lock = _w.distanceTo(o);
      T.aimPoint(tgt, o.x, o.y, o.z, lead, _w);
      dx = _w.x - o.x; dy = _w.y - o.y; dz = _w.z - o.z;
    } else {
      // Through the cursor (or the crosshair while looking): what the camera ray meets beyond the player.
      const cam = this.w.camera;
      aimDir(cam, _d);
      const c = cam.position;
      const t0 = Math.max(0, (p.pos.x - c.x) * _d.x + (p.pos.y + p.height * 0.6 - c.y) * _d.y + (p.pos.z - c.z) * _d.z);
      const sx = c.x + _d.x * t0, sy = c.y + _d.y * t0, sz = c.z + _d.z * t0;
      const h = T.probe(sx, sy, sz, _d.x, _d.y, _d.z, range);
      const ex = h.what === 'none' ? sx + _d.x * range : h.x, ey = h.what === 'none' ? sy + _d.y * range : h.y, ez = h.what === 'none' ? sz + _d.z * range : h.z;
      dx = ex - o.x; dy = ey - o.y; dz = ez - o.z;
    }
    const L = Math.hypot(dx, dy, dz) || 1;
    out.dx = dx / L; out.dy = dy / L; out.dz = dz / L;
    const h = T.probe(o.x, o.y, o.z, out.dx, out.dy, out.dz, range);
    out.hit = copyHit(h, out.hit);
    out.t = h.what === 'none' ? range : h.t;
    // Locked on: nothing in between, so it reaches the target (it may have moved off the
    // exact ray since the aim was taken — a fast drone, a running person).
    if (tgt && lock >= 0 && (out.hit.target?.obj !== tgt.obj) && out.t >= lock - 0.6 && lock <= range) {
      const c = T.centre(tgt, _w);
      out.hit.what = 'target'; out.hit.target = tgt; out.hit.building = null;
      out.t = Math.max(0.1, c.distanceTo(o) - 0.3);
      out.hit.t = out.t;
      out.dx = (c.x - o.x) / (out.t + 0.3); out.dy = (c.y - o.y) / (out.t + 0.3); out.dz = (c.z - o.z) / (out.t + 0.3);
      out.hit.x = o.x + out.dx * out.t; out.hit.y = o.y + out.dy * out.t; out.hit.z = o.z + out.dz * out.t;
      out.hit.nx = -out.dx; out.hit.ny = -out.dy; out.hit.nz = -out.dz;
    }
    // Face it.
    if (!p.flying && Math.hypot(out.dx, out.dz) > 0.1) p.yaw = Math.atan2(-out.dx, -out.dz);
    return out;
  }
  /** Yaw toward the cursor (camera yaw when the ray is near vertical or there is no cursor). */
  private cursorYaw(): number {
    aimDir(this.w.camera, _d);
    return Math.hypot(_d.x, _d.z) > 0.05 ? Math.atan2(-_d.x, -_d.z) : this.w.camRig.yaw;
  }
  private aimA: Aim = { ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 0, t: 0, hit: newHit() };

  // ================================================================== effects on targets

  private harmKind(t: Target): HarmTarget {
    return t.kind === 'bot' ? 'robot' : t.kind;
  }

  private record(power: AbilityId, t: Target | 'building' | 'ground', effect: HarmEffect, x: number, z: number): void {
    this.w.consequences.record(power, typeof t === 'string' ? t : this.harmKind(t), effect, x, z, typeof t === 'string' ? undefined : t.obj);
  }

  private track(t: Target): TargetStatus {
    this.kinds.set(t.obj, t);
    return statusFor(t.obj);
  }

  /** Knock a person over away from (fx, fz) at `power` m/s (vy: upward speed, default 0.4 × power). */
  private knock(a: PedAgent, fx: number, fz: number, power: number, vy?: number): void {
    if (a.inside) return;
    const s = statusOf(a);
    if (s) s.frozen = 0; // the ice shatters
    this.w.reactions.knockDown(a, fx, fz, power, 'player');
    if (vy !== undefined) a.vy = vy;
    this.stats.knocked++;
  }

  /** Turn a car into a physical wreck (or push the wreck it already is). keep: keep its damage look. */
  private wreck(v: Vehicle, x: number, y: number, z: number, jx: number, jy: number, jz: number, keep = false): void {
    const dmg = v.damage;
    const was = v.state;
    this.w.traffic.wreckIt(v);
    this.w.vehicles.makeWreck(v, x, y, z, jx, jy, jz);
    if (keep) v.damage = Math.max(dmg, Math.min(0.35, dmg + 0.1));
    if (was !== VState.Wreck && was !== VState.Crushed) this.stats.wrecked++;
  }

  /** A generic physical shove (impulse N·s) on any target. Returns true if it moved / fell. */
  private shove(t: Target, jx: number, jy: number, jz: number, power: AbilityId, carWreckJ = 2500): boolean {
    const J = Math.hypot(jx, jy, jz);
    switch (t.kind) {
      case 'person': {
        const a = t.obj;
        if (J < 120 || a.state === PState.Down) return false;
        const hj = Math.hypot(jx, jz) || 1;
        this.knock(a, a.x - (jx / hj), a.z - (jz / hj), Math.min(14, J / 300), Math.min(8, jy / 300 + J / 900));
        this.record(power, t, 'knockdown', a.x, a.z);
        return true;
      }
      case 'car': {
        const v = t.obj;
        if (J > carWreckJ || v.state === VState.Wreck) { this.wreck(v, v.x, v.y + 0.8, v.z, jx, jy, jz, J < carWreckJ * 3); this.record(power, t, 'wreck', v.x, v.z); return true; }
        v.damage = Math.min(1, v.damage + J / 8000);
        v.speed *= 0.5;
        this.record(power, t, 'damage', v.x, v.z);
        return false;
      }
      case 'robot': this.w.future.robots.knock(t.obj, jx, jy, jz); this.record(power, t, J > 900 ? 'break' : 'knockdown', t.obj.x, t.obj.z); return true;
      case 'bot': this.w.future.service.knock(t.obj, jx, jy, jz); this.record(power, t, J > 1100 ? 'break' : 'knockdown', t.obj.x, t.obj.z); return true;
      case 'drone': this.w.future.drones.knock(t.obj, jx, jy, jz); this.record(power, t, 'knockdown', t.obj.x, t.obj.z); return true;
      case 'prop': {
        const p = t.obj;
        const n = this.w.props.hit(p.x, p.y + Math.min(1, p.height * 0.5), p.z, 0.05, jx, jy, jz);
        if (n) this.record(power, t, 'topple', p.x, p.z);
        return n > 0;
      }
    }
  }

  private freeze(t: Target, dur: number): void {
    const s = this.track(t);
    const fresh = s.frozen <= 0;
    s.frozen = Math.max(s.frozen, dur);
    s.burning = 0;
    switch (t.kind) {
      case 'person': {
        const a = t.obj;
        if (fresh) { s.hx = a.x; s.hy = a.y; s.hz = a.z; s.hyaw = a.heading; s.hphase = a.phase; (s.saved ??= {}).walk = a.speed > 0.3; }
        a.speed = 0; a.vx = 0; a.vz = 0;
        break;
      }
      case 'car': {
        const v = t.obj;
        if (fresh) { s.hx = v.x; s.hz = v.z; s.hyaw = v.yaw; }
        v.speed = 0; v.brake = 1;
        this.savePaint(v, s);
        break;
      }
      case 'robot': case 'bot': if (fresh) { s.hx = t.obj.x; s.hz = t.obj.z; s.hyaw = t.obj.yaw; } break;
      case 'drone': this.w.future.drones.knock(t.obj, 0, -30, 0); break;
      case 'prop': if (fresh) { s.hx = t.obj.x; s.hz = t.obj.z; } break;
    }
    if (fresh) this.stats.frozen++;
  }

  private burn(t: Target, dur: number): void {
    const s = this.track(t);
    if (s.frozen > 0) { s.frozen = Math.max(0, s.frozen - dur); return; } // thaws instead
    s.burning = Math.max(s.burning, dur * (s.wet > 0 ? 0.4 : 1));
    if (t.kind === 'car') this.savePaint(t.obj, s);
  }

  private stun(t: Target, dur: number): void {
    const s = this.track(t);
    s.stunned = Math.max(s.stunned, dur);
  }

  private wet(t: Target, dur: number): void {
    const s = this.track(t);
    s.wet = Math.max(s.wet, dur);
    if (s.burning > 0) { s.burning = 0; const c = this.w.targeting.centre(t, _w); this.steam(c.x, c.y, c.z, 1); }
    if (t.kind === 'car') this.savePaint(t.obj, s);
  }

  private shrink(t: Target, factor: number, dur: number): void {
    const s = this.track(t);
    if (s.shrink <= 0) this.stats.shrunk++;
    s.shrink = Math.max(s.shrink, dur);
    s.scaleTo = Math.min(s.scaleTo === 1 ? 1 : s.scaleTo, factor);
    if (t.kind === 'car') {
      const v = t.obj;
      const sv = (s.saved ??= {});
      if (sv.len === undefined) { sv.len = v.length; sv.wid = v.width; }
    }
  }

  private savePaint(v: Vehicle, s: TargetStatus): void {
    const sv = (s.saved ??= {});
    if (!sv.paint && v.paint[0] + v.paint[1] + v.paint[2] > 0) sv.paint = v.paint.slice() as [number, number, number];
  }

  /** States run out: restore what they changed. */
  private restore(o: object, s: TargetStatus): void {
    const t = this.kinds.get(o);
    this.kinds.delete(o);
    if (!t) return;
    if (t.kind === 'car') {
      const v = t.obj, sv = s.saved;
      if (sv?.len !== undefined) { v.length = sv.len as number; v.width = sv.wid as number; }
      if (sv?.paint) v.paint = sv.charred ? [...CHARRED] : (sv.paint as [number, number, number]);
    } else if (t.kind === 'prop') this.w.props.setScale(t.obj, 1);
    else if (t.kind === 'person' && t.obj.state === PState.Idle) t.obj.stateT = 5; // walk on soon
  }

  // ================================================================== laser eyes

  private laser(dt: number, r: number, held: number): void {
    const range = LASER_RANGE[r] * this.reachK;
    const A = this.aim('eyes', range, Infinity, this.aimA);
    const p = this.w.player, h = p.height, k = p.k;
    const ex = A.ox + A.dx * A.t, ey = A.oy + A.dy * A.t, ez = A.oz + A.dz * A.t;
    // Two beams from the eyes, converging on the spot.
    const yaw = this.w.camRig.yaw, rx = Math.cos(yaw) * 0.032 * h, rz = -Math.sin(yaw) * 0.032 * h;
    if (!p.eyePositions(_eyeL, _eyeR)) { _eyeL.set(A.ox - rx, A.oy, A.oz - rz); _eyeR.set(A.ox + rx, A.oy, A.oz + rz); }
    const wdt = Math.max(0.012, 0.03 * Math.max(0.4, this.sk)) * Math.min(1, held * 6 + 0.3);
    this.fx.seg(_eyeL.x, _eyeL.y, _eyeL.z, ex, ey, ez, wdt, 2.6, 0.25, 0.12, 1.6, BeamStyle.Laser);
    this.fx.seg(_eyeR.x, _eyeR.y, _eyeR.z, ex, ey, ez, wdt, 2.6, 0.25, 0.12, 1.6, BeamStyle.Laser);
    // Sound.
    if (!this.laserLoop) this.laserLoop = this.w.synth.loop('laser', 4 * Math.max(1, this.sk));
    this.laserLoop?.set(A.ox, A.oy, A.oz, 0.55, 1 / Math.pow(Math.max(0.3, k), 0.12));
    const hit = A.hit.what !== 'none';
    // Impact glow and sparks (every frame), smoke now and then.
    if (hit) {
      const nx = A.hit.nx, ny = A.hit.ny, nz = A.hit.nz;
      this.fx.glow(ex + nx * 0.05, ey + ny * 0.05, ez + nz * 0.05, 0, 0.3, 0, 0.08, 0.25 * this.reachK, 0.5 * this.reachK, FIRE_HOT, FIRE_MID, 1, 1, 0);
      this.laserFxT -= dt;
      if (this.laserFxT <= 0) {
        this.laserFxT = 0.03;
        for (let i = 0; i < 3; i++) {
          const sp = 3 + Math.random() * 5;
          this.fx.glow(ex, ey, ez, (nx + (Math.random() - 0.5) * 1.6) * sp, (ny + Math.random() * 0.8) * sp, (nz + (Math.random() - 0.5) * 1.6) * sp, 0.25 + Math.random() * 0.3, 0.05, 0.02, SPARK, SPARK_END, 1, 0.5, 9.8);
        }
        if (Math.random() < 0.35) this.fx.soft(ex + nx * 0.2, ey + ny * 0.2, ez + nz * 0.2, nx * 0.3, 0.8, nz * 0.3, 1.6, 0.2, 1.1 * this.reachK, SMOKE, SMOKE_LIGHT, 0.45, 0.6, -0.4);
      }
    }
    // Damage: at most 10 impacts a second, a heat dose per tick.
    this.laserTick -= dt;
    if (this.laserTick > 0 || !hit) return;
    this.laserTick = LASER.tick;
    const dose = LASER_DOSE[r] * k * k * LASER.tick;
    const H = A.hit;
    // Scorch where it moved on.
    if (H.what !== 'target' && this.laserLastScorch.distanceToSquared(_w.set(ex, ey, ez)) > 0.09 * this.reachK) {
      this.laserLastScorch.set(ex, ey, ez);
      this.fx.decal(DecalKind.Scorch, ex, ey, ez, H.nx, H.ny, H.nz, 0.55 * this.reachK, 0.55 * this.reachK, Math.random() * 6, 40);
    }
    if (Math.random() < 0.4) this.w.synth.play('sizzle', ex, ey, ez, 0.5, 5);
    if (Math.random() < 0.2) this.w.stimuli.emit('power', ex, ey, ez, 4, 40);
    if (H.what === 'building' || H.what === 'roof') {
      // Cumulative heat on the spot (60 cm cells): the panel gives way once the dose beats it.
      const key = (Math.round(ex / 0.6) * 73856093) ^ (Math.round(ey / 0.6) * 19349663) ^ (Math.round(ez / 0.6) * 83492791);
      let s = this.laserSpots.get(key);
      if (!s || this.time - s.t > 3) { s = { acc: 0, t: this.time }; this.laserSpots.set(key, s); }
      s.acc += dose; s.t = this.time;
      const n = this.w.destruction.impact(ex - H.nx * 0.05, ey, ez - H.nz * 0.05, 0.5 * this.reachK, s.acc, A.dx, A.dy, A.dz, 'wall');
      this.stats.impacts++;
      if (n > 0) { this.laserSpots.delete(key); this.record('laser', 'building', 'facade', ex, ez); this.stats.broken += n; }
      if (this.laserSpots.size > 64) for (const [kk, v] of this.laserSpots) if (this.time - v.t > 3) this.laserSpots.delete(kk);
    } else if (H.what === 'target' && H.target) {
      const t = H.target;
      const acc = (this.dose.get(t.obj) ?? 0) + dose;
      this.dose.set(t.obj, acc);
      const jx = A.dx, jy = A.dy, jz = A.dz;
      switch (t.kind) {
        case 'person': {
          const a = t.obj;
          if (a.state !== PState.Down) { this.knock(a, A.ox, A.oz, 2.5); this.record('laser', t, 'knockdown', a.x, a.z); }
          if ((statusOf(a)?.burning ?? 0) <= 0) this.record('laser', t, 'burn', a.x, a.z);
          this.burn(t, 3);
          break;
        }
        case 'car': {
          const v = t.obj;
          v.damage = Math.min(1, v.damage + dose / 12000);
          v.speed *= 0.8;
          v.fear = Math.max(v.fear, 1.2);
          this.burn(t, 6);
          if (acc > 3500 && v.state !== VState.Wreck && v.state !== VState.Crushed) {
            this.wreck(v, ex, ey, ez, jx * 1500, 2500, jz * 1500);
            const sv = (this.track(t).saved ??= {}); sv.charred = true;
            this.record('laser', t, 'wreck', v.x, v.z);
            this.w.sound('car_crash', v.x, v.y, v.z, 0.7, 1.1, 10);
          }
          break;
        }
        case 'robot': this.w.future.robots.knock(t.obj, jx * acc, 80, jz * acc); this.sparks(ex, ey, ez, 6); if (acc > 900) this.record('laser', t, 'break', ex, ez); break;
        case 'bot': this.w.future.service.knock(t.obj, jx * acc, 0, jz * acc); this.sparks(ex, ey, ez, 6); if (acc > 1100) this.record('laser', t, 'break', ex, ez); break;
        case 'drone': this.w.future.drones.knock(t.obj, jx * 40, -20, jz * 40); this.sparks(ex, ey, ez, 8); this.record('laser', t, 'break', ex, ez); break;
        case 'prop': {
          const p = t.obj;
          if (p.kind.includes('lamp') && !p.dark) { this.w.props.darken(p); this.w.synth.play('pop', ex, ey, ez, 0.7, 6); }
          if (p.tree) this.burn(t, 4);
          if (this.w.props.hit(p.x, Math.min(ey, p.y + p.height), p.z, 0.05, jx * acc, 0, jz * acc)) { this.record('laser', t, 'topple', p.x, p.z); this.dose.delete(p); }
          break;
        }
      }
    }
  }

  // ================================================================== fire wave

  private fireWave(r: number): boolean {
    const k = this.w.player.k;
    const range = FIRE_RANGE[r] * this.reachK;
    const A = this.aim('hands', range, 25, this.aimA);
    const b: FireBurst = { ox: A.ox, oy: A.oy, oz: A.oz, dx: A.dx, dy: A.dy, dz: A.dz, range, rank: r, t: 0, cand: [], walls: [], k };
    // Who and what is in the cone (with a line of sight from the hands).
    const cosA = Math.cos(FIRE.halfAngle);
    this.w.targeting.inSphere(A.ox + A.dx * range * 0.5, A.oy + A.dy * range * 0.5, A.oz + A.dz * range * 0.5, range * 0.62, (t) => {
      const c = this.w.targeting.centre(t, _w);
      const vx = c.x - A.ox, vy = c.y - A.oy, vz = c.z - A.oz, d = Math.hypot(vx, vy, vz);
      if (d > range || d < 1e-3) return;
      const ext = t.kind === 'car' ? t.obj.length * 0.5 : 0.5;
      const cos = (vx * A.dx + vy * A.dy + vz * A.dz) / d;
      if (cos < cosA - ext / Math.max(1, d)) return;
      const hit = this.w.world.raycast(A.ox, A.oy, A.oz, vx / d, vy / d, vz / d, d, 0.8);
      if (hit.t < d - 1) return;
      b.cand.push({ t, d });
    });
    // Walls and ground the flames lick: a few rays across the cone.
    const T = this.w.targeting;
    const ux = -A.dz, uz = A.dx; // horizontal across
    const ul = Math.hypot(ux, uz) || 1;
    const spread = Math.tan(FIRE.halfAngle) * 0.8;
    for (let i = 0; i < 7; i++) {
      const a = i === 0 ? 0 : (i - 1) * (Math.PI / 3), s = i === 0 ? 0 : spread;
      let dx = A.dx + (ux / ul) * Math.cos(a) * s, dy = A.dy + Math.sin(a) * s, dz = A.dz + (uz / ul) * Math.cos(a) * s;
      const L = Math.hypot(dx, dy, dz); dx /= L; dy /= L; dz /= L;
      const h = T.probe(A.ox, A.oy, A.oz, dx, dy, dz, range, null, NO_TARGETS);
      if (h.what === 'none') continue;
      b.walls.push({ x: h.x, y: h.y, z: h.z, nx: h.nx, ny: h.ny, nz: h.nz, d: h.t, building: h.what === 'building' || h.what === 'roof' });
    }
    this.fires.push(b);
    const p = this.w.player;
    p.action = { id: 'cast_forward', t0: p.animClock, dur: FIRE.sweep + 0.3 };
    this.w.synth.play('fire', A.ox, A.oy, A.oz, 0.9, 5 * this.reachK, 1 / Math.pow(Math.max(0.3, k), 0.1));
    this.w.stimuli.emit('power', A.ox + A.dx * range * 0.5, A.oy, A.oz + A.dz * range * 0.5, 5, 60 + range * 3);
    return true;
  }

  private updateFires(dt: number): void {
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const b = this.fires[i];
      b.t += dt;
      const sw = FIRE.sweep;
      const sk = Math.max(0.5, Math.sqrt(b.k));
      // Flames: a stream of glowing puffs along the cone, smoke at the far end.
      if (b.t < sw) {
        const n = Math.ceil(dt * 260);
        const speed = b.range / 0.5;
        for (let j = 0; j < n; j++) {
          const a = Math.random() * Math.PI * 2, s = Math.random() * Math.tan(FIRE.halfAngle) * 0.9;
          // Random direction inside the cone.
          const px = -b.dz, pz = b.dx, pl = Math.hypot(px, pz) || 1;
          const qx = (px / pl) * Math.cos(a) * s, qy = Math.sin(a) * s, qz = (pz / pl) * Math.cos(a) * s;
          const sp = speed * (0.75 + Math.random() * 0.4);
          const life = 0.45 + Math.random() * 0.25;
          this.fx.glow(b.ox, b.oy, b.oz, (b.dx + qx) * sp, (b.dy + qy) * sp + 1, (b.dz + qz) * sp, life, 0.15 * sk, (0.9 + Math.random() * 0.8) * sk * (b.range / 14 + 0.4), FIRE_HOT, FIRE_END, 0.55, 2.2, -2);
        }
        if (Math.random() < dt * 30) {
          const d = b.range * (0.6 + Math.random() * 0.4);
          this.fx.soft(b.ox + b.dx * d, b.oy + b.dy * d + 0.5, b.oz + b.dz * d, 0, 1.5, 0, 2.2, 0.6 * sk, 2.5 * sk, SMOKE, SMOKE_LIGHT, 0.4, 0.8, -0.5);
        }
      }
      // The front reaches things at its speed.
      const front = Math.min(1, b.t / (sw * 0.8)) * b.range;
      for (let j = b.cand.length - 1; j >= 0; j--) {
        const c = b.cand[j];
        if (c.d > front) continue;
        b.cand.splice(j, 1);
        this.fireHit(c.t, c.d, b);
      }
      for (let j = b.walls.length - 1; j >= 0; j--) {
        const wl = b.walls[j];
        if (wl.d > front) continue;
        b.walls.splice(j, 1);
        this.fx.decal(DecalKind.Scorch, wl.x, wl.y, wl.z, wl.nx, wl.ny, wl.nz, 1.6 * sk, 1.6 * sk, Math.random() * 6, 45);
        if (wl.building) {
          const n = this.w.destruction.impact(wl.x - wl.nx * 0.05, wl.y, wl.z - wl.nz * 0.05, 1.1 * sk, FIRE_HEAT[b.rank] * b.k * b.k, b.dx, b.dy, b.dz, 'wall');
          this.stats.impacts++;
          if (n) { this.record('fireWave', 'building', 'facade', wl.x, wl.z); this.stats.broken += n; }
        }
      }
      if (b.t > sw + 0.4) this.fires.splice(i, 1);
    }
  }

  private fireHit(t: Target, d: number, b: FireBurst): void {
    const burnT = FIRE_BURN[b.rank];
    const c = this.w.targeting.centre(t, _w);
    switch (t.kind) {
      case 'person': {
        const a = t.obj;
        // Close: thrown off their feet. Further: on fire and running (they pat themselves out).
        if (d < b.range * 0.45 && a.state !== PState.Down) { this.knock(a, b.ox, b.oz, 3); this.record('fireWave', t, 'knockdown', a.x, a.z); }
        else if (a.state !== PState.Down) { a.state = PState.Flee; a.stateT = 0; a.fearX = b.ox; a.fearZ = b.oz; a.fear = 2; }
        this.burn(t, burnT);
        this.record('fireWave', t, 'burn', a.x, a.z);
        break;
      }
      case 'car': {
        const v = t.obj;
        v.speed *= 0.3;
        v.fear = 2;
        this.burn(t, burnT * 2);
        this.record('fireWave', t, 'burn', v.x, v.z);
        break;
      }
      case 'robot': case 'bot': this.shove(t, b.dx * 500, 150, b.dz * 500, 'fireWave'); this.burn(t, burnT * 0.5); break;
      case 'drone': this.shove(t, b.dx * 60, 20, b.dz * 60, 'fireWave'); break;
      case 'prop': {
        const p = t.obj;
        if (p.tree || p.kind.includes('bench') || p.kind.includes('bin')) { this.burn(t, burnT * 1.5); this.record('fireWave', t, 'burn', c.x, c.z); }
        else if (p.kind.includes('lamp') && !p.dark) { this.w.props.darken(p); this.w.synth.play('pop', c.x, p.y + p.height, c.z, 0.6, 6); this.record('fireWave', t, 'break', c.x, c.z); }
        else this.fx.decal(DecalKind.Scorch, p.x, this.w.collision.groundAt(p.x, p.z, p.y + 1, 1.5), p.z, 0, 1, 0, 1.4, 1.4, 0, 40);
        break;
      }
    }
  }

  // ================================================================== frost nova

  private frostNova(r: number): boolean {
    const p = this.w.player;
    const R = NOVA_RADIUS[r] * this.reachK;
    const cx = p.pos.x, cy = p.pos.y + p.height * 0.4, cz = p.pos.z;
    const dur = NOVA_FREEZE[r];
    // Everything within the radius freezes — bystanders and cars included.
    this.w.targeting.inSphere(cx, cy, cz, R, (t) => {
      this.freeze(t, dur);
      const c = this.w.targeting.centre(t, _w);
      this.record('frostNova', t, 'freeze', c.x, c.z);
    });
    // Windows shatter in the cold snap (walls hold).
    const n = this.w.destruction.impact(cx, cy, cz, R, NOVA.glass * p.k * p.k, 0, 0.1, 0, 'blast');
    if (n) this.record('frostNova', 'building', 'facade', cx, cz);
    // Icy ground.
    const g = this.w.collision.groundAt(cx, cz, p.pos.y + 0.3, 0.5);
    this.patches.push({ x: cx, y: g, z: cz, r: R * 0.92, until: this.time + dur * NOVA.iceLinger });
    this.fx.decal(DecalKind.Ice, cx, g, cz, 0, 1, 0, R * 2, R * 2, Math.random() * 6, dur * NOVA.iceLinger);
    this.novas.push({ x: cx, y: g + 0.15, z: cz, r: R, t: 0 });
    // Burst of ice motes and frosty mist.
    const sk = this.reachK;
    for (let i = 0; i < 160; i++) {
      const a = Math.random() * Math.PI * 2, sp = R * (1.2 + Math.random() * 1.2);
      this.fx.glow(cx, g + 0.3 + Math.random() * p.height, cz, Math.cos(a) * sp, Math.random() * 2, Math.sin(a) * sp, 0.6 + Math.random() * 0.5, 0.08 * sk, 0.03 * sk, ICE_C, ICE_END, 1, 2.5, 1);
    }
    for (let i = 0; i < 50; i++) {
      const a = Math.random() * Math.PI * 2, sp = R * (0.6 + Math.random() * 0.8);
      this.fx.soft(cx, g + 0.3, cz, Math.cos(a) * sp, 0.4, Math.sin(a) * sp, 1.6 + Math.random(), 0.6 * sk, 2.4 * sk, SNOW, SNOW_END, 0.45, 2, -0.1);
    }
    p.action = { id: 'cast_self', t0: p.animClock, dur: 0.7 };
    this.w.camRig.addShake(0.15);
    this.w.synth.play('frost', cx, cy, cz, 1, 6 * sk);
    this.w.stimuli.emit('power', cx, cy, cz, 5, 40 + R * 4);
    return true;
  }

  private updateNovas(dt: number): void {
    for (let i = this.novas.length - 1; i >= 0; i--) {
      const n = this.novas[i];
      n.t += dt;
      const u = n.t / 0.45;
      if (u >= 1) { this.novas.splice(i, 1); continue; }
      // Expanding ring of frost light.
      const rr = n.r * (1 - (1 - u) * (1 - u));
      const segs = 40, w = 0.35 * this.reachK * (1 - u * 0.6), I = 1.4 * (1 - u);
      for (let s = 0; s < segs; s++) {
        const a0 = (s / segs) * Math.PI * 2, a1 = ((s + 1) / segs) * Math.PI * 2;
        this.fx.seg(n.x + Math.cos(a0) * rr, n.y, n.z + Math.sin(a0) * rr, n.x + Math.cos(a1) * rr, n.y, n.z + Math.sin(a1) * rr, w, 0.6, 0.9, 1.4, I, BeamStyle.Ring);
      }
    }
  }

  // ================================================================== ice path

  private icePath(dt: number, r: number, held: number): void {
    const p = this.w.player;
    const sk = this.reachK;
    const len = ICE.tileLen * sk, wid = ICE_WIDTH[r] * sk, life = ICE_LIFE[r];
    // Direction: where the body goes, or where the camera looks when standing.
    const hs = Math.hypot(p.vel.x, p.vel.z);
    let dx: number, dz: number;
    if (hs > 0.6 * this.sk) { dx = p.vel.x / hs; dz = p.vel.z / hs; }
    else { const yaw = this.cursorYaw(); dx = -Math.sin(yaw); dz = -Math.cos(yaw); }
    // Slope from the camera: look up for a ramp, down to come down.
    const pitch = this.w.camRig.pitch;
    const slope = pitch > 0.12 ? Math.min(0.5, (pitch - 0.12) * 1.2) : pitch < -0.45 ? -0.3 : 0;
    const feet = p.pos.y;
    // Start under the feet (again) when there is no sheet or the body left its line.
    let e = this.iceEnd;
    if (e) {
      const ox = p.pos.x - e.x, oz = p.pos.z - e.z;
      const along = ox * dx + oz * dz, across = Math.abs(ox * -dz + oz * dx);
      if (across > wid * 0.7 || along > len * 2 || along < -len * 6 || Math.abs(feet - e.y) > len * 3) e = null;
    }
    if (!e) {
      const g = this.w.collision.groundAt(p.pos.x, p.pos.z, feet + 0.3, 0.6);
      e = { x: p.pos.x - dx * len * 0.5, y: Math.max(g, feet - 0.02), z: p.pos.z - dz * len * 0.5 };
      if (!p.grounded && !p.flying) e.y = feet - 0.05;
    }
    // Lay tiles until the sheet runs three tiles ahead of the body.
    let guard = 0;
    while (guard++ < 6) {
      const ahead = (e.x - p.pos.x) * dx + (e.z - p.pos.z) * dz;
      if (ahead > len * 3) break;
      const nx: number = e.x + dx * len, nz: number = e.z + dz * len;
      // Never into the ground: a hill lifts the sheet.
      const g: number = this.w.collision.groundAt(nx, nz, e.y + len, len);
      const ny: number = Math.max(e.y + slope * len, g + 0.03);
      const tp = Math.atan2(ny - e.y, len);
      const tl = Math.hypot(len, ny - e.y);
      this.addTile((e.x + nx) / 2, (e.y + ny) / 2, (e.z + nz) / 2, Math.atan2(-dx, -dz), tp, tl * 1.04, wid, life);
      e = { x: nx, y: ny, z: nz };
      // Frost mist at the leading edge.
      for (let i = 0; i < 4; i++) this.fx.soft(nx + (Math.random() - 0.5) * wid, ny + 0.1, nz + (Math.random() - 0.5) * wid, 0, 0.5, 0, 1.2, 0.3 * sk, 1.2 * sk, SNOW, SNOW_END, 0.5, 1, -0.2);
      if (Math.random() < 0.5) this.w.synth.play('crackle', nx, ny, nz, 0.5, 4);
    }
    this.iceEnd = e;
    this.iceFxT -= dt;
    if (this.iceFxT <= 0) {
      this.iceFxT = 0.05;
      const o = this.origin('hands', _v);
      this.fx.glow(o.x, o.y, o.z, dx * 2, -2, dz * 2, 0.4, 0.12 * sk, 0.03 * sk, ICE_C, ICE_END, 1, 1, 2);
    }
    if (held < 0.05) p.action = { id: 'cast_ground', t0: p.animClock, dur: 0.6 };
  }

  private addTile(x: number, y: number, z: number, yaw: number, pitch: number, len: number, wid: number, life: number): void {
    if (this.tiles.length >= ICE.maxTiles) this.tiles.shift();
    this.tiles.push({ x, y, z, yaw, pitch, len, wid, born: this.time, life });
    this.tileBounds();
  }

  private tileBounds(): void {
    const b = this.tileBox;
    b.x0 = b.z0 = Infinity; b.x1 = b.z1 = -Infinity;
    for (const t of this.tiles) {
      const r = Math.max(t.len, t.wid);
      b.x0 = Math.min(b.x0, t.x - r); b.x1 = Math.max(b.x1, t.x + r);
      b.z0 = Math.min(b.z0, t.z - r); b.z1 = Math.max(b.z1, t.z + r);
    }
  }

  /** Top of the ice sheet at (x, z) (Collision.extraGround). */
  private iceGround(x: number, z: number, yRef: number, step: number): number {
    if (!this.tiles.length) return -Infinity;
    const b = this.tileBox;
    if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) return -Infinity;
    let best = -Infinity;
    for (const t of this.tiles) {
      const fx = -Math.sin(t.yaw), fz = -Math.cos(t.yaw);
      const ox = x - t.x, oz = z - t.z;
      const along = ox * fx + oz * fz, across = ox * -fz + oz * fx;
      const hl = (t.len * Math.cos(t.pitch)) / 2;
      if (Math.abs(along) > hl || Math.abs(across) > t.wid / 2) continue;
      const top = t.y + along * Math.tan(t.pitch);
      if (top <= yRef + step && top > best) best = top;
    }
    return best;
  }

  /** On ice (patches and sheets)? */
  private onIceAt(x: number, y: number, z: number): boolean {
    for (const pt of this.patches) if (Math.hypot(x - pt.x, z - pt.z) < pt.r && Math.abs(y - pt.y) < 1.2) return true;
    const top = this.iceGround(x, z, y + 0.2, 0.4);
    return top > -Infinity && Math.abs(top - y) < 0.25;
  }

  private updateIce(dt: number): void {
    const now = this.time;
    // Melt and drop sheets.
    let changed = false;
    for (let i = this.tiles.length - 1; i >= 0; i--) {
      const t = this.tiles[i];
      const age = now - t.born;
      if (age > t.life) {
        this.tiles.splice(i, 1);
        changed = true;
        if (Math.random() < 0.3) this.fx.soft(t.x, t.y, t.z, 0, 0.3, 0, 1.2, 0.3, 1.2, STEAM, SNOW_END, 0.3, 1, -0.3);
        continue;
      }
      const melt = Math.max(0.15, Math.min(1, (t.life - age) / (t.life * 0.25)));
      this.fx.sheet(t.x, t.y, t.z, t.yaw, t.pitch, t.len, t.wid * (0.85 + 0.15 * melt), ICE.thick * this.reachK * melt);
    }
    if (changed) this.tileBounds();
    for (let i = this.patches.length - 1; i >= 0; i--) if (this.patches[i].until < now) this.patches.splice(i, 1);
    const p = this.w.player;
    p.onIce = p.grounded && this.onIceAt(p.pos.x, p.pos.y, p.pos.z);
    // People walking onto ice slip (a few checks a second).
    this.slipT -= dt;
    if (this.slipT > 0) return;
    this.slipT = 0.25;
    const check = (x: number, z: number, r: number) => {
      for (const a of this.w.peds.neighbours(x, z, r, _nb)) {
        if (a.state === PState.Down || a.inside || a.speed < 0.6) continue;
        const s = statusOf(a);
        if (s && s.frozen > 0) continue;
        if (!this.onIceAt(a.x, a.y, a.z) || Math.random() > 0.35) continue;
        const fx = -Math.sin(a.heading), fz = -Math.cos(a.heading);
        this.knock(a, a.x - fx, a.z - fz, 1.2 + a.speed * 0.4, 1);
        this.record('icePath', { kind: 'person', obj: a }, 'knockdown', a.x, a.z);
        this.w.sound('land_thud', a.x, a.y, a.z, 0.4, 1.2, 4);
      }
    };
    for (const pt of this.patches) check(pt.x, pt.z, pt.r);
    if (this.tiles.length) {
      const b = this.tileBox;
      const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
      if (b.x1 - b.x0 < 200 && b.z1 - b.z0 < 200) check(cx, cz, Math.max(b.x1 - b.x0, b.z1 - b.z0) / 2);
    }
  }

  // ================================================================== chain lightning

  private lightning(r: number): boolean {
    const T = this.w.targeting;
    const reach = BOLT_REACH[r] * this.reachK;
    const A = this.aim('hands', reach, Infinity, this.aimA);
    const pts: number[] = [A.ox, A.oy, A.oz];
    const struck = new Set<object>();
    let x: number, y: number, z: number;
    const H = A.hit;
    if (H.what === 'target' && H.target) {
      const c = T.centre(H.target, _w);
      x = c.x; y = c.y; z = c.z;
      this.boltHit(H.target, r, x, y, z);
      struck.add(H.target.obj);
    } else {
      x = A.ox + A.dx * A.t; y = A.oy + A.dy * A.t; z = A.oz + A.dz * A.t;
      if (H.what === 'building' || H.what === 'roof') {
        const n = this.w.destruction.impact(x, y, z, 1.2 * this.reachK, 2500 * this.w.player.k ** 2, A.dx, A.dy, A.dz, 'wall');
        if (n) this.record('lightning', 'building', 'facade', x, z);
        this.w.future.signs.impact(x, y, z, 3, true);
      }
      if (H.what !== 'none') {
        this.fx.decal(DecalKind.Scorch, x, y, z, H.nx, H.ny, H.nz, 1.4 * this.reachK, 1.4 * this.reachK, Math.random() * 6, 40);
        this.sparks(x, y, z, 16);
      }
    }
    pts.push(x, y, z);
    // Jumps: each to the nearest thing not struck yet.
    const jr = BOLT_JUMP_RANGE[r] * this.reachK;
    for (let j = 0; j < BOLT_JUMPS[r]; j++) {
      const pick: { t: Target | null; d: number } = { t: null, d: Infinity };
      T.inSphere(x, y, z, jr, (t, d) => {
        if (struck.has(t.obj)) return;
        // Conductors attract the arc a little more than people.
        const dd = d * (t.kind === 'prop' && !t.obj.tree ? 0.8 : 1);
        if (dd < pick.d) { pick.d = dd; pick.t = t; }
      });
      if (!pick.t) break;
      const bt: Target = pick.t;
      struck.add(bt.obj);
      const c = T.centre(bt, _w);
      x = c.x; y = c.y; z = c.z;
      this.boltHit(bt, r, x, y, z);
      pts.push(x, y, z);
    }
    this.bolts.push({ pts, t: 0, life: BOLT.flash + 0.05 * pts.length / 3, jit: 0, seed: Math.random() * 1000 });
    const p = this.w.player;
    p.action = { id: 'cast_forward', t0: p.animClock, dur: 0.5 };
    this.w.synth.play('thunder', pts[3], pts[4], pts[5], 1, 10 * this.reachK);
    this.w.stimuli.emit('power', pts[3], pts[4], pts[5], 6, 120);
    this.w.camRig.addShake(0.12);
    return true;
  }

  private boltHit(t: Target, r: number, x: number, y: number, z: number): void {
    const stunT = BOLT_STUN[r];
    this.sparks(x, y, z, 14);
    this.w.synth.play('zap', x, y, z, 0.7, 6);
    for (let i = 0; i < 10; i++) this.fx.glow(x, y, z, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, 0.25, 0.6 * this.reachK, 0.1, BOLT_C, BOLT_END, 0.7, 3, 0);
    switch (t.kind) {
      case 'person': {
        const a = t.obj;
        if (a.state !== PState.Down) this.knock(a, x + (Math.random() - 0.5), z + (Math.random() - 0.5), 1.4, 1.2);
        this.stun(t, stunT);
        this.record('lightning', t, 'stun', a.x, a.z);
        break;
      }
      case 'car': {
        const v = t.obj;
        v.speed = 0; v.brake = 1;
        v.damage = Math.min(1, v.damage + 0.12);
        v.fear = Math.max(v.fear, 1);
        this.stun(t, stunT * 2);
        this.record('lightning', t, 'stall', v.x, v.z);
        break;
      }
      case 'robot': this.w.future.robots.knock(t.obj, (Math.random() - 0.5) * 400, 1500, (Math.random() - 0.5) * 400); this.record('lightning', t, 'break', x, z); break;
      case 'bot': this.w.future.service.knock(t.obj, (Math.random() - 0.5) * 400, 1500, (Math.random() - 0.5) * 400); this.record('lightning', t, 'break', x, z); break;
      case 'drone': this.w.future.drones.knock(t.obj, 0, -60, 0); this.stun(t, stunT); this.record('lightning', t, 'break', x, z); break;
      case 'prop': {
        const p = t.obj;
        if (p.kind.includes('lamp') || p.kind.includes('traffic') || p.kind.includes('sign')) {
          this.w.props.darken(p);
          this.w.synth.play('pop', x, y, z, 0.8, 6);
          this.w.debris.chipBurst(x, p.y + p.height * 0.95, z, 10, 3, 0, -0.5, 0, C(0.75, 0.85, 0.9), 0.04, 2);
          this.record('lightning', t, 'break', x, z);
        } else if (p.tree) { this.burn(t, 2); this.record('lightning', t, 'burn', x, z); }
        // Shop signs and screens nearby flicker out.
        this.w.future.signs.impact(x, y, z, 2.5, true);
        break;
      }
    }
  }

  private updateBolts(dt: number): void {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.t += dt;
      if (b.t > b.life) { this.bolts.splice(i, 1); continue; }
      b.jit -= dt;
      if (b.jit <= 0) { b.jit = 0.045; b.seed = Math.random() * 1000; }
      const fade = 1 - b.t / b.life;
      const I = (0.6 + 0.4 * Math.random()) * (0.5 + fade);
      const P = b.pts;
      for (let s = 0; s + 5 < P.length; s += 3) this.arc(P[s], P[s + 1], P[s + 2], P[s + 3], P[s + 4], P[s + 5], b.seed + s, I, 0.07 * this.reachK);
    }
  }

  /** A jagged arc between two points (with a branch or two). */
  private arc(ax: number, ay: number, az: number, bx: number, by: number, bz: number, seed: number, I: number, w: number): void {
    const L = Math.hypot(bx - ax, by - ay, bz - az);
    const n = Math.max(4, Math.min(16, Math.round(L / 1.2)));
    const amp = Math.min(2.5, L * 0.12);
    let px = ax, py = ay, pz = az;
    let rs = seed;
    const rnd = () => { rs = (rs * 9301 + 49297) % 233280; return rs / 233280 - 0.5; };
    for (let i = 1; i <= n; i++) {
      const u = i / n;
      const e = i === n ? 0 : amp * Math.sin(u * Math.PI);
      const x = ax + (bx - ax) * u + rnd() * e, y = ay + (by - ay) * u + rnd() * e, z = az + (bz - az) * u + rnd() * e;
      this.fx.seg(px, py, pz, x, y, z, w * 6, 0.55, 0.7, 1.4, I * 1.8, BeamStyle.Bolt);
      if (i > 1 && i < n - 1 && rnd() > 0.32) {
        const l = amp * 0.8;
        this.fx.seg(x, y, z, x + rnd() * l * 2, y + rnd() * l * 2 - l * 0.3, z + rnd() * l * 2, w * 2.2, 0.6, 0.75, 1.2, I * 0.6, BeamStyle.Bolt);
      }
      px = x; py = y; pz = z;
    }
  }

  // ================================================================== seismic stomp

  private stomp(r: number): boolean {
    const p = this.w.player, T = this.w.targeting;
    let dx: number, dz: number;
    const tgt = T.current;
    if (tgt && T.alive(tgt)) { const c = T.centre(tgt, _w); dx = c.x - p.pos.x; dz = c.z - p.pos.z; }
    else { const yaw = this.cursorYaw(); dx = -Math.sin(yaw); dz = -Math.cos(yaw); }
    const L = Math.hypot(dx, dz) || 1;
    dx /= L; dz /= L;
    if (!p.flying) p.yaw = Math.atan2(-dx, -dz);
    const sk = this.reachK;
    this.quakes.push({ x0: p.pos.x + dx * p.radius * 2, z0: p.pos.z + dz * p.radius * 2, dx, dz, len: QUAKE_LENGTH[r] * sk, t: 0, done: 0, rank: r, k: p.k, hit: new Set() });
    p.action = { id: 'slam', t0: p.animClock, dur: 0.7 };
    this.w.camRig.addShake(0.5);
    this.w.dust.burst(p.pos.x, p.pos.y + 0.2, p.pos.z, 24, p.height * 0.5, 4 * sk, 0.6 * sk + 0.4, 2.5, DUST_C, 0.1, 0.55);
    this.w.synth.play('quake', p.pos.x, p.pos.y, p.pos.z, 1, 12 * sk);
    this.w.sound('step_giant', p.pos.x, p.pos.y, p.pos.z, 1, 0.7, 20);
    return true;
  }

  private updateQuakes(dt: number): void {
    const T = this.w.targeting;
    for (let i = this.quakes.length - 1; i >= 0; i--) {
      const q = this.quakes[i];
      q.t += dt;
      const sk = Math.max(0.5, Math.sqrt(q.k));
      const reach = Math.min(q.len, q.t * QUAKE.speed * sk);
      const step = 1.6 * sk;
      while (q.done + step <= reach + 1e-6) {
        const d0 = q.done, d1 = q.done + step;
        q.done = d1;
        const mx = q.x0 + q.dx * (d0 + d1) / 2, mz = q.z0 + q.dz * (d0 + d1) / 2;
        const g = this.w.collision.groundAt(mx, mz, this.w.player.pos.y + 3 * sk, 3 * sk);
        const yaw = Math.atan2(-q.dx, -q.dz) + Math.PI / 2;
        const wd = QUAKE.width * sk * (1 - (d1 / q.len) * 0.5);
        this.fx.decal(DecalKind.Crack, mx, g, mz, 0, 1, 0, step * 1.25, wd, yaw, 30);
        this.w.dust.burst(mx, g + 0.2, mz, 4, wd * 0.6, 2.5 * sk, 0.5 * sk + 0.3, 2, DUST_C, 0.1, 0.5);
        // Slabs of road jut up out of the crack.
        for (let k = 0; k < 2; k++) {
          const s = (0.3 + Math.random() * 0.4) * sk;
          const side = (Math.random() - 0.5) * wd;
          this.w.debris.spawn(mx - q.dz * side, g + 0.1, mz + q.dx * side, s * 1.5, s * 0.5, s, (Math.random() - 0.5) * 2, 3 + Math.random() * 4 * sk, (Math.random() - 0.5) * 2, WallMat.Concrete, new THREE.Color(0.5, 0.48, 0.46));
        }
        // Everything near the line is thrown.
        const J = QUAKE_IMPULSE[q.rank] * q.k * q.k;
        const R = 3.5 * sk;
        T.inSphere(mx, g + 0.5, mz, R, (t) => {
          if (q.hit.has(t.obj)) return;
          q.hit.add(t.obj);
          const c = T.centre(t, _w);
          // Away from the crack, mostly up.
          let sx = (c.x - mx) * -q.dz * -q.dz + (c.z - mz) * q.dx * -q.dz, sz = (c.x - mx) * q.dz * q.dx + (c.z - mz) * q.dx * q.dx;
          const sl = Math.hypot(sx, sz) || 1;
          sx /= sl; sz /= sl;
          switch (t.kind) {
            case 'person': this.knock(t.obj, c.x - sx, c.z - sz, Math.min(9, 3 + J / 30000), Math.min(9, 3.5 + J / 25000)); this.record('stomp', t, 'knockdown', c.x, c.z); break;
            case 'car': {
              const v = t.obj, near = Math.hypot(c.x - mx, c.z - mz) < 2.6 * sk;
              const Jc = Math.min(2.4e4, J * 0.35 + 4000);
              if (near || J > 6e4) { this.wreck(v, v.x - sx * 0.8, v.y + 0.3, v.z - sz * 0.8, sx * Jc * 0.3, Jc, sz * Jc * 0.3); this.record('stomp', t, 'wreck', v.x, v.z); }
              else { v.speed = 0; v.fear = 2; v.damage = Math.min(1, v.damage + 0.2); this.record('stomp', t, 'damage', v.x, v.z); }
              break;
            }
            case 'drone': if (c.y - g < 3 * sk) this.shove(t, sx * 100, 200, sz * 100, 'stomp'); break;
            default: this.shove(t, sx * Math.min(J, 3000), Math.min(J, 3000), sz * Math.min(J, 3000), 'stomp'); break;
          }
        });
        // Walls along the crack (only where there are buildings).
        if (this.w.world.buildingsIn(mx - R, mz - R, mx + R, mz + R).length) {
          const n = this.w.destruction.impact(mx, g + 1.4 * sk, mz, 2.6 * sk, J, 0, 1, 0, 'stomp');
          this.stats.impacts++;
          if (n) { this.record('stomp', 'building', 'facade', mx, mz); this.stats.broken += n; }
        }
        if ((Math.round(d1 / step) & 3) === 0) {
          this.w.stimuli.emit('power', mx, g, mz, 6, 80);
          this.w.sound('concrete_break', mx, g, mz, 0.7, 0.7, 10);
        }
        const pd = Math.hypot(mx - this.w.player.pos.x, mz - this.w.player.pos.z);
        this.w.camRig.addShake(Math.min(0.08, 2 / Math.max(5, pd)));
      }
      if (q.done + step > q.len) this.quakes.splice(i, 1);
    }
  }

  // ================================================================== whirlwind

  private gust(r: number): boolean {
    const T = this.w.targeting, p = this.w.player;
    const sk = this.reachK;
    const reach = GUST.reach * sk;
    let x: number, z: number, ty = -Infinity;
    const tgt = T.current;
    if (tgt && T.alive(tgt) && T.centre(tgt, _w).distanceTo(p.pos) < reach * 1.5) { x = _w.x; z = _w.z; ty = _w.y; }
    else {
      const A = this.aim('hands', reach, Infinity, this.aimA);
      // Not inside a wall: back off from a facade a little.
      const back = A.hit.what === 'building' ? GUST_RADIUS[r] * sk * 0.6 : 0;
      x = A.ox + A.dx * Math.max(2, A.t - back); z = A.oz + A.dz * Math.max(2, A.t - back);
    }
    const gy = this.w.collision.groundAt(x, z, p.pos.y + 20, 25);
    // A target up in the air (a drone): the vortex spins up there.
    const air = ty - gy > 4;
    const y = air ? ty - GUST_RADIUS[r] * sk * 0.6 : gy;
    const yaw = this.cursorYaw();
    const loop = this.w.synth.loop('wind', 8 * sk);
    this.vortices.push({ x, y, z, dx: -Math.sin(yaw), dz: -Math.cos(yaw), r: GUST_RADIUS[r] * sk, t: 0, life: GUST_TIME[r], rank: r, k: p.k, tick: 0, hitT: new Map(), loop, air });
    p.action = { id: 'cast_up', t0: p.animClock, dur: 0.7 };
    this.w.stimuli.emit('power', x, y, z, 5, 70);
    return true;
  }

  private updateVortices(dt: number): void {
    const T = this.w.targeting;
    for (let i = this.vortices.length - 1; i >= 0; i--) {
      const v = this.vortices[i];
      v.t += dt;
      const fadeIn = Math.min(1, v.t / 0.5), fadeOut = Math.min(1, (v.life - v.t) / 0.8);
      const s = Math.max(0, Math.min(fadeIn, fadeOut));
      if (v.t > v.life) { v.loop?.stop(); this.vortices.splice(i, 1); continue; }
      // Drift along, hugging the ground.
      const sk = Math.max(0.5, Math.sqrt(v.k));
      v.x += v.dx * GUST.drift * sk * dt; v.z += v.dz * GUST.drift * sk * dt;
      if (!v.air) v.y += (this.w.collision.groundAt(v.x, v.z, v.y + 3, 4) - v.y) * Math.min(1, dt * 4);
      v.loop?.set(v.x, v.y + v.r, v.z, 0.9 * s, 0.6 + 0.4 * s);
      // Funnel: dust and leaves spun up the axis.
      const n = Math.ceil(dt * 420 * s);
      const lift = GUST_LIFT[v.rank] * sk;
      for (let j = 0; j < n; j++) {
        // A funnel: narrow at the foot, wide at the top (the spawn height sets the radius).
        const u = Math.random() * Math.random();
        const h = u * v.r * 1.6;
        const a = Math.random() * Math.PI * 2, rr = v.r * (0.15 + 0.75 * u) * (0.8 + Math.random() * 0.4);
        const leaf = Math.random() < 0.15;
        const idx = leaf
          ? this.fx.soft(v.x + Math.cos(a) * rr, v.y + h, v.z + Math.sin(a) * rr, 0, v.r * 0.5, 0, 1.4 + Math.random(), 0.08 * sk, 0.08 * sk, LEAF, LEAF_END, 0.9, 0.2, 0)
          : this.fx.soft(v.x + Math.cos(a) * rr, v.y + h, v.z + Math.sin(a) * rr, 0, v.r * (0.25 + Math.random() * 0.35), 0, 0.8 + Math.random() * 0.5, 0.6 * sk, 2.0 * sk, DUST_C, DUST_END, 0.6, 0.2, 0);
        this.fx.swirlSoft(idx, v.x, v.z, 6 + Math.random() * 3, 0.05);
      }
      // Wind streaks: spinning partial rings up the funnel.
      for (let k = 0; k < 6; k++) {
        const rr = v.r * (0.25 + 0.13 * k), yy = v.y + 0.4 + k * v.r * 0.27;
        const ph = v.t * (7 - k * 0.6) + k * 1.7;
        for (let j = 0; j < 10; j++) {
          const a0 = ph + j * 0.4, a1 = a0 + 0.4;
          this.fx.seg(v.x + Math.cos(a0) * rr, yy + j * 0.03 * v.r, v.z + Math.sin(a0) * rr, v.x + Math.cos(a1) * rr, yy + (j + 1) * 0.03 * v.r, v.z + Math.sin(a1) * rr,
            0.1 * sk, 0.8, 0.82, 0.85, 0.8 * s * (1 - j / 10), BeamStyle.Ring);
        }
      }
      // Pushes, 8 times a second.
      v.tick -= dt;
      if (v.tick > 0) continue;
      v.tick = 0.125;
      this.w.debris.vortex(v.x, v.y, v.z, v.r * 1.2, lift * 1.6, lift);
      this.w.dust.clearNear(v.x, v.y + v.r, v.z, v.r * 1.6);
      const r = v.rank;
      T.each(v.x, v.z, v.r + 3, (t) => {
        const c = T.centre(t, _w);
        const dx = c.x - v.x, dz = c.z - v.z, d = Math.hypot(dx, dz);
        if (d > v.r + (t.kind === 'car' ? t.obj.length * 0.4 : 0.3) || c.y < v.y - 1 || c.y > v.y + v.r * 3) return;
        const last = v.hitT.get(t.obj) ?? -1e9;
        if (this.time - last < (t.kind === 'person' ? 2.2 : t.kind === 'car' ? 3 : 1.2)) return;
        v.hitT.set(t.obj, this.time);
        // Round the axis, a little outward, and up.
        const tx = d > 1e-3 ? -dz / d : 1, tz = d > 1e-3 ? dx / d : 0;
        const ox = d > 1e-3 ? dx / d : 0, oz = d > 1e-3 ? dz / d : 0;
        const k = s * (1 - Math.min(1, d / (v.r + 1)) * 0.5);
        switch (t.kind) {
          case 'person': {
            const a = t.obj;
            if (a.state === PState.Down && a.vy > 0) return;
            this.knock(a, a.x - tx, a.z - tz, lift * 0.7 * k, lift * k);
            a.vx = (tx * 0.8 + ox * 0.4) * lift * k; a.vz = (tz * 0.8 + oz * 0.4) * lift * k;
            this.record('gust', t, 'lift', a.x, a.z);
            break;
          }
          case 'car': {
            const car = t.obj;
            const small = car.kind === 'hatch' || car.kind === 'sedan' || car.kind === 'sports' || car.kind === 'taxi' || car.kind === 'wagon';
            const can = r >= 5 ? car.kind !== 'bus' && car.kind !== 'truck' : r >= 3 && small;
            if (can) {
              const J = 1500 * Math.min(8, lift) * k * 0.7;
              this.wreck(car, car.x - ox, car.y + 0.4, car.z - oz, tx * J * 0.5, J, tz * J * 0.5, true);
              this.record('gust', t, 'lift', car.x, car.z);
            } else { car.speed *= 0.4; car.fear = Math.max(car.fear, 1); }
            break;
          }
          case 'robot': case 'bot': this.shove(t, (tx + ox * 0.3) * 160 * lift * k, 120 * lift * k, (tz + oz * 0.3) * 160 * lift * k, 'gust'); break;
          case 'drone': this.shove(t, tx * 14 * lift * k, 8 * lift * k, tz * 14 * lift * k, 'gust'); break;
          case 'prop': {
            const J = 250 * r * lift * k;
            this.shove(t, tx * J, 0, tz * J, 'gust');
            break;
          }
        }
      });
    }
  }

  // ================================================================== hydrokinesis

  private hydro(dt: number, r: number, held: number): void {
    const range = HYDRO_RANGE[r] * this.reachK;
    const jet = 32 * this.reachK;
    const A = this.aim('hands', range, jet, this.aimA);
    const sk = this.reachK;
    const ex = A.ox + A.dx * A.t, ey = A.oy + A.dy * A.t, ez = A.oz + A.dz * A.t;
    const grow = Math.min(1, held * 4 + 0.2);
    // The jet: a churning core and spray.
    this.fx.seg(A.ox, A.oy, A.oz, ex, ey, ez, 0.16 * sk * grow, 0.45, 0.65, 0.95, 0.9, BeamStyle.Water);
    const n = Math.ceil(dt * 150);
    for (let i = 0; i < n; i++) {
      const sp = jet * (0.85 + Math.random() * 0.3);
      const sx = (Math.random() - 0.5) * 0.12, sy = (Math.random() - 0.5) * 0.12, sz = (Math.random() - 0.5) * 0.12;
      this.fx.soft(A.ox, A.oy, A.oz, (A.dx + sx) * sp, (A.dy + sy) * sp, (A.dz + sz) * sp, Math.min(1.2, A.t / jet) + 0.05, 0.1 * sk, 0.28 * sk, WATER, WATER_END, 0.75, 0.25, 3);
    }
    if (A.hit.what !== 'none') {
      const H = A.hit;
      for (let i = 0; i < 4; i++) {
        const sp = 2 + Math.random() * 4;
        this.fx.soft(ex, ey, ez, (H.nx + (Math.random() - 0.5) * 1.6) * sp, (H.ny * 0.5 + 0.5 + Math.random()) * sp, (H.nz + (Math.random() - 0.5) * 1.6) * sp, 0.6, 0.12 * sk, 0.35 * sk, WATER, WATER_END, 0.7, 0.8, 9.8);
      }
      if (Math.random() < dt * 10) this.w.dust.burst(ex, ey, ez, 2, 0.4 * sk, 1.2, 0.7 * sk, 1.2, STEAM, 0.1, 0.25);
    }
    if (!this.waterLoop) this.waterLoop = this.w.synth.loop('water', 5 * sk);
    this.waterLoop?.set(A.ox, A.oy, A.oz, 0.7);
    const p = this.w.player;
    if (!p.action || p.animClock - p.action.t0 > p.action.dur - 0.1) p.action = { id: 'cast_forward', t0: p.animClock, dur: 0.5 };
    // Force, 10 ticks a second.
    this.hydroTick -= dt;
    if (this.hydroTick > 0) return;
    this.hydroTick = 0.1;
    const J = HYDRO_FORCE[r] * p.k * p.k * 0.1;
    const H = A.hit;
    const T = this.w.targeting;
    // Fire out near the impact.
    for (const o of statusList()) {
      const s = statusOf(o), t = this.kinds.get(o);
      if (!s || !t || s.burning <= 0) continue;
      const c = T.centre(t, _w);
      if (Math.hypot(c.x - ex, c.y - ey, c.z - ez) < 2.5 * sk) { s.burning = 0; this.steam(c.x, c.y, c.z, 1); this.w.synth.play('sizzle', c.x, c.y, c.z, 0.6, 5); }
    }
    // Puddles where it lands.
    this.hydroPuddleT -= 0.1;
    if (this.hydroPuddleT <= 0 && H.what !== 'none') {
      this.hydroPuddleT = 0.5;
      const g = this.w.collision.groundAt(ex, ez, ey + 0.5, 1);
      if (ey - g < 3 * sk) this.fx.decal(DecalKind.Puddle, ex, g, ez, 0, 1, 0, (1.6 + Math.random()) * sk, (1.3 + Math.random()) * sk, Math.random() * 6, 30);
      if (Math.random() < 0.5) this.w.synth.play('splash', ex, ey, ez, 0.5, 5);
    }
    // What the jet hits: the first thing, and whatever is right next to the impact.
    const hitOne = (t: Target) => {
      const e = this.hydroAcc.get(t.obj) ?? { acc: 0, t: this.time };
      if (this.time - e.t > 1.5) e.acc = 0;
      e.acc += J; e.t = this.time;
      this.hydroAcc.set(t.obj, e);
      if (!(statusOf(t.obj)?.wet)) { const c = this.w.targeting.centre(t, _d); this.record('hydro', t, 'wet', c.x, c.z); }
      this.wet(t, 8);
      switch (t.kind) {
        case 'person': {
          const a = t.obj;
          if (a.state !== PState.Down && e.acc > 260) { this.knock(a, A.ox, A.oz, Math.min(9, 2 + e.acc / 250), 0.8); this.record('hydro', t, 'knockdown', a.x, a.z); e.acc = 0; }
          else if (a.state === PState.Down) { a.vx += A.dx * J / 150; a.vz += A.dz * J / 150; }
          break;
        }
        case 'car': {
          const v = t.obj;
          v.speed *= 0.6; v.brake = 1;
          if (r >= 3 && (e.acc > 2600 || v.state === VState.Wreck)) { this.wreck(v, ex, ey, ez, A.dx * J * 1.4, J * 0.2, A.dz * J * 1.4, true); this.record('hydro', t, 'lift', v.x, v.z); }
          break;
        }
        case 'robot': case 'bot': if (e.acc > 120) { this.shove(t, A.dx * e.acc, 80, A.dz * e.acc, 'hydro'); e.acc = 0; } break;
        case 'drone': this.shove(t, A.dx * J * 0.15, -J * 0.05, A.dz * J * 0.15, 'hydro'); break;
        case 'prop': if (this.shove(t, A.dx * e.acc, 0, A.dz * e.acc, 'hydro')) e.acc = 0; break;
      }
    };
    if (H.what === 'target' && H.target) hitOne(H.target);
    T.inSphere(ex, ey, ez, 0.9 * sk, (t) => { if (!H.target || t.obj !== H.target.obj) hitOne(t); }, { person: true, car: false, robot: true, drone: false, prop: true });
    if (H.what === 'building') {
      // Sustained pressure bursts windows.
      const key = { obj: H.building! };
      const e = this.hydroAcc.get(key.obj) ?? { acc: 0, t: this.time };
      e.acc += J; e.t = this.time;
      this.hydroAcc.set(key.obj, e);
      if (e.acc > 1200) { if (this.w.destruction.impact(ex - H.nx * 0.05, ey, ez - H.nz * 0.05, 0.7 * sk, Math.min(e.acc, 2000), A.dx, A.dy, A.dz, 'wall')) this.record('hydro', 'building', 'facade', ex, ez); e.acc = 0; }
    }
  }

  // ================================================================== shrink ray

  private shrinkRay(r: number): boolean {
    const reach = SHRINK.reach * this.reachK;
    const A = this.aim('hands', reach, Infinity, this.aimA);
    const ex = A.ox + A.dx * A.t, ey = A.oy + A.dy * A.t, ez = A.oz + A.dz * A.t;
    this.beams.push({ ax: A.ox, ay: A.oy, az: A.oz, bx: ex, by: ey, bz: ez, t: 0, life: 0.4, w: 0.12 * this.reachK });
    const p = this.w.player;
    p.action = { id: 'cast_forward', t0: p.animClock, dur: 0.5 };
    this.w.synth.play('shrink', A.ox, A.oy, A.oz, 0.8, 5);
    for (let i = 0; i < 24; i++) this.fx.glow(ex, ey, ez, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, 0.5, 0.15 * this.reachK, 0.02, SHRINK_C, SHRINK_END, 1, 2, 0);
    const H = A.hit;
    if (H.what === 'target' && H.target) {
      this.shrink(H.target, SHRINK_FACTOR[r], SHRINK_TIME[r]);
      const c = this.w.targeting.centre(H.target, _w);
      this.record('shrink', H.target, 'shrink', c.x, c.z);
    }
    return true;
  }

  private updateBeams(dt: number): void {
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.t += dt;
      if (b.t > b.life) { this.beams.splice(i, 1); continue; }
      const f = 1 - b.t / b.life;
      this.fx.seg(b.ax, b.ay, b.az, b.bx, b.by, b.bz, b.w * (0.5 + f), SHRINK_C.r * 0.4, SHRINK_C.g * 0.4, SHRINK_C.b * 0.4, 1.2 * f, BeamStyle.Shrink);
    }
  }

  // ================================================================== states

  private flameT = 0;

  private updateStatus(dt: number): void {
    tickStatus(dt, (o, s) => this.restore(o, s));
    this.flameT -= dt;
    const flames = this.flameT <= 0;
    if (flames) this.flameT = 0.05;
    this.squeakT -= dt;
    const T = this.w.targeting;
    const cam = this.w.camera.position;
    for (const o of statusList()) {
      const t = this.kinds.get(o);
      const s = statusOf(o);
      if (!t || !s) continue;
      const c = T.centre(t, _v);
      const near = c.distanceToSquared(cam) < 250 * 250;
      switch (t.kind) {
        case 'person': {
          const a = t.obj;
          if (s.frozen > 0 && a.state !== PState.Down) {
            a.x = s.hx; a.z = s.hz; a.heading = s.hyaw; a.speed = 0; a.vx = 0; a.vz = 0;
            a.state = PState.Idle; a.stateT = 0;
          }
          if (s.burning > 0 && s.frozen <= 0 && a.state !== PState.Down && a.state !== PState.Flee) { a.state = PState.Flee; a.stateT = 0; a.fearX = a.x + (Math.random() - 0.5) * 4; a.fearZ = a.z + (Math.random() - 0.5) * 4; a.fear = 2; }
          if (s.shrink > 0 && this.squeakT <= 0 && near && c.distanceToSquared(cam) < 30 * 30 && Math.random() < 0.3) {
            this.squeakT = 1.5 + Math.random() * 2;
            this.w.synth.play('squeak', a.x, a.y + 0.3, a.z, 0.6, 3, 1 / Math.max(0.3, s.scale));
          }
          break;
        }
        case 'car': {
          const v = t.obj;
          if (s.frozen > 0 || s.stunned > 0) { v.speed = 0; v.brake = 1; }
          const sv = s.saved;
          if (sv?.len !== undefined) { v.length = (sv.len as number) * s.scale; v.width = (sv.wid as number) * s.scale; }
          if (sv?.paint) {
            const base = sv.charred ? CHARRED : (sv.paint as number[]);
            const f = s.frozen > 0 ? 0.75 : 0, wet = s.wet > 0 ? 0.72 : 1;
            v.paint = [(base[0] + (ICE_PAINT[0] - base[0]) * f) * wet, (base[1] + (ICE_PAINT[1] - base[1]) * f) * wet, (base[2] + (ICE_PAINT[2] - base[2]) * f) * wet];
          }
          // A burning car burns out: charred, then a wreck.
          if (s.burning > 0 && s.burning < 0.5 && !sv?.charred) {
            const sv2 = (s.saved ??= {});
            sv2.charred = true;
            if (v.state !== VState.Wreck && v.state !== VState.Crushed) { this.w.traffic.wreckIt(v); this.stats.wrecked++; this.record('fireWave', t, 'wreck', v.x, v.z); }
            v.damage = 1;
            this.w.sound('car_crash', v.x, v.y, v.z, 0.5, 0.8, 10);
            this.w.dust.burst(v.x, v.y + 1, v.z, 10, 1.2, 2, 1.5, 4, SMOKE, 0.8, 0.6);
          }
          break;
        }
        case 'prop': {
          const p = t.obj;
          if (Math.abs(s.scale - 1) > 1e-3 || p.base) this.w.props.setScale(p, s.scale);
          break;
        }
        default: break;
      }
      if (!near) continue;
      const hgt = T.height(t);
      // Ice crystals on the frozen.
      if (s.frozen > 0) {
        const n = t.kind === 'car' ? 10 : t.kind === 'prop' ? 5 : 6;
        const ext = t.kind === 'car' ? t.obj.length * 0.45 : t.kind === 'prop' ? Math.max(0.3, t.obj.radius) : 0.35;
        const melt = Math.min(1, s.frozen / 1.5);
        const baseY = c.y - hgt * 0.5;
        for (let i = 0; i < n; i++) {
          const a = i * 2.39996 + s.hx * 3.1, rr = ext * (0.55 + 0.45 * ((i * 0.618) % 1));
          const yaw = t.kind === 'car' ? t.obj.yaw : 0;
          const lx = Math.cos(a) * rr, lz = Math.sin(a) * rr * (t.kind === 'car' ? t.obj.width / t.obj.length : 1);
          const x = c.x + lx * Math.cos(yaw) + lz * Math.sin(yaw), z = c.z - lx * Math.sin(yaw) + lz * Math.cos(yaw);
          const yy = baseY + hgt * ((i * 0.37) % 1) * 0.85;
          this.fx.crystal(x, yy, z, (0.25 + 0.3 * ((i * 0.73) % 1)) * Math.min(1.6, Math.max(0.6, hgt / 1.6)) * (t.kind === 'prop' ? 0.5 : 1) * melt, a, (Math.cos(a) * 0.6), (Math.sin(a) * 0.6));
        }
      }
      // Flames and smoke on the burning.
      if (s.burning > 0 && flames) {
        const big = t.kind === 'car' ? 2.2 : t.kind === 'prop' && t.obj.tree ? 2.5 : 1;
        const ext = t.kind === 'car' ? t.obj.length * 0.35 : 0.25;
        for (let i = 0; i < (t.kind === 'car' ? 3 : 2); i++) {
          const x = c.x + (Math.random() - 0.5) * ext * 2, z = c.z + (Math.random() - 0.5) * ext * 2;
          const y = c.y - hgt * 0.3 + Math.random() * hgt * 0.6;
          this.fx.glow(x, y, z, 0, 1.6 * big, 0, 0.45 + Math.random() * 0.3, 0.25 * big, 0.6 * big, FIRE_HOT, FIRE_END, 0.85, 1, -2.5);
        }
        if (Math.random() < 0.45) this.fx.soft(c.x, c.y + hgt * 0.5, c.z, 0, 1.2, 0, 2.5, 0.4 * big, 2 * big, SMOKE, SMOKE_LIGHT, 0.45, 0.4, -0.6);
      }
      // Sparks off the stunned (cars, drones).
      if (s.stunned > 0 && flames && Math.random() < 0.25) {
        this.fx.glow(c.x + (Math.random() - 0.5), c.y + (Math.random() - 0.3) * hgt, c.z + (Math.random() - 0.5), 0, 0, 0, 0.12, 0.35, 0.05, BOLT_C, BOLT_END, 1, 1, 0);
      }
      // Drips off the wet.
      if (s.wet > 0 && flames && Math.random() < 0.2) {
        this.fx.soft(c.x + (Math.random() - 0.5) * 0.6, c.y, c.z + (Math.random() - 0.5) * 0.6, 0, -0.5, 0, 0.6, 0.05, 0.05, WATER, WATER_END, 0.7, 0, 9.8);
      }
    }
  }

  // ================================================================== small helpers

  private sparks(x: number, y: number, z: number, n: number): void {
    this.w.debris.chipBurst(x, y, z, Math.ceil(n / 2), 5, 0, 0.6, 0, SPARK, 0.025, 0.6);
    for (let i = 0; i < n; i++) {
      const sp = 3 + Math.random() * 5;
      this.fx.glow(x, y, z, (Math.random() - 0.5) * sp, Math.random() * sp, (Math.random() - 0.5) * sp, 0.3 + Math.random() * 0.3, 0.06, 0.02, SPARK, SPARK_END, 1, 0.6, 9.8);
    }
  }

  private steam(x: number, y: number, z: number, k: number): void {
    for (let i = 0; i < 8; i++) this.fx.soft(x + (Math.random() - 0.5), y, z + (Math.random() - 0.5), 0, 1.5, 0, 1.4, 0.3 * k, 1.6 * k, STEAM, SNOW_END, 0.5, 0.6, -0.8);
  }

  /** Short summary (window.game.elements.report()). */
  report(): string {
    const s = this.stats;
    return `impacts ${s.impacts} · walls broken ${s.broken} · knocked ${s.knocked} · frozen ${s.frozen} · wrecked ${s.wrecked} · shrunk ${s.shrunk} · states ${statusCount()} · ice tiles ${this.tiles.length} · fx particles ${this.fx.active}`;
  }

  /** Ice-path sheets alive (tests). */
  get iceTiles(): number { return this.tiles.length; }
  /** Unused-height helper kept for tests: car body height. */
  static carHeight(v: Vehicle): number { return vehicleHeight(v); }
}

const NO_TARGETS = { person: false, car: false, robot: false, drone: false, prop: false };

function newHit(): ProbeHit {
  return { what: 'none', target: null, building: null, t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0 };
}

function copyHit(h: ProbeHit, out: ProbeHit): ProbeHit {
  out.what = h.what; out.target = h.target; out.building = h.building; out.t = h.t;
  out.x = h.x; out.y = h.y; out.z = h.z; out.nx = h.nx; out.ny = h.ny; out.nz = h.nz;
  return out;
}
