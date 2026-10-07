/**
 * Raising (tier 2, the necromancers' operation — VILLAINS_PLAN §3.9). Two or three of them kneel
 * in a ring on open ground among the trees of a park (or before an old landmark, or by an old
 * wall) and chant; the ground churns and skeletons claw their way out one by one, to stand guard
 * round them. Left alone for RAISING.chantFor seconds it is done: the last of the dead rise and
 * the band moves off into the night. Caught at it, the circle breaks, the dead fight for them.
 *
 * Nobody who went down in the game is ever raised: these are the city's old dead (the plan's
 * no-death rule). Hit hard enough a skeleton falls apart and pulls itself together again while
 * a necromancer of theirs still stands; with the circle beaten, the bones sink back into the
 * ground (CrimeSystem: `risen`, `crumble`).
 */
import type { CrimeWorld } from './Crime';
import { Channeling, type OpLook } from './Channeling';
import type { PedAgent } from '../../sim/Pedestrians';

export const RAISING = { ringMin: 70, ringMax: 320, hp: 48, strength: 0.9, chantFor: 32, approachTimeout: 80, noticeR: 22, radius: 2.1, moanEvery: 4, rise: 3, riseAtEnd: 2, riseR: [3.5, 7] as [number, number] };

export class Raising extends Channeling {
  readonly kind = 'raising' as const;
  readonly tier = 2;
  /** Skeletons raised so far. */
  risen = 0;
  private moanT = 0;

  constructor(w: CrimeWorld, seed: number, near: { x: number; z: number } | null = null) {
    super(w, seed, near, { workFor: RAISING.chantFor, approachTimeout: RAISING.approachTimeout, noticeR: RAISING.noticeR, hp: RAISING.hp, strength: RAISING.strength, high: false });
  }

  protected get look(): OpLook { return 'grave'; }

  /** The members raised from the dead. */
  get skeletons(): PedAgent[] { return this.criminals.filter((c) => c.actor?.memo.skel); }

  protected place(): boolean {
    const rMin = this.near ? 0 : RAISING.ringMin, rMax = this.near ? 90 : RAISING.ringMax;
    // A cemetery, else open ground among trees (a park), else before a landmark, else by a wall.
    let spots = this.w.cemeteries?.(rMin, rMax) ?? [];
    if (spots.length) spots = [spots[0]];
    else spots = (this.w.trees?.(rMin, rMax) ?? []).map((t) => ({ x: t.x + t.nx * 5, z: t.z + t.nz * 5, nx: t.nx, nz: t.nz }));
    if (!spots.length) spots = this.w.landmarks?.(rMin, rMax) ?? [];
    if (!spots.length) spots = (this.w.walls?.(rMin, rMax) ?? []).map((s) => ({ x: s.x + s.nx * 5, z: s.z + s.nz * 5, nx: s.nx, nz: s.nz }));
    spots = spots.filter((s) => !this.w.blocked?.(s.x, s.z));
    if (!spots.length) return false;
    const s = spots[this.rng.int(0, Math.min(spots.length, 6) - 1)];
    this.site = { ...s };
    const n = this.rng.chance(0.4) ? 3 : 2, a0 = this.rng.float() * Math.PI * 2;
    const from = Math.atan2(-s.nx, -s.nz) + (this.rng.float() - 0.5) * 1.5;
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * Math.PI * 2;
      this.member(s.x + Math.sin(a) * RAISING.radius, s.z + Math.cos(a) * RAISING.radius, from, true, i);
    }
    return this.criminals.filter((c) => c.actor!.memo.work).length >= 2;
  }

  protected working(dt: number): void {
    // The dead rise as the chant goes on.
    if (this.risen < Math.min(RAISING.rise, Math.floor(this.share * (RAISING.rise + 1)))) this.raiseOne();
    this.moanT -= dt;
    if (this.moanT > 0) return;
    this.moanT = RAISING.moanEvery * (0.7 + this.rng.float() * 0.6);
    const S = this.site!;
    this.w.sound(this.rng.chance(0.5) ? 'deep_murk' : 'deep_glow', S.x, 1, S.z, 0.4 + this.share * 0.3, 0.55 + this.share * 0.2);
  }

  protected finished(): void {
    for (let i = 0; i < RAISING.riseAtEnd; i++) this.raiseOne();
  }

  /** A skeleton claws out of the ground in the ring round the circle. */
  private raiseOne(): void {
    const S = this.site!;
    this.risen++;
    for (let k = 0; k < 6; k++) {
      const a = this.rng.float() * Math.PI * 2, r = RAISING.riseR[0] + this.rng.float() * (RAISING.riseR[1] - RAISING.riseR[0]);
      const x = S.x + Math.sin(a) * r, z = S.z + Math.cos(a) * r;
      if (this.w.blocked?.(x, z)) continue;
      const c = this.raiseDead(x, z, Math.atan2(x - S.x, z - S.z));
      if (c) { c.actor!.hostile = true; c.actor!.memo.postX = x; c.actor!.memo.postZ = z; }
      return;
    }
  }
}
