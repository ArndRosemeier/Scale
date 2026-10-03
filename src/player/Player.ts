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
import type { MoveState } from '../shared/types';
import { clamp, lerp, damp } from '../core/math';
import type { HumanoidAppearance } from '../humanoid/types';
import type { Collision } from '../world/Collision';
import { ImportedAvatar, type LoadedModel } from '../avatar/ImportedAvatar';

export const BASE_HEIGHT = 1.8;
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
  grounded = false;
  readonly rig: HumanoidRig;
  readonly app: HumanoidAppearance;
  /** Animation clock (runs at 1/√k). */
  private animTime = 0;
  private rigBaseHeight = 1.75;
  private lastPhase = 0;
  private stepPhase = 0;
  private bank = 0;
  private bodyPitch = 0;
  private flightBlend = 0;
  /** Seconds since takeoff (for the takeoff whoosh/pose). */
  private sinceToggle = 10;
  events: PlayerEvents = {};
  /** One-shot action (punch, wave...) in animation-clock time. */
  action: { id: string; t0: number; dur: number } | undefined;
  get animClock(): number { return this.animTime; }
  /** Walking into walls: the obstacle hit this frame (for destruction). */
  blocked: { x: number; z: number; nx: number; nz: number; speed: number } | null = null;

  constructor(seed: number, private world: WorldIndex) {
    this.app = randomAppearance('human', seed, {});
    this.rig = new HumanoidRig(this.app, { castShadow: true, priority: -10, ground: (x, y, z) => this.collision ? this.collision.groundAt(x, z, y + 0.4, 0.3) : this.world.groundHeight(x, z, y + 0.4) });
    this.rig.setEquipment(cityOutfit(seed, this.app.gender, this.app.age, 0.2, 0.3));
    this.rig.ready.then(() => { this.rigBaseHeight = this.rig.height; });
  }

  get k(): number { return this.height / BASE_HEIGHT; }
  get mass(): number { return 80 * this.k ** 3; }
  get radius(): number { return 0.3 * this.k; }

  update(dt: number, input: Input, camYaw: number, camPitch: number): void {
    // ---- size (numpad + / -): exponential growth, clamped.
    const grow = (input.down('NumpadAdd') || input.down('Equal') ? 1 : 0) - (input.down('NumpadSubtract') || input.down('Minus') ? 1 : 0);
    if (grow !== 0) {
      const before = this.height;
      this.height = clamp(this.height * Math.exp(grow * dt * 0.9), MIN_HEIGHT, MAX_HEIGHT);
      if (this.height !== before) this.events.onSizeChange?.(this.height, grow);
    }
    const k = this.k;
    const sk = Math.sqrt(k);
    this.sinceToggle += dt;
    if (input.hit('KeyF')) {
      this.flying = !this.flying;
      this.sinceToggle = 0;
      if (this.flying) this.vel.y = Math.max(this.vel.y, 4 * sk);
      this.events.onFlightToggle?.(this.flying);
    }

    // ---- desired movement in camera space
    const fwd = new THREE.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw));
    const right = new THREE.Vector3(Math.cos(camYaw), 0, -Math.sin(camYaw));
    const wish = new THREE.Vector3();
    if (input.down('KeyW')) wish.add(fwd);
    if (input.down('KeyS')) wish.sub(fwd);
    if (input.down('KeyD')) wish.add(right);
    if (input.down('KeyA')) wish.sub(right);
    const run = input.down('ShiftLeft') || input.down('ShiftRight');
    const walkSlow = input.down('AltLeft');

    if (this.flying) this.updateFlight(dt, input, wish, camYaw, camPitch, run);
    else this.updateGround(dt, input, wish, run, walkSlow);

    // ---- facing
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (!this.flying && hs > 0.1 * sk && wish.lengthSq() > 0) {
      const target = Math.atan2(-this.vel.x, -this.vel.z);
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

  private updateGround(dt: number, input: Input, wish: THREE.Vector3, run: boolean, slow: boolean): void {
    const k = this.k, sk = Math.sqrt(k);
    const g = 9.81;
    const speed = (slow ? 0.8 : run ? 5.2 : 1.45) * sk;
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
    // Acceleration limited by friction (∝ g) — giants accelerate as fast in m/s² but feel heavy relative to size.
    const accel = this.grounded ? 9 * (run ? 1.2 : 1) * Math.min(1, sk) + 3 : 2;
    const dvx = wish.x - this.vel.x, dvz = wish.z - this.vel.z;
    const dv = Math.hypot(dvx, dvz);
    const maxDv = accel * dt * Math.max(1, sk * 0.6);
    if (dv > maxDv) { this.vel.x += (dvx / dv) * maxDv; this.vel.z += (dvz / dv) * maxDv; }
    else { this.vel.x = wish.x; this.vel.z = wish.z; }
    // Gravity + quadratic drag (terminal velocity ∝ √k).
    const vt = 55 * sk;
    this.vel.y -= g * dt;
    const vy = this.vel.y;
    if (vy < 0) this.vel.y += g * (vy / vt) * (vy / vt) * dt;
    // Jump.
    if (this.grounded && input.hit('Space')) {
      this.vel.y = 3.4 * Math.pow(k, 0.3);
      this.grounded = false;
    }
    this.integrate(dt);
  }

  private updateFlight(dt: number, input: Input, wish: THREE.Vector3, camYaw: number, camPitch: number, boost: boolean): void {
    const k = this.k, sk = Math.sqrt(k);
    // Forward follows the full camera direction (pitch included).
    const dir = new THREE.Vector3(-Math.sin(camYaw) * Math.cos(camPitch), Math.sin(camPitch), -Math.cos(camYaw) * Math.cos(camPitch));
    const right = new THREE.Vector3(Math.cos(camYaw), 0, -Math.sin(camYaw));
    const w = new THREE.Vector3();
    if (input.down('KeyW')) w.add(dir);
    if (input.down('KeyS')) w.sub(dir);
    if (input.down('KeyD')) w.add(right);
    if (input.down('KeyA')) w.sub(right);
    if (input.down('Space')) w.y += 1;
    if (input.down('ControlLeft') || input.down('KeyC')) w.y -= 1;
    void wish;
    const cruise = 22 * sk, fast = 160 * sk;
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
    const sub = Math.min(12, Math.max(1, Math.ceil(travel / Math.max(0.05, r * 0.8))));
    const h = dt / sub;
    this.blocked = null;
    for (let s = 0; s < sub; s++) this.integrateStep(h, r);
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
    const ground = this.collision.groundAt(px, pz, this.pos.y, step);
    const wasGrounded = this.grounded;
    if (ny <= ground) {
      const impactV = -this.vel.y;
      ny = ground;
      if (this.vel.y < 0) this.vel.y = 0;
      this.grounded = true;
      if (!wasGrounded && impactV > 2) this.events.onLand?.(px, ny, pz, 0.5 * this.mass * impactV * impactV, this.height);
    } else if (ny - ground > 0.05 * Math.max(1, this.k)) {
      // Step down small kerbs while walking instead of falling off them.
      if (wasGrounded && !this.flying && ny - ground < step && this.vel.y <= 0) { ny = ground; this.grounded = true; }
      else this.grounded = false;
    }
    // Water: the body floats/wades (simple buoyancy).
    const wl = this.world.terrain.waterLevel(px, pz);
    if (!this.flying && wl > ny + this.height * 0.6) {
      ny = Math.max(ny, wl - this.height * 0.65);
      this.vel.y = Math.max(this.vel.y, 0);
      this.grounded = true;
    }
    this.pos.set(px, ny, pz);
  }

  private moveState(): MoveState {
    if (this.flying) return 'fly';
    if (!this.grounded) return this.vel.y > 0 ? 'jump' : 'fall';
    const wl = this.world.terrain.waterLevel(this.pos.x, this.pos.z);
    if (wl > this.pos.y + this.height * 0.5) return 'swim';
    const hs = Math.hypot(this.vel.x, this.vel.z) / Math.sqrt(this.k);
    return hs < 0.15 ? 'idle' : hs < 2.5 ? 'walk' : hs < 5.6 ? 'run' : 'sprint';
  }

  private updateRig(dt: number): void {
    const k = this.k, sk = Math.sqrt(k);
    const scale = this.height / this.rigBaseHeight;
    // Velocity in the body frame: v / √k (a giant's slow-motion stride looks like a normal walk).
    const vl: [number, number, number] = [this.vel.x / sk, this.vel.y / sk, this.vel.z / sk];
    const move = this.moveState();
    this.rig.update({ pos: [this.pos.x, this.pos.y, this.pos.z], vel: vl, yaw: this.yaw, anim: { move, action: this.action && this.animTime - this.action.t0 < this.action.dur ? this.action : undefined }, flags: 0, scale }, dt / sk, this.animTime);
    // Footsteps on the animation's heel strikes (gait phase 0.25 = left, 0.75 = right).
    const ph = this.rig.animator?.gaitPhase ?? 0;
    const prev = this.stepPhase;
    // Forward: prev < m <= ph (or across the wrap). Backwards (backpedal): ph < m <= prev.
    const crossed = (m: number) => prev - ph > 0.5 ? (prev < m || ph >= m)
      : ph - prev > 0.5 ? (ph < m || prev >= m)
      : (prev < m && ph >= m) || (ph < m && prev >= m);
    const hs = Math.hypot(this.vel.x, this.vel.z) / sk;
    if (this.grounded && !this.flying && hs > 0.3 && ph !== this.stepPhase && (crossed(0.25) || crossed(0.75))) {
      const energy = 0.5 * this.mass * (0.25 * 9.81 * this.height);
      this.events.onFootstep?.(this.pos.x, this.pos.y, this.pos.z, energy, this.height);
    }
    this.stepPhase = ph;
    // Flight body orientation: pitch forward with speed, bank into turns, superhero arms.
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
      this.superheroArms(this.flightBlend);
    } else {
      this.bodyPitch = 0;
      // Back on the feet: drop any leftover pitch/bank from flight (the rig only sets yaw,
      // so a tilted orientation would otherwise persist and mix with later turns).
      this.rig.object.rotation.set(0, this.yaw, 0, 'XYZ');
    }
    // Imported avatar follows the (invisible) puppet's final pose.
    if (this.avatar) {
      const punching = !!this.action && this.action.id === 'punch' && this.animTime - this.action.t0 < this.action.dur;
      this.avatar.update(dt / sk, move, Math.hypot(this.vel.x, this.vel.z) / sk, punching);
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

  /** Classic flight pose: one fist forward, the other arm along the body, legs together. */
  private superheroArms(w: number): void {
    const ch = this.rig.char;
    if (!ch || w <= 0.01) return;
    const set = (name: string, x: number, y: number, z: number) => {
      const i = ch.boneIndex.get(name);
      if (i === undefined) return;
      const b = ch.bones[i];
      const e = new THREE.Euler(x, y, z, 'XZY');
      const q = new THREE.Quaternion().setFromEuler(e);
      b.quaternion.slerp(q, w);
    };
    set('upperarm01.R', 2.9, 0, -0.15);
    set('lowerarm01.R', 0.15, 0, 0);
    set('upperarm01.L', -0.25, 0, 0.12);
    set('lowerarm01.L', 0.25, 0, 0);
    set('upperleg01.L', 0.02, 0, 0.03);
    set('upperleg01.R', 0.12, 0, -0.03);
    set('lowerleg01.L', -0.05, 0, 0);
    set('lowerleg01.R', -0.35, 0, 0);
    set('neck01', 0.6, 0, 0);
    set('head', 0.35, 0, 0);
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
