/**
 * A boss operation as a threat event (VILLAINS_PLAN §3.5: "boss operations become threat events"):
 * the crew of a crime/BossOp seen by the threat layer — the response director opens an incident
 * on it (patrol cars, then a perimeter with roadblocks and the evacuation siren, then SWAT going
 * in), the map and compass mark it at any distance. The crime itself stays the crime system's
 * (rewards, arrests, turf, the boss's record); this only lends its people to the response as
 * targets: an officer's baton or a stun baton through Combat, credited to the police.
 *
 * It ends when the crew is beaten or gives up ('stopped'), or when they finish and make off
 * ('retreated'); the response stands down after that.
 */
import type { Cause } from '../Stimuli';
import type { Combat } from '../Combat';
import type { ThreatEvent, ThreatOutcome, ThreatTarget } from './ThreatEvent';
import type { BossOperation } from '../crime/BossOp';
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';
import { subdued } from '../../sim/actors/Actor';

let nextId = 7000;

/** Gun hits on a crook (impulse per point of the response's damage). */
const SHOT_J = 22;

export class BossEvent implements ThreatEvent {
  readonly id = nextId++;
  readonly archetype = 'boss';
  readonly tier = 'minor' as const;
  readonly engageOnFoot = true;
  /** The highest level: SWAT (an armed crew is no reason for the army). */
  readonly ceiling = 2;
  readonly radius = 60;
  t = 0;
  active = true;
  outcome: ThreatOutcome | null = null;
  private total: number;
  private targets = new Map<PedAgent, ThreatTarget & { a: PedAgent }>();

  constructor(readonly op: BossOperation, private combat: Combat, readonly title: string) {
    this.total = Math.max(1, op.criminals.length);
  }

  get x(): number { return this.op.site?.x ?? this.op.x; }
  get z(): number { return this.op.site?.z ?? this.op.z; }
  /** People knocked down by the crew are not counted (their fights are with the hero and the police). */
  get hurt(): number { return 0; }

  /** Share of the crew still standing (escalation reads it). */
  strength(): number { return this.op.standing().length / this.total; }

  private live(a: PedAgent): boolean {
    return a.alive && !!a.actor && a.actor.hostile && !subdued(a.actor) && a.actor.state !== 'gone' && a.state !== PState.Down;
  }

  targetsNear(x: number, z: number, r: number): ThreatTarget[] {
    const out: ThreatTarget[] = [];
    if (!this.active) return out;
    for (const a of this.op.criminals) {
      if (!this.live(a) || Math.hypot(a.x - x, a.z - z) > r) continue;
      let t = this.targets.get(a);
      if (!t) {
        const aa = a, self = this;
        t = { a, get x() { return aa.x; }, get y() { return aa.y; }, get z() { return aa.z; }, grounded: true, get on() { return self.live(aa); }, speed: 3 } as ThreatTarget & { a: PedAgent };
        this.targets.set(a, t);
      }
      out.push(t);
    }
    return out;
  }

  strike(t: ThreatTarget, jx: number, jy: number, jz: number, cause: Cause): void {
    const a = (t as ThreatTarget & { a?: PedAgent }).a;
    if (a && this.live(a)) this.combat.hitActor(a, jx, jy, jz, 'strike', cause === 'player' ? 'player' : 'police', a.x - jx, a.z - jz);
  }

  shoot(t: ThreatTarget, dmg: number, cause: Cause, fromX: number, fromZ: number): boolean {
    const a = (t as ThreatTarget & { a?: PedAgent }).a;
    if (!a || !this.live(a)) return false;
    const dx = a.x - fromX, dz = a.z - fromZ, l = Math.hypot(dx, dz) || 1, J = dmg * SHOT_J;
    this.combat.hitActor(a, (dx / l) * J, J * 0.2, (dz / l) * J, 'gun', cause === 'player' ? 'player' : 'police', fromX, fromZ);
    return !this.live(a);
  }

  update(dt: number): void {
    if (!this.active) { this.t += dt; return; }
    this.t += dt;
    const op = this.op;
    if (!op.active || op.wasSubdued || (op.broken && !op.standing().some((a) => a.actor?.state === 'fight'))) this.end(op.done ? 'retreated' : 'stopped');
    else if (op.done && op.phase === 'escape' && !op.standing().some((a) => a.actor?.state === 'fight')) this.end('retreated');
  }

  private end(o: ThreatOutcome): void {
    this.active = false;
    this.outcome = o;
  }

  /** The response gives up on it: nothing to power down — the crew carries on as the crime decides. */
  shutdown(): void { this.end(this.op.done ? 'retreated' : 'abandoned'); }

  /** The crime system owns the people. */
  dispose(): void { this.active = false; }

  snapshot(): Record<string, unknown> {
    return { id: this.id, archetype: this.archetype, title: this.title, t: Math.round(this.t), outcome: this.outcome, standing: this.op.standing().length, total: this.total, op: this.op.snapshot().op };
  }
}
