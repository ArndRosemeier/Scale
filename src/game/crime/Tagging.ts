/**
 * Tagging (tier 1, a street gang's operation — VILLAINS_PLAN §3.2/§3.7). A gang member walks up to
 * a wall by the pavement, sometimes with a lookout, shakes a spray can and paints the gang's tag:
 * its emblem and name in its colours. Left alone, the tag stays on the wall (Graffiti, saved with
 * the city) and the gang's hold on the street grows; caught in the act they run (the lookout may
 * square up), and an interrupted tag is never finished.
 */
import { Crime, type CrimeWorld, setState, stand, lookAt, goTo, subdued } from './Crime';
import type { PedAgent } from '../../sim/Pedestrians';
import { hold } from '../../sim/actors/Actor';

export const TAGGING = { ringMin: 90, ringMax: 360, hp: 45, strength: 0.9, paintFor: 9, approachTimeout: 60, lookoutChance: 0.4, noticeR: 16, hissEvery: 3.3 };

/** Where a tag goes: a point on the wall at chest height, its outward normal. */
export interface TagSpot { x: number; y: number; z: number; nx: number; nz: number }

export class Tagging extends Crime {
  readonly kind = 'tagging' as const;
  readonly tier = 1;
  spot: TagSpot | null = null;
  /** Seconds of painting done (TAGGING.paintFor finishes the tag). */
  progress = 0;
  /** The tag is on the wall. */
  done = false;
  tagger: PedAgent | null = null;
  private confronted = false;
  private hissT = 0;

  constructor(w: CrimeWorld, seed: number, private near: { x: number; z: number } | null = null) {
    super(w, seed);
  }

  setup(): boolean {
    const rMin = this.near ? 0 : TAGGING.ringMin, rMax = this.near ? 90 : TAGGING.ringMax;
    const walls = this.w.walls?.(rMin, rMax) ?? this.w.shops?.(rMin, rMax) ?? [];
    if (!walls.length) return false;
    const w = walls[this.rng.int(0, Math.min(walls.length, 8) - 1)];
    // Beside the door, not on it.
    const ax = -w.nz, az = w.nx, side = this.rng.chance(0.5) ? 1 : -1;
    const sx = w.x + ax * side * 2.1, sz = w.z + az * side * 2.1;
    const n = this.rng.chance(TAGGING.lookoutChance) ? 2 : 1;
    for (let i = 0; i < n; i++) {
      let c: PedAgent | null = null;
      for (let k = 0; k < 6 && !c; k++) {
        const along = side * (22 + k * 5 + i * 2), out = 2.4;
        const x = sx + ax * along + w.nx * out, z = sz + az * along + w.nz * out;
        if (this.w.visible(x, 1, z) && this.distToPlayer({ x, z }) < 90) continue;
        c = this.spawnCriminal(x, z, Math.atan2(ax * side, az * side), { hp: TAGGING.hp, maxHp: TAGGING.hp, strength: TAGGING.strength, armed: i === 1 && this.rng.chance(0.5) ? 'bat' : 'none' });
      }
      if (!c) break;
      c.actor!.held = c.actor!.armed === 'bat' ? 'club_bat' : null;
      c.actor!.memo.brave = i === 1 ? 1 : 0;
      c.actor!.memo.role = i;
    }
    if (!this.criminals.length) return false;
    this.tagger = this.criminals[0];
    this.spot = { x: sx, y: 1.45, z: sz, nx: w.nx, nz: w.nz };
    this.x = sx; this.z = sz;
    this.hot.x = sx; this.hot.z = sz;
    return true;
  }

  protected step(dt: number): void {
    const S = this.spot!, T = this.tagger;
    const crooks = this.criminals.filter((c) => c.alive && c.actor && c.actor.state !== 'gone');
    switch (this.phase) {
      case 'approach': {
        if (!T || !T.alive || !T.actor || this.phaseT > TAGGING.approachTimeout) { this.abort(); return; }
        const fx = S.x + S.nx * 0.75, fz = S.z + S.nz * 0.75;
        crooks.forEach((c, i) => {
          const act = c.actor!;
          setState(act, 'walk');
          if (i === 0) goTo(act, fx, fz, 1.5);
          else goTo(act, S.x - S.nz * 3 + S.nx * 2.2, S.z + S.nx * 3 + S.nz * 2.2, 1.5);
        });
        if (Math.hypot(T.x - fx, T.z - fz) < 0.6) this.commit();
        break;
      }
      case 'commit': {
        // Painting: the tagger at the wall, the lookout watching the street.
        if (this.reactToPlayer(crooks, dt)) break;
        for (const c of crooks) {
          const act = c.actor!;
          stand(act);
          setState(act, 'idle');
          if (c === T) {
            lookAt(act, S.x, S.y, S.z);
            act.mood = 'focused';
            if (!act.action || act.action.id !== 'channel') hold(act, 'channel', 1.6);
          } else {
            const p = this.w.player;
            lookAt(act, p.x, p.y + 1.5, p.z);
          }
        }
        this.progress += dt;
        this.hissT -= dt;
        if (this.hissT <= 0 && T) { this.hissT = TAGGING.hissEvery; this.w.sound('spray_hiss', S.x, S.y, S.z, 0.7, 0.95 + this.rng.float() * 0.1); }
        if (this.progress >= TAGGING.paintFor) {
          // Done: the tag stays, they walk off (nobody chases them unless the player comes).
          this.done = true;
          this.emit('tagged');
          for (const c of crooks) { const act = c.actor!; if (act.action?.id === 'channel') act.action = null; setState(act, 'run'); act.face = null; act.memo.calm = 1; }
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
      default:
        break;
    }
  }

  private commit(): void {
    const T = this.tagger!;
    this.spot!.y = T.y + 1.45;
    for (const c of this.criminals) if (c.actor) c.actor.hostile = true;
    if (!this.policeCalled) { this.policeCalled = true; this.w.callPolice(this, 45); }
    this.hissT = 0.2;
    this.go('commit');
    this.emit('commit');
  }

  /** The player comes close: the tag is abandoned; each of them decides to fight, run or give up. */
  private reactToPlayer(crooks: PedAgent[], dt: number): boolean {
    const close = crooks.some((c) => this.distToPlayer(c) < TAGGING.noticeR);
    if (!close && !this.confronted) return false;
    if (close && !this.confronted) {
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
        act.memo.choice = d === 'surrender' ? 2 : d === 'fight' ? 1 : 0;
        // The tagger runs; only a brave lookout covers him.
        if (d === 'fight' && c === this.tagger && crooks.length > 1) act.memo.choice = 0;
        if (act.memo.choice === 1) this.emit('fight', c);
      }
      if (act.memo.choice === 2) { if (act.state !== 'surrender') this.surrender(c); continue; }
      if (act.memo.choice === 1 && this.distToPlayer(c) < 25) this.fight(c, dt);
      else { act.memo.panic = 4; this.flee(c, dt); }
    }
    return true;
  }
}
