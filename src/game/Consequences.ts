/**
 * Collateral ledger (stub): every effect the player's powers have on people, cars, robots,
 * drones, props and buildings is recorded here with the player as the cause. The crime and
 * reputation phase reads it (karma penalties, reputation, news); for now it only counts.
 *
 * PLAYGROUND_PLAN §0 decision 18: area effects hit everything in the area — careless use near
 * crowds has consequences. The justice layer (crime/Justice.ts) listens: hurting bystanders,
 * police or property in front of witnesses costs karma and reputation and draws the police.
 */
export type HarmTarget = 'person' | 'car' | 'robot' | 'drone' | 'prop' | 'building' | 'ground';
export type HarmEffect = 'knockdown' | 'burn' | 'freeze' | 'shrink' | 'stun' | 'wet' | 'wreck' | 'damage' | 'break' | 'topple' | 'stall' | 'lift' | 'facade';

export interface HarmEntry {
  cause: 'player';
  /** The power (ability id) or 'body' for punches and collisions. */
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
  time = 0;
  /** Listener for the later reputation / karma system. */
  onRecord: ((e: HarmEntry) => void) | null = null;

  record(power: string, target: HarmTarget, effect: HarmEffect, x: number, z: number, ref?: object): void {
    const e: HarmEntry = { cause: 'player', power, target, effect, x, z, t: this.time, ref };
    if (this.log.length >= LOG) this.log.shift();
    this.log.push(e);
    const k = `${target}:${effect}`;
    this.counts[k] = (this.counts[k] ?? 0) + 1;
    this.onRecord?.(e);
  }

  update(dt: number): void { this.time += dt; }

  /** Short summary (window.game.consequences.report()). */
  report(): string {
    return Object.entries(this.counts).map(([k, n]) => `${k} ${n}`).join(' · ') || 'nothing yet';
  }
}
