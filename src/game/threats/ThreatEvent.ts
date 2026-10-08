/**
 * What every threat event is to the rest of the game (THREATS_PLAN §4): the threat director runs
 * it, the response director escalates against it, the map marks it. Archetypes: the robot
 * malfunction (minor) and the Strider (major); later ones (swarms, tripods) implement the same
 * interface.
 *
 * A big threat is also a `ThreatActor` (THREATS_PLAN §1 "common foundation"): one body with hit
 * points, armour per body zone, weak spots and an aggro table. Everything that hurts it — the
 * player's punches and powers now, the army's ForceUnits later — goes through `damage`.
 */
import type { Cause } from '../Stimuli';

/**
 * stopped: beaten by force · defeated: a monster brought down (its body stays) · retreated: driven off ·
 * destroyed: the last resort's strike (nothing is left of it).
 */
export type ThreatOutcome = 'stopped' | 'shutdown' | 'abandoned' | 'defeated' | 'retreated' | 'destroyed';

/** A body zone of a threat actor: armour, weak spot, where it is now. */
export interface ThreatZone {
  readonly id: string;
  readonly name: string;
  /** Share of the damage its hide / plates stop (0 soft … 0.95). */
  armour: number;
  /** A weak spot: soft and multiplied while `exposed` (the throat while charging, the belly when rearing). */
  readonly weak: boolean;
  exposed: boolean;
  /** Centre (world) and radius now (markers, area hits). */
  x: number; y: number; z: number; r: number;
  /** Damage taken there (recent, decays): a leg that took a lot buckles. */
  recent: number;
}

/** Who did it: the cause (player / police / military later) and a key for the aggro table. */
export interface DamageSource {
  cause: Cause;
  /** Aggro key ('player', a squad or unit id); default: the cause. */
  key?: string;
  /** Where it came from (the monster turns on it). */
  x?: number; y?: number; z?: number;
  /** Extra aggro booked besides the damage (a distraction: small arms that barely scratch it). */
  aggro?: number;
}

export interface DamageResult { dealt: number; zone: ThreatZone | null; weak: boolean }

export interface ThreatActor {
  readonly name: string;
  readonly hp: number;
  readonly maxHp: number;
  /** Brought down (the body stays until the aftermath removes it). */
  readonly defeated: boolean;
  /** Still in the world as something to target (alive and on the map). */
  readonly targetable: boolean;
  /** Body centre and height (targeting, markers). */
  readonly x: number; readonly y: number; readonly z: number;
  readonly height: number;
  readonly zones: readonly ThreatZone[];
  /** Ray against the body: distance and zone, or null. */
  ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): { t: number; zone: ThreatZone } | null;
  /** The zone whose surface is nearest a point, and the distance to it (area effects). */
  zoneAt(x: number, y: number, z: number): { zone: ThreatZone; d: number } | null;
  /**
   * Damage before armour (points; the Strider has 3000): reduced by the zone's armour, multiplied on
   * an exposed weak spot, booked to the aggro table. `zone` null: the zone nearest `src` / the body.
   */
  damage(zone: ThreatZone | string | null, amount: number, src: DamageSource): DamageResult;
  /** A physical blow (punch, a giant's stomp, a thrown car): impulse (N·s) at a point within r of the body. */
  blow(x: number, y: number, z: number, r: number, jx: number, jy: number, jz: number, src: DamageSource): DamageResult | null;
  /** Aggro table: damage dealt by each source, decaying. */
  readonly aggro: ReadonlyMap<string, number>;
  /** Fighting strength for the con (1 = an average adult). */
  conStrength(): number;
  /** The player's own body (a rampaging giant: the police's and the army's target, never the player's). */
  readonly self?: boolean;
  /**
   * An element from the powers lands on it (fire, frost, lightning): its own reaction (an awakened
   * tree catches fire) and the multiplier on the power's damage. Absent: 1.
   */
  onElement?(el: 'fire' | 'frost' | 'shock', dur: number): number;
  /** Biggest dimension at full size (m), for the shrink ray. Absent: `height`. */
  readonly size?: number;
  /**
   * Shrink ray: the body's size factor now (1 = full; eases in and back). The body, its hit volumes
   * and its reach follow it. Absent: the actor cannot be shrunk.
   */
  setScale?(s: number): void;
}

/** Points of damage per N·s of impulse (punches, shoves, blows on a threat actor). */
export const DAMAGE_PER_IMPULSE = 1 / 1500;

/** Something of the threat the police can engage on foot (a rogue machine, a swarm creature). */
export interface ThreatTarget {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** On the ground and within an officer's reach (flying ones are not). */
  readonly grounded: boolean;
  /** Still in action (false once disabled: an officer drops it as a target). Absent: assume so. */
  readonly on?: boolean;
  /** Speed (m/s, for the aim). */
  readonly speed?: number;
}

export interface ThreatEvent {
  readonly id: number;
  readonly archetype: string;
  /** The incident's centre (follows the threat) and the radius it is active in (m). */
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  /** Seconds since it began. */
  readonly t: number;
  readonly active: boolean;
  outcome: ThreatOutcome | null;
  /** Share of the threat still in action, 1 at the start … 0 stopped (escalation reads it). */
  strength(): number;
  /** People hurt so far (knocked down by it). */
  readonly hurt: number;
  /** Targets on the ground near a point (police on foot). */
  targetsNear(x: number, z: number, r: number): ThreatTarget[];
  /** Strike a target (an officer's baton, a taser), credited to `cause`. */
  strike(t: ThreatTarget, jx: number, jy: number, jz: number, cause: Cause): void;
  /**
   * Small-arms hits on a target (police pistols and rifles: crime/Firearms), credited to `cause`:
   * wear it down without knocking it about. True when that brought it down.
   */
  shoot?(t: ThreatTarget, dmg: number, cause: Cause, fromX: number, fromZ: number): boolean;
  update(dt: number): void;
  /** The response gave up on stopping it by force: power it down / drive it off now. */
  shutdown(): void;
  /** Gone from the world (machines powered off for good, nothing left behind that it owns). */
  dispose(): void;
  /** Debug summary. */
  snapshot(): Record<string, unknown>;
  /** 'minor' (robots, scouts) or 'major' (the Strider): the response escalates faster and further. */
  readonly tier?: 'minor' | 'major';
  /** Officers may go in on foot and strike it (rogue robots yes; a 40 m monster no: they hold the lines). */
  readonly engageOnFoot?: boolean;
  /** The highest response level it may reach (unset: no limit; a human-sized rampaging player: the Guard). */
  readonly ceiling?: number;
  /** Big bodies of the event (targetable, damageable). */
  readonly actors?: readonly ThreatActor[];
  /** Its line on the map and compass (unset: by archetype). */
  readonly title?: string;
}
