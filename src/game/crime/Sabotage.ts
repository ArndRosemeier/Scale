/**
 * Sabotage (tier 2, the eco-radicals' operation — VILLAINS_PLAN §2/§3.2). Two or three of them
 * go for the street's machines: a delivery robot at the kerb, else a parked car, else a shop
 * front. They hack at it with crowbars — sparks, glass, leaves blowing about — while one or two
 * watch the street. Left alone for SABOTAGE.wreckFor seconds it is done: the machines round about
 * are wrecked, tyres slashed, the lamps knocked out and the pavement planted over with moss and
 * creepers (the world's `sabotage`); caught at it, they break off.
 */
import type { CrimeWorld } from './Crime';
import { Channeling, type OpLook } from './Channeling';

export const SABOTAGE = { ringMin: 70, ringMax: 320, hp: 55, strength: 1, wreckFor: 14, approachTimeout: 70, noticeR: 18, reach: 10, clangEvery: 1.4 };

export class Sabotage extends Channeling {
  readonly kind = 'sabotage' as const;
  readonly tier = 2;
  /** What they went for (the world wrecks it first). */
  target: 'robot' | 'car' | 'shop' = 'shop';
  private clangT = 0;

  constructor(w: CrimeWorld, seed: number, near: { x: number; z: number } | null = null) {
    super(w, seed, near, { workFor: SABOTAGE.wreckFor, approachTimeout: SABOTAGE.approachTimeout, noticeR: SABOTAGE.noticeR, hp: SABOTAGE.hp, strength: SABOTAGE.strength, high: false });
  }

  protected get look(): OpLook { return 'wreck'; }

  protected place(): boolean {
    const rMin = this.near ? 0 : SABOTAGE.ringMin, rMax = this.near ? 90 : SABOTAGE.ringMax;
    // A robot at the kerb, else a parked car, else a shop front (smash the windows, glue the locks).
    let spots: { x: number; z: number; nx: number; nz: number }[] = this.w.machines?.(rMin, rMax) ?? [];
    this.target = 'robot';
    if (!spots.length) { spots = this.w.parked?.(rMin, rMax) ?? []; this.target = 'car'; }
    if (!spots.length) { spots = (this.w.shops?.(rMin, rMax) ?? []).map((s) => ({ x: s.x + s.nx * 1.2, z: s.z + s.nz * 1.2, nx: s.nx, nz: s.nz })); this.target = 'shop'; }
    if (!spots.length) return false;
    const s = spots[this.rng.int(0, Math.min(spots.length, 6) - 1)];
    this.site = { ...s };
    const ax = -s.nz, az = s.nx, from = Math.atan2(ax, az) + (this.rng.chance(0.5) ? 0 : Math.PI);
    // Wreckers at it (either side), a lookout or two out in the street.
    const nWork = this.rng.chance(0.5) ? 2 : 1, nGuard = this.rng.chance(0.6) ? 2 : 1;
    for (let i = 0; i < nWork; i++) {
      const side = i === 0 ? 1 : -1;
      this.member(s.x + ax * side * 1.1 + s.nx * 0.6, s.z + az * side * 1.1 + s.nz * 0.6, from, true, i);
    }
    for (let i = 0; i < nGuard; i++) {
      const side = i === 0 ? -1 : 1;
      this.member(s.x + s.nx * 5 + ax * side * 3, s.z + s.nz * 5 + az * side * 3, from, false, nWork + i);
    }
    return this.criminals.some((c) => c.actor!.memo.work);
  }

  protected working(dt: number): void {
    this.clangT -= dt;
    if (this.clangT > 0) return;
    this.clangT = SABOTAGE.clangEvery * (0.7 + this.rng.float() * 0.6);
    const S = this.site!;
    this.w.sound(this.target === 'shop' || this.rng.chance(0.3) ? 'glass_shatter' : 'metal_bend', S.x, 0.8, S.z, 0.45, 0.9 + this.rng.float() * 0.4);
  }

  protected finished(): void {
    const S = this.site!;
    this.w.sabotage?.(this, S.x, S.z);
  }
}
