/**
 * Collateral ledger: every effect the player's powers have on people, cars, robots, drones,
 * props and buildings is recorded here with the player as the cause; what a threat (rogue
 * robots) or the police do in the city is recorded too, with its own cause — the casualty
 * ledger of an incident, never booked to the player (THREATS_PLAN §2, "Casualties without gore").
 *
 * PLAYGROUND_PLAN §0 decision 18: area effects hit everything in the area — careless use near
 * crowds has consequences. The justice layer (crime/Justice.ts) listens: hurting bystanders,
 * police or property in front of witnesses costs karma and reputation and draws the police.
 */
import { SIDEKICK_OWNER } from '../sim/actors/Actor';
import type { Cause } from './Stimuli';

export type HarmTarget = 'person' | 'car' | 'robot' | 'drone' | 'prop' | 'building' | 'ground' | 'bridge';
/** Same vocabulary as the stimuli's `Cause` ('world': nobody's own doing). */
export type HarmCause = Cause;
export type HarmEffect = 'knockdown' | 'burn' | 'freeze' | 'shrink' | 'stun' | 'wet' | 'wreck' | 'damage' | 'break' | 'topple' | 'stall' | 'lift' | 'facade' | 'collapse';

export interface HarmEntry {
  cause: HarmCause;
  /** The power (ability id) or 'body' for punches and collisions (threats: the machine kind). */
  power: string;
  target: HarmTarget;
  effect: HarmEffect;
  x: number; z: number;
  /** Game time (s). */
  t: number;
  /** What was hit (a PedAgent, Vehicle, …) when known: the crime layer tells criminals from bystanders. */
  ref?: object;
  /** A collapse: the storeys that came down. */
  size?: number;
}

const LOG = 256;

export class Consequences {
  /** Recent entries (ring buffer, newest last). */
  readonly log: HarmEntry[] = [];
  /** Totals per "target:effect". */
  readonly counts: Record<string, number> = {};
  /** Entries per cause (the threat clock reads the player's share as chaos). */
  readonly totals: Record<HarmCause, number> = { player: 0, threat: 0, police: 0, military: 0, world: 0 };
  time = 0;
  /** Listener for the later reputation / karma system. */
  onRecord: ((e: HarmEntry) => void) | null = null;

  record(power: string, target: HarmTarget, effect: HarmEffect, x: number, z: number, ref?: object, cause: HarmCause = 'player', size?: number): void {
    // The sidekick is outside the reputation system (SIDEKICK_PLAN §1.7): the hero catching them
    // with a power or a blow is nobody's misdeed.
    if (cause === 'player' && target === 'person' && (ref as { actor?: { owner?: number } } | undefined)?.actor?.owner === SIDEKICK_OWNER) cause = 'world';
    const e: HarmEntry = { cause, power, target, effect, x, z, t: this.time, ref, size };
    if (this.log.length >= LOG) this.log.shift();
    this.log.push(e);
    const k = cause === 'player' ? `${target}:${effect}` : `${cause}:${target}:${effect}`;
    this.counts[k] = (this.counts[k] ?? 0) + 1;
    this.totals[cause]++;
    this.onRecord?.(e);
  }

  update(dt: number): void { this.time += dt; }

  /** Short summary (window.game.consequences.report()). */
  report(): string {
    return Object.entries(this.counts).map(([k, n]) => `${k} ${n}`).join(' · ') || 'nothing yet';
  }
}
