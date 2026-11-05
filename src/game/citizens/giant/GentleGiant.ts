/**
 * The gentle giant: a city local about ten metres tall since one of the crystals got them earlier in
 * the year (no powers; neither hero nor villain), living with being an attraction at the stadium.
 * The rules (where, when, what they say) are in plan.ts.
 *
 *  - Body: an Actors character (a city person of the seed) in improvised underwear, drawn at ten
 *    metres. Walking is the player's giant walking (GiantBody): Froude pace (here only half of it:
 *    they walk carefully), the slow-motion gait (animation time / √k), footsteps on the gait's heel
 *    strikes through GiantSteps, but `calm` (nobody panics, nothing breaks).
 *  - The day: asleep on the pitch after the concert, up and out before the first match, about the
 *    stadium all day (walking round it on the apron, standing, very often sitting on the ground so as
 *    not to loom), sitting outside the gate while the concert plays.
 *  - People: they stop and wait for anyone in front of their feet ("Careful…"), wave to people and to
 *    the hero, and smile. Passers-by stop, look and film, call their name. Now and then a fan gets a
 *    lift on the palm while a friend takes the picture; the press comes by for photos.
 *  - Far from where the player is, they skip to where their day takes them (never in sight).
 *
 * People staged here are actors of GIANT_OWNER. Dev (console): dev.giant.status(), go(), sit(),
 * stand(), lie(), wave(), lift(), press(), hour(h).
 */
import * as THREE from 'three';
import type { Game } from '../../Game';
import { PState, isBystander, type PedAgent } from '../../../sim/Pedestrians';
import { Role, type Citizen } from '../../../sim/Population';
import { makeActor, attach, hold, goTo, stand, release, GIANT_OWNER, type Actor } from '../../../sim/actors/Actor';
import { HumanoidRig } from '../../../humanoid/client/HumanoidRig';
import { randomAppearance } from '../../../humanoid/appearance';
import { appearancePatch, type ActorLook } from '../../../humanoid/actors/config';
import type { ActionAnim, AnimState, MoveState } from '../../../shared/types';
import { nameOf } from '../../people/identity';
import { walkSpeed, stepEnergy, bodyMass, HUMAN_HEIGHT } from '../../GiantBody';
import { worldToSite } from '../../../plan/landmarks';
import { hash32, deriveSeed, Rng } from '../../../core/rng';
import { clamp } from '../../../core/math';
import { shaderCap } from '../../../render/shaderCap';
import type { Stimulus } from '../../Stimuli';
import { GIANT, GIANT_LINES, CROWD_LINES, dayOf, giantPlan, ringWay, angDiff, headingTo, pickLine, type DayPart, type GiantPlan } from './plan';

type Step =
  | { do: 'go'; x: number; z: number }
  | { do: 'face'; h: number }
  | { do: 'sit'; t: number }
  | { do: 'lie' }
  | { do: 'stand' }
  | { do: 'idle'; t: number };

interface Lift {
  fan: PedAgent; fanAct: Actor;
  friend: PedAgent | null; friendAct: Actor | null;
  stage: 'come' | 'scoop' | 'hold' | 'down';
  t: number;
  flashT: number;
  up: boolean;
}

interface Snapper { a: PedAgent; act: Actor; slot: number; flashT: number; talkT: number }

/** Canvas, tarpaulin, sailcloth: what the city could sew at that size. */
const CLOTH = ['#c8b38a', '#3e5a7e', '#6f7a4c', '#a4583a', '#8a8d91', '#d2c8b4'];

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class GentleGiant {
  readonly plan: GiantPlan | null;
  readonly pos = new THREE.Vector3();
  heading = 0;
  name = '';
  first = '';
  female = false;
  private cit: Citizen | null = null;
  private look: ActorLook | null = null;
  rig: HumanoidRig | null = null;
  /** 0 standing … 1 sitting on the ground … 2 lying; and where it is going. */
  seat = 0;
  private seatGoal = 0;
  private speed = 0;
  private queue: Step[] = [];
  private part: DayPart | null = null;
  private stepT = 0;
  private animTime = 0;
  private stepPhase = 0;
  private action: ActionAnim | null = null;
  private lookAtP: [number, number, number] | null = null;
  private mood: AnimState['mood'] = 'happy';
  private waitT = 0;
  private waveT = 4;
  private barkT = 0;
  private crowdT = 1;
  private carryT: number = rand(...GIANT.carryGap) * 0.4;
  private pressT: number = rand(...GIANT.pressGap) * 0.5;
  private lift: Lift | null = null;
  /** The rig's shaders: 0 not started, 1 compiling, 2 ready (shown). */
  private rigReady = 0;
  private press: { members: Snapper[]; t: number; stay: number } | null = null;
  private farT = 0;
  private scaredT = 0;
  private devDone = false;
  private tmp: PedAgent[] = [];
  private rng: Rng;
  stats = { steps: 0, waves: 0, lifts: 0, press: 0, snaps: 0, waits: 0, skips: 0 };

  constructor(private g: Game) {
    const lm = g.macro.landmarks.find((l) => l.kind === 'stadium') ?? null;
    this.plan = lm ? giantPlan(lm) : null;
    this.rng = new Rng(deriveSeed(g.settings.seed, 'gentle'));
    if (!this.plan) return;
    // Who: a grown-up of the city (the same for a seed), in what could be sewn at their size.
    for (let k = 0; k < 40; k++) {
      const c = g.population.synthetic(deriveSeed(g.settings.seed, 'gentle', k) || 1);
      if (c.role !== Role.Child && c.age > 0.42 && c.age < 0.72) { this.cit = c; break; }
    }
    const c = this.cit ?? g.population.synthetic(deriveSeed(g.settings.seed, 'gentle') || 1);
    this.cit = c;
    const nm = nameOf(c);
    this.name = nm.full; this.first = nm.first;
    this.female = c.gender < 0.5;
    const app = randomAppearance('human', c.seed, { gender: c.gender, age: c.age });
    const cloth = CLOTH[hash32(c.seed) % CLOTH.length], top = CLOTH[hash32(c.seed + 7) % CLOTH.length];
    const outfit = this.female ? ['underwear-top', 'briefs'] : ['briefs'];
    const garmentColors: Record<string, string> = { briefs: cloth, 'underwear-top': top };
    this.look = { actor: { ...appearancePatch(app, null), outfit, garmentColors } };
    // Where the day finds them at the start.
    this.snap(dayOf(g.sky.hoursAbs % 24));
    g.stimuli.on((s) => this.onStimulus(s));
  }

  /** The body's scale factor relative to a 1.8 m person. */
  private get k(): number { return GIANT.height / HUMAN_HEIGHT; }

  update(dt: number): void {
    const P = this.plan;
    if (!P || !this.look) return;
    if (!this.devDone) this.installDev();
    const g = this.g;
    const h = g.sky.hoursAbs % 24;
    const part = dayOf(h);
    const focus = g.freeCam ? g.renderer.camera.position : g.player.pos;
    const d = Math.hypot(focus.x - this.pos.x, focus.z - this.pos.z);
    // Far away: they are wherever their day takes them (checked now and then).
    if (d > GIANT.farR) {
      this.farT -= dt;
      if (this.part !== part || this.farT <= 0) {
        this.farT = 20;
        if (this.part !== part || this.queue.some((s) => s.do === 'go')) this.snap(part);
      }
    } else if (this.part !== part) this.newPart(part);
    this.part = part;
    if (!this.queue.length) this.planNext(part);

    this.scaredT -= dt;
    this.waveT -= dt; this.barkT -= dt; this.crowdT -= dt; this.carryT -= dt; this.pressT -= dt;
    this.runQueue(dt);
    this.stepSeat(dt);
    const near = d < 220;
    if (near) {
      this.people(dt);
      this.stepLift(dt);
      this.stepPress(dt, d);
    } else {
      if (this.lift) this.endLift(false);
      if (this.press) this.endPress();
    }
    this.body(dt, d);
  }

  // ================================================================== the day

  /** Where the day puts them, at once (only ever out of sight). */
  private snap(part: DayPart): void {
    const P = this.plan!;
    this.stats.skips++;
    this.queue = [];
    this.endLift(false);
    this.action = null;
    this.speed = 0;
    let x: number, z: number, h: number;
    if (part === 'sleep' || part === 'bed') {
      ({ x, z, heading: h } = P.bed);
      this.seat = this.seatGoal = 2;
      this.queue.push({ do: 'lie' });
    } else if (part === 'concert') {
      ({ x, z, heading: h } = P.concert);
      this.seat = this.seatGoal = 1;
      this.queue.push({ do: 'sit', t: 1e9 });
    } else {
      const t = this.rng.pick(P.sits);
      [x, z] = P.ring(t);
      h = P.outward(t);
      this.seat = this.seatGoal = 1;
      this.queue.push({ do: 'sit', t: rand(40, 140) });
    }
    this.pos.set(x, this.groundAt(x, z, P.field + 30), z);
    this.heading = h;
    this.part = part;
  }

  /** The day moved on: whatever they were doing, the next part starts (getting up first). */
  private newPart(part: DayPart): void {
    this.queue = [];
    this.endLift(true);
    if (part === 'bed' && this.part !== 'concert') return;
    if (part === 'roam' && this.part === 'wake') return;
    this.say(part === 'bed' ? GIANT_LINES.sleepy : part === 'wake' ? GIANT_LINES.morning : part === 'concert' ? GIANT_LINES.concert : GIANT_LINES.rise, true);
  }

  /** Inside the bowl (on the pitch or in a gate)? */
  private inside(x = this.pos.x, z = this.pos.z): boolean {
    const P = this.plan!, lm = P.lm, [u, v] = worldToSite(lm, x, z);
    const out = lm.p.tiers * lm.p.depth;
    return Math.abs(u) < lm.p.ia + out && Math.abs(v) < lm.p.ib + out;
  }

  /** Walk to the ring (out of the bowl first), then round it to angle t. */
  private toRing(t: number): void {
    const P = this.plan!, q = this.queue;
    let from: number;
    if (this.inside()) {
      q.push({ do: 'go', x: P.gateIn[0], z: P.gateIn[1] }, { do: 'go', x: P.gateOut[0], z: P.gateOut[1] });
      const [x, z] = P.ring(0);
      q.push({ do: 'go', x, z });
      from = 0;
    } else from = P.angleOf(this.pos.x, this.pos.z);
    for (const [x, z] of ringWay(P, from, t)) q.push({ do: 'go', x, z });
  }

  private planNext(part: DayPart): void {
    const P = this.plan!, q = this.queue;
    if (this.seat > 0.01 && part !== 'sleep' && part !== 'bed') q.push({ do: 'stand' });
    switch (part) {
      case 'sleep': case 'bed': {
        const atBed = Math.hypot(this.pos.x - P.bed.x, this.pos.z - P.bed.z) < 3;
        if (!atBed) {
          if (this.seat > 0.01) q.push({ do: 'stand' });
          if (!this.inside()) {
            this.toRing(0);
            q.push({ do: 'go', x: P.gateOut[0], z: P.gateOut[1] }, { do: 'go', x: P.gateIn[0], z: P.gateIn[1] });
          }
          q.push({ do: 'go', x: P.bed.x, z: P.bed.z });
        }
        q.push({ do: 'face', h: P.bed.heading }, { do: 'lie' });
        return;
      }
      case 'concert': {
        this.toRing(P.angleOf(P.concert.x, P.concert.z));
        q.push({ do: 'go', x: P.concert.x, z: P.concert.z }, { do: 'face', h: P.concert.heading }, { do: 'sit', t: 1e9 });
        return;
      }
      case 'wake': case 'roam': {
        // Mostly sitting somewhere (they don't like to loom), sometimes a stroll round and a stand.
        if (this.rng.chance(0.6)) {
          const t = this.rng.pick(P.sits) + this.rng.range(-0.08, 0.08);
          this.toRing(t);
          q.push({ do: 'face', h: P.outward(t) }, { do: 'sit', t: rand(60, 160) });
        } else {
          const from = this.inside() ? 0 : P.angleOf(this.pos.x, this.pos.z);
          const t = from + this.rng.range(0.5, 1.6) * (this.rng.chance(0.5) ? 1 : -1);
          this.toRing(t);
          q.push({ do: 'face', h: P.outward(t) }, { do: 'idle', t: rand(15, 40) });
        }
        return;
      }
    }
  }

  private runQueue(dt: number): void {
    const s = this.queue[0];
    let want = 0;
    if (!s) { this.speed = 0; return; }
    const busy = !!this.lift || this.scaredT > 0;
    switch (s.do) {
      case 'stand':
        this.seatGoal = 0;
        if (this.seat <= 0.001) this.queue.shift();
        break;
      case 'sit':
        if (this.seatGoal !== 1 && this.seat < 0.05) this.say(GIANT_LINES.sit);
        this.seatGoal = 1;
        if (this.seat >= 0.999) { s.t -= dt; if (s.t <= 0) this.queue.shift(); }
        break;
      case 'lie':
        this.seatGoal = 2;
        break;
      case 'idle':
        if (!busy) s.t -= dt;
        if (s.t <= 0) this.queue.shift();
        break;
      case 'face': {
        if (this.seat > 0.01) { this.queue.shift(); break; }
        const dh = angDiff(this.heading, s.h);
        this.heading += clamp(dh, -GIANT.turn * dt, GIANT.turn * dt);
        if (Math.abs(dh) < 0.03) this.queue.shift();
        break;
      }
      case 'go': {
        if (busy || this.seat > 0.001) break;
        const dx = s.x - this.pos.x, dz = s.z - this.pos.z, dist = Math.hypot(dx, dz);
        if (dist < 1.6) { this.queue.shift(); break; }
        const th = headingTo(this.pos.x, this.pos.z, s.x, s.z);
        const dh = angDiff(this.heading, th);
        this.heading += clamp(dh, -GIANT.turn * dt, GIANT.turn * dt);
        // Someone in front of the feet: wait for them (carefully).
        if (this.blocked()) {
          this.waitT += dt;
          if (this.waitT > 1.2 && this.barkT <= 0) { this.say(GIANT_LINES.careful); this.stats.waits++; }
          break;
        }
        this.waitT = 0;
        want = walkSpeed(GIANT.height) * GIANT.pace * smoothTurn(dh) * Math.min(1, dist / 4 + 0.35);
        break;
      }
    }
    this.speed += clamp(want - this.speed, -0.9 * dt, 0.6 * dt);
    if (this.speed > 0.01) {
      const fx = -Math.sin(this.heading), fz = -Math.cos(this.heading);
      const nx = this.pos.x + fx * this.speed * dt, nz = this.pos.z + fz * this.speed * dt;
      this.pos.set(nx, this.groundAt(nx, nz, this.pos.y + 1.6), nz);
    }
  }

  /** Someone (or the hero, at their size) just ahead of the feet. */
  private blocked(): boolean {
    const g = this.g, fx = -Math.sin(this.heading), fz = -Math.cos(this.heading);
    const ax = this.pos.x + fx * 3.2, az = this.pos.z + fz * 3.2;
    const p = g.player.pos;
    if (g.player.height < 4 && !g.player.flying && Math.hypot(p.x - ax, p.z - az) < GIANT.mind && Math.abs(p.y - this.pos.y) < 3) return true;
    for (const a of g.peds.neighbours(ax, az, GIANT.mind, this.tmp)) {
      if (!a.alive || a.inside || a.puppet) continue;
      if (Math.abs(a.y - this.pos.y) > 3) continue;
      // (Ordinary passers-by step aside: a nudge out of the way.)
      if (!a.actor && a.state !== PState.Down) {
        const sx = -fz, sz = fx, side = (a.x - ax) * sx + (a.z - az) * sz >= 0 ? 1 : -1;
        a.x += sx * side * 1.2 * 0.05; a.z += sz * side * 1.2 * 0.05;
      }
      return true;
    }
    return false;
  }

  private stepSeat(dt: number): void {
    const goal = this.seatGoal, s = this.seat;
    if (s === goal) return;
    const rate = s > 1 || (s === 1 && goal > 1) ? 1 / GIANT.lieT : 1 / GIANT.sitT;
    this.seat = goal > s ? Math.min(goal, s + rate * dt) : Math.max(goal, s - rate * dt);
  }

  // ================================================================== people

  private people(dt: number): void {
    const g = this.g, P = g.player;
    const standing = this.seat < 0.01 && !this.lift && this.speed < 0.3;
    const head: [number, number, number] = [this.pos.x, this.pos.y + GIANT.height * (this.seat > 0.5 ? 0.55 : 0.92), this.pos.z];
    // The hero close by: a wave and a hello (once in a while).
    const dp = Math.hypot(P.pos.x - this.pos.x, P.pos.z - this.pos.z);
    let target: { x: number; y: number; z: number; hero: boolean } | null = null;
    if (dp < GIANT.waveR + 10 && Math.abs(P.pos.y - this.pos.y) < 40) target = { x: P.pos.x, y: P.pos.y + P.height * 0.9, z: P.pos.z, hero: true };
    else {
      const a = g.peds.nearest(this.pos.x, this.pos.z, GIANT.waveR, (q) => isBystander(q) && this.ahead(q.x, q.z));
      if (a) target = { x: a.x, y: a.y + 1.6, z: a.z, hero: false };
    }
    this.lookAtP = target && !this.lift ? [target.x, target.y, target.z] : null;
    if (target && this.waveT <= 0 && (standing || this.seat > 0.99) && this.scaredT <= 0 && !this.action) {
      this.waveT = GIANT.waveGap * rand(1, 2.2);
      if (standing) { this.act('wave_hello', 2.7); this.stats.waves++; }
      if (target.hero) this.say(P.height > 6 ? GIANT_LINES.heroGiant : GIANT_LINES.hero, true);
      else if (Math.random() < 0.5) this.say(GIANT_LINES.greet);
    }
    // Passers-by: stop, look, film, call out.
    if (this.crowdT <= 0) {
      this.crowdT = 1.5;
      let said = false;
      for (const a of g.peds.neighbours(this.pos.x, this.pos.z, 45, this.tmp)) {
        if (!isBystander(a) || a.cit.role === Role.Child && Math.random() < 0.3) continue;
        if (a.state === PState.Walk && a.cit.curiosity > 0.35 && Math.random() < 0.35) g.reactions.watch(a, head[0], head[1], head[2]);
        else if (a.state === PState.Gawk || a.state === PState.Film) { a.lookX = head[0]; a.lookY = head[1]; a.lookZ = head[2]; }
        if (!said && (a.state === PState.Gawk || a.state === PState.Film) && Math.random() < 0.08) said = g.barks.say(a, pickLine(CROWD_LINES.see, Math.random(), this.first), 30, 'cheer');
      }
    }
    // Time for a lift? (Standing about, people near, the hero watching.)
    if (this.carryT <= 0 && !this.lift && this.scaredT <= 0 && this.seat < 0.01 && this.queue[0]?.do !== 'go' && dp < 160) this.startLift();
  }

  /** In front (within ±70°)? */
  private ahead(x: number, z: number): boolean {
    return Math.abs(angDiff(this.heading, headingTo(this.pos.x, this.pos.z, x, z))) < 1.2;
  }

  private citizen(seed: number): Citizen | null {
    const pop = this.g.population;
    for (let k = 0; k < 30; k++) {
      const c = pop.synthetic(hash32(seed * 7919 + k * 104729 + 31) || 1);
      if (c.role !== Role.Child && !this.g.peds.agentOf(c.id)) return c;
    }
    return null;
  }

  // ---- a lift for a photo

  startLift(fan?: PedAgent): boolean {
    const g = this.g;
    this.carryT = rand(...GIANT.carryGap);
    const fx = -Math.sin(this.heading), fz = -Math.cos(this.heading);
    let a = fan ?? g.peds.nearest(this.pos.x, this.pos.z, 34, (q) => isBystander(q) && q.cit.role !== Role.Child && Math.abs(q.y - this.pos.y) < 2);
    if (!a) {
      // Nobody about: a fan who came for this comes over.
      const c = this.citizen(this.rng.int(1, 1e9));
      const ang = this.heading + rand(-0.8, 0.8), r = rand(20, 28);
      const sx = this.pos.x - Math.sin(ang) * r, sz = this.pos.z - Math.cos(ang) * r;
      if (c && g.world.standable(sx, sz)) a = g.peds.spawnAt(c, sx, sz, ang);
    }
    if (!a) return false;
    const fanAct = attach(a, makeActor('bystander', GIANT_OWNER, { title: 'Fan', mood: 'happy' }));
    // A friend for the picture: someone with them, or someone near.
    let friend = g.peds.nearest(a.x, a.z, 25, (q) => q !== a && isBystander(q) && q.cit.role !== Role.Child && Math.abs(q.y - this.pos.y) < 2);
    if (!friend) {
      const c = this.citizen(a.cit.seed + 5);
      const sx = this.pos.x + fx * 18 + rand(-4, 4), sz = this.pos.z + fz * 18 + rand(-4, 4);
      if (c && g.world.standable(sx, sz)) friend = g.peds.spawnAt(c, sx, sz, this.heading + Math.PI);
    }
    const friendAct = friend ? attach(friend, makeActor('bystander', GIANT_OWNER, { title: 'Fan', mood: 'happy' })) : null;
    this.lift = { fan: a, fanAct, friend, friendAct, stage: 'come', t: 0, flashT: 1, up: false };
    this.stats.lifts++;
    return true;
  }

  private stepLift(dt: number): void {
    const L = this.lift;
    if (!L) return;
    const g = this.g;
    if (!L.fan.alive || L.fan.actor !== L.fanAct) { this.endLift(false); return; }
    L.t += dt;
    const fx = -Math.sin(this.heading), fz = -Math.cos(this.heading);
    const sx = -fz, sz = fx;
    // Where the fan steps on (in front, a little to the right: the right hand) and the friend stands.
    const ox = this.pos.x + fx * 3.0 + sx * 0.9, oz = this.pos.z + fz * 3.0 + sz * 0.9;
    const px = this.pos.x + fx * GIANT.photoD - sx * 2, pz = this.pos.z + fz * GIANT.photoD - sz * 2;
    if (L.friend && L.friendAct && L.friend.actor === L.friendAct) {
      const f = L.friend, fa = L.friendAct;
      if (Math.hypot(f.x - px, f.z - pz) > 0.8) goTo(fa, px, pz, 2.2); else stand(fa);
      fa.face = { x: L.fan.x, y: L.fan.y + 1.4, z: L.fan.z };
    }
    const k = Math.sqrt(this.k);
    switch (L.stage) {
      case 'come': {
        const dd = Math.hypot(L.fan.x - ox, L.fan.z - oz);
        if (dd > 0.6) goTo(L.fanAct, ox, oz, 2.4); else stand(L.fanAct);
        L.fanAct.face = { x: this.pos.x, y: this.pos.y + 8, z: this.pos.z };
        this.lookAtP = [L.fan.x, L.fan.y + 1, L.fan.z];
        if (dd < 0.7) { L.stage = 'scoop'; L.t = 0; this.act('scoop', 3.2); this.say(GIANT_LINES.lift, true); }
        else if (L.t > 25) this.endLift(false);
        break;
      }
      case 'scoop': {
        // (On the hand from the moment it lies on the ground.)
        const u = L.t / (3.2 * k);
        if (u > 0.45) this.onPalm(L);
        if (u >= 1) { L.stage = 'hold'; L.t = 0; g.barks.say(L.fan, pickLine(CROWD_LINES.lifted, Math.random()), 10, 'cheer'); }
        break;
      }
      case 'hold': {
        this.act('palm_hold', 1.4, true);
        this.onPalm(L);
        hold(L.fanAct, Math.floor(L.t / 3) % 2 ? 'cheer' : 'gesture_wave', 1.4);
        const fr = L.friend;
        if (fr && L.friendAct && fr.actor === L.friendAct && Math.hypot(fr.x - px, fr.z - pz) < 1.5) {
          hold(L.friendAct, 'take_photo', 1.4);
          L.flashT -= dt;
          if (L.flashT <= 0) { L.flashT = rand(1.2, 2.6); g.fame.flash(fr, 1.62, 0.32); this.stats.snaps++; if (Math.random() < 0.4) g.barks.say(fr, pickLine(CROWD_LINES.photo, Math.random()), 6); }
        }
        if (L.t > GIANT.carryHold) { L.stage = 'down'; L.t = 0; this.act('set_down', 3.2); this.say(GIANT_LINES.down, true); }
        break;
      }
      case 'down': {
        const u = L.t / (3.2 * k);
        if (u < 0.55) this.onPalm(L); else if (L.up) this.offPalm(L);
        if (u >= 1) this.endLift(true);
        break;
      }
    }
  }

  /** The fan stands on the right palm (moved with it every frame). */
  private onPalm(L: Lift): void {
    const s = this.rig?.getSocket('hand.R');
    const a = L.fan;
    a.puppet = true;
    L.up = true;
    if (s) {
      this.rig!.object.updateMatrixWorld(true);
      s.getWorldPosition(_v);
      a.x = _v.x; a.y = _v.y + 0.08 * this.k; a.z = _v.z;
    } else {
      a.x = this.pos.x - Math.sin(this.heading) * 2.4; a.y = this.pos.y + 6.2; a.z = this.pos.z - Math.cos(this.heading) * 2.4;
    }
    a.heading = this.heading;
    a.speed = 0;
    stand(L.fanAct);
  }

  private offPalm(L: Lift): void {
    const a = L.fan;
    a.puppet = false;
    L.up = false;
    a.y = this.groundAt(a.x, a.z, a.y + 1);
  }

  private endLift(thanks: boolean): void {
    const L = this.lift;
    if (!L) return;
    this.lift = null;
    if (L.up) this.offPalm(L);
    if (this.action && (this.action.id === 'palm_hold' || this.action.id === 'scoop')) this.action = null;
    for (const [a, act] of [[L.fan, L.fanAct], [L.friend, L.friendAct]] as const) {
      if (!a || !act || a.actor !== act) continue;
      if (thanks && a === L.fan) this.g.barks.say(a, pickLine(CROWD_LINES.thanks, Math.random(), this.first), 20, 'cheer');
      release(a);
    }
  }

  // ---- the press

  private stepPress(dt: number, d: number): void {
    const g = this.g;
    if (!this.press) {
      if (this.pressT > 0 || d > 160 || this.part === 'sleep' || this.part === 'bed') return;
      this.pressT = rand(...GIANT.pressGap) * 2;
      this.startPress();
      return;
    }
    const q = this.press;
    q.t += dt;
    if (q.t > q.stay) { this.endPress(); return; }
    for (const m of q.members) {
      if (!m.a.alive || m.a.actor !== m.act) continue;
      // (In front, fanned out: a sitting giant's feet reach about 6 m.)
      const ang = this.heading + m.slot;
      const dist = this.seat > 0.5 ? 13 : 16;
      const sx = this.pos.x - Math.sin(ang) * dist, sz = this.pos.z - Math.cos(ang) * dist;
      const there = Math.hypot(m.a.x - sx, m.a.z - sz) < 1.2;
      if (!there) { goTo(m.act, sx, sz, 2.6); if (m.act.action?.id === 'take_photo') m.act.action = null; continue; }
      stand(m.act);
      m.act.face = { x: this.pos.x, y: this.pos.y + GIANT.height * (this.seat > 0.5 ? 0.45 : 0.75), z: this.pos.z };
      hold(m.act, 'take_photo', 1.4);
      m.flashT -= dt;
      const age = m.act.action?.age ?? 0;
      if (m.flashT <= 0 && age % 3 > 0.45 && age % 3 < 2.5) { m.flashT = rand(1.5, 4); g.fame.flash(m.a, 1.62, 0.32); this.stats.snaps++; }
      m.talkT -= dt;
      if (m.talkT <= 0) {
        m.talkT = rand(8, 16);
        if (Math.random() < 0.6) g.barks.say(m.a, pickLine(CROWD_LINES.press, Math.random(), this.first), 12);
        else if (this.barkT <= 0) this.say(GIANT_LINES.press);
      }
    }
  }

  private startPress(): void {
    const g = this.g;
    const n = 1 + (Math.random() < 0.6 ? 1 : 0) + (Math.random() < 0.25 ? 1 : 0);
    const members: Snapper[] = [];
    for (let i = 0; i < n; i++) {
      const c = this.citizen(this.rng.int(1, 1e9));
      if (!c) continue;
      // (Somewhere they can stand: the stands and buildings round the stadium are not.)
      let x = 0, z = 0, ang = 0, ok = false;
      for (let k = 0; k < 8 && !ok; k++) {
        ang = this.heading + rand(-2.4, 2.4);
        const r = rand(30, 48);
        x = this.pos.x - Math.sin(ang) * r; z = this.pos.z - Math.cos(ang) * r;
        ok = g.world.standable(x, z);
      }
      if (!ok) continue;
      const a = g.peds.spawnAt(c, x, z, ang + Math.PI);
      if (!a) continue;
      const act = attach(a, makeActor('bystander', GIANT_OWNER, { title: 'Press photographer', held: 'presscam' }));
      members.push({ a, act, slot: (i - (n - 1) / 2) * 0.5 + rand(-0.12, 0.12), flashT: rand(1, 3), talkT: rand(3, 8) });
    }
    if (!members.length) { this.pressT = 15; return; }
    this.press = { members, t: 0, stay: rand(...GIANT.pressStay) };
    this.stats.press++;
  }

  private endPress(): void {
    const q = this.press;
    if (!q) return;
    this.press = null;
    for (const m of q.members) if (m.a.alive && m.a.actor === m.act) { m.act.action = null; release(m.a); m.a.state = PState.Walk; m.a.fear = 0; }
  }

  private onStimulus(s: Stimulus): void {
    if (!this.plan) return;
    const d = Math.hypot(s.x - this.pos.x, s.z - this.pos.z);
    if (d > Math.min(120, s.radius)) return;
    switch (s.kind) {
      case 'blast': case 'collapse': case 'roar': case 'gunfire': case 'threat': case 'sonic':
        // Frightened: put anyone down, hands to the head a moment; the press runs.
        if (this.lift) { this.endLift(false); }
        if (this.press) this.endPress();
        this.scaredT = 6;
        this.mood = 'afraid';
        if (this.seat < 0.01) this.act('hands_on_head', 2.5);
        this.g.later.after(6, () => { this.mood = 'happy'; });
        break;
      default: break;
    }
  }

  // ================================================================== the body

  private act(id: string, dur: number, keep = false): void {
    if (keep && this.action?.id === id) { this.action.dur = this.animTime - this.action.t0 + dur; return; }
    this.action = { id, t0: this.animTime, dur };
  }

  private say(list: readonly string[], force = false): void {
    if (!force && this.barkT > 0) return;
    const b = this.g.barks;
    if (!b) return;
    const head = GIANT.height * (this.seat > 1.2 ? 0.25 : this.seat > 0.5 ? 0.62 : 1.0) + 0.3;
    if (b.sayAt(this.pos, pickLine(list, Math.random()), { head, pause: 4 })) this.barkT = 9;
  }

  /** Ground under a point, as the player's walking finds it (decks, the gate steps, the pitch). */
  private groundAt(x: number, z: number, yRef: number): number {
    const g = this.g;
    return g.collision ? g.collision.groundAt(x, z, yRef, 1.2, true) : g.world.groundHeight(x, z, yRef);
  }

  /** The rig near the camera (built once in range, dropped far off), animated like the player's giant. */
  private body(dt: number, d: number): void {
    const g = this.g;
    if (!this.rig && d < GIANT.rigR) {
      this.rig = new HumanoidRig(this.look!, { castShadow: true, priority: 3, ground: (x, y, z) => this.groundAt(x, z, y + 0.4 * this.k) });
      this.rig.setEquipment({});
      this.rigReady = 0;
      g.renderer.scene.add(this.rig.object);
    } else if (this.rig && d > GIANT.dropR) {
      this.rig.dispose();
      this.rig = null;
    }
    const rig = this.rig;
    if (!rig) return;
    // Her shaders compile in the background first (as the crowd's rigs), within the shader cap:
    // compiled on first draw they stalled a frame (WebGL).
    if (this.rigReady === 0 && rig.dressed) {
      this.rigReady = 1;
      const r = rig, done = (): void => { if (this.rig === r) this.rigReady = 2; };
      void shaderCap.slot().then(() => {
        if (this.rig !== r) return;
        r.object.visible = true; // (compiling looks at what is visible)
        return g.renderer.compileAsync(r.object);
      }).then(done, done);
    }
    // (Only the rig's own node: setVisible before she is dressed would leave her body hidden.)
    rig.object.visible = this.rigReady === 2;
    const sk = Math.sqrt(this.k);
    this.animTime += dt / sk;
    // (Scaled from the built body's own height to GIANT.height; the gait in slow motion, as the player's.)
    const scale = GIANT.height / Math.max(1, rig.height);
    const fx = -Math.sin(this.heading), fz = -Math.cos(this.heading);
    const v = this.speed / sk;
    const move: MoveState = this.seat > 0.001 ? 'sit_floor' : v > 0.12 ? 'walk' : 'idle';
    const action = this.action && this.animTime - this.action.t0 < this.action.dur ? this.action : undefined;
    if (!action) this.action = null;
    rig.update({
      pos: [this.pos.x, this.pos.y, this.pos.z], vel: [fx * v, 0, fz * v], yaw: this.heading, scale, flags: 0,
      anim: { move, floor: this.seat, action, mood: this.mood, lookAt: this.lookAtP ?? undefined },
    }, dt / sk, this.animTime, g.renderer.camera.position);
    // Footsteps on the gait's heel strikes (as Player.updateRig).
    const ph = rig.animator?.gaitPhase ?? 0, prev = this.stepPhase;
    const crossed = (m: number) => (prev - ph > 0.5 ? prev < m || ph >= m : prev < m && ph >= m);
    if (move === 'walk' && ph !== prev && (crossed(0.25) || crossed(0.75)) && d < 400) {
      this.stats.steps++;
      g.interactions.steps.footstep(this.pos.x, this.pos.y, this.pos.z, stepEnergy(bodyMass(GIANT.height), GIANT.height), GIANT.height, { cause: 'world', own: false, calm: true, impact: false, ref: 25 });
    }
    this.stepPhase = ph;
  }

  // ================================================================== dev

  status(): Record<string, unknown> {
    return {
      name: this.name, part: this.part, at: [Math.round(this.pos.x), Math.round(this.pos.y), Math.round(this.pos.z)],
      seat: +this.seat.toFixed(2), speed: +this.speed.toFixed(2), next: this.queue.slice(0, 3).map((s) => s.do), lift: this.lift?.stage ?? null,
      snappers: this.press?.members.length ?? 0, rig: !!this.rig?.dressed, ...this.stats,
    };
  }

  private installDev(): void {
    const dev = (window as unknown as { dev?: Record<string, unknown> }).dev;
    if (!dev) return;
    this.devDone = true;
    dev.giant = {
      giant: this,
      status: () => this.status(),
      /** Put the hero (or the free camera) a little in front of them. */
      go: (dist = 30) => {
        const g = this.g, P = this.plan!;
        // (Out from the stadium, whichever way they face.)
        const h = this.inside() ? this.heading : P.outward(P.angleOf(this.pos.x, this.pos.z));
        const fx = -Math.sin(h), fz = -Math.cos(h);
        const x = this.pos.x + fx * dist, z = this.pos.z + fz * dist;
        g.freeCam = false;
        g.player.pos.set(x, this.groundAt(x, z, this.pos.y + 5) + 0.1, z);
        g.player.vel.set(0, 0, 0);
        g.camRig.yaw = h + Math.PI;
        return { x: Math.round(x), z: Math.round(z) };
      },
      sit: (t = 60) => { this.queue = [{ do: 'sit', t }]; return 'sitting'; },
      stand: () => { this.queue = [{ do: 'stand' }, { do: 'idle', t: 30 }]; return 'standing'; },
      lie: () => { this.queue = [{ do: 'lie' }]; return 'lying'; },
      wave: () => { this.waveT = 0; return 'waving at whoever is near'; },
      lift: () => { this.queue = [{ do: 'stand' }, { do: 'idle', t: 40 }]; this.carryT = 0; return 'a lift when standing'; },
      press: () => { this.pressT = 0; return 'the press comes'; },
      walk: (t: number) => { this.queue = []; if (this.seat > 0) this.queue.push({ do: 'stand' }); this.toRing(t); return this.queue.length; },
      hour: (h: number) => { const s = this.g.sky; s.hour = h; return dayOf(h); },
    };
  }
}

/** Walking speed share while turning (slow while facing away, full when facing the way). */
function smoothTurn(dh: number): number {
  const a = Math.abs(dh);
  return a > 1.2 ? 0 : a < 0.35 ? 1 : 1 - (a - 0.35) / 0.85;
}

const _v = new THREE.Vector3();
