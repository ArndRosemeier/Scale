/**
 * The player: a Norgo human with physically scaled size (10 cm … 100 m),
 * walking/running/jumping with Froude-similar gait, and a flight mode.
 *
 * Scaling laws (k = height / 1.8 m):
 *   mass ∝ k³, muscle strength ∝ k², walking speed ∝ √k (dynamic similarity),
 *   gait cadence ∝ 1/√k (animation time runs at 1/√k), jump take-off speed ∝ k^0.3,
 *   terminal velocity ∝ √k (air drag vs weight), gravity unchanged.
 */
import * as THREE from 'three';
import { HumanoidRig } from '../humanoid/client/HumanoidRig';
import { randomAppearance } from '../humanoid/appearance';
import { cityOutfit } from '../humanoid/client/wardrobe';
import type { WorldIndex } from '../world/WorldIndex';
import type { Input } from '../game/Input';
import type { MoveState, PowerAnim } from '../shared/types';
import { clamp, lerp, damp } from '../core/math';
import type { HumanoidAppearance } from '../humanoid/types';
import type { Collision, ObstacleProvider } from '../world/Collision';
import { ImportedAvatar, type LoadedModel } from '../avatar/ImportedAvatar';
import { outfitVisuals, plainAppearance, type CharacterLook } from '../avatar/look';
import { stepEnergy } from '../game/GiantBody';
import { SpeedNav } from './speedNav';
import { planHop } from './speedHop';
import { LEAP_RAMP } from '../game/abilities/tuning';

export const BASE_HEIGHT = 1.8;
/** Super speed carries the runner over water above this speed (m/s at 1.8 m, × √k). */
export const SPEED_WATER = 16;
export const MIN_HEIGHT = 0.1;
export const MAX_HEIGHT = 100;

export interface PlayerEvents {
  onFootstep?: (x: number, y: number, z: number, energy: number, height: number) => void;
  onLand?: (x: number, y: number, z: number, energy: number, height: number) => void;
  onSizeChange?: (h: number, dir: number) => void;
  onFlightToggle?: (flying: boolean) => void;
}

const _v = new THREE.Vector3();

export class Player {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  yaw = 0;
  /** Body height in m. */
  height = BASE_HEIGHT;
  targetHeight = BASE_HEIGHT;
  flying = false;
  /** R: keep moving forward (autorun on foot, autoflight in the air) until R, W or S. */
  autoMove = false;
  grounded = false;
  readonly rig: HumanoidRig;
  app: HumanoidAppearance;
  /** Animation clock (runs at 1/√k). */
  private animTime = 0;
  private rigBaseHeight = 1.75;
  private lastPhase = 0;
  private stepPhase = 0;
  private bank = 0;
  private bodyPitch = 0;
  private flightBlend = 0;
  /** Velocity as the animation sees it: lightly smoothed, so collision chatter (sliding along a
   *  wall alternates direction frame to frame) does not shake the torso and limbs. */
  private animVel = new THREE.Vector3();
  /** Seconds since takeoff (for the takeoff whoosh/pose). */
  private sinceToggle = 10;
  events: PlayerEvents = {};
  /** One-shot action (punch, wave...) in animation-clock time. */
  action: { id: string; t0: number; dur: number } | undefined;
  /** Knocked down (combat, a car, knocked out): seconds left on the ground; movement input is ignored. */
  downT = 0;
  /** Chilled (a villain's frost): seconds of slow left; `chillSpeed` is the share of speed left meanwhile. */
  chillT = 0;
  chillSpeed = 0.55;
  /** Ragdoll (physics/ragdoll): 'limp' while the body tumbles or lies, 'getup' while it stands up; no control. */
  ragdoll: '' | 'limp' | 'getup' = '';
  /**
   * Held by a scripted scene (the rescue drones carrying the body, the revival machine): no
   * control, no physics; the scene sets the position and facing, the body shows this move state.
   */
  puppet: MoveState | null = null;
  /** The puppet's velocity as the animation sees it (a scripted walk keeps its gait; zero: standing). */
  readonly puppetVel = new THREE.Vector3();
  get animClock(): number { return this.animTime; }
  /** Walking into walls: the obstacle hit this frame (for destruction). */
  blocked: { x: number; z: number; nx: number; nz: number; speed: number } | null = null;

  // ---- power gates (set every frame by the AbilitySystem; defaults: everything allowed)
  /** Flight available (F). */
  flightAllowed = true;
  /** Flight speed multiplier. */
  flightSpeed = 1;
  /** Boost = cruise × this (grows with the flight rank, see FLIGHT_BOOST_MUL). */
  flightBoost = 7.3;
  /** Forward speed (m/s at 1.8 m) a full-height super jump carries while steered (LEAP_SPEED by rank). */
  leapSpeed = 12;
  /** Allowed body height range (size shift). */
  minHeight = MIN_HEIGHT;
  maxHeight = MAX_HEIGHT;
  /** Admin console: any size from MIN_HEIGHT to MAX_HEIGHT, whatever the size power's rank allows. */
  sizeOverride = false;
  /** Sitting on a seat (bench, café chair …): the seat position on the ground and the way it faces. */
  seat: { x: number; z: number; yaw: number } | null = null;
  /** Space jumps normally (false while an ability handles Space itself). */
  jumpOnSpace = true;
  /**
   * Super speed: top running speed in m/s at 1.8 m (× √k like every gait), 0 = off. Set every
   * frame by the AbilitySystem while the power is switched on. The runner steers itself around
   * what is ahead (SpeedNav); what it still runs into fast is run up or vaulted, water carries it
   * above SPEED_WATER × √k, holes in the street (manholes, stairwells) are skimmed over.
   */
  speedTop = 0;
  /** Super speed autopilot (steers around what is ahead, brakes when it is blocked). */
  private readonly nav = new SpeedNav();
  /** People around as upright cylinders, for the super speed hop (set by the game; they are not in the collision). */
  hopPeople: ObstacleProvider | null = null;
  /** In a super speed hop: its pull (m/s², 0 = none), cleared on landing. */
  private hopG = 0;
  get hopping(): boolean { return this.hopG > 0; }
  /** Standing on ice (set every frame by the powers): almost no grip, the body slides. */
  onIce = false;
  /** Seconds of parkour climb grace left (super speed up a wall). */
  private climbing = 0;
  /** Running on water this frame (super speed). */
  onWater = false;
  get speeding(): boolean { return this.speedTop > 0 && !this.flying; }
  /** Active dash: seconds left and velocity. */
  private dashT = 0;
  private readonly dashV = new THREE.Vector3();
  get dashing(): boolean { return this.dashT > 0; }
  /** Super jump charge 0..1 while held (-1: none), set by the AbilitySystem (body crouches). */
  jumpCharge = -1;
  /** Super jump in the air: its strength 0..1 (0: none) and take-off time (animation clock). */
  leap = 0;
  private leapT0 = 0;
  /** Strength of the last super jump at its landing (for the landing effects), then 0. */
  landedLeap = 0;
  private readonly powerAnim: PowerAnim = { charge: -1, leap: 0, leapT: 0, dash: 0 };
  /** Flight pose input for the animator (tilt, bank, boost). */
  private readonly flyAnim = { tilt: 0, bank: 0, boost: 0 };
  private flyBoost = false;

  /** Character made in the creator, used by the next Player (null: random human from the seed). */
  static look: CharacterLook | null = null;

  constructor(seed: number, private world: WorldIndex) {
    const look = Player.look;
    this.app = look ? structuredClone(look.appearance) : plainAppearance(randomAppearance('human', seed, {}));
    this.rig = new HumanoidRig(this.app, { castShadow: true, priority: -10, ground: (x, y, z) => this.collision ? this.collision.groundAt(x, z, y + 0.4, 0.3) : this.world.groundHeight(x, z, y + 0.4) });
    this.rig.setEquipment(look ? outfitVisuals(look.outfit) : cityOutfit(seed, this.app.gender, this.app.age, 0.2, 0.3));
    // The random human is normalised to the 1.8 m base height; a created character keeps
    // its own height relative to it (size mechanics still run on `height`, k = height / 1.8).
    if (look) this.rigBaseHeight = BASE_HEIGHT;
    else this.rig.ready.then(() => { this.rigBaseHeight = this.rig.height; });
  }

  /** Change the hero's look on the spot (the clothes shop mirror): body, face, hair and outfit. */
  async applyLook(look: CharacterLook): Promise<void> {
    Player.look = look;
    this.app = structuredClone(look.appearance);
    this.rigBaseHeight = BASE_HEIGHT;
    if (this.avatar) await this.setAvatar(null);
    this.rig.setEquipment(outfitVisuals(look.outfit));
    await this.rig.setAppearance(this.app);
  }

  get k(): number { return this.height / BASE_HEIGHT; }
  get mass(): number { return 80 * this.k ** 3; }
  get radius(): number { return 0.3 * this.k; }

  update(dt: number, input: Input, camYaw: number, camPitch: number): void {
    if (this.puppet) {
      this.vel.copy(this.puppetVel);
      this.grounded = true;
      this.seat = null;
      this.autoMove = false;
      if (this.flying) this.toggleFlight();
      this.animTime += dt / Math.sqrt(this.k);
      this.updateRig(dt);
      return;
    }
    // ---- size (numpad + / -): exponential growth, clamped.
    const grow = (input.down('NumpadAdd') || input.down('Equal') ? 1 : 0) - (input.down('NumpadSubtract') || input.down('Minus') ? 1 : 0);
    const lo = this.sizeOverride ? MIN_HEIGHT : Math.max(MIN_HEIGHT, this.minHeight), hi = this.sizeOverride ? MAX_HEIGHT : Math.min(MAX_HEIGHT, Math.max(lo, this.maxHeight));
    if (grow !== 0 || this.height < lo || this.height > hi) {
      const before = this.height;
      this.height = clamp(this.height * Math.exp(grow * dt * 0.9), lo, hi);
      if (this.height !== before && grow !== 0) this.events.onSizeChange?.(this.height, grow);
    }
    const k = this.k;
    const sk = Math.sqrt(k);
    this.sinceToggle += dt;
    if (input.hit('KeyF') && this.flightAllowed) this.toggleFlight();
    else if (this.flying && !this.flightAllowed) this.toggleFlight();
    if (input.hit('KeyR')) this.autoMove = !this.autoMove;
    else if (input.hit('KeyW') || input.hit('KeyS')) this.autoMove = false;

    // ---- desired movement in camera space
    const fwd = new THREE.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw));
    const right = new THREE.Vector3(Math.cos(camYaw), 0, -Math.sin(camYaw));
    const wish = new THREE.Vector3();
    if (input.down('KeyW') || this.autoMove) wish.add(fwd);
    if (input.down('KeyS')) wish.sub(fwd);
    if (input.down('KeyD')) wish.add(right);
    if (input.down('KeyA')) wish.sub(right);
    const run = input.down('ShiftLeft') || input.down('ShiftRight') || input.touchRun;
    const walkSlow = input.down('AltLeft') || input.touchSlow;
    if (this.chillT > 0) this.chillT = Math.max(0, this.chillT - dt);
    if (this.downT > 0 || this.ragdoll) {
      this.downT = Math.max(0, this.downT - dt);
      wish.set(0, 0, 0);
      if (this.flying) this.toggleFlight();
      this.seat = null;
      this.autoMove = false;
    }
    // Seated: any move, a jump or growing / shrinking gets up; otherwise stay on the seat.
    if (this.seat) {
      if (wish.lengthSq() > 0 || input.hit('Space') || grow !== 0 || this.flying) this.standUp();
      else {
        const s = this.seat;
        this.pos.x += (s.x - this.pos.x) * Math.min(1, dt * 8);
        this.pos.z += (s.z - this.pos.z) * Math.min(1, dt * 8);
        // The collision's ground knows station halls and train floors (the world's only the street).
        this.pos.y = this.collision ? this.collision.groundAt(this.pos.x, this.pos.z, this.pos.y + 0.5, 0.3) : this.world.groundHeight(this.pos.x, this.pos.z, this.pos.y + 0.5);
        this.vel.set(0, 0, 0);
        let d = s.yaw - this.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        this.yaw += d * Math.min(1, dt * 8);
        this.grounded = true;
        this.updateRig(dt);
        return;
      }
    }

    if (this.flying) this.updateFlight(dt, input, wish, camYaw, camPitch, run);
    else this.updateGround(dt, input, wish, run, walkSlow);

    // ---- facing
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (!this.flying && hs > 0.1 * sk && wish.lengthSq() > 0) {
      // Face the movement, but against an obstacle face where one is going: the slide along a
      // wall can flip direction every frame, and the body flickered with it.
      const target = this.blocked ? Math.atan2(-wish.x, -wish.z) : Math.atan2(-this.vel.x, -this.vel.z);
      let d = target - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * damp(10, dt);
    } else if (this.flying && hs > 0.5 * sk) {
      const target = Math.atan2(-this.vel.x, -this.vel.z);
      let d = target - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * damp(4, dt);
      this.bank = lerp(this.bank, clamp(-d * 1.2, -0.9, 0.9), damp(3, dt));
    } else this.bank = lerp(this.bank, 0, damp(3, dt));

    // ---- animation (time and velocity in the body's own frame)
    this.animTime += dt / sk;
    this.updateRig(dt);
  }

  toggleFlight(): void {
    this.flying = !this.flying;
    this.leap = 0;
    this.sinceToggle = 0;
    if (this.flying) this.vel.y = Math.max(this.vel.y, 4 * Math.sqrt(this.k));
    this.events.onFlightToggle?.(this.flying);
  }

  /** Normal jump take-off speed (k^0.3 scaling). */
  get jumpSpeed(): number { return 3.4 * Math.pow(this.k, 0.3); }

  /** Leave the ground with an upward speed (jumps). */
  launch(vy: number): void {
    this.vel.y = Math.max(this.vel.y, vy);
    this.grounded = false;
  }

  /** Super jump take-off: upward speed and charge strength 0..1 (drives the leap poses). */
  superLaunch(vy: number, strength: number): void {
    this.launch(vy);
    this.leap = Math.max(0.05, strength);
    this.leapT0 = this.animTime;
  }

  /** Burst along a direction: speed (m/s) held for `dur` seconds, collision as usual. */
  dash(dx: number, dy: number, dz: number, speed: number, dur: number): void {
    this.dashV.set(dx, this.flying ? dy : 0, dz).normalize().multiplyScalar(speed);
    this.dashT = dur;
    this.yaw = Math.atan2(-dx, -dz);
  }

  /** During a dash: the burst velocity, no gravity; afterwards the normal speed comes back gradually. */
  private updateDash(dt: number): void {
    this.dashT -= dt;
    this.vel.x = this.dashV.x; this.vel.z = this.dashV.z;
    this.vel.y = this.flying ? this.dashV.y : Math.max(0, this.vel.y);
    this.integrate(dt);
    if (this.dashT <= 0) {
      this.vel.multiplyScalar(0.35);
      // On foot, come out of it at a sprint: the ground friction (≈ 12 m/s²) would otherwise
      // let a third of the dash speed slide on for dozens of metres.
      const hs = Math.hypot(this.vel.x, this.vel.z), vmax = 6 * Math.sqrt(this.k);
      if (!this.flying && hs > vmax) { this.vel.x *= vmax / hs; this.vel.z *= vmax / hs; }
    }
  }

  private updateGround(dt: number, input: Input, wish: THREE.Vector3, run: boolean, slow: boolean): void {
    if (this.dashT > 0) { this.updateDash(dt); return; }
    const k = this.k, sk = Math.sqrt(k);
    const g = 9.81;
    const fast = this.speedTop > 0;
    let speed = (fast ? this.speedTop * sk : (slow ? 0.8 : run ? 5.2 : 1.45) * sk) * (this.chillT > 0 ? this.chillSpeed : 1);
    const moving = wish.lengthSq() > 0;
    // A super jump is steered all the way through the air, at a good clip: the higher the leap,
    // the faster it carries (up to leapSpeed for the full height), building up as it flies
    // (the acceleration below), so leaping covers ground.
    const leaping = !this.grounded && this.leap > 0;
    const carry = Math.max(12, this.leapSpeed * Math.max(0, this.leap - 0.05) / 0.95) * sk;
    if (leaping) speed = Math.max(carry, fast ? Math.min(speed, Math.hypot(this.vel.x, this.vel.z)) : speed);
    if (moving) {
      wish.normalize();
      if (fast && (this.grounded || this.onWater) && this.collision) {
        // Autopilot: around what is ahead; slower when the way is blocked (braking a little
        // under the runner's real deceleration, see accel below).
        const decel = 0.55 * this.speedTop * Math.max(1, sk * 0.6);
        const st = this.nav.steer(this.collision, this.pos.x, this.pos.y, this.pos.z, this.height, this.radius, k, wish.x, wish.z, Math.hypot(this.vel.x, this.vel.z), decel, dt);
        wish.set(st.dx, 0, st.dz);
        speed = Math.min(speed, st.max);
      }
      // Hop over someone (a car, a bench) just ahead when the way over is clear (speedHop).
      if (fast && this.grounded && !this.onWater && this.jumpCharge < 0 && this.collision) {
        const hs = Math.hypot(this.vel.x, this.vel.z);
        const plan = hs > 1 ? planHop(this.collision, this.hopPeople, this.pos.x, this.pos.y, this.pos.z, this.height, this.radius, k, this.vel.x / hs, this.vel.z / hs, hs) : null;
        if (plan) { this.launch(plan.vy); this.hopG = plan.g; }
      }
      wish.multiplyScalar(speed);
    }
    // Acceleration limited by friction (∝ g) — giants accelerate as fast in m/s² but feel heavy relative to size.
    // A super-speed runner gets to top speed in about a second and a half (and stops as fast);
    // on ice there is hardly any grip at all.
    let accel = this.grounded ? 9 * (run ? 1.2 : 1) * Math.min(1, sk) + 3 : 2;
    if (fast && (this.grounded || this.onWater)) accel = Math.max(accel, (moving ? 0.65 : 1.2) * this.speedTop);
    else if (leaping && moving) accel = Math.max(accel, 14 * Math.min(1, sk) + 4, this.leapSpeed / LEAP_RAMP);
    if (this.onIce && this.grounded && !this.onWater) accel = fast ? accel * 0.35 : 1.1;
    const dvx = wish.x - this.vel.x, dvz = wish.z - this.vel.z;
    const dv = Math.hypot(dvx, dvz);
    const maxDv = accel * dt * Math.max(1, sk * 0.6);
    if (dv > maxDv) { this.vel.x += (dvx / dv) * maxDv; this.vel.z += (dvz / dv) * maxDv; }
    else { this.vel.x = wish.x; this.vel.z = wish.z; }
    // Gravity + quadratic drag (terminal velocity ∝ √k).
    const vt = 55 * sk;
    this.vel.y -= (this.hopG || g) * dt;
    const vy = this.vel.y;
    if (vy < 0) this.vel.y += g * (vy / vt) * (vy / vt) * dt;
    // Jump.
    if (this.grounded && this.jumpOnSpace && input.hit('Space')) this.launch(this.jumpSpeed);
    this.integrate(dt);
    // A long leap lands on its feet: the carry stops there instead of skidding on down the street.
    if (leaping && this.grounded) {
      const hs = Math.hypot(this.vel.x, this.vel.z), vmax = Math.max(6 * sk, fast ? this.speedTop * sk : 0);
      if (hs > vmax) { this.vel.x *= vmax / hs; this.vel.z *= vmax / hs; }
    }
    // Parkour at super speed: running into a wall carries on up it (up to the roof), running
    // into a car or a bench vaults over it.
    // (Not out of a hop: a façade grazed in the air would carry the runner up onto a roof.)
    if (fast && this.blocked && moving && !this.hopping) {
      const hs = Math.hypot(this.vel.x, this.vel.z);
      const into = this.blocked.speed;
      if (into > 4 * sk || hs > 6 * sk) {
        // Up the face at a brisk climb (not a launch): ~14 m/s for a 1.8 m runner.
        this.vel.y = Math.max(this.vel.y, Math.min(14 * sk, 0.25 * this.speedTop * sk + 4 * sk));
        this.grounded = false;
        this.climbing = 0.15;
      }
    } else if (this.climbing > 0) {
      // Over the top: a small hop onto the roof or the car, not a leap into the sky.
      this.climbing -= dt;
      if (!this.blocked && this.vel.y > 3 * sk) this.vel.y = 3 * sk;
    }
  }

  private updateFlight(dt: number, input: Input, wish: THREE.Vector3, camYaw: number, camPitch: number, boost: boolean): void {
    if (this.dashT > 0) { this.updateDash(dt); return; }
    const k = this.k, sk = Math.sqrt(k);
    // Forward follows the full camera direction (pitch included).
    const dir = new THREE.Vector3(-Math.sin(camYaw) * Math.cos(camPitch), Math.sin(camPitch), -Math.cos(camYaw) * Math.cos(camPitch));
    const right = new THREE.Vector3(Math.cos(camYaw), 0, -Math.sin(camYaw));
    const w = new THREE.Vector3();
    if (input.down('KeyW') || this.autoMove) w.add(dir);
    if (input.down('KeyS')) w.sub(dir);
    if (input.down('KeyD')) w.add(right);
    if (input.down('KeyA')) w.sub(right);
    if (input.down('Space')) w.y += 1;
    if (input.down('ControlLeft') || input.down('KeyC')) w.y -= 1;
    void wish;
    const cruise = 22 * sk * this.flightSpeed, fast = cruise * this.flightBoost;
    this.flyBoost = boost && w.lengthSq() > 0 && this.flightBoost > 1.05;
    const target = w.lengthSq() > 0 ? w.normalize().multiplyScalar(boost ? fast : cruise) : new THREE.Vector3();
    const a = boost ? 1.4 : 2.2;
    this.vel.lerp(target, damp(a, dt));
    // Hover bobbing when idle.
    if (target.lengthSq() === 0) this.vel.y += Math.sin(this.animTime * 2) * 0.02 * sk;
    this.integrate(dt);
    if (this.grounded && this.vel.y <= 0 && target.y < 0) { /* touch down but keep flying */ }
  }

  /** Collision service (set by the game). */
  collision!: Collision;

  /** Move with collision against wall panels, floors and the ground (substepped at speed). */
  private integrate(dt: number): void {
    const r = this.radius;
    const travel = this.vel.length() * dt;
    // Substeps shorter than the body radius, so fast bodies (dash, super jump, boost) never step
    // through a wall panel (the side test uses the previous position).
    const sub = Math.min(this.speedTop > 0 ? 160 : 48, Math.max(1, Math.ceil(travel / Math.max(0.05, r * 0.8))));
    const h = dt / sub;
    this.blocked = null;
    this.onWater = false;
    // A super-speed runner skims over manholes and stairwells instead of dropping in.
    this.collision.skimHoles = this.speeding && Math.hypot(this.vel.x, this.vel.z) > 8 * Math.sqrt(this.k);
    for (let s = 0; s < sub; s++) this.integrateStep(h, r);
    this.collision.skimHoles = false;
    if (this.grounded && this.vel.y <= 0) this.hopG = 0;
  }

  private integrateStep(dt: number, r: number): void {
    const ox = this.pos.x, oz = this.pos.z;
    const nx = ox + this.vel.x * dt, nz = oz + this.vel.z * dt;
    let ny = this.pos.y + this.vel.y * dt;
    const c = this.collision.collide(nx, nz, this.pos.y, this.height, r, ox, oz);
    let px = c.x, pz = c.z;
    if (c.hit) {
      const speed = Math.hypot(this.vel.x, this.vel.z);
      const into = -(this.vel.x * c.nx + this.vel.z * c.nz);
      if (!this.blocked || into > this.blocked.speed) this.blocked = { x: c.cx, z: c.cz, nx: c.nx, nz: c.nz, speed: Math.max(into, speed * 0.3) };
      const vn = this.vel.x * c.nx + this.vel.z * c.nz;
      if (vn < 0) { this.vel.x -= vn * c.nx; this.vel.z -= vn * c.nz; }
    }
    // --- ground
    const step = Math.max(0.35, this.height * 0.28);
    // From the open (the street, the river) the body only goes below ground through a hole: a
    // super-speed runner covers a quay wall in one substep and used to end up under the street,
    // in the sewer or culvert there, or in the earth.
    const surface = !this.collision.underground(ox, this.pos.y, oz) && !this.collision.under?.inHole(ox, oz) && !this.collision.under?.inHole(px, pz);
    const ground = this.collision.groundAt(px, pz, this.pos.y, step, surface);
    const wasGrounded = this.grounded;
    if (ny <= ground) {
      const impactV = -this.vel.y;
      ny = ground;
      if (this.vel.y < 0) this.vel.y = 0;
      this.grounded = true;
      if (!wasGrounded) {
        // (A hop lands as safely as a super jump: no fall, no hurt.)
        this.landedLeap = this.leap || (this.hopG > 0 ? 0.01 : 0);
        this.leap = 0;
        this.hopG = 0;
        if (impactV > 2) this.events.onLand?.(px, ny, pz, 0.5 * this.mass * impactV * impactV, this.height);
        this.landedLeap = 0;
      }
    } else if (ny - ground > 0.05 * Math.max(1, this.k)) {
      // Step down small kerbs while walking instead of falling off them.
      if (wasGrounded && !this.flying && ny - ground < step && this.vel.y <= 0) { ny = ground; this.grounded = true; }
      else this.grounded = false;
    }
    // Water: the body floats/wades (simple buoyancy) — or, fast enough, runs across it.
    // (Not in a tunnel under the river: a culvert, the metro.)
    const wl = this.collision.underground(px, ny, pz) ? -Infinity : this.world.terrain.waterLevel(px, pz);
    if (!this.flying && this.speedTop > 0 && wl > ny - 0.05 * this.height && this.vel.y <= 0.5
      && Math.hypot(this.vel.x, this.vel.z) > SPEED_WATER * Math.sqrt(this.k)) {
      ny = wl;
      if (this.vel.y < 0) this.vel.y = 0;
      this.grounded = true;
      this.onWater = true;
      this.leap = 0;
    } else if (!this.flying && wl > ny + this.height * 0.6) {
      ny = Math.max(ny, wl - this.height * 0.65);
      this.vel.y = Math.max(this.vel.y, 0);
      this.grounded = true;
      this.leap = 0;
    }
    // Underground ceilings (stations, tunnels) stop a jump instead of letting the head pass through.
    const ceil = this.collision.ceilingAt(px, pz, surface ? Math.max(ny, this.pos.y) : this.pos.y);
    if (ny + this.height > ceil) { ny = Math.max(ceil - this.height, Math.min(ny, this.pos.y)); if (this.vel.y > 0) this.vel.y = 0; }
    this.pos.set(px, ny, pz);
  }

  /** Sit down on a seat (the game finds it: benches, café chairs). */
  sitOn(x: number, z: number, yaw: number): void {
    if (this.flying || this.downT > 0 || this.ragdoll) return;
    this.seat = { x, z, yaw };
    this.autoMove = false;
  }

  /** Get up from the seat, a step forward off it. */
  standUp(): void {
    const s = this.seat;
    if (!s) return;
    this.seat = null;
    // A step off the seat: forward if that is free, else to a side or back (a café chair
    // facing a shop window must not step through it).
    const d = 0.3 + this.radius;
    for (const a of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
      const x = s.x - Math.sin(s.yaw + a) * d, z = s.z - Math.cos(s.yaw + a) * d;
      if (this.collision && this.collision.collide(x, z, this.pos.y, this.height, this.radius, s.x, s.z).hit) continue;
      this.pos.x = x; this.pos.z = z;
      return;
    }
    this.pos.x = s.x; this.pos.z = s.z;
  }

  private moveState(): MoveState {
    if (this.puppet) return this.puppet;
    if (this.ragdoll) return this.ragdoll === 'limp' ? 'knockdown' : 'idle';
    if (this.seat) return 'sit';
    if (this.downT > 0) return 'knockdown';
    if (this.flying) return 'fly';
    if (!this.grounded) return this.vel.y > 0 ? 'jump' : 'fall';
    const wl = this.collision?.underground(this.pos.x, this.pos.y, this.pos.z) ? -Infinity : this.world.terrain.waterLevel(this.pos.x, this.pos.z);
    if (wl > this.pos.y + this.height * 0.5) return 'swim';
    const hs = Math.hypot(this.vel.x, this.vel.z) / Math.sqrt(this.k);
    return hs < 0.15 ? 'idle' : hs < 2.5 ? 'walk' : hs < 5.6 ? 'run' : 'sprint';
  }

  private updateRig(dt: number): void {
    const k = this.k, sk = Math.sqrt(k);
    const scale = this.height / this.rigBaseHeight;
    // Velocity in the body frame: v / √k (a giant's slow-motion stride looks like a normal walk).
    this.animVel.lerp(this.vel, damp(14, dt));
    const vl: [number, number, number] = [this.animVel.x / sk, this.animVel.y / sk, this.animVel.z / sk];
    const move = this.moveState();
    const pw = this.powerAnim;
    pw.charge = this.flying ? -1 : this.jumpCharge;
    pw.leap = this.leap;
    pw.leapT = this.animTime - this.leapT0;
    pw.dash = this.dashT > 0 ? 1 : 0;
    const fa = this.flyAnim;
    fa.tilt = this.flightBlend; fa.bank = this.bank; fa.boost = this.flying && this.flyBoost ? 1 : 0;
    pw.fly = this.flying || this.flightBlend > 0.01 ? fa : undefined;
    this.rig.update({ pos: [this.pos.x, this.pos.y, this.pos.z], vel: vl, yaw: this.yaw, anim: { move, action: this.action && this.animTime - this.action.t0 < this.action.dur ? this.action : undefined, power: pw }, flags: 0, scale }, dt / sk, this.animTime);
    // Footsteps on the animation's heel strikes (gait phase 0.25 = left, 0.75 = right).
    const ph = this.rig.animator?.gaitPhase ?? 0;
    const prev = this.stepPhase;
    // Forward: prev < m <= ph (or across the wrap). Backwards (backpedal): ph < m <= prev.
    const crossed = (m: number) => prev - ph > 0.5 ? (prev < m || ph >= m)
      : ph - prev > 0.5 ? (ph < m || prev >= m)
      : (prev < m && ph >= m) || (ph < m && prev >= m);
    const hs = Math.hypot(this.vel.x, this.vel.z) / sk;
    if (this.grounded && !this.flying && hs > 0.3 && ph !== this.stepPhase && (crossed(0.25) || crossed(0.75))) {
      this.events.onFootstep?.(this.pos.x, this.pos.y, this.pos.z, stepEnergy(this.mass, this.height), this.height);
    }
    this.stepPhase = ph;
    // Flight body orientation: pitch forward with speed, bank into turns (the animator poses the
    // limbs for it: Animator.flight).
    const speed = this.vel.length() / sk;
    const fb = this.flying ? clamp((speed - 4) / 10, 0, 1) : 0;
    this.flightBlend = lerp(this.flightBlend, fb, damp(3, dt));
    if (this.flying || this.flightBlend > 0.01) {
      const vh = Math.hypot(this.vel.x, this.vel.z);
      const climb = Math.atan2(this.vel.y, Math.max(0.1, vh));
      const targetPitch = -(Math.PI / 2 - 0.12) * this.flightBlend + climb * this.flightBlend * 0.9;
      this.bodyPitch = lerp(this.bodyPitch, targetPitch, damp(4, dt));
      const obj = this.rig.object;
      // Rotate around the body's centre so the pivot is the chest, not the feet.
      const centre = this.height * 0.55;
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.bodyPitch, this.yaw, this.bank * this.flightBlend, 'YXZ'));
      obj.quaternion.copy(q);
      _v.set(0, centre, 0).applyQuaternion(q);
      obj.position.set(this.pos.x, this.pos.y + centre - _v.y, this.pos.z);
      obj.position.x -= _v.x; obj.position.z -= _v.z;
    } else {
      this.bodyPitch = 0;
      // Back on the feet: drop any leftover pitch/bank from flight (the rig only sets yaw,
      // so a tilted orientation would otherwise persist and mix with later turns).
      this.rig.object.rotation.set(0, this.yaw, 0, 'XYZ');
    }
    // Imported avatar follows the (invisible) puppet's final pose.
    if (this.avatar) {
      const punching = !!this.action && this.action.id === 'punch' && this.animTime - this.action.t0 < this.action.dur;
      this.avatar.update(dt / sk, move, Math.hypot(this.animVel.x, this.animVel.z) / sk, punching);
    }
  }

  /** Imported character model shown instead of the built-in human (null: back to default). */
  avatar: ImportedAvatar | null = null;

  async setAvatar(model: LoadedModel | null, forceClips = false): Promise<ImportedAvatar | null> {
    await this.rig.ready;
    this.avatar?.dispose();
    this.avatar = null;
    if (!model) return null;
    const a = new ImportedAvatar(model, this.rig, forceClips);
    a.attach();
    this.avatar = a;
    return a;
  }

  /** World positions of the two eyes (false: no character yet). */
  eyePositions(l: THREE.Vector3, r: THREE.Vector3): boolean {
    const e = this.rig.char?.eyes;
    if (!e || e.length < 2) return false;
    e[0].getWorldPosition(l);
    e[1].getWorldPosition(r);
    return true;
  }

  /** Centre of the body (for the camera pivot). */
  pivot(out: THREE.Vector3): THREE.Vector3 {
    const h = this.height;
    if (this.flightBlend > 0.5) return out.set(this.pos.x, this.pos.y + h * 0.55, this.pos.z);
    return out.set(this.pos.x, this.pos.y + h * 0.82, this.pos.z);
  }
}

/** Push a circle (x,z,r) out of a polygon; returns [x, z, nx, nz] or null. */
export function pushOutOfPoly(poly: number[], x: number, z: number, r: number): [number, number, number, number] | null {
  const n = poly.length >> 1;
  let inside = false;
  let best = Infinity, bx = 0, bz = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = poly[j * 2], az = poly[j * 2 + 1], cx = poly[i * 2], cz = poly[i * 2 + 1];
    if ((az > z) !== (cz > z) && x < ((cx - ax) * (z - az)) / (cz - az) + ax) inside = !inside;
    const dx = cx - ax, dz = cz - az;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + dx * t, qz = az + dz * t;
    const d = (qx - x) * (qx - x) + (qz - z) * (qz - z);
    if (d < best) { best = d; bx = qx; bz = qz; }
  }
  const d = Math.sqrt(best);
  if (!inside && d >= r) return null;
  let nx = x - bx, nz = z - bz;
  const l = Math.hypot(nx, nz) || 1;
  nx /= l; nz /= l;
  if (inside) { nx = -nx; nz = -nz; }
  return [bx + nx * r, bz + nz * r, nx, nz];
}
