/**
 * The elemental powers in the world (PLAYGROUND_PLAN §0 decisions 17, 18): laser eyes, fire
 * wave, fireball, frost nova, ice path, chain lightning, seismic stomp, whirlwind, hydrokinesis and the
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
 * shared status registry (src/shared/status.ts) that the renderers read. A big threat (a
 * monster, Target kind `threat`) takes every power as damage in the body zone it lands on
 * (ThreatActor.damage: armour, weak spots); frost on a leg makes it buckle.
 *
 * Idle cost: one early-out per frame when no power, state or effect is running.
 */
import * as THREE from 'three';
import { aimDir } from '../aimRay';
import type { ThreatZone } from '../threats/ThreatEvent';
import type { Player } from '../../player/Player';
import type { CameraRig } from '../../player/CameraRig';
import type { Targeting, Target, ProbeHit } from '../Targeting';
import { vehicleHeight } from '../Targeting';
import { ElementFx, BeamStyle, DecalKind } from './ElementFx';
import { fireBurst } from './blastFx';
import type { PowerSynth, SynthHandle } from '../../audio/PowerSynth';
import type { Destruction } from '../../destruction/Destruction';
import type { Debris } from '../../destruction/Debris';
import type { Dust } from '../../destruction/Dust';
import type { WorldIndex } from '../../world/WorldIndex';
import type { Collision } from '../../world/Collision';
import { PState, type Pedestrians, type PedAgent } from '../../sim/Pedestrians';
import type { Reactions } from '../../sim/Reactions';
import { VState, dentCar, type Traffic, type Vehicle } from '../../sim/Traffic';
import type { VehicleRenderer } from '../../sim/VehicleRenderer';
import type { NearFuture } from '../../future/NearFuture';
import type { PropRenderer } from '../../props/PropRenderer';
import type { Stimuli } from '../Stimuli';
import type { Sight } from '../combat/sight';
import type { Consequences, HarmEffect, HarmTarget } from '../Consequences';
import type { AbilityId } from '../abilities/defs';
import { statusFor, statusOf, statusList, statusCount, tickStatus, type TargetStatus } from '../../shared/status';
import { WallMat } from '../../plan/building';
import { DAMAGE_PER_IMPULSE } from '../threats/ThreatEvent';
import {
  LASER, LASER_RANGE, LASER_DOSE, FIRE, FIRE_RANGE, FIRE_HEAT, FIRE_BURN, FIREBALL, FIREBALL_RANGE, FIREBALL_RADIUS, FIREBALL_BLAST,
  FIREBALL_BURN, NOVA, NOVA_RADIUS, NOVA_FREEZE, ICE, ICE_WIDTH, ICE_LIFE,
  BOLT, BOLT_JUMPS, BOLT_JUMP_RANGE, BOLT_REACH, BOLT_STUN, QUAKE, QUAKE_LENGTH, QUAKE_IMPULSE, GUST, GUST_RADIUS, GUST_TIME, GUST_LIFT,
  HYDRO_RANGE, HYDRO_FORCE, SHRINK, SHRINK_TIME, SHRINK_DEALT, shrinkFactor,
  PHASE, PHASE_DMG, PHASE_RANGE, FOCUS, FOCUS_DMG, FOCUS_RANGE, SEEKER, SEEKER_DMG, SEEKER_RANGE,
  POWER_HIT,
} from '../abilities/tuning';
import { COMBAT } from '../Combat';

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
  /** Water on a spot: burning facades there die down (FacadeFires.douse). */
  douse?: (x: number, y: number, z: number, r: number, amount: number) => void;
  /** The shared line of sight (combat/sight): a targeted power fires only with a clear line. */
  sight?: Pick<Sight, 'clear'>;
  /** Short feedback (a toast) for a power that could not go off. */
  deny?: (msg: string) => void;
  /**
   * The brood's creatures round a point take a power (ThreatDirector.broodHit): dmg in their hit
   * points (frost: seconds frozen), flung at `fling` m/s. Returns where the ones hit are.
   */
  swarm?: (effect: 'blow' | 'fire' | 'shock' | 'frost' | 'wind' | 'water' | 'heat', x: number, y: number, z: number, r: number, dmg: number, fling: number) => { x: number; y: number; z: number }[];
  /** A blow on a person through the combat model (Combat.hitActor: damage, stagger, knock-down, KO). */
  hitPerson?: (a: PedAgent, jx: number, jy: number, jz: number, fromX: number, fromZ: number) => void;
  /** Underground.sameSide with feet heights: a single-target power never crosses the street / sewer boundary. */
  sameSide?: (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => boolean;
  /** Has the player bought this power's friend/foe sense (Progress.hasSense)? */
  sense?: (id: AbilityId) => boolean;
  /** Would the sense spare this target (friendFoe.spared: not fighting the player)? */
  spared?: (t: Target) => boolean;
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
interface FireBurst { ox: number; oy: number; oz: number; dx: number; dy: number; dz: number; range: number; rank: number; t: number; cand: { t: Target; d: number }[]; walls: { x: number; y: number; z: number; nx: number; ny: number; nz: number; d: number; building: boolean }[]; k: number; swarmD: number }
/** A fireball in flight: from (ox, oy, oz) along (dx, dy, dz), bursting at distance `L`. */
interface Orb { ox: number; oy: number; oz: number; dx: number; dy: number; dz: number; L: number; s: number; v: number; rank: number; k: number; trailT: number }
interface Quake { x0: number; z0: number; dx: number; dz: number; len: number; t: number; done: number; rank: number; k: number; hit: Set<object> }
interface Vortex { air: boolean; x: number; y: number; z: number; dx: number; dz: number; r: number; t: number; life: number; rank: number; k: number; tick: number; hitT: Map<object, number>; loop: SynthHandle | null }
interface Nova { x: number; y: number; z: number; r: number; t: number }
interface Beam { ax: number; ay: number; az: number; bx: number; by: number; bz: number; t: number; life: number; w: number; c: THREE.Color; style: BeamStyle; I: number }
/** A seeker orb on its way: position, velocity, the one target it hunts, and whether the line to it is clear. */
interface Seeker { x: number; y: number; z: number; vx: number; vy: number; vz: number; tgt: Target; rank: number; k: number; age: number; trailT: number; checkT: number; clear: boolean; loop: SynthHandle | null; tail: number[]; tailT: number }
interface IcePatch { x: number; y: number; z: number; r: number; until: number; sense?: boolean }
interface IceTile { x: number; y: number; z: number; yaw: number; pitch: number; len: number; wid: number; born: number; life: number }

const C = (r: number, g: number, b: number) => new THREE.Color(r, g, b);
const FIRE_HOT = C(2.2, 1.05, 0.25), FIRE_MID = C(1.8, 0.5, 0.06), FIRE_END = C(0.55, 0.08, 0.01);
const SMOKE = C(0.16, 0.15, 0.14), SMOKE_LIGHT = C(0.45, 0.44, 0.43);
const SPARK = C(4, 2.4, 0.8), SPARK_END = C(1.5, 0.4, 0.05);
const LASER_RED = C(2.6, 0.3, 0.12);
const BOLT_C = C(3, 3.6, 5), BOLT_END = C(0.6, 0.8, 1.6);
const ICE_C = C(1.6, 2.0, 2.4), ICE_END = C(0.5, 0.7, 0.9), SNOW = C(0.92, 0.96, 1.0), SNOW_END = C(0.8, 0.88, 0.95);
const WATER = C(0.72, 0.84, 0.95), WATER_END = C(0.55, 0.7, 0.85), STEAM = C(0.9, 0.92, 0.94);
const DUST_C = C(0.55, 0.5, 0.44), DUST_END = C(0.45, 0.42, 0.38), LEAF = C(0.32, 0.38, 0.16), LEAF_END = C(0.4, 0.33, 0.15);
const SHRINK_C = C(2.4, 0.9, 3.0), SHRINK_END = C(0.6, 0.3, 1.2);
const PHASE_C = C(1.1, 2.2, 3.2), PHASE_END = C(0.25, 0.5, 1.1);
const FOCUS_C = C(3.2, 2.6, 1.4), FOCUS_END = C(1.4, 0.7, 0.2), FOCUS_HOT = C(4.5, 4, 3.2), FOCUS_WHITE = C(3.5, 3.4, 3);
const SEEK_C = C(1.6, 1.4, 3.4), SEEK_END = C(0.5, 0.25, 1.4), SEEK_HOT = C(4, 3.8, 4.4), SEEK_WHITE = C(3, 3, 3.4);
const SEEK_MID = C(2.4, 2, 4), SEEK_SPARK = C(3.2, 3, 4);
const CHARRED: [number, number, number] = [0.05, 0.045, 0.04];
const ICE_PAINT: [number, number, number] = [0.8, 0.9, 0.98];

const _v = new THREE.Vector3();
const _eyeL = new THREE.Vector3(), _eyeR = new THREE.Vector3();
const _eyes = [_eyeL, _eyeR];
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
  private orbs: Orb[] = [];
  private quakes: Quake[] = [];
  private vortices: Vortex[] = [];
  private novas: Nova[] = [];
  private beams: Beam[] = [];
  private patches: IcePatch[] = [];
  private tiles: IceTile[] = [];
  private seekers: Seeker[] = [];
  private chargeLoop: SynthHandle | null = null;
  private tileBox = { x0: 0, z0: 0, x1: 0, z1: 0 };
  private slipT = 0;
  private squeakT = 0;
  private lastChannel: AbilityId | null = null;
  /** Debug counters (window.game.elements.stats). */
  readonly stats = { impacts: 0, knocked: 0, frozen: 0, wrecked: 0, shrunk: 0, broken: 0, threat: 0 };

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
    this.idle = false;
    this.w.consequences.update(dt);
    const busy = channel || this.lastChannel || this.bolts.length || this.fires.length || this.orbs.length || this.seekers.length || this.quakes.length || this.vortices.length
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
        case 'focus': this.gather(dt, channel.rank, channel.t); break;
        default: break;
      }
    }
    // ---- effects in flight
    if (this.bolts.length) this.updateBolts(dt);
    if (this.fires.length) this.updateFires(dt);
    if (this.orbs.length) this.updateOrbs(dt);
    if (this.seekers.length) this.updateSeekers(dt);
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
    if (id === 'focus') { this.chargeLoop?.stop(); this.chargeLoop = null; }
  }

  // ================================================================== tap powers

  /** A tap power: true if it went off (the AbilitySystem then charges energy and cooldown). */
  fire(id: AbilityId, rank: number): boolean {
    switch (id) {
      case 'frostNova': return this.frostNova(rank);
      case 'fireWave': return this.fireWave(rank);
      case 'fireball': return this.fireball(rank);
      case 'lightning': return this.lightning(rank);
      case 'stomp': return this.stomp(rank);
      case 'gust': return this.gust(rank);
      case 'shrink': return this.shrinkRay(rank);
      case 'phase': return this.phase(rank);
      case 'seeker': return this.seeker(rank);
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
  private aim(where: 'eyes' | 'hands', range: number, lead: number, out: Aim, pass?: (t: Target) => boolean): Aim | null {
    const T = this.w.targeting, p = this.w.player;
    const o = this.origin(where, _v);
    out.ox = o.x; out.oy = o.y; out.oz = o.z;
    const tgt = T.current;
    let dx: number, dy: number, dz: number;
    if (tgt && T.alive(tgt)) {
      // Targeted (combat/shot.ts): out of reach or no clear line → it does not go off; else it hits.
      const c = T.aimPoint(tgt, o.x, o.y, o.z, Infinity, _w);
      const cx = c.x, cy = c.y, cz = c.z;
      const pad = this.padOf(tgt);
      const d = c.distanceTo(o);
      const why = d - pad > range * 1.15 ? 'range' : this.w.sight && !this.w.sight.clear(o.x, o.y, o.z, cx, cy, cz, pad, tgt.kind === 'car' ? tgt.obj : null) ? 'sight' : null;
      if (why) { this.refuse(why); return null; }
      const t = Math.max(0.1, d - Math.min(pad, 0.3));
      if (isFinite(lead)) T.aimPoint(tgt, o.x, o.y, o.z, lead, _w);
      dx = _w.x - o.x; dy = _w.y - o.y; dz = _w.z - o.z;
      const L = Math.hypot(dx, dy, dz) || 1;
      out.dx = dx / L; out.dy = dy / L; out.dz = dz / L;
      const h = out.hit;
      h.what = 'target'; h.target = tgt; h.building = null; h.t = t; out.t = t;
      // The impact point: on the body (unled), facing back along the line.
      const k = Math.max(0, (d - Math.min(pad, 0.3)) / (d || 1));
      h.x = o.x + (cx - o.x) * k; h.y = o.y + (cy - o.y) * k; h.z = o.z + (cz - o.z) * k;
      h.nx = -out.dx; h.ny = -out.dy; h.nz = -out.dz;
      if (!p.flying && Math.hypot(out.dx, out.dz) > 0.1) p.yaw = Math.atan2(-out.dx, -out.dz);
      return out;
    }
    {
      // Through the cursor (or the crosshair while looking): what the camera ray meets beyond the player.
      const cam = this.w.camera;
      aimDir(cam, _d);
      const c = cam.position;
      const t0 = Math.max(0, (p.pos.x - c.x) * _d.x + (p.pos.y + p.height * 0.6 - c.y) * _d.y + (p.pos.z - c.z) * _d.z);
      const sx = c.x + _d.x * t0, sy = c.y + _d.y * t0, sz = c.z + _d.z * t0;
      const h = T.probe(sx, sy, sz, _d.x, _d.y, _d.z, range, null, undefined, pass);
      const ex = h.what === 'none' ? sx + _d.x * range : h.x, ey = h.what === 'none' ? sy + _d.y * range : h.y, ez = h.what === 'none' ? sz + _d.z * range : h.z;
      dx = ex - o.x; dy = ey - o.y; dz = ez - o.z;
    }
    const L = Math.hypot(dx, dy, dz) || 1;
    out.dx = dx / L; out.dy = dy / L; out.dz = dz / L;
    // Untargeted: along the ray from the origin to whatever is there first (a bystander, a car, a
    // drone, a facade, the ground) — what it meets is what it hits.
    const h = T.probe(o.x, o.y, o.z, out.dx, out.dy, out.dz, range, null, undefined, pass);
    out.hit = copyHit(h, out.hit);
    out.t = h.what === 'none' ? range : h.t;
    // Face it.
    if (!p.flying && Math.hypot(out.dx, out.dz) > 0.1) p.yaw = Math.atan2(-out.dx, -out.dz);
    return out;
  }

  /** How far short of a target's aim point a line may end (its body). */
  private padOf(t: Target): number { return this.w.targeting.padOf(t); }

  /** A targeted power that cannot go off: the frame says why, a short toast (not every frame). */
  private refuse(why: 'sight' | 'range'): void {
    this.w.targeting.refuse(why);
    this.refused++;
    if (this.time - this.refuseToastT > 1.6) {
      this.refuseToastT = this.time;
      this.w.deny?.(why === 'sight' ? 'No line of sight to your target' : 'Your target is out of reach');
    }
  }
  private refuseToastT = -9;
  /** Targeted uses refused (no line of sight / out of reach), for the dev panel. */
  refused = 0;
  /** The held power did nothing this frame (refused): AbilitySystem drains no energy for it. */
  idle = false;
  /** Yaw toward the cursor (camera yaw when the ray is near vertical or there is no cursor). */
  private cursorYaw(): number {
    aimDir(this.w.camera, _d);
    return Math.hypot(_d.x, _d.z) > 0.05 ? Math.atan2(-_d.x, -_d.z) : this.w.camRig.yaw;
  }
  private aimA: Aim = { ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 0, t: 0, hit: newHit() };

  // ================================================================== effects on targets

  // ================================================================== friend/foe sense

  /** Does this power's friend/foe sense spare the target (bought, and the target is not a foe)? */
  private spares(power: AbilityId, t: Target): boolean {
    return !!this.w.sense?.(power) && !!this.w.spared?.(t);
  }

  /** May this power damage buildings (walls, windows, signs)? Not with the sense: it harms nothing
   *  that would cost the player reputation. */
  private wrecks(power: AbilityId): boolean {
    return !this.w.sense?.(power);
  }

  /** The sense as a probe filter for a power's aim (undefined without it: the probe sees all). */
  private passFor(power: AbilityId): ((t: Target) => boolean) | undefined {
    return this.w.sense?.(power) && this.w.spared ? this.w.spared : undefined;
  }

  /** Targeting.inSphere for an area power: friends are left out when it has the sense. */
  private area(power: AbilityId, x: number, y: number, z: number, r: number, fn: (t: Target, d: number) => void, kinds?: Parameters<Targeting['inSphere']>[5]): void {
    this.w.targeting.inSphere(x, y, z, r, (t, d) => { if (!this.spares(power, t)) fn(t, d); }, kinds);
  }

  private harmKind(t: Target): HarmTarget {
    return t.kind === 'bot' ? 'robot' : t.kind === 'threat' ? 'robot' : t.kind;
  }

  private record(power: AbilityId, t: Target | 'building' | 'ground', effect: HarmEffect, x: number, z: number): void {
    // Hurting a monster is not collateral.
    if (typeof t !== 'string' && t.kind === 'threat') return;
    this.w.consequences.record(power, typeof t === 'string' ? t : this.harmKind(t), effect, x, z, typeof t === 'string' ? undefined : t.obj);
  }

  /**
   * A power lands on a big threat: damage (points before armour) in the zone at the point (default:
   * the part of the body nearest the player). Sparks / steam where it hits.
   */
  private hurtThreat(t: Target, amount: number, x?: number, y?: number, z?: number): void {
    if (t.kind !== 'threat' || amount <= 0) return;
    const p = this.w.player;
    // The zone hit: at the impact point when the power has one; otherwise what it was aimed at —
    // an exposed weak spot (the aim locks onto it), else the part the view ray meets. (It used to
    // be the zone nearest the player: from the ground almost always a leg, so aimed hits on the
    // glowing throat never counted.)
    let zone: ThreatZone | null = null;
    let px = x, py = y, pz = z;
    if (px !== undefined && py !== undefined && pz !== undefined) zone = t.obj.zoneAt(px, py, pz)?.zone ?? null;
    else {
      zone = this.w.targeting.zoneOf(t.obj) ?? t.obj.zones.find((zn) => zn.weak && zn.exposed) ?? null;
      if (!zone) {
        const cam = this.w.camera;
        aimDir(cam, _d);
        zone = t.obj.ray(cam.position.x, cam.position.y, cam.position.z, _d.x, _d.y, _d.z, 4000)?.zone ?? null;
      }
      if (zone) { px = zone.x; py = zone.y; pz = zone.z; }
    }
    px ??= t.obj.x; py ??= t.obj.y; pz ??= t.obj.z;
    const res = t.obj.damage(zone, amount, { cause: 'player', x: p.pos.x, y: p.pos.y, z: p.pos.z });
    this.stats.threat += res.dealt;
    if (res.weak && Math.random() < 0.5) this.sparks(px, py, pz, 8);
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
        dentCar(v, J / 8000);
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
      case 'threat': this.hurtThreat(t, J * DAMAGE_PER_IMPULSE); return false;
    }
  }

  private freeze(t: Target, dur: number): void {
    // A monster: the frost bites into the leg nearest the player (enough of it and the leg buckles).
    if (t.kind === 'threat') { this.hurtThreat(t, dur * POWER_HIT.frostCreature * (t.obj.onElement?.('frost', dur) ?? 1), t.obj.x + (this.w.player.pos.x - t.obj.x) * 0.3, t.obj.y * 0.4, t.obj.z + (this.w.player.pos.z - t.obj.z) * 0.3); return; }
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

  /** Set something alight from outside the player's powers (a villain's bomb): burns as from fire wave. */
  ignite(t: Target, dur: number): void {
    if (t.kind === 'threat') return;
    this.burn(t, dur);
    // Not the player's doing: a car that burns out from it is not booked to them.
    const s = statusOf(t.obj);
    if (s && s.burning > 0) (s.saved ??= {}).notPlayer = true;
  }

  private burn(t: Target, dur: number): void {
    if (t.kind === 'threat') { this.hurtThreat(t, dur * 5 * (t.obj.onElement?.('fire', dur) ?? 1)); return; }
    const s = this.track(t);
    if (s.frozen > 0) { s.frozen = Math.max(0, s.frozen - dur); return; } // thaws instead
    s.burning = Math.max(s.burning, dur * (s.wet > 0 ? 0.4 : 1));
    if (s.saved?.notPlayer) delete s.saved.notPlayer;
    if (t.kind === 'car') this.savePaint(t.obj, s);
  }

  private stun(t: Target, dur: number): void {
    if (t.kind === 'threat') { this.hurtThreat(t, dur * 22 * (t.obj.onElement?.('shock', dur) ?? 1)); return; }
    const s = this.track(t);
    s.stunned = Math.max(s.stunned, dur);
  }

  private wet(t: Target, dur: number): void {
    if (t.kind === 'threat') return;
    const s = this.track(t);
    s.wet = Math.max(s.wet, dur);
    if (s.burning > 0) { s.burning = 0; const c = this.w.targeting.centre(t, _w); this.steam(c.x, c.y, c.z, 1); }
    if (t.kind === 'car') this.savePaint(t.obj, s);
  }

  /**
   * Shrink ray at rank `r`: by the rank's factor, but never more than the rank's cap off the target's
   * biggest dimension (a person halves, a car loses a metre, a monster a few). While shrunk it deals
   * less (`dealtBy`). Monsters that cannot shrink (`setScale` absent) only hit softer.
   */
  private shrink(t: Target, r: number): void {
    const factor = t.kind === 'threat' && !t.obj.setScale ? 1 : shrinkFactor(this.w.targeting.size(t), r);
    const s = this.track(t);
    if (s.shrink <= 0) { this.stats.shrunk++; s.dealt = 1; }
    s.shrink = Math.max(s.shrink, SHRINK_TIME[r]);
    s.scaleTo = Math.min(s.scaleTo === 1 ? 1 : s.scaleTo, factor);
    s.dealt = Math.min(s.dealt, SHRINK_DEALT[r]);
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
    else if (t.kind === 'threat') t.obj.setScale?.(1);
    else if (t.kind === 'person' && t.obj.state === PState.Idle) t.obj.stateT = 5; // walk on soon
  }

  // ================================================================== laser eyes

  private laser(dt: number, r: number, held: number): void {
    const range = LASER_RANGE[r] * this.reachK;
    const A = this.aim('eyes', range, Infinity, this.aimA, this.passFor('laser'));
    if (!A) { this.idle = true; this.laserLoop?.stop(); this.laserLoop = null; return; }
    const p = this.w.player, h = p.height, k = p.k;
    const ex = A.ox + A.dx * A.t, ey = A.oy + A.dy * A.t, ez = A.oz + A.dz * A.t;
    // Two beams from the eyes, converging on the spot.
    const yaw = this.w.camRig.yaw, rx = Math.cos(yaw) * 0.032 * h, rz = -Math.sin(yaw) * 0.032 * h;
    if (!p.eyePositions(_eyeL, _eyeR)) { _eyeL.set(A.ox - rx, A.oy, A.oz - rz); _eyeR.set(A.ox + rx, A.oy, A.oz + rz); }
    // A white-hot core inside a wide red halo, pulsing slightly, plus a flare at each eye.
    const grow = Math.min(1, held * 6 + 0.3), pulse = 1 + 0.12 * Math.sin(this.time * 31);
    const wdt = Math.max(0.022, 0.055 * Math.max(0.4, this.sk)) * grow;
    for (const e of _eyes) {
      this.fx.seg(e.x, e.y, e.z, ex, ey, ez, wdt * 3.2 * pulse, 2.4, 0.18, 0.08, 0.7, BeamStyle.Laser);
      this.fx.seg(e.x, e.y, e.z, ex, ey, ez, wdt, 2.8, 0.35, 0.16, 2.3 * pulse, BeamStyle.Laser);
      this.fx.glow(e.x, e.y, e.z, 0, 0, 0, 0.05, wdt * 4.5 * pulse, wdt * 3, SPARK, LASER_RED, 0.9, 1, 0);
    }
    // Sound.
    if (!this.laserLoop) this.laserLoop = this.w.synth.loop('laser', 4 * Math.max(1, this.sk));
    this.laserLoop?.set(A.ox, A.oy, A.oz, 0.55, 1 / Math.pow(Math.max(0.3, k), 0.12));
    const hit = A.hit.what !== 'none';
    // Impact glow and sparks (every frame), smoke now and then.
    if (hit) {
      const nx = A.hit.nx, ny = A.hit.ny, nz = A.hit.nz;
      const rk = this.reachK;
      this.fx.glow(ex + nx * 0.05, ey + ny * 0.05, ez + nz * 0.05, 0, 0.3, 0, 0.08, 0.5 * rk * pulse, 0.9 * rk, FIRE_HOT, FIRE_MID, 1, 1, 0);
      this.fx.glow(ex + nx * 0.1, ey + ny * 0.1, ez + nz * 0.1, 0, 0, 0, 0.06, 1.3 * rk * pulse, 1.6 * rk, LASER_RED, FIRE_END, 0.45, 1, 0);
      this.laserFxT -= dt;
      if (this.laserFxT <= 0) {
        this.laserFxT = 0.03;
        for (let i = 0; i < 6; i++) {
          const sp = 4 + Math.random() * 7;
          this.fx.glow(ex, ey, ez, (nx + (Math.random() - 0.5) * 1.8) * sp, (ny + Math.random() * 0.9) * sp, (nz + (Math.random() - 0.5) * 1.8) * sp, 0.3 + Math.random() * 0.4, 0.07, 0.02, SPARK, SPARK_END, 1, 0.5, 9.8);
        }
        // Molten drips running off the spot.
        if (Math.random() < 0.5) this.fx.glow(ex + nx * 0.05, ey + ny * 0.05, ez + nz * 0.05, nx * 0.6 + (Math.random() - 0.5), 0.5, nz * 0.6 + (Math.random() - 0.5), 0.7 + Math.random() * 0.4, 0.09 * rk, 0.04 * rk, FIRE_HOT, FIRE_END, 1, 0.3, 9.8);
        if (Math.random() < 0.5) this.fx.soft(ex + nx * 0.2, ey + ny * 0.2, ez + nz * 0.2, nx * 0.3, 0.8, nz * 0.3, 1.8, 0.25, 1.4 * rk, SMOKE, SMOKE_LIGHT, 0.5, 0.6, -0.4);
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
    this.w.swarm?.('heat', ex, ey, ez, 0.8 * this.reachK, 1.2, 1.5);
    if ((H.what === 'building' || H.what === 'roof') && this.wrecks('laser')) {
      // Cumulative heat on the spot (60 cm cells): the panel gives way once the dose beats it.
      const key = (Math.round(ex / 0.6) * 73856093) ^ (Math.round(ey / 0.6) * 19349663) ^ (Math.round(ez / 0.6) * 83492791);
      let s = this.laserSpots.get(key);
      if (!s || this.time - s.t > 3) { s = { acc: 0, t: this.time }; this.laserSpots.set(key, s); }
      s.acc += dose; s.t = this.time;
      const n = this.w.destruction.impact(ex - H.nx * 0.05, ey, ez - H.nz * 0.05, 0.5 * this.reachK, s.acc, A.dx, A.dy, A.dz, 'wall');
      this.stats.impacts++;
      if (n > 0) { this.laserSpots.delete(key); this.stats.broken += n; }
      if (this.laserSpots.size > 64) for (const [kk, v] of this.laserSpots) if (this.time - v.t > 3) this.laserSpots.delete(kk);
    } else if (H.what === 'target' && H.target) {
      const t = H.target;
      const acc = (this.dose.get(t.obj) ?? 0) + dose;
      this.dose.set(t.obj, acc);
      const jx = A.dx, jy = A.dy, jz = A.dz;
      switch (t.kind) {
        case 'person': {
          const a = t.obj;
          if (a.state !== PState.Down) { this.knock(a, A.ox, A.oz, POWER_HIT.laserKnock[r]); this.record('laser', t, 'knockdown', a.x, a.z); }
          if ((statusOf(a)?.burning ?? 0) <= 0) this.record('laser', t, 'burn', a.x, a.z);
          this.burn(t, 3);
          break;
        }
        case 'car': {
          const v = t.obj;
          dentCar(v, dose / 12000);
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
        case 'threat': this.hurtThreat(t, dose * DAMAGE_PER_IMPULSE, ex, ey, ez); this.dose.delete(t.obj); break;
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
    const A = this.aim('hands', range, 25, this.aimA, this.passFor('fireWave'));
    if (!A) return false;
    const b: FireBurst = { ox: A.ox, oy: A.oy, oz: A.oz, dx: A.dx, dy: A.dy, dz: A.dz, range, rank: r, t: 0, cand: [], walls: [], k, swarmD: 0 };
    // Who and what is in the cone (with a line of sight from the hands).
    const cosA = Math.cos(FIRE.halfAngle);
    this.area('fireWave', A.ox + A.dx * range * 0.5, A.oy + A.dy * range * 0.5, A.oz + A.dz * range * 0.5, range * 0.62, (t) => {
      const c = this.w.targeting.centre(t, _w);
      const vx = c.x - A.ox, vy = c.y - A.oy, vz = c.z - A.oz, d = Math.hypot(vx, vy, vz);
      if (d > range || d < 1e-3) return;
      const ext = t.kind === 'car' ? t.obj.length * 0.5 : 0.5;
      const cos = (vx * A.dx + vy * A.dy + vz * A.dz) / d;
      if (cos < cosA - ext / Math.max(1, d)) return;
      if (!this.w.targeting.sees({ x: A.ox, y: A.oy, z: A.oz }, t, c)) return;
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
      // The brood in the cone: burnt where the front passes (a slab every 1.5 m).
      while (this.w.swarm && b.swarmD + 1.5 <= front) {
        b.swarmD += 1.5;
        const d = b.swarmD;
        this.w.swarm('fire', b.ox + b.dx * d, b.oy + b.dy * d - 0.8, b.oz + b.dz * d, Math.tan(FIRE.halfAngle) * d + 0.8, 1.4, 2);
      }
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
        if (wl.building && this.wrecks('fireWave')) {
          const n = this.w.destruction.impact(wl.x - wl.nx * 0.05, wl.y, wl.z - wl.nz * 0.05, 1.1 * sk, FIRE_HEAT[b.rank] * b.k * b.k, b.dx, b.dy, b.dz, 'wall');
          this.stats.impacts++;
          if (n) this.stats.broken += n;
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
        if (d < b.range * POWER_HIT.fireKnockReach && a.state !== PState.Down) { this.knock(a, b.ox, b.oz, POWER_HIT.fireKnock[b.rank]); this.record('fireWave', t, 'knockdown', a.x, a.z); }
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
      case 'threat': this.hurtThreat(t, FIRE_HEAT[b.rank] * b.k * b.k * DAMAGE_PER_IMPULSE * POWER_HIT.fireCreatureMul * (t.obj.onElement?.('fire', burnT) ?? 1), b.ox + b.dx * d, b.oy + b.dy * d, b.oz + b.dz * d); break;
      case 'prop': {
        const p = t.obj;
        if (p.tree || p.kind.includes('bench') || p.kind.includes('bin')) { this.burn(t, burnT * 1.5); this.record('fireWave', t, 'burn', c.x, c.z); }
        else if (p.kind.includes('lamp') && !p.dark) { this.w.props.darken(p); this.w.synth.play('pop', c.x, p.y + p.height, c.z, 0.6, 6); this.record('fireWave', t, 'break', c.x, c.z); }
        else this.fx.decal(DecalKind.Scorch, p.x, this.w.collision.groundAt(p.x, p.z, p.y + 1, 1.5), p.z, 0, 1, 0, 1.4, 1.4, 0, 40);
        break;
      }
    }
  }

  // ================================================================== fireball

  /** Hurl a fireball at the target or along the cursor; it bursts on what it meets (or at full reach). */
  private fireball(r: number): boolean {
    const k = this.w.player.k;
    const range = FIREBALL_RANGE[r] * this.reachK;
    const v = FIREBALL.speed * this.reachK;
    const A = this.aim('hands', range, v, this.aimA, this.passFor('fireball'));
    if (!A) return false;
    this.orbs.push({ ox: A.ox, oy: A.oy, oz: A.oz, dx: A.dx, dy: A.dy, dz: A.dz, L: Math.max(0.5, A.t), s: 0, v, rank: r, k, trailT: 0 });
    const p = this.w.player;
    p.action = { id: 'cast_forward', t0: p.animClock, dur: 0.5 };
    this.w.synth.play('fire', A.ox, A.oy, A.oz, 0.7, 5 * this.reachK, 1.3 / Math.pow(Math.max(0.3, k), 0.1));
    this.w.stimuli.emit('power', A.ox, A.oy, A.oz, 4, 40 + range);
    return true;
  }

  private updateOrbs(dt: number): void {
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const o = this.orbs[i];
      const s0 = o.s;
      o.s = Math.min(o.L, o.s + o.v * dt);
      const sk = Math.max(0.5, Math.sqrt(o.k)), size = (0.35 + o.rank * 0.08) * sk;
      const x = o.ox + o.dx * o.s, y = o.oy + o.dy * o.s, z = o.oz + o.dz * o.s;
      // The ball: a hot core and licking flames, a trail of embers and smoke behind it.
      this.fx.glow(x, y, z, 0, 0, 0, 0.06, size * 1.6, size * 1.2, SPARK, FIRE_MID, 1, 1, 0);
      for (let j = 0; j < 3; j++) this.fx.glow(x, y, z, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2 + 0.5, (Math.random() - 0.5) * 2, 0.12 + Math.random() * 0.1, size * 1.4, size * 0.6, FIRE_HOT, FIRE_END, 0.8, 1, 0);
      const n = Math.ceil((o.s - s0) / (0.35 * sk));
      for (let j = 0; j < n; j++) {
        const t = s0 + (o.s - s0) * (j / Math.max(1, n));
        this.fx.glow(o.ox + o.dx * t, o.oy + o.dy * t, o.oz + o.dz * t, (Math.random() - 0.5) * 1.5, 0.8 + Math.random(), (Math.random() - 0.5) * 1.5, 0.25 + Math.random() * 0.25, size * 0.9, size * 0.2, FIRE_MID, FIRE_END, 0.6, 1.5, -1);
      }
      o.trailT -= dt;
      if (o.trailT <= 0) { o.trailT = 0.05; this.fx.soft(x, y, z, 0, 0.6, 0, 0.9, size * 0.6, size * 2.2, SMOKE, SMOKE_LIGHT, 0.3, 1, -0.3); }
      if (o.s < o.L) continue;
      this.orbs.splice(i, 1);
      this.fireballBurst(x - o.dx * 0.2, y - o.dy * 0.2, z - o.dz * 0.2, o);
    }
  }

  /** The fireball bursts: a blast on the facades (the old test blast's impact), everything in the radius thrown and set alight. */
  private fireballBurst(x: number, y: number, z: number, o: Orb): void {
    const r = o.rank, k = o.k, sk = Math.max(0.5, Math.sqrt(k));
    const R = FIREBALL_RADIUS[r] * sk;
    const burnT = FIREBALL_BURN[r];
    if (this.wrecks('fireball')) {
      const n = this.w.destruction.impact(x, y, z, R * 0.6, FIREBALL_BLAST[r] * k * k, 0, 0.2, 0, 'blast');
      this.stats.impacts++;
      if (n) this.stats.broken += n;
    }
    this.w.swarm?.('fire', x, y, z, R, 3, 4);
    this.area('fireball', x, y, z, R, (t, d) => {
      const f = 1 - d / R;
      const c = this.w.targeting.centre(t, _w);
      let hx = c.x - x, hz = c.z - z;
      const hl = Math.hypot(hx, hz) || 1;
      hx /= hl; hz /= hl;
      switch (t.kind) {
        case 'person': {
          const a = t.obj;
          if (a.state !== PState.Down) { this.knock(a, x, z, POWER_HIT.fireballKnock[r] * (0.5 + 0.5 * f), 2 + 4 * f); this.record('fireball', t, 'knockdown', a.x, a.z); }
          this.burn(t, burnT);
          this.record('fireball', t, 'burn', a.x, a.z);
          break;
        }
        case 'car': {
          const v = t.obj;
          v.fear = 2;
          this.burn(t, burnT * 2);
          this.record('fireball', t, 'burn', v.x, v.z);
          // Rank 3 on: the car is thrown and burns out; below, scorched and stalled.
          if (r >= 3 && f > 0.25) { this.wreck(v, x, y, z, hx * 9000 * f * k, 7000 * f * k, hz * 9000 * f * k); this.record('fireball', t, 'wreck', v.x, v.z); }
          else { v.speed *= 0.2; dentCar(v, 0.25 * f); }
          break;
        }
        case 'robot': case 'bot': this.shove(t, hx * 900 * f * k, 400 * f * k, hz * 900 * f * k, 'fireball'); this.burn(t, burnT * 0.5); break;
        case 'drone': this.shove(t, hx * 120 * f, 60 * f, hz * 120 * f, 'fireball'); break;
        case 'threat': this.hurtThreat(t, FIREBALL_BLAST[r] * k * k * DAMAGE_PER_IMPULSE * POWER_HIT.fireballCreatureMul * (t.obj.onElement?.('fire', burnT) ?? 1), x, y, z); break;
        case 'prop': {
          const p = t.obj;
          this.shove(t, hx * 600 * f * k, 400 * f * k, hz * 600 * f * k, 'fireball');
          if (p.tree || p.kind.includes('bench') || p.kind.includes('bin')) { this.burn(t, burnT * 1.5); this.record('fireball', t, 'burn', c.x, c.z); }
          else if (p.kind.includes('lamp') && !p.dark) { this.w.props.darken(p); this.record('fireball', t, 'break', c.x, c.z); }
          break;
        }
      }
    });
    const g = this.w.collision.groundAt(x, z, y + 1, 2);
    fireBurst(this.fx, this.w.debris, this.w.dust, x, y, z, (0.8 + r * 0.3) * sk, g);
    this.w.sound('explosion', x, y, z, Math.min(1, 0.55 + r * 0.1), 1.25 - r * 0.06, 6 + r * 3);
    // Bystanders farther off run (the burst itself already threw the ones in it).
    this.w.stimuli.emit('power', x, y, z, 6, 60 + R * 10);
    const p = this.w.player;
    this.w.camRig.addShake(Math.min(0.8, (0.2 + r * 0.1) * 30 / Math.max(10, Math.hypot(x - p.pos.x, z - p.pos.z))));
  }

  // ================================================================== frost nova

  private frostNova(r: number): boolean {
    const p = this.w.player;
    const R = NOVA_RADIUS[r] * this.reachK;
    const cx = p.pos.x, cy = p.pos.y + p.height * 0.4, cz = p.pos.z;
    const dur = NOVA_FREEZE[r];
    // Everything within the radius freezes — bystanders and cars included.
    this.area('frostNova', cx, cy, cz, R, (t) => {
      this.freeze(t, dur);
      const c = this.w.targeting.centre(t, _w);
      this.record('frostNova', t, 'freeze', c.x, c.z);
    });
    // The brood round about freezes solid (the next blow shatters them).
    this.w.swarm?.('frost', cx, p.pos.y + 0.3, cz, R, dur, 0);
    // Windows shatter in the cold snap (walls hold).
    if (this.wrecks('frostNova')) this.w.destruction.impact(cx, cy, cz, R, NOVA.glass * p.k * p.k, 0, 0.1, 0, 'blast');
    // Icy ground.
    const g = this.w.collision.groundAt(cx, cz, p.pos.y + 0.3, 0.5);
    this.patches.push({ x: cx, y: g, z: cz, r: R * 0.92, until: this.time + dur * NOVA.iceLinger, sense: !!this.w.sense?.('frostNova') });
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
    const check = (x: number, z: number, r: number, sense = false) => {
      for (const a of this.w.peds.neighbours(x, z, r, _nb)) {
        if (a.state === PState.Down || a.inside || a.speed < 0.6) continue;
        // Frost nova ice with the sense: only foes slip on it.
        if (sense && this.w.spared?.({ kind: 'person', obj: a })) continue;
        const s = statusOf(a);
        if (s && s.frozen > 0) continue;
        if (!this.onIceAt(a.x, a.y, a.z) || Math.random() > 0.35) continue;
        const fx = -Math.sin(a.heading), fz = -Math.cos(a.heading);
        this.knock(a, a.x - fx, a.z - fz, POWER_HIT.iceSlipKnock + a.speed * POWER_HIT.iceSlipPerSpeed, 1);
        this.record('icePath', { kind: 'person', obj: a }, 'knockdown', a.x, a.z);
        this.w.sound('land_thud', a.x, a.y, a.z, 0.4, 1.2, 4);
      }
    };
    for (const pt of this.patches) check(pt.x, pt.z, pt.r, pt.sense);
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
    const A = this.aim('hands', reach, Infinity, this.aimA, this.passFor('lightning'));
    if (!A) return false;
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
      if ((H.what === 'building' || H.what === 'roof') && this.wrecks('lightning')) {
        this.w.destruction.impact(x, y, z, 1.2 * this.reachK, 2500 * this.w.player.k ** 2, A.dx, A.dy, A.dz, 'wall');
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
      this.area('lightning', x, y, z, jr, (t, d) => {
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
    // The brood: every bolt point arcs into the creatures round it, and the chain runs on through
    // the swarm (jumps from creature to creature, clearing clumps).
    if (this.w.swarm) {
      const sr = 3 * this.reachK;
      let left = BOLT_JUMPS[r] + 2;
      const n0 = pts.length / 3;
      for (let i = 1; i < n0; i++) this.swarmArcs(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2], sr);
      while (left-- > 0) {
        const lx = pts[pts.length - 3], ly = pts[pts.length - 2], lz = pts[pts.length - 1];
        const near = this.w.swarm('shock', lx, ly, lz, jr, 0, 0);
        let best: { x: number; y: number; z: number } | null = null, bd = -1;
        for (const c of near) { const d = Math.hypot(c.x - lx, c.z - lz); if (d > sr * 0.6 && d < jr && d > bd) { bd = d; best = c; } }
        if (!best) break;
        pts.push(best.x, best.y, best.z);
        this.swarmArcs(best.x, best.y, best.z, sr);
      }
    }
    this.bolts.push({ pts, t: 0, life: BOLT.flash + 0.05 * pts.length / 3, jit: 0, seed: Math.random() * 1000 });
    const p = this.w.player;
    p.action = { id: 'cast_forward', t0: p.animClock, dur: 0.5 };
    this.w.synth.play('thunder', pts[3], pts[4], pts[5], 1, 10 * this.reachK);
    this.w.stimuli.emit('power', pts[3], pts[4], pts[5], 6, 120);
    this.w.camRig.addShake(0.12);
    return true;
  }

  /** A bolt point among the brood: side arcs into the creatures round it, which die of it. */
  private swarmArcs(x: number, y: number, z: number, r: number): void {
    const hit = this.w.swarm?.('shock', x, y, z, r, 3, 3) ?? [];
    for (let k = 0; k < Math.min(5, hit.length); k++) {
      const c = hit[k];
      this.bolts.push({ pts: [x, y, z, c.x, c.y, c.z], t: 0, life: BOLT.flash, jit: 0, seed: Math.random() * 1000 });
      this.sparks(c.x, c.y, c.z, 4);
    }
  }

  private boltHit(t: Target, r: number, x: number, y: number, z: number): void {
    const stunT = BOLT_STUN[r];
    this.sparks(x, y, z, 14);
    this.w.synth.play('zap', x, y, z, 0.7, 6);
    for (let i = 0; i < 10; i++) this.fx.glow(x, y, z, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, 0.25, 0.6 * this.reachK, 0.1, BOLT_C, BOLT_END, 0.7, 3, 0);
    switch (t.kind) {
      case 'person': {
        const a = t.obj;
        if (a.state !== PState.Down) this.knock(a, x + (Math.random() - 0.5), z + (Math.random() - 0.5), POWER_HIT.boltKnock[r], 1.2);
        this.stun(t, stunT);
        this.record('lightning', t, 'stun', a.x, a.z);
        break;
      }
      case 'car': {
        const v = t.obj;
        v.speed = 0; v.brake = 1;
        dentCar(v, 0.12);
        v.fear = Math.max(v.fear, 1);
        this.stun(t, stunT * 2);
        this.record('lightning', t, 'stall', v.x, v.z);
        break;
      }
      case 'robot': this.w.future.robots.knock(t.obj, (Math.random() - 0.5) * 400, 1500, (Math.random() - 0.5) * 400); this.record('lightning', t, 'break', x, z); break;
      case 'bot': this.w.future.service.knock(t.obj, (Math.random() - 0.5) * 400, 1500, (Math.random() - 0.5) * 400); this.record('lightning', t, 'break', x, z); break;
      case 'drone': this.w.future.drones.knock(t.obj, 0, -60, 0); this.stun(t, stunT); this.record('lightning', t, 'break', x, z); break;
      case 'threat': this.hurtThreat(t, stunT * POWER_HIT.boltCreature * this.reachK * (t.obj.onElement?.('shock', stunT) ?? 1), x, y, z); break;
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
        this.w.swarm?.('blow', mx, g + 0.3, mz, R, 4, 6);
        this.area('stomp', mx, g + 0.5, mz, R, (t) => {
          if (q.hit.has(t.obj)) return;
          q.hit.add(t.obj);
          const c = T.centre(t, _w);
          // Away from the crack, mostly up.
          let sx = (c.x - mx) * -q.dz * -q.dz + (c.z - mz) * q.dx * -q.dz, sz = (c.x - mx) * q.dz * q.dx + (c.z - mz) * q.dx * q.dx;
          const sl = Math.hypot(sx, sz) || 1;
          sx /= sl; sz /= sl;
          switch (t.kind) {
            case 'person': this.knock(t.obj, c.x - sx, c.z - sz, Math.min(POWER_HIT.quakeKnockMax, POWER_HIT.quakeKnock + J * POWER_HIT.quakeKnockPerNs), Math.min(9, 3.5 + J / 25000)); this.record('stomp', t, 'knockdown', c.x, c.z); break;
            case 'car': {
              const v = t.obj, near = Math.hypot(c.x - mx, c.z - mz) < 2.6 * sk;
              const Jc = Math.min(2.4e4, J * 0.35 + 4000);
              if (near || J > 6e4) { this.wreck(v, v.x - sx * 0.8, v.y + 0.3, v.z - sz * 0.8, sx * Jc * 0.3, Jc, sz * Jc * 0.3); this.record('stomp', t, 'wreck', v.x, v.z); }
              else { v.speed = 0; v.fear = 2; dentCar(v, 0.2); this.record('stomp', t, 'damage', v.x, v.z); }
              break;
            }
            case 'drone': if (c.y - g < 3 * sk) this.shove(t, sx * 100, 200, sz * 100, 'stomp'); break;
            // A giant creature takes the quake's full impulse at its legs (not the capped shove).
            case 'threat': this.hurtThreat(t, J * DAMAGE_PER_IMPULSE * POWER_HIT.quakeCreatureMul, t.obj.x, t.obj.y * 0.4, t.obj.z); break;
            default: { const Js = Math.min(J, POWER_HIT.quakeShoveMax); this.shove(t, sx * Js, Js, sz * Js, 'stomp'); break; }
          }
        });
        // Walls along the crack (only where there are buildings).
        if (this.wrecks('stomp') && this.w.world.buildingsIn(mx - R, mz - R, mx + R, mz + R).length) {
          const n = this.w.destruction.impact(mx, g + 1.4 * sk, mz, 2.6 * sk, J, 0, 1, 0, 'stomp');
          this.stats.impacts++;
          if (n) this.stats.broken += n;
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
    if (tgt && T.alive(tgt)) {
      // On a target: it spins up there — if the target is in reach and in sight (else it does not go off).
      const c = T.centre(tgt, _w);
      x = c.x; z = c.z; ty = c.y;
      const o = this.origin('hands', _v);
      if (c.distanceTo(p.pos) > reach * 1.5) { this.refuse('range'); return false; }
      if (this.w.sight && !this.w.sight.clear(o.x, o.y, o.z, x, ty, z, this.padOf(tgt), tgt.kind === 'car' ? tgt.obj : null)) { this.refuse('sight'); return false; }
    } else {
      const A = this.aim('hands', reach, Infinity, this.aimA, this.passFor('gust'));
      if (!A) return false;
      // Not inside a wall: back off from a facade a little.
      const back = A.hit.what === 'building' ? GUST_RADIUS[r] * sk * 0.6 : 0;
      x = A.ox + A.dx * Math.max(2, A.t - back); z = A.oz + A.dz * Math.max(2, A.t - back);
    }
    // (Underground: the tunnel floor, not the street overhead.)
    const below = this.w.collision.underground(p.pos.x, p.pos.y, p.pos.z);
    const gy = this.w.collision.groundAt(x, z, p.pos.y + (below ? 2 : 20), below ? 4 : 25);
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
      this.w.swarm?.('wind', v.x, v.y + 0.5, v.z, v.r, 0.6, 3 + lift);
      this.w.dust.clearNear(v.x, v.y + v.r, v.z, v.r * 1.6);
      const r = v.rank;
      T.each(v.x, v.z, v.r + 3, (t) => {
        if (this.spares('gust', t)) return;
        const c = T.centre(t, _w);
        const dx = c.x - v.x, dz = c.z - v.z, d = Math.hypot(dx, dz);
        if (d > v.r + (t.kind === 'car' ? t.obj.length * 0.4 : 0.3) || c.y < v.y - 1 || c.y > v.y + v.r * 3) return;
        const last = v.hitT.get(t.obj) ?? -1e9;
        if (this.time - last < (t.kind === 'person' ? POWER_HIT.gustEveryPerson : t.kind === 'car' ? 3 : POWER_HIT.gustEvery)) return;
        v.hitT.set(t.obj, this.time);
        // Round the axis, a little outward, and up.
        const tx = d > 1e-3 ? -dz / d : 1, tz = d > 1e-3 ? dx / d : 0;
        const ox = d > 1e-3 ? dx / d : 0, oz = d > 1e-3 ? dz / d : 0;
        const k = s * (1 - Math.min(1, d / (v.r + 1)) * 0.5);
        switch (t.kind) {
          case 'person': {
            const a = t.obj;
            if (a.state === PState.Down && a.vy > 0) return;
            this.knock(a, a.x - tx, a.z - tz, lift * POWER_HIT.gustKnock * k, lift * k);
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
          case 'threat': this.hurtThreat(t, POWER_HIT.gustCreature * lift * k); break;
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
    const A = this.aim('hands', range, jet, this.aimA, this.passFor('hydro'));
    if (!A) { this.idle = true; this.waterLoop?.stop(); this.waterLoop = null; return; }
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
      // The jet washes the brood away (and drowns the small ones).
      if (Math.random() < dt * 8) this.w.swarm?.('water', ex, ey, ez, 1.4 * sk, 0.5, 6);
    }
    if (!this.waterLoop) this.waterLoop = this.w.synth.loop('water', 5 * sk);
    this.waterLoop?.set(A.ox, A.oy, A.oz, 0.7);
    const p = this.w.player;
    if (!p.action || p.animClock - p.action.t0 > p.action.dur - 0.1) p.action = { id: 'cast_forward', t0: p.animClock, dur: 0.5 };
    // Force, 10 ticks a second.
    this.hydroTick -= dt;
    if (this.hydroTick > 0) return;
    this.hydroTick = POWER_HIT.hydroTick;
    const J = HYDRO_FORCE[r] * p.k * p.k * POWER_HIT.hydroTick;
    const H = A.hit;
    const T = this.w.targeting;
    // Fire out near the impact (burning facades too).
    if (A.hit.what !== 'none') this.w.douse?.(A.hit.x, A.hit.y, A.hit.z, 2.5 * Math.max(1, this.sk), 6 * r);
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
          if (a.state !== PState.Down && e.acc > POWER_HIT.hydroKnockAt) { this.knock(a, A.ox, A.oz, Math.min(POWER_HIT.hydroKnockMax, POWER_HIT.hydroKnock[r] + e.acc * POWER_HIT.hydroKnockPerNs), 0.8); this.record('hydro', t, 'knockdown', a.x, a.z); e.acc = 0; }
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
        case 'threat': this.hurtThreat(t, J * DAMAGE_PER_IMPULSE * POWER_HIT.hydroCreatureMul, ex, ey, ez); break;
        case 'prop': if (this.shove(t, A.dx * e.acc, 0, A.dz * e.acc, 'hydro')) e.acc = 0; break;
      }
    };
    if (H.what === 'target' && H.target) hitOne(H.target);
    this.area('hydro', ex, ey, ez, 0.9 * sk, (t) => { if (!H.target || t.obj !== H.target.obj) hitOne(t); }, { person: true, car: false, robot: true, drone: false, prop: true });
    if (H.what === 'building' && this.wrecks('hydro')) {
      // Sustained pressure bursts windows.
      const key = { obj: H.building! };
      const e = this.hydroAcc.get(key.obj) ?? { acc: 0, t: this.time };
      e.acc += J; e.t = this.time;
      this.hydroAcc.set(key.obj, e);
      if (e.acc > 1200) { this.w.destruction.impact(ex - H.nx * 0.05, ey, ez - H.nz * 0.05, 0.7 * sk, Math.min(e.acc, 2000), A.dx, A.dy, A.dz, 'wall'); e.acc = 0; }
    }
  }

  // ================================================================== shrink ray

  private shrinkRay(r: number): boolean {
    const reach = SHRINK.reach * this.reachK;
    const A = this.aim('hands', reach, Infinity, this.aimA);
    if (!A) return false;
    const ex = A.ox + A.dx * A.t, ey = A.oy + A.dy * A.t, ez = A.oz + A.dz * A.t;
    this.beams.push({ ax: A.ox, ay: A.oy, az: A.oz, bx: ex, by: ey, bz: ez, t: 0, life: 0.4, w: 0.12 * this.reachK, c: SHRINK_C, style: BeamStyle.Shrink, I: 1.2 });
    const p = this.w.player;
    p.action = { id: 'cast_forward', t0: p.animClock, dur: 0.5 };
    this.w.synth.play('shrink', A.ox, A.oy, A.oz, 0.8, 5);
    for (let i = 0; i < 24; i++) this.fx.glow(ex, ey, ez, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, 0.5, 0.15 * this.reachK, 0.02, SHRINK_C, SHRINK_END, 1, 2, 0);
    const H = A.hit;
    if (H.what === 'target' && H.target) {
      this.shrink(H.target, r);
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
      this.fx.seg(b.ax, b.ay, b.az, b.bx, b.by, b.bz, b.w * (0.5 + f), b.c.r * 0.4, b.c.g * 0.4, b.c.b * 0.4, b.I * f, b.style);
    }
  }

  // ================================================================== single-target energy powers

  /**
   * The target a single-target power goes for: the Tab target, else what the crosshair is on.
   * null (with a toast) when there is none.
   */
  private soleTarget(name: string, range: number): Target | null {
    const T = this.w.targeting;
    if (T.current && T.alive(T.current)) return T.current;
    const A = this.aim('hands', range, Infinity, this.aimB);
    if (A && A.hit.what === 'target' && A.hit.target) return A.hit.target;
    if (this.time - this.refuseToastT > 1.6) { this.refuseToastT = this.time; this.w.deny?.(`${name} needs a target: press Tab or aim at someone`); }
    return null;
  }
  private aimB: Aim = { ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: 0, t: 0, hit: newHit() };

  /** Feet height of a target (the street / sewer side test is made with feet). */
  private feetOf(t: Target, c: THREE.Vector3): number {
    return t.kind === 'person' ? t.obj.y : c.y - this.w.targeting.height(t) * 0.5;
  }

  /**
   * An energy blow on one target (phase pulse, focus beam, seeker orb): `hp` damage to a person
   * (through the combat model), `laserS` laser seconds of this rank to a monster, a knock to a
   * machine, a dent to a car (`wreck`: it is thrown), a shove to a prop. Along (dx, dy, dz).
   */
  private energyHit(power: AbilityId, t: Target, r: number, hp: number, laserS: number, x: number, y: number, z: number, dx: number, dy: number, dz: number, wreck = false): void {
    const k = this.w.player.k, k2 = k * k;
    const J = (hp / COMBAT.dmgPerNs) * k2;
    const hl = Math.hypot(dx, dz) || 1, hx = dx / hl, hz = dz / hl;
    switch (t.kind) {
      case 'person': {
        const a = t.obj;
        // (A slight lift; the blow's whole impulse is still J.)
        if (this.w.hitPerson) this.w.hitPerson(a, hx * J * 0.97, J * 0.24, hz * J * 0.97, a.x - hx, a.z - hz);
        else if (a.state !== PState.Down) { this.knock(a, a.x - hx, a.z - hz, Math.min(8, J / 350)); this.record(power, t, 'knockdown', a.x, a.z); }
        break;
      }
      case 'threat': this.hurtThreat(t, laserS * LASER_DOSE[r] * k2 * DAMAGE_PER_IMPULSE, x, y, z); break;
      case 'car': {
        const v = t.obj;
        if (wreck && v.state !== VState.Wreck && v.state !== VState.Crushed) { this.wreck(v, x, y, z, hx * 6000 * k2, 3000 * k2, hz * 6000 * k2); this.record(power, t, 'wreck', v.x, v.z); }
        else { dentCar(v, Math.min(0.5, hp / 200)); v.speed *= 0.5; v.fear = Math.max(v.fear, 1.2); this.record(power, t, 'damage', v.x, v.z); }
        break;
      }
      case 'robot': case 'bot': this.shove(t, hx * J * 0.15, J * 0.08, hz * J * 0.15, power); break;
      case 'drone': this.shove(t, hx * J * 0.02, -J * 0.01, hz * J * 0.02, power); break;
      case 'prop': this.shove(t, hx * J * 0.1, 0, hz * J * 0.1, power); break;
    }
    this.sparkBurst(x, y, z, 10, power === 'focus' ? FOCUS_C : power === 'seeker' ? SEEK_C : PHASE_C, power === 'focus' ? FOCUS_END : power === 'seeker' ? SEEK_END : PHASE_END);
  }

  /** A puff of coloured sparks (energy impacts). */
  private sparkBurst(x: number, y: number, z: number, n: number, c0: THREE.Color, c1: THREE.Color): void {
    const sk = this.reachK;
    for (let i = 0; i < n; i++) {
      const sp = 2 + Math.random() * 5;
      this.fx.glow(x, y, z, (Math.random() - 0.5) * sp, (Math.random() - 0.3) * sp, (Math.random() - 0.5) * sp, 0.25 + Math.random() * 0.3, 0.09 * sk, 0.02 * sk, c0, c1, 1, 1.5, 2);
    }
    this.fx.glow(x, y, z, 0, 0, 0, 0.18, 0.9 * sk, 1.6 * sk, c0, c1, 0.8, 1, 0);
  }

  /**
   * A ring of glowing motes flung outward in the plane across (nx, ny, nz): a shock front in the
   * air (the focus beam's ripples, an orb bursting). `speed` m/s outward.
   */
  private shockRing(x: number, y: number, z: number, nx: number, ny: number, nz: number, n: number, speed: number, life: number,
    s0: number, s1: number, c0: THREE.Color, c1: THREE.Color, alpha: number): void {
    // Two axes across the normal.
    let ux = -nz, uy = 0, uz = nx;
    if (Math.abs(ny) > 0.9) { ux = 1; uy = 0; uz = 0; }
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
    const a0 = Math.random() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      this.fx.glow(x, y, z, (ux * ca + vx * sa) * speed, (uy * ca + vy * sa) * speed, (uz * ca + vz * sa) * speed, life, s0, s1, c0, c1, alpha, 4, 0);
    }
  }

  /**
   * Where a focus beam lands (`f` the charge): a white-hot flash, a shock front across the
   * surface, sparks spraying back off it, dust and chips kicked up. Looks only.
   */
  private focusImpact(x: number, y: number, z: number, dx: number, dy: number, dz: number, nx: number, ny: number, nz: number, f: number): void {
    const sk = this.reachK, s = (0.8 + 1.2 * f) * sk;
    this.fx.glow(x, y, z, 0, 0, 0, 0.25, s * 3.5, s * 6, FOCUS_HOT, FOCUS_C, 1, 1, 0);
    this.fx.glow(x, y, z, 0, 0, 0, 0.7, s * 2.5, s * 4.5, FOCUS_C, FOCUS_END, 0.6, 1, 0);
    this.shockRing(x, y, z, nx, ny, nz, 32, (12 + 14 * f) * sk, 0.4, 0.3 * s, 0.08 * s, FOCUS_C, FOCUS_END, 1);
    this.shockRing(x, y, z, nx, ny, nz, 18, (5 + 6 * f) * sk, 0.5, 0.4 * s, 0.12 * s, FOCUS_WHITE, FOCUS_END, 0.7);
    // The blow carries on past what it hit: a spray of light out the far side.
    for (let i = 0; i < 10; i++) {
      const sp = (10 + Math.random() * 16) * sk;
      this.fx.glow(x, y, z, (dx + (Math.random() - 0.5) * 0.7) * sp, (dy + (Math.random() - 0.5) * 0.7) * sp, (dz + (Math.random() - 0.5) * 0.7) * sp, 0.18 + Math.random() * 0.15, 0.18 * s, 0.03 * s, FOCUS_WHITE, FOCUS_END, 0.8, 3, 0);
    }
    // Sparks thrown back out of the hit, in a cone round the reflected beam.
    const dn = dx * nx + dy * ny + dz * nz;
    const rx = dx - 2 * dn * nx, ry = dy - 2 * dn * ny, rz = dz - 2 * dn * nz;
    const nSp = Math.round(10 + 18 * f);
    for (let i = 0; i < nSp; i++) {
      const sp = (6 + Math.random() * 14) * sk;
      this.fx.glow(x, y, z, (rx + (Math.random() - 0.5) * 1.4) * sp, (ry + (Math.random() - 0.5) * 1.4) * sp + 1, (rz + (Math.random() - 0.5) * 1.4) * sp,
        0.25 + Math.random() * 0.35, 0.07 * sk, 0.02 * sk, SPARK, FOCUS_END, 1, 2, 9);
    }
    this.w.debris.chipBurst(x, y, z, Math.round(4 + 10 * f), 5 + 6 * f, rx, ry + 0.4, rz, DUST_C, 0.05, 1.4);
    const g = this.w.collision.groundAt(x, z, y + 1, 2);
    // Near the ground a slower ring rolls out across it.
    if (y - g < 2.5 * sk) this.shockRing(x, g + 0.3 * sk, z, 0, 1, 0, 28, (6 + 6 * f) * sk, 0.8, 0.5 * s, 0.25 * s, FOCUS_WHITE, FOCUS_END, 0.55);
    if (y - g < 2.5 * sk) this.w.dust.burst(x, g + 0.2, z, Math.round(6 + 10 * f), s * 1.2, 3 + 4 * f, s * 0.9, 2, DUST_C, 0.3, 0.45);
    if (f > 0.5) this.w.sound('land_thud', x, y, z, 0.3 + 0.5 * f, 0.8, 6 * sk);
  }

  // ================================================================== phase pulse

  /** A pulse through walls, cars and people to the one target (Tab, or under the crosshair). */
  private phase(r: number): boolean {
    const T = this.w.targeting, p = this.w.player;
    const range = PHASE_RANGE[r] * this.reachK;
    const tgt = this.soleTarget('Phase pulse', range);
    if (!tgt) return false;
    const o = this.origin('hands', _v);
    const c = T.aimPoint(tgt, o.x, o.y, o.z, Infinity, _w);
    const d = c.distanceTo(o);
    if (d - this.padOf(tgt) > range * 1.15) { this.refuse('range'); return false; }
    // Through walls, never through the pavement: the street and the sewers below stay apart.
    if (tgt.kind !== 'threat' && this.w.sameSide && !this.w.sameSide(p.pos.x, p.pos.y, p.pos.z, c.x, this.feetOf(tgt, c), c.z)) { this.refuse('sight'); return false; }
    const ox = o.x, oy = o.y, oz = o.z, cx = c.x, cy = c.y, cz = c.z;
    const dx = (cx - ox) / (d || 1), dy = (cy - oy) / (d || 1), dz = (cz - oz) / (d || 1);
    this.energyHit('phase', tgt, r, PHASE_DMG[r], PHASE.laserS, cx, cy, cz, dx, dy, dz);
    // A pale ripple along the line, rings where it slips through a wall, a flash on the target.
    const sk = this.reachK;
    this.beams.push({ ax: ox, ay: oy, az: oz, bx: cx, by: cy, bz: cz, t: 0, life: 0.3, w: 0.07 * sk, c: PHASE_C, style: BeamStyle.Shrink, I: 1.4 });
    const n = Math.min(40, Math.ceil(d / 0.8));
    for (let i = 0; i < n; i++) {
      const u = i / n, sp = d / 0.25;
      this.fx.glow(ox + (cx - ox) * u * 0.2, oy + (cy - oy) * u * 0.2, oz + (cz - oz) * u * 0.2, dx * sp * (0.8 + u * 0.2), dy * sp * (0.8 + u * 0.2), dz * sp * (0.8 + u * 0.2), 0.22, 0.14 * sk, 0.05 * sk, PHASE_C, PHASE_END, 0.8, 1, 0);
    }
    const wall = T.probe(ox, oy, oz, dx, dy, dz, d, null, NO_TARGETS);
    if (wall.what === 'building') {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2, ux = -wall.nz, uz = wall.nx;
        this.fx.glow(wall.x, wall.y, wall.z, (ux * Math.cos(a)) * 2.5, Math.sin(a) * 2.5, (uz * Math.cos(a)) * 2.5, 0.35, 0.12 * sk, 0.04 * sk, PHASE_C, PHASE_END, 0.7, 2, 0);
      }
    }
    if (!p.flying && Math.hypot(dx, dz) > 0.1) p.yaw = Math.atan2(-dx, -dz);
    p.action = { id: 'cast_forward', t0: p.animClock, dur: 0.45 };
    this.w.synth.play('phase', ox, oy, oz, 0.8, 5 * sk);
    this.w.synth.play('phase', cx, cy, cz, 0.5, 4 * sk, 0.7);
    this.w.stimuli.emit('power', cx, cy, cz, 3, 25);
    return true;
  }

  // ================================================================== focus beam

  /** While the focus beam gathers: light grows behind the eyes, motes stream in, a rising hum. */
  private gather(dt: number, _r: number, held: number): void {
    const p = this.w.player, sk = this.reachK;
    const f = Math.min(1, held / FOCUS.charge);
    const o = this.origin('eyes', _v);
    const pulse = f >= 1 ? 1 + 0.2 * Math.sin(this.time * 24) : 1;
    this.fx.glow(o.x, o.y, o.z, 0, 0, 0, 0.05, (0.04 + 0.16 * f) * sk * pulse, (0.05 + 0.12 * f) * sk, FOCUS_C, FOCUS_END, 0.9, 1, 0);
    if (Math.random() < dt * (20 + 60 * f)) {
      const a = Math.random() * Math.PI * 2, b = (Math.random() - 0.5) * 2, rr = (0.6 + Math.random() * 0.6) * p.height * 0.4;
      const ex = Math.cos(a) * rr, ey = b * rr * 0.6, ez = Math.sin(a) * rr;
      this.fx.glow(o.x + ex, o.y + ey, o.z + ez, -ex / 0.3, -ey / 0.3, -ez / 0.3, 0.3, 0.03 * sk, 0.06 * sk, FOCUS_C, FOCUS_END, 1, 1, 0);
    }
    if (!this.chargeLoop) this.chargeLoop = this.w.synth.loop('charge', 4 * sk);
    this.chargeLoop?.set(o.x, o.y, o.z, 0.25 + 0.35 * f, f);
    if (held < 0.05) p.action = { id: 'cast_forward', t0: p.animClock, dur: FOCUS.charge + 0.5 };
    // Gather facing what it will hit: the target, else the cursor.
    if (!p.flying) {
      const T = this.w.targeting, tgt = T.current && T.alive(T.current) ? T.current : null;
      if (tgt) {
        const c = T.aimPoint(tgt, p.pos.x, p.pos.y, p.pos.z, Infinity, _w);
        const dx = c.x - p.pos.x, dz = c.z - p.pos.z;
        if (Math.hypot(dx, dz) > 0.3) p.yaw = Math.atan2(-dx, -dz);
      } else p.yaw = this.cursorYaw();
    }
  }

  /**
   * A charged power is let go (AbilitySystem): the focus beam fires with `charge` 0..1. False when
   * it cannot go off (no line of sight, out of reach): the energy is given back.
   */
  release(id: AbilityId, r: number, charge: number): boolean {
    if (id !== 'focus') return false;
    this.chargeLoop?.stop(); this.chargeLoop = null;
    const range = FOCUS_RANGE[r] * this.reachK;
    const A = this.aim('eyes', range, Infinity, this.aimA);
    if (!A) return false;
    const f = FOCUS.min + (1 - FOCUS.min) * Math.max(0, Math.min(1, charge));
    const k = this.w.player.k, sk = this.reachK;
    const ex = A.ox + A.dx * A.t, ey = A.oy + A.dy * A.t, ez = A.oz + A.dz * A.t;
    const H = A.hit;
    if (H.what === 'target' && H.target) {
      this.energyHit('focus', H.target, r, FOCUS_DMG[r] * f, FOCUS.laserS * f, ex, ey, ez, A.dx, A.dy, A.dz, r >= 3 && f > 0.9);
    } else if (H.what === 'building') {
      // One panel: a full charge holes it like a second and a half of the laser on it.
      const n = this.w.destruction.impact(ex - H.nx * 0.05, ey, ez - H.nz * 0.05, 0.6 * sk, LASER_DOSE[r] * k * k * FOCUS.wallS * f, A.dx, A.dy, A.dz, 'wall');
      this.stats.impacts++;
      if (n) { this.stats.broken += n; this.record('focus', 'building', 'facade', ex, ez); }
    }
    if (H.what !== 'none') {
      this.fx.decal(DecalKind.Scorch, ex, ey, ez, H.nx, H.ny, H.nz, 0.9 * sk * f, 0.9 * sk * f, Math.random() * 6, 35);
      if (H.what !== 'target') this.sparkBurst(ex, ey, ez, 14, FOCUS_C, FOCUS_END);
      this.focusImpact(ex, ey, ez, A.dx, A.dy, A.dz, H.what === 'target' ? -A.dx : H.nx, H.what === 'target' ? -A.dy : H.ny, H.what === 'target' ? -A.dz : H.nz, f);
    }
    // The shot: a white-gold haze round a white-hot core, and a slower afterglow. The air it
    // punches through ripples away in rings along the line, densest at the eyes.
    const w = (0.1 + 0.16 * f) * sk;
    this.beams.push({ ax: A.ox, ay: A.oy, az: A.oz, bx: ex, by: ey, bz: ez, t: 0, life: FOCUS.flash * 2.2, w: w * 5, c: FOCUS_C, style: BeamStyle.Ring, I: 0.55 });
    this.beams.push({ ax: A.ox, ay: A.oy, az: A.oz, bx: ex, by: ey, bz: ez, t: 0, life: FOCUS.flash * 1.4, w: w * 3, c: FOCUS_C, style: BeamStyle.Laser, I: 1.6 });
    this.beams.push({ ax: A.ox, ay: A.oy, az: A.oz, bx: ex, by: ey, bz: ez, t: 0, life: FOCUS.flash * 1.1, w, c: FOCUS_WHITE, style: BeamStyle.Laser, I: 4 });
    const L = A.t, rings = Math.min(9, Math.max(2, Math.floor(L / (2.5 * sk))));
    for (let i = 0; i < rings; i++) {
      const u = (i + 0.3) / rings, d = L * u * u;
      this.shockRing(A.ox + A.dx * d, A.oy + A.dy * d, A.oz + A.dz * d, A.dx, A.dy, A.dz, 14, (3 + 5 * f) * sk * (1 - 0.5 * u), 0.3, (0.16 + 0.12 * f) * sk, 0.04 * sk, FOCUS_C, FOCUS_END, 0.7 * (1 - 0.5 * u));
    }
    // Muzzle: a flash at the eyes and a ring blown back off the face.
    this.fx.glow(A.ox, A.oy, A.oz, 0, 0, 0, 0.14, (0.5 + 0.9 * f) * sk, (0.2 + 0.3 * f) * sk, FOCUS_HOT, FOCUS_C, 1, 1, 0);
    this.shockRing(A.ox + A.dx * 0.3 * sk, A.oy + A.dy * 0.3 * sk, A.oz + A.dz * 0.3 * sk, A.dx, A.dy, A.dz, 16, (5 + 6 * f) * sk, 0.25, 0.12 * sk, 0.03 * sk, FOCUS_C, FOCUS_END, 0.8);
    const p = this.w.player;
    p.action = { id: 'cast_forward', t0: p.animClock, dur: 0.4 };
    this.w.camRig.addShake(0.12 + 0.3 * f);
    this.w.synth.play('beam', A.ox, A.oy, A.oz, 0.6 + 0.4 * f, 6 * sk, 1.15 - 0.3 * f);
    this.w.stimuli.emit('power', ex, ey, ez, 4 + 2 * f, 40 + 40 * f);
    return true;
  }

  // ================================================================== seeker orb

  /** Throw a seeker orb at the one target (it needs one). */
  private seeker(r: number): boolean {
    const T = this.w.targeting, p = this.w.player;
    const range = SEEKER_RANGE[r] * this.reachK;
    const tgt = this.soleTarget('Seeker orb', range);
    if (!tgt) return false;
    const o = this.origin('hands', _v);
    const c = T.aimPoint(tgt, o.x, o.y, o.z, Infinity, _w);
    if (c.distanceTo(o) - this.padOf(tgt) > range * 1.15) { this.refuse('range'); return false; }
    if (tgt.kind !== 'threat' && this.w.sameSide && !this.w.sameSide(p.pos.x, p.pos.y, p.pos.z, c.x, this.feetOf(tgt, c), c.z)) { this.refuse('sight'); return false; }
    const sp = SEEKER.speed * this.reachK;
    let dx = c.x - o.x, dz = c.z - o.z;
    const hl = Math.hypot(dx, dz) || 1;
    dx /= hl; dz /= hl;
    // Off the hands forward and a little up; it finds its way from there.
    this.seekers.push({ x: o.x, y: o.y, z: o.z, vx: dx * sp * 0.7, vy: sp * 0.35, vz: dz * sp * 0.7, tgt, rank: r, k: p.k, age: 0, trailT: 0, checkT: 0, clear: true, loop: this.w.synth.loop('charge', 3 * this.reachK), tail: [], tailT: 0 });
    if (!p.flying) p.yaw = Math.atan2(-dx, -dz);
    p.action = { id: 'cast_forward', t0: p.animClock, dur: 0.5 };
    this.sparkBurst(o.x, o.y, o.z, 6, SEEK_C, SEEK_END);
    this.fx.glow(o.x, o.y, o.z, 0, 0, 0, 0.2, 0.3 * this.reachK, 1.1 * this.reachK, SEEK_WHITE, SEEK_C, 0.9, 1, 0);
    this.shockRing(o.x, o.y, o.z, dx, 0.4, dz, 12, 3 * this.reachK, 0.3, 0.1 * this.reachK, 0.02 * this.reachK, SEEK_C, SEEK_END, 0.8);
    this.w.synth.play('orb', o.x, o.y, o.z, 0.7, 5 * this.reachK);
    return true;
  }

  private updateSeekers(dt: number): void {
    const T = this.w.targeting, W = this.w.world;
    for (let i = this.seekers.length - 1; i >= 0; i--) {
      const s = this.seekers[i];
      s.age += dt;
      const sk = Math.max(0.5, Math.sqrt(s.k)), sp = SEEKER.speed * sk;
      const gone = !T.alive(s.tgt);
      if (gone || s.age > SEEKER.life) { this.fizzle(s); this.seekers.splice(i, 1); continue; }
      const c = T.aimPoint(s.tgt, s.x, s.y, s.z, Infinity, _w);
      const pad = this.padOf(s.tgt);
      let tx = c.x - s.x, ty = c.y - s.y, tz = c.z - s.z;
      const td = Math.hypot(tx, ty, tz) || 1;
      if (td < pad + 0.35 * sk) {
        const vl = Math.hypot(s.vx, s.vy, s.vz) || 1;
        this.energyHit('seeker', s.tgt, s.rank, SEEKER_DMG[s.rank], SEEKER.laserS, s.x, s.y, s.z, s.vx / vl, s.vy / vl, s.vz / vl);
        this.seekerBurst(s, s.vx / vl, s.vy / vl, s.vz / vl);
        this.w.synth.play('orb', s.x, s.y, s.z, 0.6, 5 * sk, 0.6);
        s.loop?.stop();
        this.seekers.splice(i, 1);
        continue;
      }
      tx /= td; ty /= td; tz /= td;
      // Is the way to the target open? (A few times a second; the shared line of sight.)
      s.checkT -= dt;
      if (s.checkT <= 0) {
        s.checkT = 0.12;
        s.clear = !this.w.sight || this.w.sight.clear(s.x, s.y, s.z, c.x, c.y, c.z, pad, s.tgt.kind === 'car' ? s.tgt.obj : null);
      }
      // Open: straight for it. Blocked: up and over (a building, a wall), still edging towards it.
      // High enough above the target and still no line (a narrow street, an awning, a courtyard):
      // cruise level to above it, then drop straight down, instead of climbing until it fizzles.
      let wx = tx, wy = ty, wz = tz;
      if (!s.clear) {
        const hd = Math.hypot(c.x - s.x, c.z - s.z);
        if (s.y - c.y < SEEKER.over * sk) { wx = tx * 0.35; wy = 1; wz = tz * 0.35; }
        else if (hd > 2 * sk) { wx = (c.x - s.x) / hd; wy = 0; wz = (c.z - s.z) / hd; }
      }
      const wl = Math.hypot(wx, wy, wz) || 1;
      const turn = Math.min(1, SEEKER.turn * dt);
      s.vx += (wx / wl * sp - s.vx) * turn; s.vy += (wy / wl * sp - s.vy) * turn; s.vz += (wz / wl * sp - s.vz) * turn;
      let nx = s.x + s.vx * dt, ny = s.y + s.vy * dt, nz = s.z + s.vz * dt;
      // Never into a building: against a facade it only climbs.
      const b = W.buildingAt(nx, nz);
      if (b && b.alive && ny < b.top + 0.4 && ny > b.low && !(W.buildingAt(s.x, s.z) === b)) { nx = s.x; nz = s.z; ny = s.y + Math.max(s.vy, sp * 0.6) * dt; s.clear = false; }
      // Nor into the ground.
      const g = this.w.collision.groundAt(nx, nz, ny + 1, 2);
      if (ny < g + 0.4 * sk) { ny = g + 0.4 * sk; s.vy = Math.max(0, s.vy); }
      s.x = nx; s.y = ny; s.z = nz;
      s.loop?.set(s.x, s.y, s.z, 0.35, 0.6);
      this.drawSeeker(s, i, dt);
    }
  }

  /**
   * The orb: a white-hot heart in a violet glow inside a faint halo, sparks circling it on tilted
   * orbits, little arcs crackling off its skin, and a tapering comet tail behind it. Grows with
   * distance from the camera so it stays easy to follow far off.
   */
  private drawSeeker(s: Seeker, i: number, dt: number): void {
    const sk = Math.max(0.5, Math.sqrt(s.k));
    const camD = this.w.camera.position.distanceTo(_v.set(s.x, s.y, s.z));
    const size = (0.22 + s.rank * 0.03) * sk * Math.min(2.5, Math.max(1, camD / 15));
    const pulse = 1 + 0.15 * Math.sin(this.time * 18 + i);
    this.fx.glow(s.x, s.y, s.z, 0, 0, 0, 0.05, size * 0.9 * pulse, size * 0.8, SEEK_HOT, SEEK_WHITE, 1, 1, 0);
    this.fx.glow(s.x, s.y, s.z, 0, 0, 0, 0.05, size * 1.5 * pulse, size * 1.2, SEEK_MID, SEEK_C, 1, 1, 0);
    this.fx.glow(s.x, s.y, s.z, 0, 0, 0, 0.08, size * 3 * pulse, size * 2.4, SEEK_C, SEEK_END, 0.5, 1, 0);
    this.fx.glow(s.x, s.y, s.z, 0, 0, 0, 0.08, size * 6, size * 5.5, SEEK_END, SEEK_END, 0.18, 1, 0);
    // Three sparks on tilted orbits.
    for (let j = 0; j < 3; j++) {
      const a = this.time * (9 + j * 2.5) + j * 2.09 + i, tilt = 0.6 + j * 0.9;
      const ca = Math.cos(a), sa = Math.sin(a), ct = Math.cos(tilt), st = Math.sin(tilt), R = size * 1.25;
      this.fx.glow(s.x + ca * R, s.y + sa * st * R, s.z + sa * ct * R, 0, 0, 0, 0.12, size * 0.32, size * 0.08, SEEK_SPARK, SEEK_C, 1, 1, 0);
    }
    // Arcs crackling off the skin.
    if (Math.random() < dt * 14) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r0 = Math.sqrt(1 - u * u), R = size * (1.6 + Math.random() * 0.8);
      const ex = s.x + Math.cos(a) * r0 * R, ey = s.y + u * R, ez = s.z + Math.sin(a) * r0 * R;
      const mx = (s.x + ex) / 2 + (Math.random() - 0.5) * size * 0.6, my = (s.y + ey) / 2 + (Math.random() - 0.5) * size * 0.6, mz = (s.z + ez) / 2 + (Math.random() - 0.5) * size * 0.6;
      this.fx.seg(s.x, s.y, s.z, mx, my, mz, size * 0.12, SEEK_C.r, SEEK_C.g, SEEK_C.b, 1.2, BeamStyle.Bolt);
      this.fx.seg(mx, my, mz, ex, ey, ez, size * 0.1, SEEK_C.r, SEEK_C.g, SEEK_C.b, 1, BeamStyle.Bolt);
    }
    // Comet tail: the last positions as a ribbon that thins and fades behind the orb.
    s.tailT -= dt;
    if (s.tailT <= 0) {
      s.tailT = 0.03;
      s.tail.unshift(s.x, s.y, s.z);
      if (s.tail.length > 30) s.tail.length = 30;
    }
    // (Each piece spans two steps, so they overlap by half and the joints don't bead.)
    // A piece right at the camera would be seen edge-on as a band across the screen: skipped.
    const T = s.tail, nT = T.length / 3, cp = this.w.camera.position, near = Math.max(2.5, size * 4);
    for (let j = -1; j < nT - 1; j++) {
      const f = 1 - (j + 1) / nT, o = j * 3, q = Math.min(nT - 1, j + 2) * 3;
      const ax = j < 0 ? s.x : T[o], ay = j < 0 ? s.y : T[o + 1], az = j < 0 ? s.z : T[o + 2];
      if (Math.hypot(ax - cp.x, ay - cp.y, az - cp.z) < near || Math.hypot(T[q] - cp.x, T[q + 1] - cp.y, T[q + 2] - cp.z) < near) continue;
      this.fx.seg(ax, ay, az, T[q], T[q + 1], T[q + 2], size * (0.3 + 1.1 * f), SEEK_C.r, SEEK_C.g, SEEK_C.b, 0.5 * f, BeamStyle.Ring);
    }
    s.trailT -= dt;
    if (s.trailT <= 0) {
      s.trailT = 0.025;
      this.fx.glow(s.x, s.y, s.z, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2, 0.5 + Math.random() * 0.3, size * 0.5, size * 0.08, SEEK_MID, SEEK_END, 0.8, 1, 0);
    }
  }

  /** A seeker orb bursts on its target: a violet flash, a shock front, arcs and sparks flung out. */
  private seekerBurst(s: Seeker, dx: number, dy: number, dz: number): void {
    const sk = Math.max(0.5, Math.sqrt(s.k)), q = (0.8 + s.rank * 0.12) * sk;
    this.fx.glow(s.x, s.y, s.z, 0, 0, 0, 0.12, q * 0.8, q * 3, SEEK_HOT, SEEK_C, 1, 1, 0);
    this.fx.glow(s.x, s.y, s.z, 0, 0, 0, 0.35, q * 1.5, q * 3.5, SEEK_C, SEEK_END, 0.55, 1, 0);
    this.shockRing(s.x, s.y, s.z, dx, dy, dz, 20, 9 * q, 0.3, 0.22 * q, 0.04 * q, SEEK_C, SEEK_END, 0.9);
    this.shockRing(s.x, s.y, s.z, 0, 1, 0, 16, 6 * q, 0.4, 0.2 * q, 0.04 * q, SEEK_MID, SEEK_END, 0.7);
    for (let j = 0; j < 18; j++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r0 = Math.sqrt(1 - u * u), sp = (4 + Math.random() * 8) * q;
      this.fx.glow(s.x, s.y, s.z, Math.cos(a) * r0 * sp, u * sp, Math.sin(a) * r0 * sp, 0.3 + Math.random() * 0.3, 0.08 * q, 0.02 * q, SEEK_SPARK, SEEK_END, 1, 2.5, 0);
    }
    this.w.camRig.addShake(Math.min(0.25, 3 / Math.max(8, this.w.camera.position.distanceTo(_v.set(s.x, s.y, s.z)))));
  }

  /** A seeker orb that lost its target or ran out: it fades in a soft puff. */
  private fizzle(s: Seeker): void {
    s.loop?.stop();
    this.sparkBurst(s.x, s.y, s.z, 8, SEEK_C, SEEK_END);
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
            if (v.state !== VState.Wreck && v.state !== VState.Crushed) { this.w.traffic.wreckIt(v); this.stats.wrecked++; if (!sv?.notPlayer) this.record('fireWave', t, 'wreck', v.x, v.z); }
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
        case 'threat': t.obj.setScale?.(s.scale); break;
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

const NO_TARGETS = { person: false, car: false, robot: false, drone: false, prop: false, threat: false };

function newHit(): ProbeHit {
  return { what: 'none', target: null, building: null, t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0 };
}

function copyHit(h: ProbeHit, out: ProbeHit): ProbeHit {
  out.what = h.what; out.target = h.target; out.building = h.building; out.t = h.t;
  out.x = h.x; out.y = h.y; out.z = h.z; out.nx = h.nx; out.ny = h.ny; out.nz = h.nz;
  return out;
}
