/**
 * Ritual (tier 2, the elemental cult's operation — VILLAINS_PLAN §3.2/§3.7). Three or four robed
 * cultists stand in a circle before a landmark (or on a quiet stretch of pavement) and chant, arms
 * raised: a ring of runes kindles on the ground and a column of their element (fire, frost, a
 * storm) rises from the centre, brighter as it goes on. Left alone for RITUAL.chantFor seconds it
 * is complete — a burst of the element knocks back whoever stands near, and the cult's hold on the
 * district grows; caught at it, the circle breaks and it is never finished.
 */
import type { CrimeWorld } from './Crime';
import { Channeling, type OpLook } from './Channeling';

export const RITUAL = { ringMin: 70, ringMax: 320, hp: 50, strength: 0.95, chantFor: 30, approachTimeout: 80, noticeR: 20, radius: 2.3, humEvery: 4.5 };

export type RitualElement = 'fire' | 'frost' | 'storm';

export class Ritual extends Channeling {
  readonly kind = 'ritual' as const;
  readonly tier = 2;
  /** The cult's element (CrimeSystem sets it from the group's colours). */
  element: RitualElement;
  private humT = 0;

  constructor(w: CrimeWorld, seed: number, near: { x: number; z: number } | null = null) {
    super(w, seed, near, { workFor: RITUAL.chantFor, approachTimeout: RITUAL.approachTimeout, noticeR: RITUAL.noticeR, hp: RITUAL.hp, strength: RITUAL.strength, high: true });
    this.element = (['fire', 'frost', 'storm'] as const)[this.rng.int(0, 2)];
  }

  protected get look(): OpLook { return this.element; }

  protected place(): boolean {
    const rMin = this.near ? 0 : RITUAL.ringMin, rMax = this.near ? 90 : RITUAL.ringMax;
    // Before a landmark, else on the pavement in front of a wall.
    let spots = this.w.landmarks?.(rMin, rMax) ?? [];
    if (!spots.length) spots = (this.w.walls?.(rMin, rMax) ?? this.w.shops?.(rMin, rMax) ?? []).map((s) => ({ x: s.x + s.nx * 4, z: s.z + s.nz * 4, nx: s.nx, nz: s.nz }));
    if (!spots.length) return false;
    const s = spots[this.rng.int(0, Math.min(spots.length, 6) - 1)];
    this.site = { ...s };
    const n = this.rng.chance(0.5) ? 4 : 3, a0 = this.rng.float() * Math.PI * 2;
    const from = Math.atan2(-s.nx, -s.nz) + (this.rng.float() - 0.5) * 1.5;
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * Math.PI * 2;
      this.member(s.x + Math.sin(a) * RITUAL.radius, s.z + Math.cos(a) * RITUAL.radius, from, true, i);
    }
    // Most circles have one of them on watch, a little way off.
    if (this.rng.chance(0.6)) this.member(s.x + s.nx * 6, s.z + s.nz * 6, from, false, n);
    return this.criminals.filter((c) => c.actor!.memo.work).length >= 2;
  }

  protected working(dt: number): void {
    this.humT -= dt;
    if (this.humT > 0) return;
    this.humT = RITUAL.humEvery;
    const S = this.site!;
    this.w.sound(this.element === 'frost' ? 'lumen_chime' : 'deep_glow', S.x, 1.5, S.z, 0.4 + this.share * 0.4, 0.55 + this.share * 0.35);
  }

  protected finished(): void {
    const S = this.site!;
    this.w.ritual?.(this, S.x, S.z, this.element);
  }
}
