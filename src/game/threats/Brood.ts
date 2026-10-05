/**
 * The Brood (THREATS_PLAN §1 #4, roadmap Phase C): a swarm of small creatures pouring out of the
 * sewers — the city's entry-level threat. Near the player the manhole lids rattle, then the
 * creatures leap out one after another, a chittering dark carpet that spreads through the street:
 * they chase people and knock them down, gnaw cars to a standstill (the big ones flip them), chew
 * robots apart, go for the player, run up facades and over low roofs. The simulation is
 * BroodSim (pure, 15 Hz); this is the event around it: the world it lives in, what its bites do,
 * the police and the player's powers against it, the rewards and the end.
 *
 * A weak hero can fight single creatures (a punch kills a small one); fire, chain lightning,
 * frost, a stomp or a whirlwind clear whole clumps. The police come as for any minor event
 * (patrol, cordon and evacuation, SWAT), shooting and batoning the creatures. It ends when they
 * are all dead (stopped), or when most are and the rest flee back underground, or after a few
 * minutes when the brood withdraws on its own (retreated).
 *
 * Omens (`broodOmen`): 'chitter' — a manhole near the player rattles and chitters, a puff of dust
 * from its holes, people stop and look round; 'glimpse' — three creatures dart out of one manhole,
 * across the street and down another.
 *
 * Rewards (Normal mode; the player's credit is the last hit): a small one killed 1 karma, a big one
 * 5 (+0.5 rep); one killed while it was on someone +2 ("saved someone", at most every 4 s); the
 * swarm stopped with at least 8 killed by the player 20 karma, +4 rep, cheers.
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import { Rng } from '../../core/rng';
import { PState, type PedAgent } from '../../sim/Pedestrians';
import { VState, type Vehicle } from '../../sim/Traffic';
import { RState, type Robot } from '../../future/Robots';
import type { Cause } from '../Stimuli';
import type { ThreatEvent, ThreatOutcome, ThreatTarget } from './ThreatEvent';
import { BroodSim, BROOD, BROOD_KINDS, CMode, type BroodWorld, type Critter, type HitEffect, type Prey } from './brood/BroodSim';

export interface BroodOpts {
  /** Creatures (≤ 150) and how many of them are big ones. */
  count?: number;
  brutes?: number;
  /** Seconds until the brood withdraws on its own. */
  duration?: number;
}

export const BROOD_EVENT = {
  /** A scout pack (the clock's minor event); dev.threat.spawn('brood', { count: 150 }) for a full swarm. */
  count: [40, 60], brutesPer: 25,
  /** Manholes it comes out of: up to this many within this radius of the site (m). */
  holes: 3, holeR: 75,
  duration: 300,
  /** Few left (share): the rest flee underground. */
  flee: 0.12,
  /** The player gone this far for this long: it winds down unseen. */
  farR: 700, farT: 30,
  /** Prey is gathered within this of the swarm's centre (m). */
  preyR: 90,
  /** A bite on the player (health points; at most one per gap s); a car gnawed this often is wrecked. */
  playerBite: 4, playerGap: 0.6, carBites: 9, robotBites: 4,
  karma: { skitter: 1, brute: 5, saved: 2, stopped: 20 },
  rep: { brute: 0.5, stopped: 4 },
  /** Player kills needed for the stopped bonus. */
  minKills: 8,
};

let EVENT_ID = 5000;

type CritterTarget = ThreatTarget & { c: Critter };

export class Brood implements ThreatEvent {
  readonly id = EVENT_ID++;
  readonly archetype = 'brood';
  readonly tier = 'minor' as const;
  readonly engageOnFoot = true;
  readonly radius = 60;
  x: number;
  z: number;
  t = 0;
  active = true;
  outcome: ThreatOutcome | null = null;
  hurt = 0;
  readonly sim: BroodSim;
  readonly stats = { cars: 0, flipped: 0, robots: 0, playerBites: 0, playerKills: 0, saved: 0 };
  private total: number;
  private maxT: number;
  private farT = 0;
  private stimT = 0;
  private goalT = 0;
  private soundT = 0;
  private screechT = 0;
  private savedT = -9;
  private playerHitT = -9;
  private loop: ReturnType<Game['audio']['loop']> = null;
  private rng: Rng;
  /** One prey object per thing (creatures hold on to theirs). */
  private preyOf = new WeakMap<object, Prey>();
  private gnaw = new WeakMap<object, number>();
  private targets = new Map<Critter, CritterTarget>();
  private nb: PedAgent[] = [];
  private ground = new Map<number, number>();

  constructor(private g: Game, site: { x: number; z: number }, seed: number, opts: BroodOpts = {}) {
    this.rng = new Rng(seed);
    const R = BROOD_EVENT;
    const holes = findHoles(g, site, R.holes, R.holeR, this.rng);
    this.sim = new BroodSim(this.world(), seed, holes);
    const n = Math.min(BROOD.cap, Math.max(1, Math.round(opts.count ?? this.rng.int(R.count[0], R.count[1]))));
    const brutes = Math.min(n, Math.max(0, Math.round(opts.brutes ?? Math.max(1, n / R.brutesPer))));
    this.sim.spawn(n, brutes, 1.2);
    this.total = n;
    this.maxT = opts.duration ?? R.duration;
    this.x = this.sim.origin.x; this.z = this.sim.origin.z;
    this.sim.onBite = (c, p) => this.bite(c, p);
    this.sim.onKill = (c, cause) => this.killed(c, cause);
    // The lids burst open: a clank, dust, the first screech; people round about run.
    const cam = g.renderer.camera.position;
    for (const h of holes) {
      const y = g.world.groundHeight(h.x, h.z);
      g.audio.play('metal_bend', h.x, y, h.z, 0.8, 1.3, 10, cam);
      g.dust.burst(h.x, y + 0.2, h.z, 14, 0.6, 2.5, 0.8, 1.6, DUST, 0.2, 0.5);
    }
    g.audio.play('brood_screech', this.x, g.world.groundHeight(this.x, this.z) + 0.5, this.z, 1, 0.9, 14, cam);
    g.stimuli.emit('threat', this.x, g.world.groundHeight(this.x, this.z) + 1, this.z, 3, 50, { cause: 'threat' });
  }

  /** What the swarm sees of the city. */
  private world(): BroodWorld {
    const g = this.g, W = g.world, cache = this.ground;
    return {
      // The street level is cached on a 0.5 m grid (it does not change); roofs and decks only for
      // those up there.
      surface: (x, z, yRef) => {
        const k = (Math.round(x * 2) + 32768) * 65536 + (Math.round(z * 2) + 32768);
        let base = cache.get(k);
        if (base === undefined) {
          if (cache.size > 30000) cache.clear();
          base = W.groundHeight(x, z, -1e9);
          cache.set(k, base);
        }
        return yRef > base + 0.7 ? W.groundHeight(x, z, yRef, 0.6) : base;
      },
      wall: (x, z, y) => {
        const b = W.buildingAt(x, z);
        return b && b.top > y + 0.6 && b.low < y + 0.5 ? b.top : NaN;
      },
      prey: (out) => this.gather(out),
    };
  }

  private preyFor(ref: object, kind: Prey['kind'], x: number, y: number, z: number, r: number): Prey {
    let p = this.preyOf.get(ref);
    if (!p) { p = { kind, x, y, z, r, ref, n: 0 }; this.preyOf.set(ref, p); }
    p.x = x; p.y = y; p.z = z; p.r = r;
    return p;
  }

  /** People on their feet, the player, cars and robots near the swarm. */
  private gather(out: Prey[]): void {
    const g = this.g, R = BROOD_EVENT.preyR, cx = this.x, cz = this.z;
    if (this.sim.leaving) return;
    for (const a of g.peds.neighbours(cx, cz, R, this.nb)) {
      if (!a.alive || a.inside || a.ragdoll || a.state === PState.Down) continue;
      out.push(this.preyFor(a, 'person', a.x, a.y, a.z, 0.3));
    }
    const p = g.player;
    if (!p.flying && p.height < 6 && Math.hypot(p.pos.x - cx, p.pos.z - cz) < R && !g.underground.isUnder(p.pos.x, p.pos.y + 0.5, p.pos.z)) {
      out.push(this.preyFor(p, 'player', p.pos.x, p.pos.y, p.pos.z, p.radius));
    }
    const near = (v: { x: number; z: number }) => Math.abs(v.x - cx) < R && Math.abs(v.z - cz) < R;
    for (const v of g.traffic.vehicles) if (v.state < VState.Wreck && near(v)) out.push(this.preyFor(v, 'car', v.x, v.y, v.z, v.width * 0.6));
    for (const v of g.parkedCars) if (v.state < VState.Wreck && near(v)) out.push(this.preyFor(v, 'car', v.x, v.y, v.z, v.width * 0.6));
    for (const r of g.future.robots.list) if (r.alive && r.state < RState.Broken && near(r)) out.push(this.preyFor(r, 'robot', r.x, r.y, r.z, 0.45));
  }

  // ================================================================== bites

  private bite(c: Critter, p: Prey): void {
    const g = this.g, cam = g.renderer.camera.position, big = c.kind === 1;
    if (Math.random() < 0.35) g.audio.play('brood_bite', c.x, c.y + 0.3, c.z, big ? 0.8 : 0.5, (big ? 0.75 : 1) + Math.random() * 0.2, 5, cam);
    switch (p.kind) {
      case 'person': {
        const a = p.ref as PedAgent;
        if (a.state === PState.Down || !a.alive) return;
        g.reactions.knockDown(a, c.x, c.z, big ? 4 : 2.2, 'threat');
        g.consequences.record('brood', 'person', 'knockdown', a.x, a.z, a, 'threat');
        g.stimuli.emit('scream', a.x, a.y + 1.5, a.z, 3, 30, { cause: 'threat' });
        this.hurt++;
        break;
      }
      case 'player': {
        if (this.t - this.playerHitT < BROOD_EVENT.playerGap) return;
        this.playerHitT = this.t;
        const dealt = g.crime.health.damage(BROOD_EVENT.playerBite * (big ? 2.5 : 1), 'monster', c.x, c.z);
        if (dealt <= 0) g.camRig.addShake(0.08);
        this.stats.playerBites++;
        break;
      }
      case 'car': {
        const v = p.ref as Vehicle;
        if (v.state >= VState.Wreck) return;
        const n = (this.gnaw.get(v) ?? 0) + (big ? 4 : 1);
        this.gnaw.set(v, n);
        v.speed *= 0.3; v.fear = 2; v.damage = Math.min(0.95, v.damage + 0.05);
        if (v.state === VState.Drive) v.brake = 1;
        if (n === 1) { this.stats.cars++; g.traffic.onHorn?.(v); }
        if (n >= BROOD_EVENT.carBites) this.flip(v, c);
        else g.consequences.record('brood', 'car', 'damage', v.x, v.z, v, 'threat');
        break;
      }
      case 'robot': {
        const r = p.ref as Robot;
        const n = (this.gnaw.get(r) ?? 0) + (big ? 3 : 1);
        this.gnaw.set(r, n);
        const dx = r.x - c.x, dz = r.z - c.z, l = Math.hypot(dx, dz) || 1;
        // Chewed apart: knocked about, then broken.
        g.future.robots.knock(r, (dx / l) * (n >= BROOD_EVENT.robotBites ? 1500 : 160), 60, (dz / l) * (n >= BROOD_EVENT.robotBites ? 1500 : 160));
        if (n >= BROOD_EVENT.robotBites) { this.stats.robots++; g.consequences.record('brood', 'robot', 'break', r.x, r.z, r, 'threat'); }
        break;
      }
    }
  }

  /** A car gnawed through or heaved by a big one: rolled over onto its side or roof. */
  private flip(v: Vehicle, c: Critter): void {
    const g = this.g;
    g.traffic.wreckIt(v);
    const side = (c.x - v.x) * Math.cos(v.yaw) - (c.z - v.z) * Math.sin(v.yaw) > 0 ? 1 : -1;
    const rx = Math.cos(v.yaw) * side, rz = -Math.sin(v.yaw) * side;
    g.vehicles.makeWreck(v, v.x + rx * v.width * 0.45, v.y + 0.3, v.z + rz * v.width * 0.45, -rx * 3500, 7500, -rz * 3500);
    g.consequences.record('brood', 'car', 'wreck', v.x, v.z, v, 'threat');
    g.audio.play('car_crash', v.x, v.y + 0.6, v.z, 0.8, 0.9, 10, g.renderer.camera.position);
    g.stimuli.emit('crash', v.x, v.y + 1, v.z, 4, 60, { cause: 'threat' });
    this.stats.flipped++;
  }

  // ================================================================== being hit

  /**
   * The player (or a power) hits the swarm round a point: punches and blasts ('blow', damage from
   * the impulse), fire, lightning, frost, wind, water, the laser's heat. Returns the creatures hit.
   */
  hit(x: number, y: number, z: number, r: number, effect: HitEffect, dmg: number, fling: number, cause: Cause = 'player', fromX = this.g.player.pos.x, fromZ = this.g.player.pos.z): Critter[] {
    if (!this.active && !this.sim.leaving) return [];
    const res = this.sim.hit(x, y, z, r, effect, dmg, fromX, fromZ, fling, cause);
    if (res.hit.length && effect !== 'frost') this.splat(res.hit, effect);
    return res.hit;
  }

  /** Feedback where creatures were hit (bits of chitin, sparks, frost). */
  private splat(list: Critter[], effect: HitEffect): void {
    const g = this.g;
    let k = 0;
    for (const c of list) {
      if (k++ > 6) break;
      g.debris.chipBurst(c.x, c.y + 0.25 * c.size, c.z, 4, 2.5, 0, 1, 0, effect === 'fire' ? CHAR : CHITIN, 0.04 * c.size, 1.6);
    }
  }

  private killed(c: Critter, cause: string | null): void {
    const g = this.g, K = BROOD_EVENT.karma, cam = g.renderer.camera.position;
    if (this.t - this.screechT > 0.12) { this.screechT = this.t; g.audio.play('brood_screech', c.x, c.y + 0.3, c.z, c.kind ? 0.9 : 0.45, (c.kind ? 0.7 : 1.1) + Math.random() * 0.3, 6, cam); }
    if (cause !== 'player') return;
    this.stats.playerKills++;
    if (c.kind === 1) { g.progress.addKarma(K.brute, 'killed a brood beast'); g.crime.rep.add(BROOD_EVENT.rep.brute, 'brood beast'); }
    else g.progress.addKarma(K.skitter, 'killed a brood creature');
    // It was on someone: they owe the player.
    const p = c.prey;
    if (p && p.kind === 'person' && Math.hypot(p.x - c.x, p.z - c.z) < 3 && this.t - this.savedT > 4) {
      this.savedT = this.t;
      this.stats.saved++;
      g.progress.addKarma(K.saved, 'saved someone from the brood');
    }
  }

  // ================================================================== per frame

  update(dt: number): void {
    this.t += dt;
    const g = this.g, sim = this.sim;
    sim.update(dt);
    // The incident's centre follows the swarm (those out and alive).
    let cx = 0, cz = 0, n = 0;
    for (const c of sim.list) if (c.mode === CMode.Run || c.mode === CMode.Wall || c.mode === CMode.Frozen) { cx += c.x; cz += c.z; n++; }
    if (n) { const k = Math.min(1, dt * 0.8); this.x += (cx / n - this.x) * k; this.z += (cz / n - this.z) * k; }
    this.sounds(dt, n);
    if (!this.active) {
      if (sim.leaving && sim.alive === 0) this.loop?.stop();
      return;
    }
    // Where the carpet heads when there is nobody in reach: the busiest spot round about, or the player.
    this.goalT -= dt;
    if (this.goalT <= 0) { this.goalT = 6; this.pickGoal(); }
    // People round about hear it (chittering, screams): they keep away.
    this.stimT -= dt;
    if (this.stimT <= 0 && n) { this.stimT = 1.5; g.stimuli.emit('threat', this.x, g.world.groundHeight(this.x, this.z) + 1, this.z, 3, 45, { cause: 'threat' }); }
    // The end: all dead; most dead and the rest flee; time up; or the player far away.
    const out = sim.stats.out, alive = sim.alive;
    const p = g.player.pos;
    this.farT = Math.hypot(p.x - this.x, p.z - this.z) > BROOD_EVENT.farR ? this.farT + dt : 0;
    if (alive === 0 && out > 0) this.finish('stopped');
    else if (out >= this.total && alive <= Math.ceil(this.total * BROOD_EVENT.flee) && this.t > 8) this.finish('stopped');
    else if (this.farT > BROOD_EVENT.farT) this.finish('abandoned');
    else if (this.t > this.maxT) this.finish('retreated');
  }

  private pickGoal(): void {
    const g = this.g, p = g.player.pos, sim = this.sim;
    // The player close by and fighting them: the brood turns on the player.
    if (Math.hypot(p.x - this.x, p.z - this.z) < 45 && this.stats.playerKills > 3 && !g.player.flying) { sim.goal = { x: p.x, z: p.z }; return; }
    // Else the most people within reach of the leash.
    const peds = g.peds.neighbours(this.x, this.z, 70, this.nb).filter((a) => a.alive && !a.inside && a.state !== PState.Down);
    if (!peds.length) { const a = this.rng.range(0, Math.PI * 2); sim.goal = { x: sim.origin.x + Math.cos(a) * 25, z: sim.origin.z + Math.sin(a) * 25 }; return; }
    let best = peds[0], bn = -1;
    for (let k = 0; k < Math.min(12, peds.length); k++) {
      const a = peds[this.rng.int(0, peds.length - 1)];
      let c = 0;
      for (const b of peds) if (Math.abs(b.x - a.x) < 12 && Math.abs(b.z - a.z) < 12) c++;
      if (Math.hypot(a.x - sim.origin.x, a.z - sim.origin.z) > BROOD.leash * 0.8) continue;
      if (c > bn) { bn = c; best = a; }
    }
    sim.goal = { x: best.x, z: best.z };
  }

  /** The chittering (a loop at the swarm, louder with more of them out), now and then a screech. */
  private sounds(dt: number, n: number): void {
    const g = this.g, cam = g.renderer.camera.position;
    if (n > 0 && !this.loop) this.loop = g.audio.loop('brood_chitter', 10);
    if (this.loop) {
      // At the creature nearest the camera (it is a carpet: you hear the ones round you).
      let best: Critter | null = null, bd = Infinity;
      for (const c of this.sim.list) {
        if (c.mode !== CMode.Run && c.mode !== CMode.Wall && c.mode !== CMode.Leave) continue;
        const d = Math.hypot(c.x - cam.x, c.z - cam.z);
        if (d < bd) { bd = d; best = c; }
      }
      if (best) this.loop.set(best.x, best.y + 0.3, best.z, Math.min(1, 0.25 + n / 60), 0.9 + Math.min(0.3, n / 300));
      else this.loop.set(this.x, 0, this.z, 0, 1);
    }
    this.soundT -= dt;
    if (this.soundT <= 0 && n > 0) {
      this.soundT = 1.5 + Math.random() * 2.5;
      const c = this.sim.list[Math.floor(Math.random() * this.sim.list.length)];
      if (c && this.sim.visible(c) && c.mode !== CMode.Dead) g.audio.play('brood_screech', c.x, c.y + 0.3, c.z, 0.35, 1 + Math.random() * 0.4, 6, cam);
    }
  }

  private finish(outcome: ThreatOutcome): void {
    if (!this.active) return;
    this.active = false;
    this.outcome = outcome;
    this.sim.leave();
    const g = this.g;
    if (outcome === 'stopped' && this.stats.playerKills >= BROOD_EVENT.minKills) {
      g.progress.addKarma(BROOD_EVENT.karma.stopped, 'the brood is beaten back');
      g.crime.rep.add(BROOD_EVENT.rep.stopped, 'brood beaten back');
      g.crime.rep.count('stopped');
      g.crime.cheer();
    }
  }

  strength(): number {
    if (!this.active) return 0;
    return this.total ? this.sim.alive / this.total : 0;
  }

  // ================================================================== the police

  targetsNear(x: number, z: number, r: number): ThreatTarget[] {
    const out: ThreatTarget[] = [];
    for (const c of this.sim.list) {
      if (c.mode !== CMode.Run && c.mode !== CMode.Frozen && c.mode !== CMode.Wall) continue;
      if (Math.abs(c.x - x) > r || Math.abs(c.z - z) > r || Math.hypot(c.x - x, c.z - z) > r) continue;
      let t = this.targets.get(c);
      if (!t) {
        const cc = c;
        t = { c, get x() { return cc.x; }, get y() { return cc.y + cc.size * 0.25; }, get z() { return cc.z; }, get grounded() { return cc.mode !== CMode.Wall || cc.y - cc.py < 3; }, get on() { return cc.mode !== CMode.Dead && cc.mode !== CMode.Gone; }, get speed() { return Math.hypot(cc.vx, cc.vz); } } as CritterTarget;
        this.targets.set(c, t);
      }
      out.push(t);
      if (out.length >= 24) break;
    }
    return out;
  }

  strike(t: ThreatTarget, jx: number, jy: number, jz: number, cause: Cause): void {
    const c = (t as Partial<CritterTarget>).c;
    if (!c) return;
    const J = Math.hypot(jx, jy, jz);
    this.sim.damage(c, 'blow', 0.6 + J / 600, c.x - jx, c.z - jz, Math.min(8, J / 120), cause);
  }

  shoot(t: ThreatTarget, dmg: number, cause: Cause, fromX: number, fromZ: number): boolean {
    const c = (t as Partial<CritterTarget>).c;
    if (!c) return false;
    return this.sim.damage(c, 'blow', dmg / 20, fromX, fromZ, 2, cause);
  }

  shutdown(): void { this.finish('retreated'); }

  dispose(): void {
    this.loop?.stop();
    this.loop = null;
    for (const c of this.sim.list) c.mode = CMode.Gone;
    this.targets.clear();
  }

  snapshot(): Record<string, unknown> {
    const S = this.sim.stats;
    const modes: Record<string, number> = {};
    const names = Object.keys(CMode) as (keyof typeof CMode)[];
    for (const c of this.sim.list) { const m = names[c.mode]; modes[m] = (modes[m] ?? 0) + 1; }
    return {
      id: this.id, archetype: this.archetype, t: +this.t.toFixed(1), active: this.active, outcome: this.outcome,
      x: Math.round(this.x), z: Math.round(this.z), strength: +this.strength().toFixed(2), hurt: this.hurt,
      total: this.total, alive: this.sim.alive, holes: this.sim.holes.length, modes, ...S, ...this.stats,
    };
  }
}

const DUST = new THREE.Color(0.42, 0.4, 0.37);
const CHITIN = new THREE.Color(0.09, 0.08, 0.09);
const CHAR = new THREE.Color(0.05, 0.04, 0.03);

/** Manholes near the site (spread apart), nearest first; the site itself when there are none. */
export function findHoles(g: Game, site: { x: number; z: number }, max: number, r: number, rng: Rng): { x: number; z: number }[] {
  const all: { x: number; z: number; d: number }[] = [];
  g.underground.forEachManhole((x, z) => { const d = Math.hypot(x - site.x, z - site.z); if (d < r && !g.world.buildingAt(x, z)) all.push({ x, z, d }); });
  all.sort((a, b) => a.d - b.d);
  const out: { x: number; z: number }[] = [];
  for (const h of all) {
    if (out.length >= max) break;
    if (out.some((o) => Math.hypot(o.x - h.x, o.z - h.z) < 12)) continue;
    out.push({ x: h.x, z: h.z });
  }
  if (!out.length) {
    // No manhole about: a storm drain in the street nearby.
    const ne = g.net.nearestEdge(site.x, site.z, 80);
    if (ne) {
      const e = g.net.edges[ne.e], o = { x: 0, z: 0, dx: 0, dz: 0 };
      g.net.pointAt(e, ne.s, (e.width / 2 - 0.4) * (rng.chance(0.5) ? 1 : -1), o);
      out.push({ x: o.x, z: o.z });
    } else out.push({ x: site.x, z: site.z });
  }
  return out;
}

/**
 * The few creatures of an omen ('glimpse'): out of one manhole, across the street and down
 * another. Drawn with the swarms; gone after a few seconds.
 */
export class BroodGlimpse {
  readonly sim: BroodSim;
  t = 0;
  constructor(g: Game, from: { x: number; z: number }, to: { x: number; z: number }, seed: number) {
    const W = g.world;
    this.sim = new BroodSim({
      surface: (x, z, yRef) => W.groundHeight(x, z, yRef, 0.6),
      wall: (x, z, y) => { const b = W.buildingAt(x, z); return b && b.top > y + 0.6 ? b.top : NaN; },
      prey: () => { /* they do not stop for anyone */ },
    }, seed, [from, to]);
    // All three out of the first hole, the second is where they go.
    this.sim.spawn(3, 0, 0);
    for (const c of this.sim.list) { c.hole = 0; c.ox = c.oz = 0; }
    this.sim.goal = { x: to.x, z: to.z };
  }
  get done(): boolean { return this.t > 14 || (this.t > 2 && this.sim.alive === 0); }
  update(dt: number): void {
    this.t += dt;
    this.sim.update(dt);
    // Across, then down the far hole.
    if (this.t > 1.2 && !this.sim.leaving) {
      this.sim.leave();
      for (const c of this.sim.list) if (c.mode === CMode.Leave) c.hole = 1;
    }
  }
}

/**
 * An omen of a coming brood near `site`, seen from where the player is: false when there was
 * nothing to show it on (no manhole about).
 */
export function broodOmen(g: Game, site: { x: number; z: number }, kind: string, rng: Rng, glimpses: BroodGlimpse[]): boolean {
  const p = g.player.pos, cam = g.renderer.camera.position;
  if (g.underground.isUnder(p.x, p.y + 0.5, p.z)) return false;
  // Manholes between 15 and 80 m of the player, towards the site first.
  const near: { x: number; z: number; d: number }[] = [];
  g.underground.forEachManhole((x, z) => {
    const d = Math.hypot(x - p.x, z - p.z);
    if (d > 15 && d < 80 && !g.world.buildingAt(x, z)) near.push({ x, z, d: d + Math.hypot(x - site.x, z - site.z) * 0.3 });
  });
  if (!near.length) return false;
  near.sort((a, b) => a.d - b.d);
  const h = near[0];
  const y = g.world.groundHeight(h.x, h.z);
  if (kind === 'glimpse') {
    // A second hole across the street (another manhole, else a drain at the far kerb).
    const far = near.find((o) => { const d = Math.hypot(o.x - h.x, o.z - h.z); return d > 8 && d < 30; });
    let to: { x: number; z: number };
    if (far) to = { x: far.x, z: far.z };
    else {
      const ne = g.net.nearestEdge(h.x, h.z, 30);
      if (!ne) return false;
      const e = g.net.edges[ne.e], o = { x: 0, z: 0, dx: 0, dz: 0 };
      g.net.pointAt(e, Math.min(e.len - 2, ne.s + 10), -(e.width / 2 - 0.3), o);
      to = { x: o.x, z: o.z };
    }
    glimpses.push(new BroodGlimpse(g, { x: h.x, z: h.z }, to, (rng.float() * 2 ** 32) >>> 0));
    g.audio.play('brood_screech', h.x, y + 0.3, h.z, 0.5, 1.3, 8, cam);
    g.stimuli.emit('scream', h.x, y + 1, h.z, 2, 25, { cause: 'threat' });
    return true;
  }
  // 'chitter': the lid rattles, dust puffs out of its holes, a chittering from below.
  g.audio.play('brood_chitter', h.x, y, h.z, 0.7, 1, 8, cam);
  g.audio.play('metal_bend', h.x, y, h.z, 0.3, 1.8, 6, cam);
  g.dust.burst(h.x, y + 0.1, h.z, 8, 0.4, 1.2, 0.5, 1.4, DUST, 0.3, 0.4);
  g.stimuli.emit('tremor', h.x, y, h.z, 2, 30, { cause: 'threat' });
  return true;
}

export { BROOD_KINDS };
