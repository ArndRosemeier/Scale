/**
 * Player ↔ world physical interactions: punches, smashing through walls,
 * giant footsteps and landings (GiantBody), roof overloading and the test blast.
 */
import * as THREE from 'three';
import { aimDir } from './aimRay';
import type { Player } from '../player/Player';
import type { Destruction } from '../destruction/Destruction';
import type { Dust } from '../destruction/Dust';
import type { Debris } from '../destruction/Debris';
import type { CameraRig } from '../player/CameraRig';
import type { Input } from './Input';
import type { WorldIndex } from '../world/WorldIndex';
import type { Collision } from '../world/Collision';
import { Stimuli, noticeRadius } from './Stimuli';
import { GiantSteps } from './GiantBody';
import { pointInPoly, polyArea } from '../core/geom2';
import type { Target } from './Targeting';
import { POWER_HIT } from './abilities/tuning';

export class Interactions {
  private punchT = -10;
  private punchDone = true;
  private punchQueued = false;
  private smashCooldown = 0;
  private roofT = 0;
  /** Punch impulse at 1.8 m (N·s, × k²): set by the AbilitySystem from super strength. */
  punchImpulse = 380;
  /** Body-momentum wall smashing multiplier (super strength). */
  smashMul = 1;
  /** B = test blast where the camera looks (debug; sandbox only). */
  debugBlast = true;
  /** Soft lock: the facing for a punch (a target in reach), null = where the camera looks. */
  aimYaw: (() => number | null) | null = null;
  onSound?: (id: string, x: number, y: number, z: number, gain: number, pitch?: number, ref?: number) => void;
  /** Footsteps and landings of any heavy body (the player's own, a monster's): GiantBody. */
  readonly steps: GiantSteps;
  /** Physical strike on movable things (cars, props, people): point, radius, impulse vector (N*s). */
  /** A physical strike (punch, blast); `spare`: the friend/foe sense leaves these out. */
  onStrike?: (x: number, y: number, z: number, r: number, jx: number, jy: number, jz: number, spare?: (t: Target) => boolean, personJ?: number) => void;

  constructor(
    private player: Player,
    private destruction: Destruction,
    private dust: Dust,
    private debris: Debris,
    private cam: THREE.PerspectiveCamera,
    private camRig: CameraRig,
    private world: WorldIndex,
    private collision: Collision,
    readonly stimuli: Stimuli,
  ) {
    this.steps = new GiantSteps({ camera: cam, camRig, dust, destruction, stimuli, playerPos: player.pos });
    this.steps.sound = (id, x, y, z, gain, pitch, ref) => this.onSound?.(id, x, y, z, gain, pitch, ref);
    // A hero knocked flying (by a monster's blow) does not steer where they come down: what that
    // breaks is nobody's doing ('world'), not booked to the player.
    player.events.onFootstep = (x, y, z, e, h) => this.steps.footstep(x, y, z, e, h, { own: true, cause: this.flung ? 'world' : 'player' });
    player.events.onLand = (x, y, z, e, h) => this.steps.land(x, y, z, e, h, { own: true, cause: this.flung ? 'world' : 'player' });
  }

  /** Out of control (knocked down, a ragdoll tumbling): the body's impacts are not the player's own blows. */
  get flung(): boolean { return this.player.downT > 0 || this.player.ragdoll !== ''; }

  /** Throw a punch on the next update (the Punch power); false while the last one is still out. */
  punch(): boolean {
    if (this.lastTime - this.punchT <= 0.5) return false;
    this.punchQueued = true;
    return true;
  }
  private lastTime = 0;

  update(dt: number, input: Input, time: number): void {
    this.lastTime = time;
    const p = this.player;
    const k = p.k;
    this.smashCooldown -= dt;
    // ---- punch (a hotbar power: AbilitySystem → punch())
    const punchNow = this.punchQueued;
    this.punchQueued = false;
    if (punchNow && time - this.punchT > 0.5) {
      this.punchT = time;
      this.punchDone = false;
      p.action = { id: 'punch', t0: p.animClock, dur: 0.55 };
      // Punch where you look: standing (or walking) side-on to a wall, the fist still goes into it.
      if (!p.flying) p.yaw = this.aimYaw?.() ?? this.cursorYaw();
    }
    if (!this.punchDone && time - this.punchT > 0.22 * Math.sqrt(k)) {
      this.punchDone = true;
      // Strike point: in front of the chest along the facing direction, at arm's length — or on
      // the facade the fist meets first. (A fixed point overshot a wall the body leant on by
      // more than the impact radius, so a punch at a facade often broke nothing.)
      const reach = 0.75 * p.height * 0.55 + p.radius;
      const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
      const sy = p.pos.y + p.height * 0.72;
      const wall = this.destruction.facadeHit(p.pos.x, sy, p.pos.z, fx, fz, reach + p.radius * 0.5);
      const t = wall ? wall.t + 0.02 * p.height : reach;
      const sx = p.pos.x + fx * t, sz = p.pos.z + fz * t;
      const impulse = this.punchImpulse * k * k;
      const n = this.destruction.impact(sx, sy, sz, 0.35 * p.height, impulse, fx, -0.05, fz, 'wall');
      this.onStrike?.(sx, sy, sz, 0.45 * p.height, fx * impulse, impulse * POWER_HIT.punchLift, fz * impulse);
      this.stimuli.emit('impact', sx, sy, sz, Math.log10(impulse * 10), noticeRadius(impulse * 20));
      if (n > 0) {
        this.camRig.addShake(0.25);
        this.onSound?.('concrete_break', sx, sy, sz, Math.min(1, 0.4 + n * 0.1), 1 / Math.pow(k, 0.15));
      } else this.onSound?.('punch_impact', sx, sy, sz, 0.6);
    }
    // ---- smashing through walls with body momentum (walking giants, fast flight)
    if (p.blocked && this.smashCooldown <= 0) {
      const momentum = p.mass * p.blocked.speed * this.smashMul;
      if (momentum > 2000) {
        const b = p.blocked;
        const y = p.pos.y + p.height * 0.5;
        const n = this.destruction.as(this.flung ? 'world' : 'player', () => this.destruction.impact(b.x, y, b.z, p.height * 0.55, momentum, -b.nx, 0, -b.nz, 'wall'));
        if (n > 0) {
          this.smashCooldown = 0.08;
          this.camRig.addShake(Math.min(0.6, n * 0.05));
          this.onSound?.('concrete_break', b.x, y, b.z, 1, 1 / Math.pow(k, 0.2));
          this.stimuli.emit('impact', b.x, y, b.z, Math.log10(momentum * 10), noticeRadius(momentum * 30));
        }
      }
    }
    // ---- overloading roofs and floors (a giant standing on a building)
    this.roofT -= dt;
    if (p.grounded && !p.flying && this.roofT <= 0) {
      this.roofT = 0.3;
      const b = this.world.buildingAt(p.pos.x, p.pos.z);
      if (b) {
        const L = this.destruction.layoutOf(b);
        const area = Math.abs(polyArea(L.tiers[L.tiers.length - 1].poly));
        // Distributed capacity of a roof/floor slab ≈ 1500 kg/m² at failure; the load concentrates under the feet.
        const footArea = Math.max(0.05, (p.height * 0.15) * (p.height * 0.06) * 2);
        const pressureLoad = p.mass / Math.min(area, footArea * 6);
        if (pressureLoad > 1500 && p.pos.y > L.base + 1) {
          this.destruction.impact(p.pos.x, p.pos.y - 1.5, p.pos.z, Math.max(3, p.height * 0.12), p.mass * 3, 0, -1, 0, 'stomp');
          this.destruction.crushAt(b, p.pos.y);
          this.dust.burst(p.pos.x, p.pos.y, p.pos.z, 10, p.height * 0.2, 3, p.height * 0.1 + 1, 6, new THREE.Color(0.65, 0.62, 0.58), 0.3, 0.5);
        }
      }
    }
    // ---- test blast (B): explosion where the camera looks
    if (this.debugBlast && input.hit('KeyB')) this.blastAtView(800, 2.5e5, false);
  }

  /** Yaw toward where the cursor points on the ground plane (camera forward without a cursor). */
  private cursorYaw(): number {
    const d = aimDir(this.cam, new THREE.Vector3());
    return Math.hypot(d.x, d.z) > 0.05 ? Math.atan2(-d.x, -d.z) : this.camRig.forwardYaw;
  }

  /** Blast where the cursor points, up to `range` m (anywhere=true: also mid-air at the range).
   *  `spare` (the friend/foe sense): it hurts only foes and breaks nothing. `personJ`: the most a
   *  person takes at the centre (N·s; half at the rim), see Game.strike. */
  blastAtView(range: number, impulse: number, anywhere: boolean, spare?: (t: Target) => boolean, personJ?: number): boolean {
    const dir = aimDir(this.cam, new THREE.Vector3());
    const o = this.cam.position;
    const hit = this.world.raycast(o.x, o.y, o.z, dir.x, dir.y, dir.z, range, 1);
    const t = hit.t < Infinity ? hit.t : anywhere ? range : -1;
    if (t < 0) return false;
    this.blast(o.x + dir.x * t, o.y + dir.y * t, o.z + dir.z * t, impulse, spare, personJ);
    return true;
  }

  blast(x: number, y: number, z: number, impulse: number, spare?: (t: Target) => boolean, personJ?: number): void {
    const r = 3 + Math.cbrt(impulse) * 0.08;
    if (!spare) this.destruction.impact(x, y, z, r, impulse, 0, 0.2, 0, 'blast');
    this.onStrike?.(x, y, z, r * 1.5, 0, impulse * POWER_HIT.blastShare, 0, spare, personJ);
    this.dust.burst(x, y, z, 50, r * 0.6, 12, r * 0.8, 10, new THREE.Color(0.35, 0.33, 0.32), 0.9, 0.7);
    this.dust.burst(x, y, z, 20, r * 0.3, 16, r * 0.5, 2.5, new THREE.Color(1.0, 0.55, 0.2).multiplyScalar(3), 1.5, 0.9);
    this.debris.chipBurst(x, y, z, 120, 18, 0, 0.5, 0, new THREE.Color(0.4, 0.38, 0.35), 0.12, 4);
    this.stimuli.emit('blast', x, y, z, 7, noticeRadius(impulse * 200), spare && { spare: (a) => spare({ kind: 'person', obj: a }) });
    this.camRig.addShake(Math.min(1.2, 30 / Math.max(5, Math.hypot(x - this.player.pos.x, z - this.player.pos.z))));
    this.onSound?.('explosion', x, y, z, 1);
  }
}

void pointInPoly;
