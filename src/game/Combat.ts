/**
 * Combat model (PLAYGROUND_PLAN §4.3, decision 12): every hit on a person goes through
 * `hitActor`, which turns an impulse into damage and one of four outcomes:
 *
 *   stagger    a light hit: the body flinches and slows for a moment (an ordinary punch on an
 *              ordinary adult)
 *   knockdown  a hard hit (or a big share of the health at once): they go down and get up
 *              again after a few seconds
 *   ko         health used up: down and out (criminals stay down until the police cuff them;
 *              bystanders are "injured", not dead)
 *   none       too weak to matter (a tiny hero's tap)
 *
 * Damage follows the impulse (N·s), so it already scales with the attacker's strength and size
 * (punch impulse ∝ k² and super strength): an ordinary person needs about three punches for a
 * purse snatcher, five for an armed robber; a strong or giant hero floors anyone at once. Shrunk
 * targets take more. Knock-downs from other sources (powers, dashes, stomps, blasts) arrive via
 * `knocked` (Reactions.onKnockDown) and cost health too.
 *
 * `onKnockdown(agent, jx, jy, jz)` listeners fire for every knock-down with the impulse — the hook
 * for a ragdoll system to take the body over.
 *
 * No three.js: usable in headless tests through `CombatWorld`.
 */
import type { PedAgent, DownCause } from '../sim/Pedestrians';
import { PState } from '../sim/Pedestrians';
import type { HarmEffect, HarmTarget } from './Consequences';
import { play, setState } from '../sim/actors/Actor';
import { statusOf } from '../shared/status';
import { Role } from '../sim/Population';

export type HitKind = 'punch' | 'strike' | 'tackle' | 'power' | 'knife' | 'bat' | 'shove' | 'gun';
export type HitSource = 'player' | 'npc' | 'police' | 'world';
export type HitEffect = 'none' | 'stagger' | 'knockdown' | 'ko';

export interface HitResult { effect: HitEffect; damage: number; hp: number; maxHp: number }

export interface CombatWorld {
  /** Reactions.knockDown (the existing knock-down: fling, lie, get up or stay down). */
  knockDown(a: PedAgent, fx: number, fz: number, power: number, cause: DownCause): void;
  /** Collateral ledger (Consequences.record) for the player's hits. */
  record?(power: string, target: HarmTarget, effect: HarmEffect, x: number, z: number, ref?: object): void;
  sound?(id: string, x: number, y: number, z: number, gain: number, pitch?: number): void;
}

/** Numbers of the combat model. */
export const COMBAT = {
  /** Damage per N·s of impulse (an ordinary punch, 200 N·s, does 12). */
  dmgPerNs: 0.06,
  /** Below this impulse a hit does nothing. */
  minJ: 40,
  /** From this impulse on a hit always knocks down. */
  knockJ: 850,
  /** Knock-down when one hit takes this share of the maximum health. */
  knockShare: 0.45,
  /** Health of an ordinary adult (children and seniors less). */
  civilianHp: 36,
  /** Stagger time (s). */
  stagger: 0.5,
  /** Time down after a knock-down that is not a KO (s). */
  upMin: 2.4, upMax: 4.2,
  /** Damage of a knock-down by a power or a body (per m/s of fling speed, plus a base). */
  knockBase: 8, knockPerSpeed: 5,
};

export class Combat {
  /** Knock-down listeners (ragdolls): the agent and the impulse (N·s). */
  readonly onKnockdown: ((a: PedAgent, jx: number, jy: number, jz: number) => void)[] = [];
  /** Every resolved hit (crime system: KO rewards, wanted ledger, crowd reactions). */
  onHit: ((a: PedAgent, r: HitResult, source: HitSource, kind: HitKind) => void) | null = null;
  /** Health of people who are not actors (bystanders), by agent. */
  private civHp = new WeakMap<PedAgent, number>();
  private inHit = false;
  stats = { hits: 0, staggers: 0, knockdowns: 0, kos: 0 };

  constructor(private w: CombatWorld) {}

  maxHpOf(a: PedAgent): number {
    if (a.actor) return a.actor.maxHp;
    const r = a.cit.role;
    return COMBAT.civilianHp * (r === Role.Child ? 0.6 : r === Role.Senior ? 0.75 : 1);
  }

  hpOf(a: PedAgent): number {
    if (a.actor) return a.actor.hp;
    return this.civHp.get(a) ?? this.maxHpOf(a);
  }

  private setHp(a: PedAgent, hp: number): void {
    if (a.actor) a.actor.hp = hp;
    else this.civHp.set(a, hp);
  }

  /**
   * A hit with impulse (jx, jy, jz) N·s on a person. `from` is where it came from (for the
   * knock-down direction; default: against the impulse).
   */
  hitActor(a: PedAgent, jx: number, jy: number, jz: number, kind: HitKind, source: HitSource, fromX?: number, fromZ?: number): HitResult {
    const J = Math.hypot(jx, jy, jz);
    const maxHp = this.maxHpOf(a);
    let hp = this.hpOf(a);
    const res: HitResult = { effect: 'none', damage: 0, hp, maxHp };
    if (!a.alive || a.inside || J < COMBAT.minJ) return res;
    const act = a.actor;
    if (act && (act.state === 'arrested' || act.state === 'gone')) return res;
    const scale = statusOf(a)?.scale ?? 1;
    let dmg = J * COMBAT.dmgPerNs / Math.max(0.2, scale);
    if (kind === 'knife') dmg *= 1.4;
    // Someone already down takes less from a light hit (no "kicking people who are down" loop).
    const down = a.state === PState.Down;
    if (down) dmg *= 0.5;
    hp = Math.max(0, hp - dmg);
    this.setHp(a, hp);
    res.damage = dmg; res.hp = hp;
    this.stats.hits++;
    const hl = Math.hypot(jx, jz) || 1;
    const fx = fromX ?? a.x - (jx / hl), fz = fromZ ?? a.z - (jz / hl);
    if (act) { if (source === 'player') act.hitByPlayer = true; }
    if (hp <= 0) {
      res.effect = 'ko';
      this.stats.kos++;
      if (act) { setState(act, 'ko'); act.koByPlayer = source === 'player'; act.action = null; act.goal = null; }
      if (!down) this.knock(a, fx, fz, Math.max(2.2, Math.min(12, J / 350)), jx, jy, jz, source === 'player' ? 'player' : 'other');
    } else if (!down && (J >= COMBAT.knockJ || dmg >= maxHp * COMBAT.knockShare || kind === 'tackle')) {
      res.effect = 'knockdown';
      this.stats.knockdowns++;
      if (act) { setState(act, 'down'); act.upT = COMBAT.upMin + Math.random() * (COMBAT.upMax - COMBAT.upMin); act.action = null; }
      this.knock(a, fx, fz, Math.max(1.6, Math.min(12, J / 350)), jx, jy, jz, source === 'player' ? 'player' : 'other');
    } else if (!down) {
      res.effect = 'stagger';
      this.stats.staggers++;
      // A step back from the blow, a flinch.
      const push = Math.min(0.5, J / 900);
      a.x += (jx / hl) * push; a.z += (jz / hl) * push;
      if (act) {
        // No stun-lock: a fresh stagger at most every 1.4 s; tough, armed people shrug off light blows.
        const tough = act.strength >= 1.2 && J < 350;
        if (!tough && !(act.memo.stagCd > 0)) { act.staggerT = COMBAT.stagger; act.memo.stagCd = 1.4; }
        play(act, J > 300 && !tough ? 'stagger' : 'flinch', 0.5);
      }
      else {
        // Bystanders hit get scared and run from where the blow came from.
        a.fear = Math.min(2, a.fear + 0.9);
        a.fearX = fx; a.fearZ = fz;
        a.state = PState.Flee; a.stateT = 0;
      }
    }
    if (source === 'player' && res.effect !== 'none') {
      this.w.record?.('body', 'person', res.effect === 'stagger' ? 'damage' : 'knockdown', a.x, a.z, a);
    }
    this.onHit?.(a, res, source, kind);
    return res;
  }

  /**
   * A knock-down that did not come through hitActor (a power, a dash, a stomp, a blast, a car):
   * it costs health (by fling speed) and may KO. Wired to Reactions.onKnockDown.
   */
  knocked(a: PedAgent, fx: number, fz: number, power: number, cause: DownCause): void {
    if (this.inHit) return;
    const dx = a.x - fx, dz = a.z - fz, d = Math.hypot(dx, dz) || 1;
    const J = power * 70;
    this.fireKnockdown(a, (dx / d) * J, J * 0.4, (dz / d) * J);
    if (cause === 'accident') return;
    const dmg = COMBAT.knockBase + COMBAT.knockPerSpeed * power;
    const hp = Math.max(0, this.hpOf(a) - dmg);
    this.setHp(a, hp);
    const act = a.actor;
    let effect: HitEffect = 'knockdown';
    if (act) {
      if (cause === 'player') act.hitByPlayer = true;
      if (hp <= 0) { setState(act, 'ko'); act.koByPlayer = cause === 'player'; effect = 'ko'; this.stats.kos++; }
      else if (act.state !== 'ko' && act.state !== 'arrested') { setState(act, 'down'); act.upT = COMBAT.upMin + Math.random() * (COMBAT.upMax - COMBAT.upMin); }
      act.action = null; act.goal = null;
    }
    this.stats.knockdowns++;
    this.onHit?.(a, { effect, damage: dmg, hp, maxHp: this.maxHpOf(a) }, cause === 'player' ? 'player' : 'world', 'power');
  }

  private knock(a: PedAgent, fx: number, fz: number, power: number, jx: number, jy: number, jz: number, cause: DownCause): void {
    this.inHit = true;
    try { this.w.knockDown(a, fx, fz, power, cause); } finally { this.inHit = false; }
    this.fireKnockdown(a, jx, jy, jz);
  }

  private fireKnockdown(a: PedAgent, jx: number, jy: number, jz: number): void {
    for (const f of this.onKnockdown) f(a, jx, jy, jz);
  }

  /** Back on their feet (owner decides when): health partly restored for bystanders. */
  heal(a: PedAgent, hp: number): void {
    this.setHp(a, Math.min(this.maxHpOf(a), hp));
  }
}
