/**
 * Villain powers (VILLAINS_PLAN §3.4, Phase 3): the actor-agnostic caster core. A caster is anyone
 * with a few powers — a group's lieutenant today, cultists and bosses later. The core decides what
 * to cast and when, and runs the cast's three stages; what a power does to the world (beams,
 * orbs, cracks, flashes, damage) is the caller's (crime/VillainCasts), so it runs headless in tests.
 *
 *   begin    the world grants a cast slot (≤ CASTERS.maxCasting at once) and the aim is fixed
 *   tell     the wind-up: glow on the hands, a cast pose, a sound — long enough to dodge
 *   release  the power goes off at the fixed aim (a side step during the tell gets clear)
 *   hold     lasting powers (shield, dash) run on the caster for a while after the release
 *
 * Fairness: every power has a tell, a cooldown and damage sized against the player's 100 hp (a
 * lieutenant alone cannot knock out a hero who keeps moving). Pure (no three.js, no DOM).
 */
import type { Rng } from '../../core/rng';

export type VillainPower = 'bolt' | 'fireball' | 'frost' | 'gust' | 'quake' | 'dash' | 'shield' | 'stun' | 'smoke' | 'emp';

export interface PowerDef {
  /** Wind-up (s): the tell. */
  windup: number;
  /** Seconds before the same power again. */
  cooldown: number;
  /** Used against a target this far away (m). */
  min: number; max: number;
  /** Damage to the player on a clean hit (before size). */
  dmg: number;
  /** Area of effect (m), or the hit width of a beam. */
  radius: number;
  /** How long a lasting power runs on the caster after the release (s). */
  hold: number;
  /** The pose of the wind-up (an actor action). */
  pose: string;
  /** Glow on the hands during the tell (linear RGB, >1 glows). */
  tell: [number, number, number];
  /** Sound of the tell and of the release (public/sounds ids), and the release's pitch. */
  tellSound: string; sound: string; pitch?: number;
}

export const VILLAIN_POWERS: Record<VillainPower, PowerDef> = {
  /** Lightning from the hand: instant along the fixed aim; a step aside during the crackle dodges it. */
  bolt: { windup: 0.8, cooldown: 6, min: 3, max: 22, dmg: 14, radius: 1.1, hold: 0, pose: 'cast_forward', tell: [1.2, 1.6, 3], tellSound: 'deep_glow', sound: 'thunder_near' },
  /** A ball of fire that flies to where the target stood and bursts. */
  fireball: { windup: 0.9, cooldown: 8, min: 6, max: 26, dmg: 18, radius: 3.2, hold: 0, pose: 'cast_forward', tell: [3, 1.2, 0.2], tellSound: 'deep_glow', sound: 'explosion', pitch: 1.2 },
  /** A frost ray along the fixed aim: hurts a little and chills (slow) for a few seconds. */
  frost: { windup: 0.75, cooldown: 7, min: 3, max: 20, dmg: 9, radius: 1.1, hold: 0.45, pose: 'cast_forward', tell: [1.2, 1.9, 2.6], tellSound: 'lumen_chime', sound: 'shrink_whoosh' },
  /** A blast of wind in a cone: shoves, barely hurts. */
  gust: { windup: 0.6, cooldown: 7, min: 0, max: 9, dmg: 4, radius: 0.6, hold: 0, pose: 'cast_forward', tell: [1.6, 1.7, 1.6], tellSound: 'amb_wind_gust', sound: 'whoosh_takeoff' },
  /** A stomp: a crack runs along the ground to the target, knocking down whoever stands on it. */
  quake: { windup: 0.95, cooldown: 9, min: 2, max: 13, dmg: 15, radius: 1.5, hold: 0, pose: 'slam', tell: [2, 1.3, 0.5], tellSound: 'grow_rumble', sound: 'murk_slam' },
  /** A shoulder charge: a brace, then a rush at where the target stood. */
  dash: { windup: 0.6, cooldown: 7, min: 4, max: 14, dmg: 20, radius: 1.3, hold: 0.85, pose: 'block', tell: [1.8, 1.4, 1.0], tellSound: 'shout_hey', sound: 'dash_whoosh' },
  /** A shimmering bubble: blows barely hurt for a few seconds. */
  shield: { windup: 0.35, cooldown: 14, min: 0, max: 12, dmg: 0, radius: 1.1, hold: 4, pose: 'cast_self', tell: [1.4, 1.8, 2.4], tellSound: 'deep_glow', sound: 'membrane' },
  /** A stun grenade: lobbed, a short fuse, a white flash that knocks the target down for a moment. */
  stun: { windup: 0.55, cooldown: 10, min: 5, max: 18, dmg: 5, radius: 5.5, hold: 0, pose: 'throw', tell: [2, 2, 2], tellSound: 'cuffs', sound: 'explosion', pitch: 1.9 },
  /** An electromagnetic pulse at the target: cars stall, drones drop, the hero takes a jolt and is slowed for a moment. */
  emp: { windup: 0.85, cooldown: 11, min: 4, max: 20, dmg: 7, radius: 6, hold: 0, pose: 'cast_up', tell: [0.9, 1.5, 3], tellSound: 'deep_glow', sound: 'thunder_far', pitch: 1.4 },
  /** A smoke bomb at their own feet: a cloud to slip away in. */
  smoke: { windup: 0.3, cooldown: 40, min: 0, max: 60, dmg: 0, radius: 6, hold: 0, pose: 'throw', tell: [1, 1, 1], tellSound: 'cuffs', sound: 'spray_hiss', pitch: 0.55 },
};

export const CASTERS = {
  /** Casts in their wind-up or release at once, city-wide (VILLAINS_PLAN §5: ≤ 3 casters). */
  maxCasting: 3,
  /** Seconds before a fresh caster's first power (they square up first). */
  firstDelay: 1.6,
  /** Shield: share of damage that gets through. */
  shieldTakes: 0.15,
  /** Chilled by frost: seconds of slow, and the speed share left. */
  chill: 3, chillSpeed: 0.55,
  /** Dash speed (m/s). */
  dashSpeed: 11,
  /** Stun: seconds down. */
  stunDown: 1.4,
  /** Fireball flight speed (m/s); quake crack speed (m/s). */
  orbSpeed: 20, crackSpeed: 15,
};

/** What a caster knows when it picks a power. */
export interface CastContext {
  /** Distance to the target (m). */
  dist: number;
  /** Its own health share (0..1). */
  hp: number;
  /** On the run (only an escape gadget then). */
  fleeing: boolean;
  /** The target is down already (no point). */
  targetDown: boolean;
  /** Clear line to the target (beams and orbs need one). */
  clear: boolean;
}

export interface Cast {
  power: VillainPower;
  /** Seconds since it began. */
  t: number;
  /** The fixed aim. */
  tx: number; ty: number; tz: number;
  stage: 'tell' | 'hold';
}

/** Powers that need a clear line to the target. */
const LINE: readonly VillainPower[] = ['bolt', 'fireball', 'frost', 'gust', 'dash'];

export class Caster {
  /** Seconds until each power can be used again. */
  readonly cd = new Map<VillainPower, number>();
  cast: Cast | null = null;
  /** Casts made (tests, dev). */
  made = 0;

  constructor(readonly powers: readonly VillainPower[], readonly rng: Rng) {
    for (const p of powers) this.cd.set(p, CASTERS.firstDelay + rng.float() * 1.2);
  }

  get busy(): boolean { return !!this.cast; }

  /** Running a lasting power (shield, dash) on the caster after its release. */
  holding(p: VillainPower): boolean { return this.cast?.power === p && this.cast.stage === 'hold'; }

  /** Cooldowns run. */
  tick(dt: number): void {
    for (const [p, v] of this.cd) if (v > 0) this.cd.set(p, v - dt);
  }

  /** The power that fits now (null: none ready / none fits). Seeded choice among the ready ones. */
  choose(c: CastContext): VillainPower | null {
    if (this.cast || c.targetDown) return null;
    const ok: VillainPower[] = [];
    for (const p of this.powers) {
      if ((this.cd.get(p) ?? 0) > 0) continue;
      const P = VILLAIN_POWERS[p];
      if (c.fleeing) { if (p === 'smoke') ok.push(p); continue; }
      if (p === 'smoke') continue;
      if (p === 'shield') { if (c.hp < 0.75 || c.dist < 5) ok.push(p); continue; }
      if (c.dist < P.min || c.dist > P.max) continue;
      if (LINE.includes(p) && !c.clear) continue;
      ok.push(p);
    }
    if (!ok.length) return null;
    return ok[this.rng.int(0, ok.length - 1)];
  }

  /** Start a cast at a fixed aim (the world has granted the slot). */
  begin(p: VillainPower, tx: number, ty: number, tz: number): Cast {
    this.cast = { power: p, t: 0, tx, ty, tz, stage: 'tell' };
    this.cd.set(p, VILLAIN_POWERS[p].cooldown);
    this.made++;
    return this.cast;
  }

  /**
   * Advance the cast: 'release' once when the wind-up ends, 'end' once when it is over (after the
   * hold of a lasting power), else null.
   */
  step(dt: number): 'release' | 'end' | null {
    const C = this.cast;
    if (!C) return null;
    C.t += dt;
    const P = VILLAIN_POWERS[C.power];
    if (C.stage === 'tell') {
      if (C.t < P.windup) return null;
      if (P.hold > 0) { C.stage = 'hold'; C.t = 0; return 'release'; }
      this.cast = null;
      return 'release';
    }
    if (C.t >= P.hold) { this.cast = null; return 'end'; }
    return null;
  }

  /** Interrupted (knocked down, staggered in the wind-up): the power fizzles, the cooldown stays. */
  interrupt(): void { this.cast = null; }
}

/** Distance from a point to a segment in the ground plane (a beam's or a crack's hit test). */
export function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
  const u = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2)) : 0;
  return Math.hypot(px - (ax + dx * u), pz - (az + dz * u));
}
