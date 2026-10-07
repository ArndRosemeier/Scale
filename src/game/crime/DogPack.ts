/**
 * Trained dogs (VILLAINS_PLAN §3.6, the eco-radicals): a Beast-master's pack of three or four. They
 * keep at heel while their handler is calm; once the handler squares up to the hero they run them
 * down and bite (small damage, every bite a flinch); the handler's whistle (powers/Caster
 * 'whistle', the tell first) sends them in a lunge at where the hero stood. Hit hard enough they
 * go down yelping, then slink off; with their handler beaten the whole pack scatters. No deaths:
 * a dog that is "beaten" only runs away. A giant hero scares them off.
 *
 * Pure simulation (positions, states, timers) behind `PackWorld`, so it runs headless in tests;
 * CrimeSystem draws them (deeds/critters' dog, run cycle) and routes hits to them (Game.strike,
 * the powers' `swarm` hook). The pack counts against the actor budget as one actor.
 */
import type { HitEffect } from '../threats/brood/BroodSim';

export const DOGS = {
  /** Dogs in a pack. */
  n: [3, 4] as [number, number],
  /** Hit points in the brood's units (a punch is J / 150: a good one floors a dog). */
  hp: 4,
  /** Speeds (m/s): trotting at heel, running down a target, the whistle's lunge. */
  trot: 3.4, run: 8.2, lunge: 12.5,
  /** At heel: within this of the handler (m). */
  heelR: 3.2,
  /** Bite reach (m), seconds between bites, damage (a lunge's hit is harder). */
  biteR: 1.15, biteEvery: 1.25, bite: 2.2, lungeHit: 6,
  /** Run the hero down within this of the handler; back to heel beyond the leash. */
  chaseR: 26, leash: 38,
  /** The lunge lasts at most this long (s), and lands within this of the hero (m). */
  lungeT: 1.3, lungeR: 1.6,
  /** Seconds lying down after a hard hit, then running off for this long before gone. */
  downT: 4.5, fleeFor: 14,
  /** The hero this tall scares them off (m). */
  giant: 4,
  /** Dogs keep this far apart (m). */
  sep: 0.95,
};

export type DogState = 'heel' | 'chase' | 'bite' | 'lunge' | 'down' | 'flee' | 'gone';

export interface Dog {
  id: number;
  x: number; y: number; z: number;
  vx: number; vz: number;
  /** Facing (yaw: forward = (−sin, −cos), like people). */
  heading: number;
  hp: number;
  state: DogState;
  /** Seconds in the state. */
  t: number;
  /** Seconds to the next bite. */
  biteT: number;
  /** The lunge's end point, and whether it has landed. */
  lx: number; lz: number; landed: boolean;
  /** Frozen solid for this long (frost). */
  frozen: number;
  /** Seed for the look (coat colour, size). */
  seed: number;
  /** Where at heel (angle round the handler). */
  slot: number;
}

/** The dogs' handler as the pack sees them. */
export interface Handler {
  readonly x: number;
  readonly z: number;
  /** Squared up to the hero (fighting them). */
  fighting(): boolean;
  /** Beaten, cuffed, gone: the pack scatters. */
  beaten(): boolean;
}

export interface PackWorld {
  player: { x: number; y: number; z: number; height: number; down?: boolean };
  ground(x: number, z: number): number;
  /** Inside a building (a dog does not run through walls). */
  blocked?(x: number, z: number): boolean;
  hurtPlayer(dmg: number, fromX: number, fromZ: number): void;
  sound(id: string, x: number, y: number, z: number, gain: number, pitch: number): void;
  random(): number;
}

let nextId = 1;

export class DogPack {
  readonly dogs: Dog[] = [];
  /** Bites landed, lunges that hit, dogs knocked out (tests, dev). */
  stats = { bites: 0, lunges: 0, downed: 0 };
  private barkT = 0;

  constructor(private w: PackWorld, readonly handler: Handler, n: number, seed: number) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + seed * 0.001;
      const x = handler.x + Math.sin(a) * 2, z = handler.z + Math.cos(a) * 2;
      this.dogs.push({ id: nextId++, x, y: w.ground(x, z), z, vx: 0, vz: 0, heading: 0, hp: DOGS.hp, state: 'heel', t: 0, biteT: 0.4 + i * 0.3, lx: 0, lz: 0, landed: false, frozen: 0, seed: (seed + i * 7919) >>> 0, slot: a });
    }
  }

  /** Every dog gone (ran off): the pack can be dropped. */
  get done(): boolean { return this.dogs.every((d) => d.state === 'gone'); }

  /** Dogs still in the fight (not down, not running off). */
  get active(): Dog[] { return this.dogs.filter((d) => d.state !== 'down' && d.state !== 'flee' && d.state !== 'gone'); }

  /** The whistle: every dog still in it lunges at (tx, tz). */
  sic(tx: number, tz: number): number {
    let n = 0;
    for (const d of this.dogs) {
      if (d.state === 'down' || d.state === 'flee' || d.state === 'gone' || d.frozen > 0) continue;
      d.state = 'lunge'; d.t = 0; d.landed = false;
      // Spread round the point (they come at it from their own sides).
      const ox = (this.w.random() - 0.5) * 1.2, oz = (this.w.random() - 0.5) * 1.2;
      d.lx = tx + ox; d.lz = tz + oz;
      n++;
    }
    if (n) this.w.sound('dog_bark', tx, 0.6, tz, 0.7, 1.15);
    return n;
  }

  update(dt: number): void {
    const p = this.w.player, H = this.handler;
    const scatter = H.beaten() || p.height > DOGS.giant;
    const hunt = !scatter && H.fighting() && !p.down && Math.hypot(p.x - H.x, p.z - H.z) < DOGS.chaseR;
    this.barkT -= dt;
    for (const d of this.dogs) {
      if (d.state === 'gone') continue;
      d.t += dt;
      if (d.frozen > 0) { d.frozen -= dt; d.vx = d.vz = 0; continue; }
      if (scatter && d.state !== 'down' && d.state !== 'flee') this.flee(d);
      let tx = d.x, tz = d.z, speed = 0;
      switch (d.state) {
        case 'heel': {
          if (hunt) { d.state = 'chase'; d.t = 0; break; }
          // A place round the handler; trot (or run when left behind).
          tx = H.x + Math.sin(d.slot) * 1.6; tz = H.z + Math.cos(d.slot) * 1.6;
          const far = Math.hypot(tx - d.x, tz - d.z);
          speed = far < 0.4 ? 0 : far > 6 ? DOGS.run : DOGS.trot;
          break;
        }
        case 'chase':
        case 'bite': {
          const dp = Math.hypot(p.x - d.x, p.z - d.z);
          if (!hunt || Math.hypot(d.x - H.x, d.z - H.z) > DOGS.leash) { d.state = 'heel'; d.t = 0; break; }
          if (dp < DOGS.biteR) {
            d.state = 'bite';
            d.biteT -= dt;
            if (d.biteT <= 0) {
              d.biteT = DOGS.biteEvery * (0.8 + this.w.random() * 0.4);
              this.w.hurtPlayer(DOGS.bite * (0.8 + this.w.random() * 0.4), d.x, d.z);
              this.w.sound('dog_bark', d.x, 0.5, d.z, 0.6, 1.3 + this.w.random() * 0.2);
              this.stats.bites++;
            }
            // Snapping round the hero's legs: circle a little.
            const ax = d.x - p.x, az = d.z - p.z, al = Math.hypot(ax, az) || 1;
            tx = p.x + (ax / al) * 0.8 - (az / al) * 0.4; tz = p.z + (az / al) * 0.8 + (ax / al) * 0.4;
            speed = 2;
          } else {
            d.state = 'chase';
            tx = p.x; tz = p.z; speed = DOGS.run;
          }
          break;
        }
        case 'lunge': {
          tx = d.lx; tz = d.lz; speed = DOGS.lunge;
          if (!d.landed && !p.down && Math.hypot(p.x - d.x, p.z - d.z) < DOGS.lungeR && Math.abs(p.y - d.y) < 1.8) {
            d.landed = true;
            this.w.hurtPlayer(DOGS.lungeHit * (0.85 + this.w.random() * 0.3), d.x, d.z);
            this.stats.lunges++;
          }
          if (d.t > DOGS.lungeT || Math.hypot(d.lx - d.x, d.lz - d.z) < 0.5) { d.state = hunt ? 'chase' : 'heel'; d.t = 0; }
          break;
        }
        case 'down':
          if (d.t > DOGS.downT) this.flee(d);
          break;
        case 'flee': {
          // Away from the hero, off into the streets; gone once well away.
          const ax = d.x - p.x, az = d.z - p.z, al = Math.hypot(ax, az) || 1;
          tx = d.x + (ax / al) * 10; tz = d.z + (az / al) * 10; speed = DOGS.run * 0.9;
          if (d.t > DOGS.fleeFor || al > 70) d.state = 'gone';
          break;
        }
      }
      this.steer(d, tx, tz, speed, dt);
    }
    if (hunt && this.barkT <= 0) {
      this.barkT = 1.2 + this.w.random() * 1.5;
      const d = this.active[0];
      if (d) this.w.sound('dog_bark', d.x, 0.5, d.z, 0.55, 0.9 + this.w.random() * 0.3);
    }
  }

  private flee(d: Dog): void {
    d.state = 'flee'; d.t = 0;
  }

  /** Move towards a point at `speed` (eased), keep apart, stay out of buildings, on the ground. */
  private steer(d: Dog, tx: number, tz: number, speed: number, dt: number): void {
    let dx = tx - d.x, dz = tz - d.z;
    const l = Math.hypot(dx, dz);
    let wx = 0, wz = 0;
    if (speed > 0 && l > 0.05) { wx = (dx / l) * speed; wz = (dz / l) * speed; }
    // Separation from the others.
    for (const o of this.dogs) {
      if (o === d || o.state === 'gone') continue;
      const ox = d.x - o.x, oz = d.z - o.z, ol = Math.hypot(ox, oz);
      if (ol > 0.001 && ol < DOGS.sep) { wx += (ox / ol) * (DOGS.sep - ol) * 6; wz += (oz / ol) * (DOGS.sep - ol) * 6; }
    }
    const k = Math.min(1, dt * (d.state === 'lunge' ? 10 : 5));
    d.vx += (wx - d.vx) * k; d.vz += (wz - d.vz) * k;
    const nx = d.x + d.vx * dt, nz = d.z + d.vz * dt;
    if (this.w.blocked?.(nx, nz)) { d.vx *= -0.3; d.vz *= -0.3; }
    else { d.x = nx; d.z = nz; }
    d.y = this.w.ground(d.x, d.z);
    const v = Math.hypot(d.vx, d.vz);
    if (v > 0.3) d.heading = Math.atan2(-d.vx, -d.vz);
    else if (d.state === 'bite' || d.state === 'chase') { dx = this.w.player.x - d.x; dz = this.w.player.z - d.z; d.heading = Math.atan2(-dx, -dz); }
  }

  /**
   * A hit round a point (a punch, a power — the brood's effects and units): dogs in reach take it.
   * A floored dog lies there yelping, then runs off; fire sends them running at once; frost freezes.
   */
  hit(x: number, y: number, z: number, r: number, effect: HitEffect, dmg: number, fling: number): Dog[] {
    const out: Dog[] = [];
    for (const d of this.dogs) {
      if (d.state === 'gone' || d.state === 'down' || Math.hypot(d.x - x, d.z - z) > r + 0.4 || Math.abs(d.y + 0.4 - y) > r + 1.5) continue;
      out.push(d);
      if (effect === 'frost') { d.frozen = Math.max(d.frozen, dmg); continue; }
      if (effect === 'fire' || effect === 'heat') { if (d.state !== 'flee') { this.flee(d); this.w.sound('dog_bark', d.x, 0.5, d.z, 0.7, 1.6); } continue; }
      d.hp -= Math.max(effect === 'wind' || effect === 'water' ? 0.5 : 0, dmg);
      const ax = d.x - x, az = d.z - z, al = Math.hypot(ax, az) || 1;
      d.vx += (ax / al) * fling * 1.5; d.vz += (az / al) * fling * 1.5;
      if (d.hp <= 0 || fling > 5) {
        d.state = 'down'; d.t = 0; d.hp = Math.max(d.hp, 0);
        this.stats.downed++;
        this.w.sound('dog_bark', d.x, 0.4, d.z, 0.8, 1.8);
      }
    }
    return out;
  }

  /** Debug summary. */
  snapshot(): { state: DogState; hp: number; x: number; z: number }[] {
    return this.dogs.map((d) => ({ state: d.state, hp: +d.hp.toFixed(1), x: Math.round(d.x), z: Math.round(d.z) }));
  }
}
