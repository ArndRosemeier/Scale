/**
 * A brood creature as something to target (Arnd 2026-10-09: "swarm critters are not targettable"):
 * a small ThreatActor (`swarm: true`) wrapped round one Critter, so Tab, clicks, map markers and the
 * single-target powers treat it as a monster — a foe for the friend/foe sense, damage through
 * `damage` like any big threat. One per critter (Brood.actorOf), never listed in ThreatDirector.actors()
 * (they are not big threats: no monster grace, no army, no airstrike).
 *
 * Damage arrives in monster points (Strider: 3000); a critter's hit points are on the scale of
 * Game.strike's brood blows (J / 150 against the monsters' J / 1500), so points × HP_PER_POINT.
 *
 * No three.js: usable in headless tests.
 */
import { BROOD_KINDS, CMode, type BroodSim, type Critter, type HitEffect } from './BroodSim';
import type { DamageResult, DamageSource, ThreatActor, ThreatZone } from '../ThreatEvent';

/** Critter hit points per monster damage point. */
export const HP_PER_POINT = 10;

/** What a hit on one critter goes through (Brood: the sim, the chitin bits). */
export interface CritterOwner {
  readonly sim: BroodSim;
  hitOne(c: Critter, effect: HitEffect, dmg: number, fling: number, cause: string, fromX: number, fromZ: number): void;
}

const NO_AGGRO: ReadonlyMap<string, number> = new Map();
const ELEMENT: Record<'fire' | 'frost' | 'shock' | 'wind', HitEffect> = { fire: 'fire', frost: 'frost', shock: 'shock', wind: 'wind' };

export class CritterActor implements ThreatActor {
  readonly swarm = true;
  readonly name: string;
  readonly maxHp: number;
  private readonly zone: ThreatZone;
  /** The element of the power landing now (onElement comes just before damage). */
  private fx: HitEffect = 'blow';

  constructor(readonly owner: CritterOwner, readonly c: Critter) {
    this.name = c.kind === 1 ? 'Brood beast' : 'Brood creature';
    this.maxHp = BROOD_KINDS[c.kind].hp;
    this.zone = { id: 'body', name: 'Body', armour: 0, weak: false, exposed: false, x: c.x, y: c.y, z: c.z, r: this.r, recent: 0 };
  }

  get hp(): number { return Math.max(0, this.c.hp); }
  get defeated(): boolean { return this.c.mode === CMode.Dead || this.c.mode === CMode.Gone; }
  /** Out of the hole and alive (running, on a wall, frozen, or fleeing back to a hole). */
  get targetable(): boolean { const m = this.c.mode; return m === CMode.Run || m === CMode.Wall || m === CMode.Frozen || m === CMode.Leave; }
  get x(): number { return this.c.x; }
  get y(): number { return this.c.y + this.c.size * 0.2; }
  get z(): number { return this.c.z; }
  get height(): number { return this.c.size * 0.45; }
  get size(): number { return this.c.size; }
  /** Body radius (a little generous: they are small and fast). */
  get r(): number { return this.c.size * 0.45; }
  get zones(): readonly ThreatZone[] {
    const z = this.zone;
    z.x = this.x; z.y = this.y; z.z = this.z; z.r = this.r;
    return [z];
  }
  get aggro(): ReadonlyMap<string, number> { return NO_AGGRO; }
  get vx(): number { return this.c.vx; }
  get vz(): number { return this.c.vz; }

  ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): { t: number; zone: ThreatZone } | null {
    // A sphere round the body centre.
    const px = ox - this.x, py = oy - this.y, pz = oz - this.z, r = this.r;
    const b = px * dx + py * dy + pz * dz, c = px * px + py * py + pz * pz - r * r;
    const disc = b * b - c;
    if (disc < 0) return null;
    const s = Math.sqrt(disc);
    let t = -b - s;
    if (t < 0) t = -b + s;
    if (t < 0 || t > maxT) return null;
    return { t: c < 0 ? 0 : t, zone: this.zones[0] };
  }

  zoneAt(x: number, y: number, z: number): { zone: ThreatZone; d: number } | null {
    return { zone: this.zones[0], d: Math.max(0, Math.hypot(x - this.x, y - this.y, z - this.z) - this.r) };
  }

  damage(_zone: ThreatZone | string | null, amount: number, src: DamageSource): DamageResult {
    const fx = this.fx;
    this.fx = 'blow';
    if (amount <= 0 || !this.targetable) return { dealt: 0, zone: this.zone, weak: false };
    const hp = this.c.hp;
    this.owner.hitOne(this.c, fx, amount * HP_PER_POINT, fx === 'blow' ? 4 : 2, src.cause, src.x ?? this.c.x, src.z ?? this.c.z);
    return { dealt: Math.max(0, Math.min(hp, amount * HP_PER_POINT)) / HP_PER_POINT, zone: this.zone, weak: false };
  }

  blow(x: number, y: number, z: number, r: number, jx: number, jy: number, jz: number, src: DamageSource): DamageResult | null {
    const near = this.zoneAt(x, y, z);
    if (!near || near.d > r) return null;
    const J = Math.hypot(jx, jy, jz);
    if (!this.targetable || J <= 0) return null;
    const hp = this.c.hp;
    this.owner.hitOne(this.c, 'blow', J / 150, Math.min(10, J / 60), src.cause, this.c.x - jx / J, this.c.z - jz / J);
    return { dealt: Math.max(0, Math.min(hp, J / 150)) / HP_PER_POINT, zone: this.zone, weak: false };
  }

  /** Fighting strength for the con: a skitter is no match for anyone, a brute is a tough dog. */
  conStrength(): number { return this.c.kind === 1 ? 1.5 : 0.4; }

  /**
   * A power's element: frost freezes it outright (no damage on top: the next blow shatters it); the
   * others go into the damage that follows.
   */
  onElement(el: 'fire' | 'frost' | 'shock' | 'wind', dur: number): number {
    if (el === 'frost') {
      if (this.targetable) this.owner.hitOne(this.c, 'frost', Math.max(2, dur), 0, 'player', this.c.x, this.c.z);
      return 0;
    }
    this.fx = ELEMENT[el];
    return 1;
  }
}
