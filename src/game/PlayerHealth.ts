/**
 * The player's health (PLAYGROUND_PLAN §0 decision 3): criminals punch and stab back, cars,
 * falls from height and collapses hurt. Health regenerates out of combat; a heavy blow knocks
 * the player down for a moment; at zero the player is knocked out: a short fade, waking up
 * where they fell with some health back, at a small karma / reputation cost (or, when the
 * police took them down, arrested — handled by the justice layer through `onKnockout`).
 *
 * Super strength makes the body tougher, size scales damage by mass (a giant shrugs off a
 * mugger's knife). Sandbox: invulnerable by default (toggle in the pause menu).
 */
import type { Player } from '../player/Player';

export type HurtKind = 'punch' | 'knife' | 'bat' | 'car' | 'fall' | 'collapse' | 'police' | 'robot' | 'monster' | 'military' | 'gun';

export const HEALTH = {
  max: 100,
  /** Extra maximum per rank of super strength. */
  perStrength: 30,
  /** Regeneration (hp/s) after `regenDelay` seconds without damage. */
  regen: 7,
  regenDelay: 6,
  /** One hit of at least this much knocks the player down for `downTime` seconds. */
  knockAt: 22,
  downTime: 1.6,
  /** Falls: no damage below this landing speed (m/s at 1.8 m, × √k); damage per m/s above. */
  fallSafe: 10.5,
  fallPerMs: 9,
  /** Knocked out: fade time (s) and the health one wakes up with (share of max). */
  koTime: 3.2,
  wakeShare: 0.6,
};

export class PlayerHealth {
  hp = HEALTH.max;
  /** Invulnerable (sandbox default). */
  invulnerable: boolean;
  /** Seconds since the last damage. */
  sinceHurt = 999;
  /** Knocked out: seconds left until waking up (0 = awake). */
  koT = 0;
  /** Strength rank (super strength), set by the game every frame. */
  strengthRank = 0;
  /** Recent hurt flash 0..1 (HUD vignette). */
  flash = 0;
  onHurt: ((dmg: number, kind: HurtKind, fromX: number, fromZ: number) => void) | null = null;
  /** Health reached zero (the game fades and wakes the player). */
  onKnockout: ((kind: HurtKind) => void) | null = null;
  onWake: (() => void) | null = null;
  private lastKind: HurtKind = 'punch';

  constructor(private player: Player, sandbox: boolean) {
    this.invulnerable = sandbox;
  }

  get max(): number { return HEALTH.max + HEALTH.perStrength * this.strengthRank; }
  get frac(): number { return this.hp / this.max; }
  get down(): boolean { return this.koT > 0; }
  /** In a fight recently (no regeneration yet). */
  get inCombat(): boolean { return this.sinceHurt < HEALTH.regenDelay; }

  /** Damage before size: a body k times taller has k³ the mass and shrugs off proportionally more. */
  damage(dmg: number, kind: HurtKind, fromX = this.player.pos.x, fromZ = this.player.pos.z): number {
    if (this.invulnerable || this.koT > 0 || dmg <= 0) return 0;
    const k = this.player.k;
    const d = dmg / Math.max(0.05, k ** 3);
    if (d < 0.5) return 0;
    this.hp = Math.max(0, this.hp - d);
    this.sinceHurt = 0;
    this.flash = Math.min(1, this.flash + 0.35 + d / 40);
    this.lastKind = kind;
    this.onHurt?.(d, kind, fromX, fromZ);
    const p = this.player;
    if (this.hp <= 0) {
      this.koT = HEALTH.koTime;
      p.downT = HEALTH.koTime + 0.6;
      this.onKnockout?.(kind);
    } else if (d >= HEALTH.knockAt && !p.flying) {
      p.downT = Math.max(p.downT, HEALTH.downTime);
      // Pushed away from the blow.
      const dx = p.pos.x - fromX, dz = p.pos.z - fromZ, l = Math.hypot(dx, dz) || 1;
      p.vel.x += (dx / l) * 2.5; p.vel.z += (dz / l) * 2.5;
    }
    return d;
  }

  /** A landing (Player.events.onLand): energy in J. Super jump landings are safe. */
  land(energy: number, leap: boolean): void {
    if (leap || this.player.flying) return;
    const v = Math.sqrt((2 * energy) / Math.max(1, this.player.mass));
    const safe = HEALTH.fallSafe * Math.sqrt(this.player.k);
    if (v > safe) this.damage((v - safe) * HEALTH.fallPerMs * this.player.k ** 3, 'fall');
  }

  update(dt: number): void {
    this.sinceHurt += dt;
    this.flash = Math.max(0, this.flash - dt * 1.4);
    if (this.hp > this.max) this.hp = this.max;
    if (this.koT > 0) {
      this.koT -= dt;
      if (this.koT <= 0) {
        this.koT = 0;
        this.hp = Math.max(this.hp, this.max * HEALTH.wakeShare);
        this.sinceHurt = HEALTH.regenDelay;
        this.onWake?.();
      }
      return;
    }
    if (this.sinceHurt > HEALTH.regenDelay && this.hp < this.max) this.hp = Math.min(this.max, this.hp + HEALTH.regen * dt * (1 + this.strengthRank * 0.2));
  }

  get lastHurt(): HurtKind { return this.lastKind; }

  /** Full health (respawn, sandbox toggle). */
  reset(): void { this.hp = this.max; this.koT = 0; this.flash = 0; }
}
