/**
 * Third-person orbit camera. Distance is measured in body heights (mouse
 * wheel), collides with terrain/buildings, and the near/far planes scale
 * with the player's size. Speed widens the field of view in flight.
 */
import * as THREE from 'three';
import type { Player } from './Player';
import type { WorldIndex } from '../world/WorldIndex';
import type { Input } from '../game/Input';
import { clamp, damp, lerp } from '../core/math';

export class CameraRig {
  yaw = 0;
  pitch = -0.2;
  /** Distance in body heights. */
  zoom = 2.6;
  private dist = 4;
  private fov = 60;
  private shake = 0;
  private shakeT = 0;
  /** FOV kick (dash): extra degrees, how long it holds, time since it started. */
  private kickDeg = 0;
  private kickHold = 0;
  private kickT = 9;
  private pivot = new THREE.Vector3();
  private smoothPivot = new THREE.Vector3();
  private init = false;

  /** Optional solidity test overriding the default building-prism ray cast (used indoors). */
  solidAt: ((x: number, y: number, z: number) => boolean) | null = null;
  /** Set while the player is underground: no clamping above the terrain. */
  underground = false;

  constructor(private cam: THREE.PerspectiveCamera, private world: WorldIndex) {}

  addShake(amount: number): void {
    this.shake = Math.min(1.5, this.shake + amount);
  }

  /** Widen the view by `deg` for a burst of speed: snaps open, holds `hold` s, eases back. */
  kickFov(deg: number, hold: number): void {
    this.kickDeg = deg;
    this.kickHold = hold;
    this.kickT = 0;
  }

  update(dt: number, p: Player, input: Input): void {
    this.yaw -= input.mouseDX * 0.0024;
    this.pitch = clamp(this.pitch - input.mouseDY * 0.0024, -1.45, 1.2);
    if (input.wheel) this.zoom = clamp(this.zoom * Math.pow(1.15, input.wheel), 0.35, 40);
    const h = p.height;
    p.pivot(this.pivot);
    if (!this.init) { this.smoothPivot.copy(this.pivot); this.init = true; }
    // Smooth vertical follow (steps, jumps); horizontal stays tight.
    this.smoothPivot.x = this.pivot.x;
    this.smoothPivot.z = this.pivot.z;
    this.smoothPivot.y = lerp(this.smoothPivot.y, this.pivot.y, damp(p.flying ? 20 : 12, dt));
    // Tunnels are narrow: cap the boom so the view stays over the shoulder.
    const want = Math.min(this.zoom * h * 1.1 + h * 0.4, this.underground ? Math.max(h * 1.6, 3.2) : Infinity);
    const dir = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), -Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    // Shoulder offset to the right for a cinematic view.
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const shoulder = this.zoom < 6 && !this.underground ? h * 0.18 : 0;
    const origin = this.smoothPivot.clone().addScaledVector(right, shoulder);
    // Collision: shorten the boom when something is in between (skip for giants vs small buildings).
    let maxD = want;
    if (this.solidAt) {
      // Dense enough that thin interior walls (tested within 0.12 m) can't be stepped over.
      const steps = Math.min(400, Math.max(40, Math.ceil(want / 0.08)));
      for (let i = 1; i <= steps; i++) {
        const t = (i / steps) * want;
        if (this.solidAt(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t)) { maxD = Math.max(h * 0.15, t - Math.max(0.15, h * 0.08)); break; }
      }
    } else {
      const hit = this.world.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, want, Math.max(0.2, want / 48));
      if (hit.t < want) maxD = Math.max(h * 0.3, hit.t - h * 0.15);
    }
    this.dist = maxD < this.dist ? maxD : lerp(this.dist, maxD, damp(3, dt));
    const camPos = origin.clone().addScaledVector(dir, this.dist);
    // Keep above the ground.
    if (!this.underground) {
      const g = this.world.terrain.height(camPos.x, camPos.z);
      if (camPos.y < g + h * 0.15 + 0.05) camPos.y = g + h * 0.15 + 0.05;
    }
    // Shake (decays).
    this.shake = Math.max(0, this.shake - dt * 1.8);
    // Big bodies shake slowly (like all their motion, by √size): a fast tremble on a giant's
    // view read as jittery animation.
    this.shakeT += (dt * 30) / Math.sqrt(Math.max(1, h / 1.8));
    if (this.shake > 0) {
      const s = this.shake * this.shake * h * 0.05;
      camPos.x += Math.sin(this.shakeT * 1.1) * s;
      camPos.y += Math.sin(this.shakeT * 1.7 + 1) * s;
      camPos.z += Math.sin(this.shakeT * 1.3 + 2) * s;
    }
    this.cam.position.copy(camPos);
    this.cam.lookAt(origin);
    // FOV widens with flight speed.
    const speed = p.vel.length() / Math.sqrt(p.k);
    // (Super speed on foot widens it more: everything else seems to stand still.)
    const targetFov = 60 + (p.flying ? clamp((speed - 20) / 140, 0, 1) * 22 : p.speeding ? clamp((speed - 8) / 90, 0, 1) * 28 : 0);
    this.fov = lerp(this.fov, targetFov, damp(2, dt));
    this.kickT += dt;
    const kt = this.kickT, kick = this.kickDeg * Math.min(1, kt / 0.06) * (kt < this.kickHold ? 1 : Math.exp(-(kt - this.kickHold) * 6));
    const fov = this.fov + (kick > 0.05 ? kick : 0);
    // Near/far planes follow the player's size (reversed depth keeps precision).
    const near = clamp(Math.min(h * 0.04, this.dist * 0.2), 0.004, 2);
    if (Math.abs(this.cam.near - near) > near * 0.05 || this.cam.fov !== fov) {
      this.cam.near = near;
      this.cam.far = 60000;
      this.cam.fov = fov;
      this.cam.updateProjectionMatrix();
    }
  }

  get forwardYaw(): number {
    return this.yaw;
  }
}
