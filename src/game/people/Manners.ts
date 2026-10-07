/**
 * Behaviour from personality around the hero (NPC_PERSONALITY_PLAN §3.5, phase 2; the rules are
 * in behaviour.ts):
 *
 *  - People who dislike you (what you did to them, or your reputation for the agreeable) keep out
 *    of your way: they step aside as you come near and walk on instead of standing by you.
 *  - Kind passers-by help up someone who fell (an everyday fall is left to the hero for a while:
 *    that is the hero's good deed to do).
 *  - Agreeable people point after a thief running past, so you see where they went.
 *  - People who know and like you stop and wave (People.greet decides when).
 *
 * The helpers, pointers and wavers are brief actors of PEOPLE_OWNER (their own small budget,
 * MANNERS.maxBusy at once); they go back to their day when done or when anything gets in the way.
 */
import type { Game } from '../Game';
import type { People } from './People';
import { PState, type PedAgent } from '../../sim/Pedestrians';
import { Role } from '../../sim/Population';
import { makeActor, release, goTo, stand, lookAt, play, PEOPLE_OWNER, type Actor } from '../../sim/actors/Actor';
import { opinionOf } from './memory';
import { MANNERS, berthOf, helps, points, reactLine, type Moment } from './behaviour';

type JobKind = 'help' | 'point' | 'wave';

interface Job {
  kind: JobKind;
  a: PedAgent;
  act: Actor;
  /** Seconds since it began, and since the current step began. */
  t: number;
  stepT: number;
  step: 'go' | 'kneel' | 'up' | 'show';
  /** Who they help up / point at. */
  who: PedAgent | null;
}

/** States of people free to step in (walking, standing, looking). */
const FREE = new Set<PState>([PState.Walk, PState.Idle, PState.Wait, PState.Gawk, PState.Film]);

/** Out in the street on their own (not driven by anyone, not indoors, in a landmark's hall, underground or evacuating). */
function free(a: PedAgent): boolean {
  return a.alive && !a.actor && !a.inside && !a.hall && !a.under && !a.evac && FREE.has(a.state);
}

export class Manners {
  private jobs: Job[] = [];
  private awayT = 0;
  private scanT = 0;
  /** Barks already said, per citizen (keeping away): game seconds. */
  private spoke = new Map<number, number>();
  /** Thieves already pointed at (by agent id): game seconds. */
  private pointed = new Map<number, number>();
  private time = 0;
  private nb: PedAgent[] = [];

  constructor(private g: Game, private people: People) {}

  /** Someone is busy with a good turn (not to be talked to or handed another one). */
  busy(a: PedAgent): boolean {
    return this.jobs.some((j) => j.a === a || j.who === a);
  }

  /** A line for a moment in this person's temperament (null: the common line). */
  line(a: PedAgent, m: Moment): string | null {
    return reactLine(m, this.people.person(a.cit).temper, Math.random());
  }

  update(dt: number): void {
    this.time += dt;
    this.tick(dt);
    this.awayT -= dt;
    if (this.awayT <= 0) { this.awayT = 0.2; this.keepAway(); }
    this.scanT -= dt;
    if (this.scanT <= 0) { this.scanT = 1; this.findHelpers(); this.findPointers(); }
  }

  /** End everything (a save loaded, the city left). */
  clear(): void {
    for (const j of this.jobs) if (j.a.actor === j.act) release(j.a);
    this.jobs.length = 0;
  }

  // ------------------------------------------------------------------ keeping away

  /** People who dislike the hero step out of their way and don't hang around next to them. */
  private keepAway(): void {
    const g = this.g, P = g.player;
    if (P.height > 2.4 || P.flying || g.freeCam) return;
    const rep = g.crime?.rep.value ?? 0;
    const px = P.pos.x, pz = P.pos.z;
    for (const a of g.peds.neighbours(px, pz, MANNERS.berthMax * 1.2 + P.radius, this.nb)) {
      if (!free(a) || Math.abs(a.y - P.pos.y) > 2) continue;
      if (this.people.partner === a) continue;
      const p = this.people.person(a.cit);
      const op = opinionOf(this.people.find(a.cit.id), rep, p.traits.a);
      const berth = berthOf(op, p.traits) + P.radius;
      const dx = a.x - px, dz = a.z - pz, d = Math.hypot(dx, dz);
      if (berth <= P.radius || d > berth || d < 1e-3) continue;
      // Sideways off their way and away from you, the closer the harder.
      const k = 0.6 + 1.6 * (1 - d / berth);
      a.sideX = (dx / d) * k; a.sideZ = (dz / d) * k; a.sideT = 0.3;
      if (a.state !== PState.Walk) { a.state = PState.Walk; a.stateT = 0; }
      if (!a.glance) { a.glance = 1.2; a.lookX = px; a.lookY = P.pos.y + P.height * 0.9; a.lookZ = pz; }
      const last = this.spoke.get(a.cit.id) ?? -1e9;
      if (this.time - last > 90 && d < berth * 0.8) {
        this.spoke.set(a.cit.id, this.time);
        const l = Math.random() < 0.6 ? this.line(a, 'away') : null;
        if (l) g.barks?.say(a, l, 20, 'angry');
      }
    }
  }

  // ------------------------------------------------------------------ helping up

  /** Kind people near someone lying in the street go and help them up. */
  private findHelpers(): void {
    const g = this.g, P = g.player.pos;
    if (this.jobs.length >= MANNERS.maxBusy) return;
    for (const v of g.peds.neighbours(P.x, P.z, 70, [])) {
      if (v.state !== PState.Down || !v.alive || v.actor || v.inside || v.under || v.hall || v.evac || v.downBy === undefined) continue;
      if (v.stateT < (v.downBy === 'accident' ? MANNERS.helpAfterAccident : MANNERS.helpAfter) || this.busy(v)) continue;
      // Not while it is still dangerous here.
      if (this.trouble(v.x, v.z)) continue;
      let best: PedAgent | null = null, bd: number = MANNERS.helpR;
      for (const h of g.peds.neighbours(v.x, v.z, MANNERS.helpR, [])) {
        if (h === v || !free(h) || Math.abs(h.y - v.y) > 1.2) continue;
        if (this.people.partner === h || this.busy(h)) continue;
        if (!helps(this.people.person(h.cit).traits, h.fear, h.cit.role === Role.Child)) continue;
        const d = Math.hypot(h.x - v.x, h.z - v.z);
        if (d < bd) { bd = d; best = h; }
      }
      if (!best) continue;
      this.begin('help', best, v);
      if (this.jobs.length >= MANNERS.maxBusy) return;
    }
  }

  /** Harm near a point in the last half minute (someone helps once it is calm again). */
  private trouble(x: number, z: number): boolean {
    const C = this.g.consequences;
    for (let i = C.log.length - 1; i >= 0; i--) {
      const e = C.log[i];
      if (C.time - e.t > 30) break;
      if (e.cause !== 'police' && Math.abs(e.x - x) < 40 && Math.abs(e.z - z) < 40) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ pointing out a thief

  /** A thief running past: an agreeable passer-by points after them. */
  private findPointers(): void {
    const g = this.g, P = g.player.pos;
    if (this.jobs.length >= MANNERS.maxBusy) return;
    for (const c of g.peds.neighbours(P.x, P.z, 60, [])) {
      const ca = c.actor;
      if (!c.alive || !ca || ca.role !== 'criminal' || ca.state !== 'run' || c.state === PState.Down) continue;
      if (this.time - (this.pointed.get(c.id) ?? -1e9) < 6) continue;
      let best: PedAgent | null = null, bd: number = MANNERS.pointR;
      for (const w of g.peds.neighbours(c.x, c.z, MANNERS.pointR, [])) {
        if (!free(w) || this.busy(w) || this.people.partner === w) continue;
        if (!points(this.people.person(w.cit).traits, w.fear)) continue;
        // Somewhere between the thief and the hero is best: you see them point.
        const d = Math.hypot(w.x - c.x, w.z - c.z) + Math.hypot(w.x - P.x, w.z - P.z) * 0.25;
        if (d < bd) { bd = d; best = w; }
      }
      if (!best) continue;
      this.pointed.set(c.id, this.time);
      this.begin('point', best, c);
      if (this.jobs.length >= MANNERS.maxBusy) return;
    }
    if (this.pointed.size > 64) for (const [k, t] of this.pointed) if (this.time - t > 30) this.pointed.delete(k);
  }

  // ------------------------------------------------------------------ waving

  /** A person who knows and likes you stops and waves (People.greet). False: not now. */
  wave(a: PedAgent): boolean {
    if (!free(a) || this.jobs.length >= MANNERS.maxBusy + 1) return false;
    return this.begin('wave', a, null);
  }

  // ------------------------------------------------------------------ the jobs

  private begin(kind: JobKind, a: PedAgent, who: PedAgent | null): boolean {
    const p = this.people.person(a.cit);
    const act = makeActor('bystander', PEOPLE_OWNER, { title: p.full, pinned: false });
    a.actor = act;
    if (kind === 'wave') play(act, 'gesture_wave', 1.7);
    else if (kind === 'point') {
      play(act, 'gesture_point', 2.4);
      const l = this.line(a, 'point');
      if (l) this.g.barks?.say(a, l, 15);
    }
    this.jobs.push({ kind, a, act, t: 0, stepT: 0, step: kind === 'help' ? 'go' : 'show', who });
    return true;
  }

  private tick(dt: number): void {
    const P = this.g.player.pos, H = this.g.player.height;
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const j = this.jobs[i], a = j.a, act = j.act;
      j.t += dt; j.stepT += dt;
      // Someone else took them, or they were knocked down: the job is over.
      const lost = !a.alive || a.actor !== act || a.state === PState.Down || a.ragdoll;
      if (lost || !this.step(j, P.x, P.y, P.z, H)) {
        if (!lost) release(a);
        else if (a.actor === act) a.actor = undefined;
        this.jobs.splice(i, 1);
      }
    }
  }

  /** One frame of a job; false when it is done (or can't go on). */
  private step(j: Job, px: number, py: number, pz: number, H: number): boolean {
    const a = j.a, act = j.act, v = j.who;
    switch (j.kind) {
      case 'wave': {
        stand(act);
        lookAt(act, px, py + H * 0.9, pz);
        act.mood = 'happy';
        return j.t < 2;
      }
      case 'point': {
        if (!v || !v.alive) return false;
        stand(act);
        lookAt(act, v.x, v.y + 1.2, v.z);
        act.mood = 'surprised';
        return j.t < 2.6;
      }
      case 'help': {
        if (!v) return false;
        if (j.step === 'go') {
          // They got up (or the hero helped them), someone else has them, or it takes too long.
          if (!v.alive || v.state !== PState.Down || v.actor || j.t > 20) return false;
          const dx = a.x - v.x, dz = a.z - v.z, d = Math.hypot(dx, dz) || 1;
          // Beside them, on our side.
          const sx = v.x + (dx / d) * 0.75, sz = v.z + (dz / d) * 0.75;
          if (Math.hypot(a.x - sx, a.z - sz) > 0.35) { goTo(act, sx, sz, d > 6 ? 2.6 : 1.5); act.mood = 'surprised'; return true; }
          stand(act);
          act.move = 'crouch';
          lookAt(act, v.x, v.y + 0.3, v.z);
          play(act, 'pickup', 1.6);
          act.mood = 'neutral';
          j.step = 'kneel'; j.stepT = 0;
          const l = this.line(a, 'helper');
          if (l) this.g.barks?.say(a, l, 15);
          return true;
        }
        if (j.step === 'kneel') {
          if (!v.alive || v.state !== PState.Down || v.actor) { act.move = null; j.step = 'up'; j.stepT = 0; return true; }
          lookAt(act, v.x, v.y + 0.3, v.z);
          if (j.stepT < 1.3) return true;
          // Up they get: as the hero helps (game/Deeds), without the karma.
          v.state = PState.Idle; v.stateT = 0; v.fear = 0; v.vx = v.vy = v.vz = 0; v.speed = 0;
          v.helped = true; v.downBy = undefined;
          v.heading = Math.atan2(-(a.x - v.x), -(a.z - v.z));
          act.move = null;
          j.step = 'up'; j.stepT = 0;
          return true;
        }
        // A moment together, then both go on.
        lookAt(act, v.x, v.y + 1.4, v.z);
        act.mood = 'happy';
        return j.stepT < 1.6;
      }
    }
    return false;
  }
}
