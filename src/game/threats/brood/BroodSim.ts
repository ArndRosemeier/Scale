/**
 * The Brood's swarm (THREATS_PLAN §1 #4): the pure simulation behind it — no three.js, no Game,
 * deterministic per seed, headless-testable (tools/selftest.ts). The game side (Brood.ts) feeds it
 * the ground and the prey round about and turns its bites into knock-downs, gnawed cars and hurt
 * players; the renderer (broodMesh.ts) draws its creatures, interpolated between steps.
 *
 * It steps at a fixed 15 Hz (THREATS_PLAN §4 budget: ≤ 150 creatures, boids at 15 Hz):
 *
 *  - Emerging: the creatures wait their turn in the sewer, then leap out of the manhole one after
 *    another, a stream spreading into a carpet.
 *  - Running: boids on a spatial grid — strong separation (a carpet, not a heap), a little
 *    alignment and cohesion (the wave keeps together), a skittering burst-and-pause gait. Each
 *    goes for the nearest prey within reach that is not already covered (a few per person, more
 *    on a car), otherwise for the swarm's goal at its own offset in the carpet; never further than
 *    the leash from where they came out.
 *  - Walls: a creature that runs into a facade may climb it (skitters, not the big ones): up the
 *    wall to a seeded height, cling a moment and drop off — or over the edge onto a low roof and
 *    across it. The others slide along the wall.
 *  - Bites: in reach of its prey it bites (the owner decides what that does) and keeps biting
 *    every so often while it stays on it.
 *  - Hit (punches, blasts, fire, lightning, frost, wind, water, the police): hit points per kind;
 *    frozen ones stand still and shatter at the next blow; killed ones are flung, curl up and
 *    fade after a few seconds (no gore). Leaving, they run for the nearest hole and drop in.
 */
import { Rng } from '../../../core/rng';

/** Kinds: skitters are the carpet; brutes are few, slow and strong (they flip cars). */
export const BROOD_KINDS = [
  { name: 'skitter', len: 1.1, speed: 6.2, hp: 1, sep: 1.15, reach: 0.8, biteGap: 1.5, climb: 0.4 },
  { name: 'brute', len: 2.4, speed: 4.6, hp: 6, sep: 2.4, reach: 1.5, biteGap: 2.4, climb: 0 },
] as const;

export const BROOD = {
  /** Simulation rate (Hz) and the most creatures one swarm has. */
  hz: 15, cap: 150,
  /** Prey within this (m) is hunted; neighbours within flockR flock. */
  huntR: 18, flockR: 5,
  /** The most creatures on one prey at a time. */
  maxOn: { person: 5, player: 8, car: 10, robot: 4 } as Record<PreyKind, number>,
  /** No further than this from the hole they came out of (m). */
  leash: 120,
  /** Climbing speed (m/s), the highest a climb goes (m), gravity (m/s²). */
  climbSpeed: 3.4, climbMax: 14, gravity: 18,
  /** Turning: steering acceleration (m/s²). */
  accel: 34,
  /** A killed creature lies curled this long (s) before it is gone. */
  deadT: 5,
  /** Leaving: one that has not reached a hole by then slips away into a drain or a crack (s). */
  leaveT: 20,
  /** Out of the hole: the stream (s between creatures, per hole). */
  emergeGap: 0.12,
};

export type PreyKind = 'person' | 'player' | 'car' | 'robot';

/** Something the swarm can go for, as the owner sees it this step. */
export interface Prey {
  kind: PreyKind;
  x: number; y: number; z: number;
  /** Body radius (m): bites land within reach + r. */
  r: number;
  /** The game object behind it (a person, a car, the player, a robot). */
  ref: unknown;
  /** Creatures on it this step (the sim counts). */
  n: number;
  /** The step it was last offered in (the sim stamps it). */
  seen?: number;
}

/** What the sim needs of the world. */
export interface BroodWorld {
  /** Walkable height under (x, z) for something at height yRef: ground, roofs and decks below it. */
  surface(x: number, z: number, yRef: number): number;
  /** A building wall at (x, z) for something at height y: its roof height, or NaN (open). */
  wall(x: number, z: number, y: number): number;
  /** The prey about now (refilled every step; keep one object per thing — creatures hold on to it). */
  prey(out: Prey[]): void;
}

export const CMode = { Hidden: 0, Run: 1, Wall: 2, Frozen: 3, Leave: 4, Dead: 5, Gone: 6 } as const;
export type CMode = (typeof CMode)[keyof typeof CMode];

export type HitEffect = 'blow' | 'fire' | 'shock' | 'frost' | 'wind' | 'water' | 'heat';

export interface Critter {
  readonly id: number;
  /** 0 skitter, 1 brute. */
  readonly kind: 0 | 1;
  /** Body length (m). */
  readonly size: number;
  x: number; y: number; z: number;
  /** Position and heading at the previous step (the renderer interpolates). */
  px: number; py: number; pz: number; pyaw: number;
  vx: number; vy: number; vz: number;
  yaw: number;
  /** Off the ground (leaping out, falling, flung). */
  air: boolean;
  mode: CMode;
  /** Seconds in this mode. */
  t: number;
  /** Hidden: seconds until it comes out; which hole. */
  delay: number;
  hole: number;
  hp: number;
  /** Climbing: the wall's outward normal, the height it climbs to, the roof's height. */
  nx: number; nz: number; climbTo: number; top: number;
  prey: Prey | null;
  pickT: number;
  biteT: number;
  /** Frozen for (s). */
  frozenT: number;
  /** Fleeing from fire / a blow (s): runs away from fx, fz. */
  fleeT: number; fx: number; fz: number;
  /** Gait phase (rad) and its previous value; curl (0 alive … 1 curled up, dead). */
  phase: number; pphase: number;
  curl: number;
  /** Its place in the carpet round the goal. */
  ox: number; oz: number;
  /** Who hurt it last ('player', 'police', …). */
  lastBy: string | null;
}

export interface BroodStats {
  spawned: number; out: number; killed: number; bites: number; climbs: number; gone: number;
  killedBy: Record<string, number>;
  bitesOn: Record<PreyKind, number>;
}

const STEP = 1 / BROOD.hz;
const CELL = 2.5;
const PCELL = 8;
const ckey = (x: number, z: number, c: number) => ((Math.floor(x / c) + 32768) & 0xffff) * 65536 + ((Math.floor(z / c) + 32768) & 0xffff);

export class BroodSim {
  readonly list: Critter[] = [];
  readonly holes: { x: number; z: number }[];
  /** Where the swarm goes when there is nothing to hunt (the owner moves it). */
  goal: { x: number; z: number };
  /** Where they came out (the leash is round it). */
  readonly origin: { x: number; z: number };
  readonly stats: BroodStats = { spawned: 0, out: 0, killed: 0, bites: 0, climbs: 0, gone: 0, killedBy: {}, bitesOn: { person: 0, player: 0, car: 0, robot: 0 } };
  /** A bite landed (the owner applies it). */
  onBite: ((c: Critter, p: Prey) => void) | null = null;
  /** A creature was killed (sounds, rewards). */
  onKill: ((c: Critter, cause: string | null) => void) | null = null;
  /** Interpolation between the last two steps (0 … 1). */
  alpha = 0;
  /** Seconds simulated. */
  time = 0;
  leaving = false;
  private acc = 0;
  private rng: Rng;
  private grid = new Map<number, Critter[]>();
  private pool: Critter[][] = [];
  private preyList: Prey[] = [];
  private pgrid = new Map<number, Prey[]>();
  private ppool: Prey[][] = [];
  private nb: Critter[] = [];
  private nextId = 0;
  private stepNo = 0;

  constructor(private world: BroodWorld, seed: number, holes: { x: number; z: number }[]) {
    this.rng = new Rng(seed);
    this.holes = holes.length ? holes : [{ x: 0, z: 0 }];
    let sx = 0, sz = 0;
    for (const h of this.holes) { sx += h.x; sz += h.z; }
    this.origin = { x: sx / this.holes.length, z: sz / this.holes.length };
    this.goal = { ...this.origin };
  }

  /**
   * Queue `n` creatures (brutes among them) to come out of the holes in a stream, the first
   * after `delay` s.
   */
  spawn(n: number, brutes: number, delay = 0): void {
    const rng = this.rng;
    n = Math.min(n, BROOD.cap - this.list.filter((c) => c.mode !== CMode.Gone).length);
    const H = this.holes.length;
    // Brutes spread through the stream (not all at the start).
    const bruteAt = new Set<number>();
    for (let k = 0; k < Math.min(brutes, n); k++) bruteAt.add(Math.floor(((k + 0.5) / brutes) * n));
    for (let i = 0; i < n; i++) {
      const kind: 0 | 1 = bruteAt.has(i) ? 1 : 0;
      const K = BROOD_KINDS[kind];
      const hole = i % H;
      const a = rng.range(0, Math.PI * 2), rr = Math.sqrt(rng.float()) * Math.sqrt(n) * 1.4 + 1.5;
      const c: Critter = {
        id: this.nextId++, kind, size: K.len * rng.range(0.85, 1.15),
        x: this.holes[hole].x, y: 0, z: this.holes[hole].z, px: 0, py: 0, pz: 0, pyaw: 0,
        vx: 0, vy: 0, vz: 0, yaw: rng.range(-Math.PI, Math.PI), air: false,
        mode: CMode.Hidden, t: 0, delay: delay + Math.floor(i / H) * BROOD.emergeGap * rng.range(0.6, 1.6), hole, hp: K.hp,
        nx: 0, nz: 0, climbTo: 0, top: 0, prey: null, pickT: rng.range(0, 0.5), biteT: 0, frozenT: 0, fleeT: 0, fx: 0, fz: 0,
        phase: rng.range(0, Math.PI * 2), pphase: 0, curl: 0,
        ox: Math.cos(a) * rr, oz: Math.sin(a) * rr, lastBy: null,
      };
      c.y = this.world.surface(c.x, c.z, Infinity) - 0.8;
      c.px = c.x; c.py = c.y; c.pz = c.z; c.pyaw = c.yaw; c.pphase = c.phase;
      this.list.push(c);
      this.stats.spawned++;
    }
  }

  /** Creatures still in the fight (out or about to come out, not dead or gone). */
  get alive(): number {
    let n = 0;
    for (const c of this.list) if (c.mode !== CMode.Dead && c.mode !== CMode.Gone) n++;
    return n;
  }

  /** Seen in the world (for drawing): out of the hole and not faded away. */
  visible(c: Critter): boolean { return c.mode !== CMode.Hidden && c.mode !== CMode.Gone; }

  /** Everyone heads for the nearest hole and drops in (the swarm withdraws). */
  leave(): void {
    if (this.leaving) return;
    this.leaving = true;
    for (const c of this.list) {
      if (c.mode === CMode.Hidden) { c.mode = CMode.Gone; this.stats.gone++; continue; }
      if (c.mode === CMode.Run || c.mode === CMode.Wall || c.mode === CMode.Frozen) this.setLeave(c);
    }
  }

  private setLeave(c: Critter): void {
    let bi = 0, bd = Infinity;
    this.holes.forEach((h, i) => { const d = Math.hypot(h.x - c.x, h.z - c.z); if (d < bd) { bd = d; bi = i; } });
    c.hole = bi;
    if (c.mode === CMode.Wall) this.dropOff(c);
    c.mode = CMode.Leave; c.t = 0; c.prey = null;
  }

  /** Advance by dt seconds (steps at 15 Hz; `alpha` is how far into the next step). */
  update(dt: number): void {
    this.acc += Math.min(dt, 0.25);
    while (this.acc >= STEP) { this.acc -= STEP; this.step(STEP); }
    this.alpha = this.acc / STEP;
  }

  // ================================================================== one step

  step(h: number): void {
    this.time += h;
    this.stepNo++;
    this.buildGrid();
    this.buildPrey();
    for (const c of this.list) {
      c.px = c.x; c.py = c.y; c.pz = c.z; c.pyaw = c.yaw; c.pphase = c.phase;
      if (c.mode === CMode.Gone) continue;
      c.t += h;
      c.biteT -= h;
      switch (c.mode) {
        case CMode.Hidden: this.hidden(c, h); break;
        case CMode.Run: case CMode.Leave: this.run(c, h); break;
        case CMode.Wall: this.climb(c, h); break;
        case CMode.Frozen:
          c.frozenT -= h;
          if (c.air) this.fall(c, h);
          if (c.frozenT <= 0) { c.mode = this.leaving ? CMode.Leave : CMode.Run; c.t = 0; if (this.leaving) this.setLeave(c); }
          break;
        case CMode.Dead:
          if (c.air) this.fall(c, h);
          c.curl = Math.min(1, c.curl + h * 4);
          if (c.t > BROOD.deadT) { c.mode = CMode.Gone; this.stats.gone++; }
          break;
      }
    }
  }

  private hidden(c: Critter, h: number): void {
    c.delay -= h;
    if (c.delay > 0 || this.leaving) return;
    // Out of the hole: a leap up and away.
    const H = this.holes[c.hole], rng = this.rng;
    const a = rng.range(0, Math.PI * 2), sp = rng.range(1.5, 4);
    c.x = H.x + Math.cos(a) * 0.2; c.z = H.z + Math.sin(a) * 0.2;
    c.y = this.world.surface(c.x, c.z, Infinity) - 0.3;
    c.vx = Math.cos(a) * sp; c.vz = Math.sin(a) * sp; c.vy = rng.range(4, 6.5) * (c.kind ? 0.8 : 1);
    c.yaw = Math.atan2(-c.vx, -c.vz);
    c.px = c.x; c.py = c.y; c.pz = c.z; c.pyaw = c.yaw;
    c.air = true;
    c.mode = CMode.Run; c.t = 0;
    this.stats.out++;
  }

  /** Ballistic (leaping out, falling off a wall, flung); lands on what is below. */
  private fall(c: Critter, h: number): void {
    c.vy -= BROOD.gravity * h;
    let nx = c.x + c.vx * h, nz = c.z + c.vz * h;
    const ny = c.y + c.vy * h;
    // Flung into a wall: stops against it and slides down.
    if (!isNaN(this.world.wall(nx, nz, ny))) { nx = c.x; nz = c.z; c.vx *= -0.2; c.vz *= -0.2; }
    c.x = nx; c.z = nz;
    const s = this.world.surface(c.x, c.z, Math.max(c.y, ny) + 0.3);
    if (ny <= s) { c.y = s; c.vy = 0; c.air = false; c.vx *= 0.3; c.vz *= 0.3; }
    else c.y = ny;
  }

  private run(c: Critter, h: number): void {
    if (c.air) { this.fall(c, h); c.phase += h * 14; return; }
    const K = BROOD_KINDS[c.kind], rng = this.rng;
    // What it goes for.
    let tx: number, tz: number;
    let speed: number = K.speed;
    if (c.mode === CMode.Leave) {
      const H = this.holes[c.hole];
      tx = H.x; tz = H.z;
      speed *= 1.15;
      // In the hole — or, cut off from it (on a roof, behind a wall), into a drain or a crack.
      if (Math.hypot(H.x - c.x, H.z - c.z) < 0.9 || c.t > BROOD.leaveT) { c.mode = CMode.Gone; this.stats.gone++; return; }
    } else if (c.fleeT > 0) {
      c.fleeT -= h;
      const dx = c.x - c.fx, dz = c.z - c.fz, l = Math.hypot(dx, dz) || 1;
      tx = c.x + (dx / l) * 10; tz = c.z + (dz / l) * 10;
      speed *= 1.2;
    } else {
      c.pickT -= h;
      if (c.pickT <= 0 || (c.prey && c.prey.seen !== this.stepNo)) { c.pickT = 0.4 + rng.float() * 0.3; c.prey = this.pickPrey(c); }
      if (c.prey) c.prey.n++;
      const fromO = Math.hypot(c.x - this.origin.x, c.z - this.origin.z);
      if (c.prey && fromO < BROOD.leash) { tx = c.prey.x; tz = c.prey.z; }
      else if (fromO > BROOD.leash) { c.prey = null; tx = this.origin.x + c.ox; tz = this.origin.z + c.oz; }
      else { tx = this.goal.x + c.ox; tz = this.goal.z + c.oz; }
    }
    // Desired velocity: towards it, apart from the others, with the wave.
    let dx = tx - c.x, dz = tz - c.z;
    const dist = Math.hypot(dx, dz);
    // At its place in the carpet: mill about slowly.
    const arrive = c.prey ? 1 : Math.min(1, dist / 4);
    if (dist > 1e-3) { dx /= dist; dz /= dist; }
    let sx = 0, sz = 0, ax = 0, az = 0, cx = 0, cz = 0, n = 0;
    for (const o of this.neighbours(c.x, c.z, BROOD.flockR)) {
      if (o === c || o.mode === CMode.Dead || o.air) continue;
      const ox = c.x - o.x, oz = c.z - o.z, d = Math.hypot(ox, oz);
      if (d > BROOD.flockR || Math.abs(o.y - c.y) > 2) continue;
      const sep = (K.sep + BROOD_KINDS[o.kind].sep) * 0.5;
      if (d < sep) { const k = (sep - d) / sep / Math.max(0.05, d); sx += ox * k; sz += oz * k; }
      ax += o.vx; az += o.vz; cx += o.x; cz += o.z; n++;
    }
    let wx = dx * arrive * 1.0 + sx * 1.6, wz = dz * arrive * 1.0 + sz * 1.6;
    if (n) {
      const al = Math.hypot(ax, az) || 1;
      wx += (ax / al) * 0.25 + ((cx / n - c.x) / BROOD.flockR) * 0.15;
      wz += (az / al) * 0.25 + ((cz / n - c.z) / BROOD.flockR) * 0.15;
    }
    // Wander: a slowly turning twitch.
    const wa = c.phase * 0.13 + c.id * 1.7;
    wx += Math.cos(wa) * 0.3; wz += Math.sin(wa) * 0.3;
    // Skittering: bursts and pauses (the big ones lumber steadily).
    const burst = c.kind ? 1 : 0.55 + 0.6 * Math.abs(Math.sin(this.time * 2.7 + c.id * 0.9));
    const wl = Math.hypot(wx, wz);
    const want = Math.min(1, wl) * speed * burst;
    const tvx = wl > 1e-3 ? (wx / wl) * want : 0, tvz = wl > 1e-3 ? (wz / wl) * want : 0;
    const ddx = tvx - c.vx, ddz = tvz - c.vz, dl = Math.hypot(ddx, ddz), amax = BROOD.accel * h;
    if (dl > amax) { c.vx += (ddx / dl) * amax; c.vz += (ddz / dl) * amax; } else { c.vx = tvx; c.vz = tvz; }
    const sp = Math.hypot(c.vx, c.vz);
    // Heading turns towards the velocity.
    if (sp > 0.3) {
      let da = Math.atan2(-c.vx, -c.vz) - c.yaw;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      c.yaw += da * Math.min(1, h * 12);
    }
    c.phase += h * (2 + sp * (c.kind ? 3.2 : 6));
    this.move(c, c.x + c.vx * h, c.z + c.vz * h);
    // Bite.
    const p = c.prey;
    if (p && c.mode === CMode.Run && c.biteT <= 0 && Math.hypot(p.x - c.x, p.z - c.z) < K.reach + p.r && Math.abs(p.y - c.y) < 2.5) {
      c.biteT = K.biteGap * rng.range(0.8, 1.25);
      this.stats.bites++;
      this.stats.bitesOn[p.kind]++;
      this.onBite?.(c, p);
    }
  }

  /** Step to (nx, nz): onto what is there, or up / along a wall. */
  private move(c: Critter, nx: number, nz: number): void {
    const W = this.world;
    const top = W.wall(nx, nz, c.y);
    if (!isNaN(top)) {
      const K = BROOD_KINDS[c.kind];
      // A climber: up the facade (not while leaving).
      if (c.mode === CMode.Run && K.climb > 0 && this.rng.chance(K.climb * 0.15)) {
        const l = Math.hypot(nx - c.x, nz - c.z) || 1;
        c.nx = -(nx - c.x) / l; c.nz = -(nz - c.z) / l;
        c.top = top;
        c.climbTo = top - c.y <= BROOD.climbMax ? top : c.y + this.rng.range(3, BROOD.climbMax);
        c.mode = CMode.Wall; c.t = 0; c.vx = c.vz = 0;
        c.yaw = Math.atan2(c.nx, c.nz);
        this.stats.climbs++;
        return;
      }
      // Slide along it (whichever axis is free), else stop and turn.
      if (isNaN(W.wall(nx, c.z, c.y))) nz = c.z;
      else if (isNaN(W.wall(c.x, nz, c.y))) nx = c.x;
      else { c.vx *= -0.3; c.vz *= -0.3; return; }
    }
    c.x = nx; c.z = nz;
    const s = W.surface(c.x, c.z, c.y + 0.5);
    if (c.y > s + 0.6) { c.air = true; c.vy = 0; }
    else c.y = s;
  }

  private climb(c: Critter, h: number): void {
    c.phase += h * 16;
    if (c.y < c.climbTo) { c.y = Math.min(c.climbTo, c.y + BROOD.climbSpeed * h); return; }
    // Over the edge onto the roof.
    if (c.climbTo >= c.top - 0.01) {
      c.x -= c.nx * 0.9; c.z -= c.nz * 0.9;
      c.y = this.world.surface(c.x, c.z, c.top + 0.5);
      c.yaw = Math.atan2(c.nx, c.nz);
      c.mode = CMode.Run; c.t = 0;
      return;
    }
    // Cling a moment, then drop off.
    if (c.t > (c.climbTo - c.py) / BROOD.climbSpeed + 1 + (c.id % 5) * 0.4) this.dropOff(c);
  }

  private dropOff(c: Critter): void {
    c.vx = c.nx * 2.5; c.vz = c.nz * 2.5; c.vy = 1.5;
    c.x += c.nx * 0.3; c.z += c.nz * 0.3;
    c.air = true;
    c.yaw = Math.atan2(-c.nx, -c.nz);
    c.mode = this.leaving ? CMode.Leave : CMode.Run; c.t = 0;
  }

  // ================================================================== prey and neighbours

  private pickPrey(c: Critter): Prey | null {
    let best: Prey | null = null, bd = BROOD.huntR;
    const R = BROOD.huntR;
    const i0 = Math.floor((c.x - R) / PCELL), i1 = Math.floor((c.x + R) / PCELL), j0 = Math.floor((c.z - R) / PCELL), j1 = Math.floor((c.z + R) / PCELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const l = this.pgrid.get(((i + 32768) & 0xffff) * 65536 + ((j + 32768) & 0xffff));
      if (!l) continue;
      for (const p of l) {
        if (Math.abs(p.y - c.y) > 4) continue;
        // Stay on the one it has; others only while not crowded (the big ones go for cars first).
        const full = p !== c.prey && p.n >= BROOD.maxOn[p.kind];
        if (full) continue;
        let d = Math.hypot(p.x - c.x, p.z - c.z);
        if (p === c.prey) d *= 0.6;
        if (c.kind === 1 && p.kind === 'car') d *= 0.5;
        if (d < bd) { bd = d; best = p; }
      }
    }
    return best;
  }

  private buildPrey(): void {
    for (const l of this.pgrid.values()) { l.length = 0; this.ppool.push(l); }
    this.pgrid.clear();
    this.preyList.length = 0;
    this.world.prey(this.preyList);
    for (const p of this.preyList) {
      p.n = 0;
      p.seen = this.stepNo;
      const k = ckey(p.x, p.z, PCELL);
      let l = this.pgrid.get(k);
      if (!l) { l = this.ppool.pop() ?? []; this.pgrid.set(k, l); }
      l.push(p);
    }
  }

  private buildGrid(): void {
    for (const l of this.grid.values()) { l.length = 0; this.pool.push(l); }
    this.grid.clear();
    for (const c of this.list) {
      if (c.mode === CMode.Hidden || c.mode === CMode.Gone) continue;
      const k = ckey(c.x, c.z, CELL);
      let l = this.grid.get(k);
      if (!l) { l = this.pool.pop() ?? []; this.grid.set(k, l); }
      l.push(c);
    }
  }

  /** Creatures within about r of a point (from the grid of this step; reused array). */
  neighbours(x: number, z: number, r: number): Critter[] {
    const out = this.nb;
    out.length = 0;
    const i0 = Math.floor((x - r) / CELL), i1 = Math.floor((x + r) / CELL), j0 = Math.floor((z - r) / CELL), j1 = Math.floor((z + r) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const l = this.grid.get(((i + 32768) & 0xffff) * 65536 + ((j + 32768) & 0xffff));
      if (l) for (const c of l) out.push(c);
    }
    return out;
  }

  // ================================================================== being hit

  /**
   * Something hits the swarm round (x, y, z) within r: `dmg` hit points to each (frost: seconds
   * frozen instead), flung away from (fromX, fromZ) at `fling` m/s. Returns the creatures hit
   * (reused array, valid until the next call) — `killed` says how many died of it.
   */
  hit(x: number, y: number, z: number, r: number, effect: HitEffect, dmg: number, fromX: number, fromZ: number, fling: number, cause: string | null): { hit: Critter[]; killed: number } {
    const out = HIT_OUT;
    out.hit.length = 0;
    out.killed = 0;
    for (const c of this.list) {
      if (c.mode === CMode.Hidden || c.mode === CMode.Dead || c.mode === CMode.Gone) continue;
      const dx = c.x - x, dz = c.z - z, d = Math.hypot(dx, dz);
      if (d > r + c.size * 0.4 || Math.abs(c.y + 0.3 - y) > r + 1.2) continue;
      out.hit.push(c);
      if (this.damage(c, effect, dmg, fromX, fromZ, fling, cause)) out.killed++;
    }
    return out;
  }

  /** Damage one creature (police rounds and batons, a power); true when that killed it. */
  damage(c: Critter, effect: HitEffect, dmg: number, fromX: number, fromZ: number, fling: number, cause: string | null): boolean {
    if (c.mode === CMode.Hidden || c.mode === CMode.Dead || c.mode === CMode.Gone) return false;
    c.lastBy = cause;
    if (effect === 'frost') {
      if (c.mode === CMode.Wall) this.dropOff(c);
      c.mode = CMode.Frozen; c.frozenT = Math.max(c.frozenT, dmg); c.t = 0; c.vx = c.vz = 0;
      return false;
    }
    // Frozen solid: the next blow shatters it.
    if (c.mode === CMode.Frozen && (effect === 'blow' || effect === 'wind' || effect === 'shock')) dmg = Math.max(dmg, c.hp);
    if (effect === 'fire' && c.mode === CMode.Frozen) c.frozenT = 0;
    c.hp -= dmg;
    let dx = c.x - fromX, dz = c.z - fromZ;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    const k = c.kind ? 0.35 : 1;
    if (c.hp <= 0) { this.kill(c, dx * fling * k, Math.max(2, fling * 0.6) * k, dz * fling * k, cause); return true; }
    // Survived: knocked back, and it shies away for a moment (fire most).
    if (c.mode === CMode.Wall && fling > 1) this.dropOff(c);
    if (fling > 0.5 && c.mode !== CMode.Frozen) { c.vx += dx * fling * k; c.vz += dz * fling * k; if (fling * k > 3) { c.vy = fling * k * 0.4; c.air = true; } }
    if (effect === 'fire' || (effect === 'blow' && c.kind === 0)) { c.fleeT = effect === 'fire' ? 2.5 : 0.8; c.fx = fromX; c.fz = fromZ; }
    return false;
  }

  private kill(c: Critter, vx: number, vy: number, vz: number, cause: string | null): void {
    if (c.mode === CMode.Wall) { c.x += c.nx * 0.3; c.z += c.nz * 0.3; }
    c.mode = CMode.Dead; c.t = 0; c.hp = 0; c.prey = null;
    c.vx = vx; c.vy = vy; c.vz = vz;
    c.air = vy > 0 || c.air || c.y > this.world.surface(c.x, c.z, c.y + 0.3) + 0.2;
    this.stats.killed++;
    const by = cause ?? 'other';
    this.stats.killedBy[by] = (this.stats.killedBy[by] ?? 0) + 1;
    this.onKill?.(c, cause);
  }

  /** A deterministic summary (selftest: same seed, same swarm). */
  hash(): number {
    let h = 2166136261;
    const mix = (v: number) => { h ^= Math.round(v * 100) | 0; h = Math.imul(h, 16777619); };
    for (const c of this.list) { mix(c.x); mix(c.y); mix(c.z); mix(c.mode); mix(c.hp); }
    return h >>> 0;
  }
}

const HIT_OUT: { hit: Critter[]; killed: number } = { hit: [], killed: 0 };
