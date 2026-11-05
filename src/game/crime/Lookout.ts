/**
 * Lookouts (GAME_MASTER_PLAN §2.2, phase 3): a group's members seen before or after one of its big
 * moves. Signs, not crimes: they do nothing illegal while they are watched, so they call no police.
 *
 *   casing   two or three members at the site of a boss operation planned for later (suits
 *            watching the bank, robes by the cathedral, hackers at a robot port), looking it over
 *            for a while, then walking off. Seen, it goes into the tracker. Come close and they
 *            break off; caught, one of them tells when the job is (CrimeSystem `stopped`).
 *   taunt    after the hero hurt the group (a boss operation stopped, a stash busted), one member
 *            walks up, says the group's answer to the hero's face (CrimeSystem 'taunt' event: an
 *            important bubble) and runs off. The calling card.
 *
 * Coming close makes them hostile like any crook (they run, the brave square up); stopping them is
 * a small deed (kinds.ts), letting them go is nothing (no turf for the group).
 */
import { Crime, type CrimeWorld, setState, stand, lookAt, goTo, subdued } from './Crime';
import type { PedAgent } from '../../sim/Pedestrians';

export const LOOKOUT = {
  hp: 50, strength: 0.95,
  /** Seconds of watching the site (casing). */
  watchFor: 150,
  /** Members casing a site, how far from it they stand (m). */
  casers: [2, 3] as [number, number], standOff: [10, 16] as [number, number],
  /** The hero this close (and in view) makes them break off; a taunter stops this far from the hero. */
  noticeR: 11, tauntAt: 6.5,
  /** Seconds a taunter takes to reach the hero before giving up; seconds standing after the line. */
  tauntTimeout: 45, tauntHold: 2.6,
};

export type LookoutMode = 'casing' | 'taunt';
export interface LookoutSite { x: number; z: number; nx: number; nz: number }

export class Lookout extends Crime {
  readonly tier = 1;
  /** Casing: they watched the whole time and left unseen-to (nothing more to do). */
  watched = false;
  /** Taunt: the line was said (CrimeSystem shows it on the 'taunt' event). */
  said = false;
  /** Taunt: what the hero did to the group (the game master's calling card picks the words). */
  memoWhy: 'op' | 'stash' | null = null;
  private confronted = false;
  private holdT = 0;

  constructor(w: CrimeWorld, seed: number, readonly kind: LookoutMode, readonly site: LookoutSite | null = null) {
    super(w, seed);
  }

  setup(): boolean {
    const P = this.w.player;
    if (this.kind === 'casing') {
      const S = this.site;
      if (!S) return false;
      const n = this.rng.int(LOOKOUT.casers[0], LOOKOUT.casers[1]), ax = -S.nz, az = S.nx;
      for (let i = 0; i < n; i++) {
        const off = LOOKOUT.standOff[0] + this.rng.float() * (LOOKOUT.standOff[1] - LOOKOUT.standOff[0]), side = (i - (n - 1) / 2) * 3.2;
        const px = S.x + S.nx * off + ax * side, pz = S.z + S.nz * off + az * side;
        if (this.w.blocked?.(px, pz)) continue;
        const c = this.comeIn(px, pz, S.x, S.z);
        if (c) { c.actor!.memo.postX = px; c.actor!.memo.postZ = pz; c.actor!.memo.role = i; }
      }
      if (!this.criminals.length) return false;
      this.x = S.x; this.z = S.z;
    } else {
      const c = this.comeIn(P.x, P.z, P.x, P.z);
      if (!c) return false;
      c.actor!.memo.brave = 0;
      this.x = P.x; this.z = P.z;
    }
    this.hot.x = this.x; this.hot.z = this.z;
    return true;
  }

  /** A member walking in from out of the hero's view towards a point. */
  private comeIn(px: number, pz: number, fx: number, fz: number): PedAgent | null {
    const from = this.rng.float() * Math.PI * 2;
    for (let k = 0; k < 12; k++) {
      const ang = from + k * 0.52, r = 28 + k * 3;
      const x = px + Math.sin(ang) * r, z = pz + Math.cos(ang) * r;
      if (this.w.blocked?.(x, z)) continue;
      if (this.w.visible(x, 1, z) && this.distToPlayer({ x, z }) < 70) continue;
      const c = this.spawnCriminal(x, z, Math.atan2(fx - x, fz - z), { hp: LOOKOUT.hp, maxHp: LOOKOUT.hp, strength: LOOKOUT.strength, armed: 'none' });
      if (c) return c;
    }
    return null;
  }

  protected step(dt: number): void {
    const crooks = this.criminals.filter((c) => c.alive && c.actor && c.actor.state !== 'gone');
    if (!crooks.length) { if (!this.committed) this.abort(); return; }
    if (this.phase === 'approach') {
      if (this.kind === 'casing') this.casing(crooks, dt);
      else this.taunting(crooks[0], dt);
      return;
    }
    // Broken off: they run (the brave square up), like any crook.
    for (const c of crooks) {
      const act = c.actor!;
      if (subdued(act) || act.state === 'down') continue;
      this.rethink(c, (d) => (d === 'surrender' ? 2 : d === 'fight' ? 1 : 0));
      this.actOnChoice(c, dt);
    }
  }

  private casing(crooks: PedAgent[], dt: number): void {
    const S = this.site!;
    if (crooks.some((c) => this.distToPlayer(c) < LOOKOUT.noticeR && this.w.visible(c.x, c.y + 1, c.z))) { this.breakOff(); return; }
    let there = 0;
    for (const c of crooks) {
      const act = c.actor!, px = act.memo.postX ?? c.x, pz = act.memo.postZ ?? c.z;
      if (Math.hypot(c.x - px, c.z - pz) > 0.8 && !act.memo.at) { setState(act, 'walk'); goTo(act, px, pz, 1.4); continue; }
      act.memo.at = 1;
      there++;
      stand(act);
      setState(act, 'idle');
      lookAt(act, S.x, c.y + 1.6, S.z);
      act.mood = 'focused';
      // Now and then one points at the place.
      act.memo.pointT = (act.memo.pointT ?? 4 + (act.memo.role ?? 0) * 3) - dt;
      if (act.memo.pointT < 0 && !act.action) { act.memo.pointT = 7 + this.rng.float() * 6; act.action = { id: 'gesture_point', age: 0, dur: 1.6 }; }
    }
    if (there) this.watched = true;
    if (this.phaseT > LOOKOUT.watchFor + 40) {
      // Done looking: they go back to the street (CrimeSystem hands them back) without a trace.
      this.abort();
    }
  }

  private taunting(c: PedAgent, dt: number): void {
    const act = c.actor!, P = this.w.player, d = this.distToPlayer(c);
    if (!this.said) {
      if (this.phaseT > LOOKOUT.tauntTimeout || P.flying) { this.abort(); return; }
      if (d > LOOKOUT.tauntAt) { setState(act, 'walk'); goTo(act, P.x, P.z, 1.6); return; }
      stand(act);
      setState(act, 'idle');
      act.face = { x: P.x, y: P.y + P.height * 0.9, z: P.z };
      act.mood = 'angry';
      act.action = { id: 'gesture_point', age: 0, dur: 1.6 };
      this.said = true;
      this.holdT = LOOKOUT.tauntHold;
      this.emit('taunt', c);
      return;
    }
    act.face = { x: P.x, y: P.y + P.height * 0.9, z: P.z };
    this.holdT -= dt;
    if (this.holdT <= 0) this.breakOff();
  }

  /** The hero came close (or the line was said): off they go; from now on they are crooks like any. */
  private breakOff(): void {
    if (this.confronted) return;
    this.confronted = true;
    for (const c of this.criminals) if (c.actor) { c.actor.hostile = true; c.actor.face = null; c.actor.action = null; setState(c.actor, 'run'); }
    this.go('escape');
  }
}
