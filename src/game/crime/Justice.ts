/**
 * Justice (PLAYGROUND_PLAN §0 decisions 4 and 5, §2.6): what the player does wrong has real
 * consequences. It reads the collateral ledger (Consequences): hurting bystanders, attacking the
 * police and wrecking cars or buildings in front of witnesses costs karma and reputation now, and
 * builds "heat"; enough heat makes the player wanted (1–3): the police come and try to arrest them.
 *
 *   heat ≥ 2.5 → wanted 1 · ≥ 6 → 2 · ≥ 12 → 3   (a suspect — reputation ≤ −50 — at 1.2)
 *
 * Getting away: out of the officers' reach (no officer within 70 m) for 12 s + 6 s per level drops
 * a level. Getting caught (an officer cuffs the player on the ground): a fade, a fine in karma,
 * reputation lost, heat cleared. Atonement: heat cools off by itself when not wanted; stopping
 * crimes cools it faster; walking up to an officer or a police car and pressing E (turning yourself
 * in) clears it at a smaller cost.
 */
import type { HarmEntry } from '../Consequences';
import type { PedAgent } from '../../sim/Pedestrians';
import type { Vehicle } from '../../sim/Traffic';

export interface JusticeHost {
  time: number;
  player: { x: number; z: number };
  /** Ordinary people (witnesses) within r of a point, besides `except`. */
  witnesses(x: number, z: number, r: number, except?: object): number;
  /** Officers within r of a point. */
  officersNear(x: number, z: number, r: number): number;
  karma(amount: number, reason: string): void;
  rep(delta: number, reason: string): void;
  repValue(): number;
  /** Ask the police for (more) units on the player. */
  pursue(level: number): void;
  /** A short hint / feedback line. */
  toast(html: string, kind: 'warn' | 'info' | 'karma'): void;
  /** No karma in this game (sandbox): the lines leave the karma out. */
  readonly noKarma?: boolean;
  sound(id: string, gain: number): void;
  /** A machine gone rogue (a threat): fair game, not property. */
  hostileThing?(ref: object): boolean;
}

export const JUSTICE = {
  levels: [2.5, 6, 12],
  suspectLevel1: 1.2,
  decay: 0.06,
  witnessR: 32,
  policeSeeR: 60,
  /** Per level: seconds out of reach to drop a level (base + per level). */
  loseBase: 12, losePer: 6, reachR: 70,
  /** Seconds after the police are called before the player can lose them. */
  grace: 40,
  fineBase: 10, finePer: 10,
  turnInBase: 5, turnInPer: 6,
  /** Breaking a facade in front of witnesses (at most every 2 s). */
  facade: { heat: 0.45, karma: 1, rep: 0.6 },
  /** A collapse the player caused (always known): base + per storey that came down (≤ 12). */
  collapse: { heat: 2.6, heatPer: 0.35, karma: 6, karmaPer: 1.5, rep: 3, repPer: 0.7 },
};

export class Justice {
  heat = 0;
  wanted = 0;
  /** Seconds with no officer within reach (while wanted). */
  private unseen = 0;
  /** When the current pursuit began (the police need time to arrive before one can "lose" them). */
  private since = 0;
  private recent = new WeakMap<object, number>();
  private propT = 0;
  private hurtT = -99;
  stats = { offences: 0, arrests: 0, turnIns: 0, escapes: 0, collapses: 0 };
  private felled = new WeakSet<object>();
  /** Called when the wanted level changes (HUD). */
  onChange: ((wanted: number) => void) | null = null;

  constructor(private h: JusticeHost) {}

  /** A ledger entry (Consequences.onRecord). */
  record(e: HarmEntry): void {
    const H = this.h;
    // Only the player's own doing (a rogue robot's or the police's damage is never booked to them).
    if (e.cause !== 'player') return;
    if (e.ref && H.hostileThing?.(e.ref)) return;
    const now = H.time;
    const ref = e.ref as (PedAgent | Vehicle | undefined);
    if (e.target === 'building' && e.effect === 'collapse') {
      // Bringing a building down: everyone sees it, and a block of homes and shops is gone. Once per
      // building (an upper part coming down first and the rest after is one deed).
      if (this.felled.has(e.ref ?? e)) return;
      this.felled.add(e.ref ?? e);
      const f = Math.min(12, e.size ?? 1);
      this.stats.collapses++;
      this.offence(JUSTICE.collapse.heat + f * JUSTICE.collapse.heatPer, -(JUSTICE.collapse.karma + f * JUSTICE.collapse.karmaPer), -(JUSTICE.collapse.rep + f * JUSTICE.collapse.repPer), e, 'You brought a building down', true);
      return;
    }
    // Repeated hits on the same thing within 3 s (beams, area ticks) count once.
    if (ref) {
      const last = this.recent.get(ref);
      if (last !== undefined && now - last < 3) return;
      this.recent.set(ref, now);
    }
    if (e.target === 'person') {
      const a = ref as PedAgent | undefined;
      const role = a?.actor?.role;
      if (role === 'criminal') {
        // Fair game while they are a threat; beating the cuffed or surrendered is not.
        const st = a!.actor!.state;
        if (st === 'arrested' || st === 'surrender') this.offence(1.2, -6, -3, e, 'Hitting someone who gave up');
        return;
      }
      if (role === 'police') { this.offence(2.6, -6, -4, e, 'Assaulting a police officer', true); return; }
      if (role === 'soldier') { this.offence(2.6, -6, -4, e, 'Attacking a soldier', true); return; }
      const lvl = e.effect === 'damage' ? 0.7 : e.effect === 'wet' ? 0.25 : e.effect === 'shrink' ? 0.5 : 1;
      this.offence(lvl * 1.15, -3 * lvl, -2 * lvl, e, 'You hurt a bystander');
      return;
    }
    if (e.target === 'car') {
      const v = ref as Vehicle | undefined;
      if (v?.kind === 'police' && (e.effect === 'wreck' || e.effect === 'damage')) { this.offence(e.effect === 'wreck' ? 2.4 : 0.6, -4, -3, e, 'Wrecking a police car', true); return; }
      if (e.effect === 'wreck') this.offence(0.8, -2, -1.5, e, 'You wrecked a car');
      else if (e.effect === 'stall' || e.effect === 'freeze') this.offence(0.15, 0, -0.2, e, '');
      return;
    }
    if (e.target === 'building' || e.target === 'prop' || e.target === 'robot' || e.target === 'drone') {
      // Property damage: rate-limited (a beam on a facade is many entries).
      if (now - this.propT < 2) return;
      this.propT = now;
      if (e.target === 'building') { this.offence(JUSTICE.facade.heat, -JUSTICE.facade.karma, -JUSTICE.facade.rep, e, 'You are wrecking a building'); return; }
      const lvl = e.target === 'robot' || e.target === 'drone' ? 0.3 : 0.15;
      this.offence(lvl, 0, -lvl, e, '');
    }
  }

  /** Witnessed misdeed: heat, karma, reputation. `always`: the police know anyway. */
  private offence(heat: number, karma: number, rep: number, e: HarmEntry, msg: string, always = false): void {
    const H = this.h;
    const seen = always || H.witnesses(e.x, e.z, JUSTICE.witnessR, e.ref) > 0 || H.officersNear(e.x, e.z, JUSTICE.policeSeeR) > 0;
    if (!seen) return;
    this.stats.offences++;
    this.heat += heat;
    if (karma < 0) H.karma(Math.round(karma), msg || 'misdeed');
    if (rep < 0) H.rep(rep, msg || 'misdeed');
    if (msg && H.time - this.hurtT > 6) { this.hurtT = H.time; H.toast(`${msg} — people saw it${H.noKarma ? '' : ` (<b>${Math.round(karma)} karma</b>)`}`, 'warn'); }
    this.levelUp();
  }

  private thresholds(): number[] {
    const t = JUSTICE.levels.slice();
    if (this.h.repValue() <= -50) t[0] = JUSTICE.suspectLevel1;
    return t;
  }

  private levelUp(): void {
    const t = this.thresholds();
    let lvl = 0;
    for (let i = 0; i < t.length; i++) if (this.heat >= t[i]) lvl = i + 1;
    if (lvl > this.wanted) {
      if (this.wanted === 0) this.since = this.h.time;
      this.wanted = lvl;
      this.unseen = 0;
      this.h.pursue(lvl);
      this.h.sound('siren_short', 0.5);
      this.h.toast(lvl === 1 ? 'The police are after you — get away, or turn yourself in to an officer (<b>E</b>)' : `Wanted level <b>${lvl}</b>`, 'warn');
      this.onChange?.(this.wanted);
    }
  }

  update(dt: number): void {
    const H = this.h;
    if (this.wanted <= 0) {
      this.heat = Math.max(0, this.heat - JUSTICE.decay * dt);
      return;
    }
    // Out of reach of every officer long enough: one level down.
    const near = H.officersNear(H.player.x, H.player.z, JUSTICE.reachR);
    this.unseen = near > 0 || H.time - this.since < JUSTICE.grace ? 0 : this.unseen + dt;
    if (this.unseen > JUSTICE.loseBase + JUSTICE.losePer * this.wanted) {
      this.unseen = 0;
      this.wanted--;
      const t = this.thresholds();
      this.heat = this.wanted > 0 ? t[this.wanted - 1] : Math.min(this.heat, t[0] * 0.6);
      if (this.wanted === 0) { this.stats.escapes++; H.toast('You lost them — the heat is off for now', 'info'); }
      else H.pursue(this.wanted);
      this.onChange?.(this.wanted);
    } else if (this.unseen === 0) H.pursue(this.wanted);
  }

  /** Saves: heat, wanted level and the statistics. */
  serialize(): { heat: number; wanted: number; stats: Justice['stats'] } {
    return { heat: this.heat, wanted: this.wanted, stats: { ...this.stats } };
  }

  /** Saves: restore them; a wanted player is pursued again (with the usual grace before they can get away). */
  restore(o: { heat?: number; wanted?: number; stats?: Partial<Record<string, number>> } | null): void {
    if (!o) return;
    this.heat = Math.max(0, Number(o.heat) || 0);
    this.wanted = Math.max(0, Math.min(JUSTICE.levels.length, Math.floor(Number(o.wanted) || 0)));
    if (o.stats) for (const k of Object.keys(this.stats) as (keyof Justice['stats'])[]) this.stats[k] = Number(o.stats[k]) || 0;
    this.unseen = 0;
    this.since = this.h.time;
    if (this.wanted > 0) this.h.pursue(this.wanted);
    this.onChange?.(this.wanted);
  }

  /** A good deed cools things down. */
  atone(amount: number): void {
    if (this.wanted > 0) return;
    this.heat = Math.max(0, this.heat - amount);
  }

  /** Can the player turn themselves in now (anything to clear)? */
  get hot(): boolean { return this.wanted > 0 || this.heat >= 1; }

  /** E next to an officer / police car: cleared at a cost. */
  turnIn(): void {
    const H = this.h;
    const cost = JUSTICE.turnInBase + JUSTICE.turnInPer * this.wanted;
    H.karma(-cost, 'turned yourself in');
    H.rep(1, 'turned yourself in');
    H.toast(H.noKarma ? 'You turned yourself in — a clean slate' : `You turned yourself in — a fine of <b>${cost} karma</b>, and a clean slate`, 'info');
    this.heat = 0;
    this.wanted = 0;
    this.unseen = 0;
    this.stats.turnIns++;
    this.onChange?.(0);
  }

  /** Cuffed by the police. */
  arrested(): void {
    const H = this.h;
    const fine = JUSTICE.fineBase + JUSTICE.finePer * Math.max(1, this.wanted);
    H.karma(-fine, 'arrested');
    H.rep(-5, 'arrested');
    H.toast(H.noKarma ? 'Arrested — a night in a cell' : `Arrested — a night in a cell, a fine of <b>${fine} karma</b>`, 'warn');
    this.heat = 0;
    this.wanted = 0;
    this.unseen = 0;
    this.stats.arrests++;
    this.onChange?.(0);
  }
}
