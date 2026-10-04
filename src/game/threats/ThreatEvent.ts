/**
 * What every threat event is to the rest of the game (THREATS_PLAN §4): the threat director runs
 * it, the response director escalates against it, the map marks it. Phase A has one archetype
 * (robot malfunction); later ones (swarms, the Strider, tripods) implement the same interface.
 */
import type { Cause } from '../Stimuli';

export type ThreatOutcome = 'stopped' | 'shutdown' | 'abandoned';

/** Something of the threat the police can engage on foot (a rogue machine, a swarm creature). */
export interface ThreatTarget {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** On the ground and within an officer's reach (flying ones are not). */
  readonly grounded: boolean;
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
  update(dt: number): void;
  /** The response gave up on stopping it by force: power it down / drive it off now. */
  shutdown(): void;
  /** Gone from the world (machines powered off for good, nothing left behind that it owns). */
  dispose(): void;
  /** Debug summary. */
  snapshot(): Record<string, unknown>;
}
