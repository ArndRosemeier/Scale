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
export type HarmTarget = 'person' | 'car' | 'robot' | 'drone' | 'prop' | 'building' | 'ground';
export type HarmCause = 'player' | 'threat' | 'police' | 'military';
export type HarmEffect = 'knockdown' | 'burn' | 'freeze' | 'shrink' | 'stun' | 'wet' | 'wreck' | 'damage' | 'break' | 'topple' | 'stall' | 'lift' | 'facade';

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
}

const LOG = 256;

export class Consequences {
  /** Recent entries (ring buffer, newest last). */
  readonly log: HarmEntry[] = [];
  /** Totals per "target:effect". */
  readonly counts: Record<string, number> = {};
  /** Entries per cause (the threat clock reads the player's share as chaos). */
  readonly totals: Record<HarmCause, number> = { player: 0, threat: 0, police: 0, military: 0 };
  time = 0;
  /** Listener for the later reputation / karma system. */
  onRecord: ((e: HarmEntry) => void) | null = null;

  record(power: string, target: HarmTarget, effect: HarmEffect, x: number, z: number, ref?: object, cause: HarmCause = 'player'): void {
    const e: HarmEntry = { cause, power, target, effect, x, z, t: this.time, ref };
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
