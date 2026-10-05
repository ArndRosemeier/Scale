/**
 * A channelled operation (VILLAINS_PLAN §3.2, Phase 3): a few members of a group go to a spot and
 * one or more of them work at something for a while — the techno-cult hacking the street's robots
 * (Hijack), the elemental cult chanting in a circle (Ritual). The work shows (the world's `opFx`:
 * glow, sparks, a rune ring) and grows; left alone it finishes and something happens (`done`);
 * caught at it they break off and weigh the hero up (fight, run, give up) — an interrupted one is
 * never finished. Guards keep an eye on the street meanwhile.
 *
 * Subclasses place the people (`place`) and say what happens when it is done (`finished`).
 */
import { Crime, type CrimeWorld, setState, stand, lookAt, goTo, subdued } from './Crime';
import type { PedAgent } from '../../sim/Pedestrians';
import { hold } from '../../sim/actors/Actor';

export interface ChannelSpec {
  /** Seconds of work to finish. */
  workFor: number;
  approachTimeout: number;
  /** The hero this close (or a blow landed) breaks it off. */
  noticeR: number;
  hp: number;
  strength: number;
  /** Hands raised to the sky (a ritual) rather than at waist height (a hack). */
  high: boolean;
}

/** The look of the work (CrimeWorld.opFx): a hack, or a ritual of an element. */
export type OpLook = 'hack' | 'fire' | 'frost' | 'storm';

export abstract class Channeling extends Crime {
  /** Where the work happens (the circle's centre, the robot being hacked). */
  site: { x: number; z: number; nx: number; nz: number } | null = null;
  /** Seconds of work done. */
  progress = 0;
  /** Finished (the effect happened). */
  done = false;
  protected confronted = false;

  constructor(w: CrimeWorld, seed: number, protected near: { x: number; z: number } | null, readonly spec: ChannelSpec) {
    super(w, seed);
  }

  /** Each member's post (`memo.postX/Z`) and whether they work (`memo.work` = 1) or guard. */
  protected abstract place(): boolean;
  /** The work is done: the world does what it does. */
  protected abstract finished(): void;
  /** The look of the work. */
  protected abstract get look(): OpLook;
  /** Every frame of the work (sounds). */
  protected working(_dt: number): void { /* none */ }

  get share(): number { return Math.min(1, this.progress / this.spec.workFor); }

  setup(): boolean {
    if (!this.place() || !this.criminals.length || !this.site) return false;
    this.x = this.site.x; this.z = this.site.z;
    this.hot.x = this.site.x; this.hot.z = this.site.z;
    return true;
  }

  /** A member walking in from out of view towards their post. */
  protected member(px: number, pz: number, from: number, work: boolean, i: number): PedAgent | null {
    const S = this.site!;
    let c: PedAgent | null = null;
    for (let k = 0; k < 8 && !c; k++) {
      const ang = from + (k - 3) * 0.35, r = 26 + k * 4;
      const x = S.x + Math.sin(ang) * r, z = S.z + Math.cos(ang) * r;
      if (this.w.visible(x, 1, z) && this.distToPlayer({ x, z }) < 90) continue;
      const u = this.rng.float();
      c = this.spawnCriminal(x, z, Math.atan2(x - S.x, z - S.z), { hp: this.spec.hp, maxHp: this.spec.hp, strength: this.spec.strength * (0.9 + this.rng.float() * 0.25), armed: !work && u < 0.35 ? 'bat' : 'none' });
    }
    if (!c) return null;
    const act = c.actor!;
    act.held = act.armed === 'bat' ? 'club_bat' : null;
    act.memo.postX = px; act.memo.postZ = pz;
    act.memo.work = work ? 1 : 0;
    act.memo.brave = work ? 0 : 1;
    act.memo.role = i;
    return c;
  }

  protected step(dt: number): void {
    const S = this.site!;
    const crooks = this.criminals.filter((c) => c.alive && c.actor && c.actor.state !== 'gone');
    switch (this.phase) {
      case 'approach': {
        if (!crooks.length || this.phaseT > this.spec.approachTimeout) { this.abort(); return; }
        let there = 0;
        for (const c of crooks) {
          const act = c.actor!;
          if (Math.hypot(act.memo.postX - c.x, act.memo.postZ - c.z) < 0.7) { there++; stand(act); continue; }
          setState(act, 'walk');
          goTo(act, act.memo.postX, act.memo.postZ, 1.5);
        }
        // Everyone at their post (or the workers, after a while): it begins.
        const workers = crooks.filter((c) => c.actor!.memo.work);
        if (there === crooks.length || (this.phaseT > 25 && workers.every((c) => Math.hypot(c.actor!.memo.postX - c.x, c.actor!.memo.postZ - c.z) < 0.7))) this.commit();
        break;
      }
      case 'commit': {
        if (this.reactToPlayer(crooks, dt)) break;
        const p = this.w.player;
        let working = 0;
        for (const c of crooks) {
          const act = c.actor!;
          if (subdued(act) || act.state === 'down') continue;
          stand(act);
          setState(act, 'idle');
          if (act.memo.work) {
            lookAt(act, S.x, c.y + (this.spec.high ? 1.8 : 0.6), S.z);
            act.mood = 'focused';
            if (!act.action || act.action.id !== 'channel') hold(act, 'channel', 2);
            if (act.staggerT <= 0) working++;
          } else lookAt(act, p.x, p.y + 1.5, p.z);
        }
        if (working) { this.progress += dt; this.working(dt); }
        this.w.opFx?.(this.look, S.x, S.z, this.share, crooks.filter((c) => c.actor!.memo.work && !subdued(c.actor!) && c.actor!.state !== 'down'));
        if (this.progress >= this.spec.workFor) {
          this.done = true;
          this.finished();
          this.emit('done');
          for (const c of crooks) { const act = c.actor!; if (act.action?.id === 'channel') act.action = null; act.face = null; act.memo.calm = 1; setState(act, 'run'); }
          this.go('escape');
        }
        break;
      }
      case 'escape':
      case 'subdued': {
        if (this.reactToPlayer(crooks, dt)) break;
        for (const c of crooks) {
          const act = c.actor!;
          if (subdued(act) || act.state === 'down') continue;
          if (act.state === 'fight') this.fight(c, dt);
          else this.flee(c, dt);
        }
        break;
      }
      default: break;
    }
  }

  private commit(): void {
    for (const c of this.criminals) if (c.actor) c.actor.hostile = true;
    if (!this.policeCalled) { this.policeCalled = true; this.w.callPolice(this, 50); }
    this.go('commit');
    this.emit('commit');
  }

  /**
   * The hero comes close (or lands a blow): the work stops (never finished); guards and a
   * lieutenant stand and fight, the others weigh it up. True when this took the frame.
   */
  private reactToPlayer(crooks: PedAgent[], dt: number): boolean {
    const close = crooks.some((c) => this.distToPlayer(c) < this.spec.noticeR) || this.playerAttacked;
    if (!close && !this.confronted) return false;
    if (!this.confronted) {
      this.confronted = true;
      this.playerInvolved = true;
      for (const c of crooks) if (c.actor?.action?.id === 'channel') c.actor.action = null;
      if (this.phase === 'commit') this.go('escape');
    }
    for (const c of crooks) {
      const act = c.actor!;
      if (subdued(act) || act.state === 'down') continue;
      if (act.memo.decHp !== act.hp) {
        act.memo.decHp = act.hp;
        const d = this.decide(c);
        act.memo.choice = d === 'surrender' ? 2 : d === 'fight' || (act.memo.brave && act.hp > act.maxHp * 0.5) ? 1 : 0;
        if (act.memo.choice === 1) this.emit('fight', c);
      }
      if (act.memo.choice === 2) { if (act.state !== 'surrender') this.surrender(c); continue; }
      if (act.memo.choice === 1 && this.distToPlayer(c) < 25) this.fight(c, dt);
      else { act.memo.panic = 4; this.flee(c, dt); }
    }
    return true;
  }
}
