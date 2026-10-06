/**
 * Officers walking the beat (game/news: police presence by crime index). Where the crime index is
 * low the streets around the player have pairs of uniformed officers strolling along the
 * sidewalks (game/news/pulse beatPairs: up to three pairs); in rough areas there are none.
 *
 * They come in out of view, walk a sidewalk route to a point a block or two away, pick the next
 * one (drifting toward the player), and leave unseen when the player is far. A crime breaking out
 * near them (or the player wanted close by) and they step in at once: they run in and take the
 * criminals down and cuff them like a patrol car's officers (Police.footCrime / footPlayer), and a
 * car is called to take the arrested away. Then they go back to their round.
 */
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';
import { followRoute, goTo, setState, stand, lookAt, endPursuit } from '../../sim/actors/Actor';
import type { Crime } from './Crime';
import type { Police } from './Police';
import { beatPairs } from '../news/pulse';

export const BEAT = {
  /** Seconds between two looks at the pairs (spawning, leaving, crimes near). */
  tick: 1.2,
  /** Where pairs come in (m from the player) and how far they are left to wander. */
  spawnMin: 70, spawnMax: 140, dropR: 210,
  /** A walk's length (m) and pace (m/s). */
  leg: 160, pace: 1.3,
  /** They step in at crimes within this (m), at a wanted player within this. */
  respondR: 85, playerR: 55,
  /** Seconds with nothing to do at a scene before they walk on. */
  idle: 5,
};

export interface BeatHost {
  player: { x: number; z: number };
  /** Police presence at a point (0..1). */
  presence(x: number, z: number): number;
  /** No officers on the beat now (underground, crime off, the origin scene …). */
  paused(): boolean;
  spawnOfficer(seed: number, x: number, z: number, heading: number): PedAgent | null;
  route(ax: number, az: number, bx: number, bz: number): Float32Array | null;
  visible(x: number, y: number, z: number): boolean;
  crimes(): readonly Crime[];
  wanted(): number;
  police: Police;
  /** A free actor slot for two more (the crime layer's budget). */
  room(): boolean;
}

interface Pair {
  officers: PedAgent[];
  job: Crime | 'player' | null;
  idleT: number;
  /** Seconds since it came in (they are not taken back while just arrived). */
  age: number;
}

export class Beat {
  readonly pairs: Pair[] = [];
  private t = 0;
  private seed = 0x5eed;
  stats = { spawned: 0, left: 0, steppedIn: 0 };

  constructor(private h: BeatHost) {}

  /** Officers on the beat (for "officers near" and armed criminals). */
  *officers(): Iterable<PedAgent> {
    for (const p of this.pairs) for (const o of p.officers) if (o.alive && o.actor && o.state !== PState.Down) yield o;
  }

  update(dt: number): void {
    const H = this.h;
    for (const p of this.pairs) p.age += dt;
    this.t -= dt;
    if (this.t <= 0) { this.t = BEAT.tick; this.look(); }
    for (const p of this.pairs) this.step(p, dt);
  }

  /** Remove everyone (crime off, a save loaded). */
  clear(): void {
    for (const p of this.pairs) for (const o of p.officers) o.alive = false;
    this.pairs.length = 0;
  }

  private look(): void {
    const H = this.h, P = H.player;
    // Gone: both officers out (down for good, removed) or the pair far off and out of sight.
    for (let i = this.pairs.length - 1; i >= 0; i--) {
      const p = this.pairs[i];
      p.officers = p.officers.filter((o) => o.alive && o.actor?.role === 'police');
      const lead = p.officers[0];
      const far = !lead || (p.job === null && Math.hypot(lead.x - P.x, lead.z - P.z) > BEAT.dropR && !p.officers.some((o) => H.visible(o.x, o.y + 1, o.z)));
      if (!lead || far || (H.paused() && p.job === null)) {
        for (const o of p.officers) o.alive = false;
        this.pairs.splice(i, 1);
        this.stats.left++;
      }
    }
    if (H.paused()) return;
    // Step in: a crime near a pair (the nearest free pair goes), or a wanted player close by.
    for (const c of H.crimes()) {
      if (!c.active || !c.committed || c.criminals.every((a) => !a.alive)) continue;
      if (this.pairs.some((p) => p.job === c)) continue;
      let best: Pair | null = null, bd = BEAT.respondR;
      for (const p of this.pairs) {
        if (p.job || !p.officers[0]) continue;
        const d = Math.hypot(p.officers[0].x - c.hot.x, p.officers[0].z - c.hot.z);
        if (d < bd) { bd = d; best = p; }
      }
      if (!best) continue;
      best.job = c;
      best.idleT = 0;
      this.stats.steppedIn++;
      // A car comes for the arrested (once).
      if (!H.police.covered(c)) H.police.call(c, 4);
    }
    if (H.wanted() > 0) {
      for (const p of this.pairs) if (!p.job && p.officers[0] && Math.hypot(p.officers[0].x - P.x, p.officers[0].z - P.z) < BEAT.playerR) { p.job = 'player'; p.idleT = 0; }
    }
    // Come in: as many pairs as the area's presence asks for.
    const want = beatPairs(H.presence(P.x, P.z));
    if (this.pairs.length < want && H.room()) this.spawnPair();
  }

  private spawnPair(): void {
    const H = this.h, P = H.player;
    for (let k = 0; k < 10; k++) {
      const a = this.rand() * Math.PI * 2, r = BEAT.spawnMin + this.rand() * (BEAT.spawnMax - BEAT.spawnMin);
      const x = P.x + Math.cos(a) * r, z = P.z + Math.sin(a) * r;
      const R = this.leg(x, z);
      if (!R) continue;
      const sx = R[0], sz = R[1];
      if (Math.hypot(sx - P.x, sz - P.z) < BEAT.spawnMin * 0.7 || H.visible(sx, 1, sz)) continue;
      const hd = R.length >= 6 ? Math.atan2(-(R[3] - sx), -(R[4] - sz)) : 0;
      const o1 = H.spawnOfficer(this.next(), sx, sz, hd);
      if (!o1) return;
      const o2 = H.spawnOfficer(this.next(), sx + Math.cos(hd) * 1.1, sz - Math.sin(hd) * 1.1, hd);
      const p: Pair = { officers: o2 ? [o1, o2] : [o1], job: null, idleT: 0, age: 0 };
      o1.actor!.route = R;
      o1.actor!.wp = 1;
      this.pairs.push(p);
      this.stats.spawned++;
      return;
    }
  }

  /** A walking route from a point to somewhere a leg away (biased toward the player). */
  private leg(x: number, z: number): Float32Array | null {
    const P = this.h.player;
    const toP = Math.atan2(P.z - z, P.x - x);
    const a = toP + (this.rand() - 0.5) * 2.4;
    const R = this.h.route(x, z, x + Math.cos(a) * BEAT.leg, z + Math.sin(a) * BEAT.leg);
    return R && R.length >= 6 ? R : null;
  }

  private step(p: Pair, dt: number): void {
    const H = this.h;
    const free = p.officers.filter((o) => o.alive && o.actor && o.state !== PState.Down);
    if (!free.length) return;
    if (p.job) {
      const busy = p.job === 'player' ? H.police.footPlayer(free, dt) : H.police.footCrime(free, p.job, dt);
      if (busy) { p.idleT = 0; return; }
      p.idleT += dt;
      if (p.idleT < BEAT.idle) { for (const o of free) stand(o.actor!); return; }
      // Back on the round.
      p.job = null;
      for (const o of free) { const act = o.actor!; act.hostile = false; act.action = null; act.held = null; act.mood = 'neutral'; act.face = null; endPursuit(act); }
      const lead = free[0];
      lead.actor!.route = this.leg(lead.x, lead.z);
      lead.actor!.wp = 1;
      return;
    }
    // Walking: the first leads along the route, the other keeps beside them.
    const lead = free[0], la = lead.actor!;
    la.hostile = false;
    if (!followRoute(lead, la, BEAT.pace)) {
      la.route = this.leg(lead.x, lead.z);
      la.wp = 1;
      if (!la.route) { stand(la); setState(la, 'idle'); }
    } else setState(la, 'walk');
    la.face = null;
    for (let i = 1; i < free.length; i++) {
      const o = free[i], act = o.actor!;
      act.hostile = false;
      // Beside and a little behind the leader, on their right.
      const hx = -Math.sin(lead.heading), hz = -Math.cos(lead.heading);
      const tx = lead.x - hx * 0.5 - hz * 1.0, tz = lead.z - hz * 0.5 + hx * 1.0;
      const d = Math.hypot(tx - o.x, tz - o.z);
      if (d > 0.6) { goTo(act, tx, tz, d > 4 ? 2.6 : Math.max(BEAT.pace, la.speed) * (d > 1.5 ? 1.25 : 1)); setState(act, d > 4 ? 'run' : 'walk'); }
      else { stand(act); setState(act, la.speed > 0.2 ? 'walk' : 'idle'); }
      if (la.speed < 0.2) lookAt(act, lead.x, lead.y + 1.6, lead.z); else act.face = null;
    }
  }

  private next(): number { return (this.seed = (this.seed * 1103515245 + 12345) >>> 0); }
  private rand(): number { return this.next() / 4294967296; }
}
