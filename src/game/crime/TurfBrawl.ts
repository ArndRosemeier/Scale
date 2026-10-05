/**
 * Turf brawl (VILLAINS_PLAN §3.3, Phase 2): two rival groups meet on a street at the edge of their
 * turfs and fight it out — fists, bats, the odd knife. Each member picks the nearest rival still on
 * their feet; the badly hurt run. Left alone, one side is beaten and the winners swagger off: their
 * group gains the street, the losers lose it. The player can break it up (both groups lose ground)
 * or wait and clean up the winners; whoever they come close to weighs them up (fight, run, give up).
 */
import { Crime, type CrimeWorld, setState, stand, lookAt, goTo, play, subdued } from './Crime';
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';
import type { Armed } from '../../sim/actors/Actor';

export const BRAWL = { ringMin: 70, ringMax: 260, hp: 50, strength: 1, meetR: 8, approachTimeout: 70, noticeR: 12, fleeHp: 0.3, reach: 1.15, hitR: 1.75, windup: 0.32 };

/** Impulse of a blow (N·s) by weapon: a few blows put someone down (Combat: dmg = J × 0.06). */
const BLOW: Record<Armed, number> = { none: 330, bat: 520, knife: 380, gun: 330 };

export class TurfBrawl extends Crime {
  readonly kind = 'brawl' as const;
  readonly tier = 1;
  /** The other group (`faction` is the side whose street it is). */
  rival = -1;
  /** The group that won (a faction id) once the other side is beaten; -1: still fighting, or the player broke it up. */
  winner = -1;
  meet: { x: number; z: number } | null = null;
  private confronted = false;

  constructor(w: CrimeWorld, seed: number, private near: { x: number; z: number } | null = null) {
    super(w, seed);
  }

  /** Side of a member: 0 the street's own group, 1 the rivals. */
  side(c: PedAgent): number { return c.actor?.memo.side ?? 0; }

  /** Members of a side still in it (standing or knocked down, not out, not given up, not run off). */
  standing(side: number): PedAgent[] {
    return this.criminals.filter((c) => c.alive && c.actor && this.side(c) === side && !subdued(c.actor) && c.actor.state !== 'gone' && !c.actor.memo.out);
  }

  setup(): boolean {
    const rMin = this.near ? 0 : BRAWL.ringMin, rMax = this.near ? 80 : BRAWL.ringMax;
    // Plain doors first (a side street); in a shopping street the shop fronts do.
    let spots = this.w.walls?.(rMin, rMax) ?? [];
    if (!spots.length) spots = this.w.shops?.(rMin, rMax) ?? [];
    if (!spots.length) return false;
    const s = spots[this.rng.int(0, Math.min(spots.length, 8) - 1)];
    // On the pavement in front of a door; the two sides come along the street from either end.
    const mx = s.x + s.nx * 2.6, mz = s.z + s.nz * 2.6;
    const ax = -s.nz, az = s.nx;
    for (let side = 0; side < 2; side++) {
      const dir = side ? 1 : -1;
      const n = 2 + (this.rng.chance(0.5) ? 1 : 0);
      for (let i = 0; i < n; i++) {
        let c: PedAgent | null = null;
        for (let k = 0; k < 6 && !c; k++) {
          const along = dir * (24 + k * 5 + i * 1.8), out = (i - 1) * 1.1;
          const x = mx + ax * along + s.nx * out, z = mz + az * along + s.nz * out;
          if (this.w.visible(x, 1, z) && this.distToPlayer({ x, z }) < 90) continue;
          const u = this.rng.float();
          c = this.spawnCriminal(x, z, Math.atan2(ax * dir, az * dir), { hp: BRAWL.hp, maxHp: BRAWL.hp, strength: BRAWL.strength * (0.9 + this.rng.float() * 0.3), armed: u < 0.3 ? 'bat' : u < 0.42 ? 'knife' : 'none' });
        }
        if (!c) break;
        const act = c.actor!;
        act.held = act.armed === 'bat' ? 'club_bat' : act.armed === 'knife' ? 'knife' : null;
        act.memo.side = side;
        act.memo.brave = this.rng.chance(0.5) ? 1 : 0;
      }
    }
    if (!this.standing(0).length || !this.standing(1).length) return false;
    this.meet = { x: mx, z: mz };
    this.x = mx; this.z = mz;
    this.hot.x = mx; this.hot.z = mz;
    return true;
  }

  protected step(dt: number): void {
    const M = this.meet!;
    const crooks = this.criminals.filter((c) => c.alive && c.actor && c.actor.state !== 'gone');
    switch (this.phase) {
      case 'approach': {
        if (this.phaseT > BRAWL.approachTimeout || !this.standing(0).length || !this.standing(1).length) { this.abort(); return; }
        // Both sides walk up to the spot, squaring up.
        let met = false;
        for (const c of crooks) {
          const act = c.actor!, sd = this.side(c);
          // Up to the spot, stopping short on their own side of it.
          const al = Math.hypot(M.x - c.x, M.z - c.z) || 1;
          const tx = M.x + ((c.x - M.x) / al) * 1.6, tz = M.z + ((c.z - M.z) / al) * 1.6;
          setState(act, 'walk');
          goTo(act, tx, tz, 1.6);
          act.mood = 'angry';
          for (const o of crooks) if (this.side(o) !== sd && Math.hypot(o.x - c.x, o.z - c.z) < BRAWL.meetR) met = true;
        }
        if (met) this.commit();
        break;
      }
      case 'commit': {
        if (this.reactToPlayer(crooks, dt)) break;
        for (const c of crooks) {
          const act = c.actor!;
          if (subdued(act) || act.state === 'down' || c.state === PState.Down) continue;
          if (act.memo.out) { this.flee(c, dt); continue; }
          // Badly hurt: they run (the brave keep going a little longer).
          if (act.hp < act.maxHp * BRAWL.fleeHp * (act.memo.brave ? 0.6 : 1)) { act.memo.out = 1; act.memo.panic = 3; this.flee(c, dt); continue; }
          const t = this.target(c);
          if (t) this.brawl(c, t, dt);
          else { stand(act); setState(act, 'idle'); }
        }
        // One side beaten (nobody of theirs still in it): the others won the street.
        const a = this.standing(0).length, b = this.standing(1).length;
        if ((a === 0) !== (b === 0)) this.won(a ? 0 : 1);
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
    for (const c of this.criminals) if (c.actor) { c.actor.hostile = true; setState(c.actor, 'fight'); }
    if (!this.policeCalled) { this.policeCalled = true; this.w.callPolice(this, 35); }
    const M = this.meet!;
    this.w.emit('cry', M.x, 1.6, M.z, 1.4, 34);
    this.w.sound('scream_single', M.x, 1.6, M.z, 0.45, 0.8);
    this.go('commit');
    this.emit('commit');
  }

  /** The nearest rival still in it (within 30 m). */
  private target(c: PedAgent): PedAgent | null {
    const sd = this.side(c);
    let best: PedAgent | null = null, bd = 30;
    for (const o of this.standing(1 - sd)) {
      const d = Math.hypot(o.x - c.x, o.z - c.z);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  /** Close in on a rival and hit them (a wind-up, then the blow lands if they are still in reach). */
  private brawl(c: PedAgent, t: PedAgent, dt: number): void {
    const act = c.actor!;
    setState(act, 'fight');
    act.mood = 'angry';
    lookAt(act, t.x, t.y + 1.3, t.z);
    const d = Math.hypot(t.x - c.x, t.z - c.z);
    if (d > BRAWL.reach) goTo(act, t.x, t.z, d > 6 ? 4.4 : 2.4);
    else stand(act);
    const pending = act.memo.windup ?? 0;
    if (pending > 0) {
      act.memo.windup = pending - dt;
      if (act.memo.windup <= 0) {
        act.memo.windup = 0;
        const dd = Math.hypot(t.x - c.x, t.z - c.z);
        if (dd < BRAWL.hitR && act.staggerT <= 0 && c.state !== PState.Down && t.alive) {
          const J = BLOW[act.armed] * Math.sqrt(act.strength) * (0.8 + 0.4 * this.w.random());
          const ux = (t.x - c.x) / (dd || 1), uz = (t.z - c.z) / (dd || 1);
          this.w.combat.hitActor(t, ux * J, 60, uz * J, act.armed === 'bat' ? 'bat' : act.armed === 'knife' ? 'knife' : 'punch', 'npc', c.x, c.z);
          this.w.sound('punch_impact', t.x, t.y + 1.2, t.z, 0.55, act.armed === 'bat' ? 0.8 : 1);
        }
      }
    } else if (d < BRAWL.hitR - 0.15 && act.attackT <= 0 && act.staggerT <= 0) {
      act.attackT = (act.armed === 'none' ? 1.0 : 1.2) + this.w.random() * 0.6;
      act.memo.windup = BRAWL.windup;
      play(act, act.armed === 'knife' ? 'stab' : act.armed === 'bat' ? 'swing_1h' : this.w.random() < 0.7 ? 'punch' : 'kick', 0.7);
    }
  }

  /** One side is beaten: the winners take the street and walk off. */
  private won(side: number): void {
    this.winner = side === 0 ? this.faction : this.rival;
    this.emit('won');
    for (const c of this.standing(side)) {
      const act = c.actor!;
      act.memo.calm = 1;
      act.memo.choice = 0;
      act.face = null;
      play(act, 'cheer', 1.6);
      setState(act, 'run');
    }
    this.go('escape');
  }

  /**
   * The player comes close (or hits one of them): the brawl is broken up. Those near the player
   * decide (fight them, run, give up); the rest scatter. Returns true when this took the frame.
   */
  private reactToPlayer(crooks: PedAgent[], dt: number): boolean {
    const close = crooks.some((c) => this.distToPlayer(c) < BRAWL.noticeR) || this.playerAttacked;
    if (!close && !this.confronted) return false;
    if (!this.confronted) {
      this.confronted = true;
      this.playerInvolved = true;
      if (this.phase === 'commit') {
        this.go('escape');
        // Broken up before either side won: that is the stop (paid now, not when the police cuff the last of them).
        if (this.winner < 0 && !this.wasSubdued) { this.wasSubdued = true; this.emit('subdued'); }
      }
    }
    for (const c of crooks) {
      const act = c.actor!;
      if (subdued(act) || act.state === 'down') continue;
      if (act.memo.decHp !== act.hp) {
        act.memo.decHp = act.hp;
        const d = this.decide(c);
        act.memo.choice = d === 'surrender' ? 2 : d === 'fight' ? 1 : 0;
        if (act.memo.choice === 1) this.emit('fight', c);
      }
      if (act.memo.choice === 2) { if (act.state !== 'surrender') this.surrender(c); continue; }
      if (act.memo.choice === 1 && this.distToPlayer(c) < 25) this.fight(c, dt);
      else { act.memo.panic = 4; this.flee(c, dt); }
    }
    return true;
  }
}
