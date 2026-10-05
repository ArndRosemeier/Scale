/**
 * Robot hijack (tier 2, the techno-cult's operation — VILLAINS_PLAN §3.2/§3.7). Two or three
 * cultists walk up to the street's delivery robots (or a shop the robots roll out of); one or two
 * jack into a robot's service port and work at it — sparks, a blue glow, glitch chirps — while the
 * others watch the street. Left alone for HIJACK.hackFor seconds the hack goes through: the robots,
 * service robots and drones round about turn on the street (the world's `hijack`, a RogueOwner of
 * its own) and the cultists slip away; the machines run riot until the city cuts them off, or
 * until the hackers are stopped (then they go dark). Caught at it, the hack is broken off.
 */
import type { CrimeWorld } from './Crime';
import { Channeling, type OpLook } from './Channeling';

export const HIJACK = { ringMin: 70, ringMax: 320, hp: 55, strength: 1, hackFor: 11, approachTimeout: 70, noticeR: 18, machines: [4, 6], chirpEvery: 2.6 };

export class Hijack extends Channeling {
  readonly kind = 'hijack' as const;
  readonly tier = 2;
  private chirpT = 0;

  constructor(w: CrimeWorld, seed: number, near: { x: number; z: number } | null = null) {
    super(w, seed, near, { workFor: HIJACK.hackFor, approachTimeout: HIJACK.approachTimeout, noticeR: HIJACK.noticeR, hp: HIJACK.hp, strength: HIJACK.strength, high: false });
  }

  protected get look(): OpLook { return 'hack'; }

  protected place(): boolean {
    const rMin = this.near ? 0 : HIJACK.ringMin, rMax = this.near ? 90 : HIJACK.ringMax;
    // A robot at the kerb, else a shop door (where the delivery robots come and go).
    const spots: { x: number; z: number; nx: number; nz: number }[] = this.w.machines?.(rMin, rMax) ?? [];
    if (!spots.length) spots.push(...(this.w.shops?.(rMin, rMax) ?? []).map((s) => ({ x: s.x + s.nx * 1.5, z: s.z + s.nz * 1.5, nx: s.nx, nz: s.nz })));
    if (!spots.length) return false;
    const s = spots[this.rng.int(0, Math.min(spots.length, 6) - 1)];
    this.site = { ...s };
    const ax = -s.nz, az = s.nx, from = Math.atan2(ax, az) + (this.rng.chance(0.5) ? 0 : Math.PI);
    // Hackers kneel at the port (either side), guards a few metres out, watching the street.
    const nHack = this.rng.chance(0.4) ? 2 : 1, nGuard = this.rng.chance(0.5) ? 2 : 1;
    for (let i = 0; i < nHack; i++) {
      const side = i === 0 ? 1 : -1;
      this.member(s.x + ax * side * 0.9 + s.nx * 0.5, s.z + az * side * 0.9 + s.nz * 0.5, from, true, i);
    }
    for (let i = 0; i < nGuard; i++) {
      const side = i === 0 ? -1 : 1;
      this.member(s.x + s.nx * 4.5 + ax * side * 3.5, s.z + s.nz * 4.5 + az * side * 3.5, from, false, nHack + i);
    }
    return this.criminals.some((c) => c.actor!.memo.work);
  }

  protected working(dt: number): void {
    this.chirpT -= dt;
    if (this.chirpT > 0) return;
    this.chirpT = HIJACK.chirpEvery * (0.7 + this.rng.float() * 0.6);
    const S = this.site!;
    this.w.sound(this.rng.chance(0.5) ? 'robot_glitch' : 'deep_glow', S.x, 0.6, S.z, 0.45, 1.3 + this.share * 0.5);
  }

  protected finished(): void {
    const S = this.site!;
    this.w.hijack?.(this, S.x, S.z, this.rng.int(HIJACK.machines[0], HIJACK.machines[1]));
  }
}
