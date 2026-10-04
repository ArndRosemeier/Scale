/**
 * Burning facades: fires set by a monster's breath (later by crashed helicopters, the army's
 * shells) that keep burning in windows and on walls for a minute or two — flames licking out,
 * smoke rising, now and then a window bursting from the heat. Drawn with the powers' particle pool
 * (ElementFx), no lights (the scene's light count stays constant). Water and frost put them out
 * (`douse`: hydrokinesis now, fire trucks in a later stage).
 *
 * Budget: ≤ 32 fires; particles per fire scale down with distance from the camera; one heat
 * impact per fire every few seconds at most.
 */
import * as THREE from 'three';
import type { ElementFx } from '../powers/ElementFx';
import type { Destruction } from '../../destruction/Destruction';

export interface FacadeFire {
  x: number; y: number; z: number;
  /** Outward normal of the wall (flames lean out of it). */
  nx: number; nz: number;
  /** Size (m) and life left (s). */
  size: number;
  life: number;
  heatT: number;
}

const MAX = 32;
const FLAME_A = new THREE.Color(2.2, 1.0, 0.22), FLAME_B = new THREE.Color(0.6, 0.1, 0.01);
const SMOKE_A = new THREE.Color(0.12, 0.11, 0.1), SMOKE_B = new THREE.Color(0.3, 0.29, 0.28);

export class FacadeFires {
  readonly list: FacadeFire[] = [];
  readonly stats = { lit: 0, doused: 0, windows: 0 };
  private emitAcc = 0;

  constructor(private fx: ElementFx, private destruction: Destruction, private camera: THREE.Camera) {}

  /** Set a wall burning at a point (a fire close by grows instead). */
  ignite(x: number, y: number, z: number, nx: number, nz: number, size = 3, life = 110): FacadeFire {
    for (const f of this.list) if (Math.hypot(f.x - x, f.y - y, f.z - z) < f.size * 1.2) { f.life = Math.max(f.life, life); f.size = Math.min(8, f.size + size * 0.25); return f; }
    if (this.list.length >= MAX) this.list.sort((a, b) => b.life - a.life).pop();
    const f: FacadeFire = { x, y, z, nx, nz, size, life, heatT: 2 + Math.random() * 4 };
    this.list.push(f);
    this.stats.lit++;
    return f;
  }

  /** Water / frost on a spot: fires within r die down (true if one was put out). */
  douse(x: number, y: number, z: number, r: number, amount = 8): boolean {
    let out = false;
    for (const f of this.list) {
      if (Math.hypot(f.x - x, f.y - y, f.z - z) > r + f.size) continue;
      f.life -= amount;
      if (f.life <= 0) { out = true; this.stats.doused++; }
      // Steam.
      this.fx.soft(f.x + f.nx * 0.4, f.y, f.z + f.nz * 0.4, f.nx, 2, f.nz, 1.5, f.size * 0.3, f.size * 1.2, SMOKE_B, SMOKE_B, 0.5, 0.8, -1);
    }
    return out;
  }

  /** Burning within r of a point? */
  burningNear(x: number, y: number, z: number, r: number): number {
    let n = 0;
    for (const f of this.list) if (Math.hypot(f.x - x, f.y - y, f.z - z) < r + f.size) n++;
    return n;
  }

  update(dt: number): void {
    if (!this.list.length) return;
    const c = this.camera.position;
    this.emitAcc += dt * 60;
    const ticks = Math.floor(this.emitAcc);
    this.emitAcc -= ticks;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const f = this.list[i];
      f.life -= dt;
      if (f.life <= 0) { this.list.splice(i, 1); continue; }
      const d = Math.hypot(f.x - c.x, f.y - c.y, f.z - c.z);
      // Fewer, bigger puffs far away; nothing beyond 900 m.
      const per = d > 900 ? 0 : d > 400 ? 0.25 : d > 150 ? 0.6 : 1.2;
      const grow = Math.min(1, f.life / 15) * f.size;
      for (let k = 0; k < ticks; k++) {
        if (Math.random() > per) continue;
        const ox = (Math.random() - 0.5) * grow, oy = (Math.random() - 0.5) * grow * 0.6;
        const sx = -f.nz * ox, sz = f.nx * ox;
        this.fx.glow(f.x + sx + f.nx * 0.3, f.y + oy, f.z + sz + f.nz * 0.3, f.nx * 1.5 + (Math.random() - 0.5), 2.5 + Math.random() * 2.5, f.nz * 1.5 + (Math.random() - 0.5),
          0.6 + Math.random() * 0.5, grow * 0.35, grow * 0.6, FLAME_A, FLAME_B, 0.7, 1.5, -3);
        if (Math.random() < 0.35) this.fx.soft(f.x + sx + f.nx * 0.8, f.y + grow * 0.5, f.z + sz + f.nz * 0.8, f.nx * 0.8, 3 + Math.random() * 2, f.nz * 0.8,
          3 + Math.random() * 2, grow * 0.5, grow * 2.4, SMOKE_A, SMOKE_B, 0.55, 0.4, -0.6);
      }
      // Now and then the heat bursts a window or cracks a panel.
      f.heatT -= dt;
      if (f.heatT <= 0) {
        f.heatT = 4 + Math.random() * 6;
        const n = this.destruction.as('fire', () => this.destruction.impact(f.x - f.nx * 0.3, f.y + (Math.random() - 0.3) * f.size, f.z - f.nz * 0.3, f.size * 0.6, 9000 * f.size, -f.nx, 0, -f.nz, 'wall'));
        if (n) this.stats.windows += n;
      }
    }
  }
}
