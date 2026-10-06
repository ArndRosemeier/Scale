/**
 * Station life: commuters in the metro around the player.
 *
 * Near a station hall, people come down the entrance stairs from the street, some crossing to the
 * far platform by the underpass, and wait on the platforms (standing, or sitting on the benches).
 * When a train pulls in and opens its doors, some of its riders get off and walk out and up the
 * stairs to the street, and most of the waiting people step in and take a seat (or stand by a door)
 * and ride away with it. Trains near the player carry riders; they sit along the benches and are
 * carried with their car.
 *
 * Commuters are pedestrian agents with an actor (owner METRO_OWNER, pinned): Pedestrians steps them
 * along the underground floors (`PedAgent.under`), so every one going down or up a staircase walks
 * the real floor of the passage. Riders are placed in their car each frame (after the trains moved).
 *
 * Pure logic over a small view of the metro (Underground provides it): usable headless.
 */
import { hash32, hashToFloat } from '../../core/rng';
import type { Box, Tube } from '../../underground/Volumes';
import type { MetroLine } from '../../plan/types';
import type { Citizen } from '../../sim/Population';
import { PState, type PedAgent } from '../../sim/Pedestrians';
import { makeActor, attach, METRO_OWNER } from '../../sim/actors/Actor';
import { PLATFORM_H, PLATFORM_EDGE, PLATFORM_W, CAR_W, CAR_L, CAR_FLOOR, DOOR_U, DOOR_CLOSE, TRAIN_SEATS, seatYaw, platformSeats } from '../../underground/layout';

/** A car of a train as the metro reports it (see Underground.cars). */
export interface MetroCar {
  line: number; k: number; slot: number; dir: number;
  x: number; y: number; z: number; dx: number; dz: number;
  dwell: boolean; left: number; next: number; open: boolean;
}

/** What station life needs of the metro (Underground). */
export interface MetroView {
  readonly boxes: Box[];
  readonly cars: MetroCar[];
  readonly entrances: Map<string, { passage: Tube | null; box: number }>;
  readonly underpasses: Map<number, Tube>;
  carWorld(c: MetroCar, u: number, v: number): [number, number];
  carLocal(c: MetroCar, x: number, y: number, z: number): { u: number; v: number; h: number };
}

/** And of the people (Pedestrians, Population). */
export interface MetroPeople {
  spawnAt(c: Citizen, x: number, z: number, heading: number): PedAgent | null;
  citizen(seed: number): Citizen;
}

export const METRO_LIFE = {
  /** Halls this close to the player (m, from the hall's middle, less its half length) are lived in. */
  activeR: 150,
  /** Riders are in the cars this close to the player (m). */
  carR: 110,
  /** At most this many commuters in all (waiting, walking, riding). */
  max: 90,
  /** Waiting on a platform side at most. */
  perSide: 9,
  /** Seconds between people coming down an entrance (per hall, random within). */
  arriveEvery: [6, 14] as [number, number],
  /** Riders per car when a train comes near (random within). */
  riders: [1, 6] as [number, number],
  /** Of the riders, the share getting off at a stop; of the waiting, the share getting on. */
  alight: 0.4, board: 0.85,
  /** Of the people coming down, the share crossing to the far platform (underpass). */
  cross: 0.3,
  walk: 1.35,
};

type Mode = 'walk' | 'wait' | 'board' | 'ride' | 'alight';

interface Commuter {
  a: PedAgent;
  mode: Mode;
  /** Hall (box index) whose platforms it is on or heading for; -1 riding. */
  hall: number;
  /** Platform side (box frame v sign) it is on or heading for. */
  side: number;
  /** Walk: x, z pairs and the next one; what to do at the end. */
  path: number[];
  wp: number;
  then: 'wait' | 'gone' | 'seat';
  /** Waiting: where (and facing), seated on a platform bench or not. */
  spot: { x: number; z: number; yaw: number; sit: boolean } | null;
  /** Boarding / riding / alighting: the car (key) and the place in it (car-local u, v), seated. */
  car: string;
  at: [number, number];
  seated: boolean;
  /** Seconds in the mode; the walk's no-progress watch. */
  t: number;
  best: number; stall: number;
}

const carKey = (c: MetroCar) => `${c.line}:${c.k}:${c.slot}`;

export class StationLife {
  private people: Commuter[] = [];
  private active = new Set<number>();
  private nextArrival = new Map<number, number>();
  /** Cars that got their riders on this approach. */
  private populated = new Set<string>();
  /** Stops already handled (car key and stop: doors opened, alighting chosen). */
  private stopped = new Set<string>();
  private serial = 1;
  private time = 0;
  readonly stats = { spawned: 0, boarded: 0, alighted: 0, left: 0, stuck: 0, crossed: 0 };

  /** rnd: the dice (tests pass a seeded one). */
  constructor(private m: MetroView, private p: MetroPeople, private lines: MetroLine[], private rnd: () => number = Math.random) {}

  get count(): number { return this.people.length; }
  /** The commuters (for tests and debugging). */
  get list(): readonly { a: PedAgent; mode: string; hall: number; side: number; seated: boolean }[] { return this.people; }

  update(dt: number, px: number, py: number, pz: number): void {
    this.time += dt;
    const cars = new Map<string, MetroCar>();
    for (const c of this.m.cars) cars.set(carKey(c), c);
    // Gone (despawned, knocked out by someone, taken over): forget.
    this.people = this.people.filter((q) => q.a.alive && q.a.actor?.owner === METRO_OWNER && q.a.state !== PState.Down);
    // Halls around the player.
    this.m.boxes.forEach((b, bi) => {
      if (b.kind !== 'station') return;
      const d = Math.hypot(b.cx - px, b.cz - pz) - b.hu, deep = Math.abs(py - b.y0) < 90;
      const on = deep && d < METRO_LIFE.activeR, off = !deep || d > METRO_LIFE.activeR + 40;
      if (on && !this.active.has(bi)) { this.active.add(bi); this.populate(bi); }
      else if (off && this.active.has(bi)) {
        this.active.delete(bi);
        for (const q of this.people) if (q.hall === bi && q.mode !== 'ride') this.drop(q);
      }
    });
    // People coming down the stairs.
    for (const bi of this.active) {
      const t = this.nextArrival.get(bi) ?? this.time + this.rand(bi * 7 + 1) * METRO_LIFE.arriveEvery[1];
      if (this.time >= t) {
        this.arrive(bi);
        const [lo, hi] = METRO_LIFE.arriveEvery;
        this.nextArrival.set(bi, this.time + lo + (hi - lo) * this.rnd());
      } else this.nextArrival.set(bi, t);
    }
    // Trains: riders in the cars near the player, doors opening at a lived-in station.
    for (const [key, c] of cars) {
      const d = Math.hypot(c.x - px, c.z - pz);
      if (d < METRO_LIFE.carR && !this.populated.has(key)) { this.populated.add(key); this.fillCar(c); }
      else if (d > METRO_LIFE.carR + 40 && this.populated.has(key)) {
        this.populated.delete(key);
        for (const q of this.people) if (q.car === key && (q.mode === 'ride' || q.mode === 'board')) this.drop(q);
      }
      if (c.open) {
        const bi = this.hallAt(c);
        const sk = `${key}:${c.next}`;
        if (bi >= 0 && this.active.has(bi) && !this.stopped.has(sk)) { this.stopped.add(sk); this.doorsOpen(c, bi); }
      } else if (!c.dwell) for (const s of [`${key}:${c.next - 1}`, `${key}:${c.next + 1}`]) this.stopped.delete(s);
    }
    for (const q of this.people) this.step(q, dt, cars);
    this.people = this.people.filter((q) => q.a.alive);
  }

  /** The hall the car stands at (dwelling at its next stop), or -1. */
  private hallAt(c: MetroCar): number {
    if (!c.dwell) return -1;
    const line = this.lines[c.line];
    const st = line?.stations[c.next];
    return this.m.boxes.findIndex((b) => b.kind === 'station' && b.line === c.line && b.station === st);
  }

  // ------------------------------------------------------------ spawning

  private rand(k: number): number { return hashToFloat(hash32(k * 2654435761 + 97)); }

  private spawn(x: number, y: number, z: number, heading: number, hall: number, side: number, mode: Mode): Commuter | null {
    if (this.people.length >= METRO_LIFE.max) return null;
    const seed = hash32(0x6d657472 + this.serial++ * 7919);
    const a = this.p.spawnAt(this.p.citizen(seed), x, z, heading);
    if (!a) return null;
    a.under = true;
    a.y = y;
    a.pref = METRO_LIFE.walk * (0.85 + 0.3 * hashToFloat(seed));
    attach(a, makeActor('bystander', METRO_OWNER));
    const q: Commuter = { a, mode, hall, side, path: [], wp: 0, then: 'wait', spot: null, car: '', at: [0, 0], seated: false, t: 0, best: Infinity, stall: 0 };
    this.people.push(q);
    this.stats.spawned++;
    return q;
  }

  private drop(q: Commuter): void {
    q.a.alive = false;
  }

  /** A hall comes alive: people already waiting on both platforms. */
  private populate(bi: number): void {
    const b = this.m.boxes[bi];
    for (const side of [-1, 1]) {
      const n = 2 + Math.floor(this.rnd() * 4);
      for (let i = 0; i < n; i++) {
        const spot = this.pickSpot(bi, side);
        const q = this.spawn(spot.x, b.y0 + PLATFORM_H, spot.z, spot.yaw, bi, side, 'wait');
        if (q) { q.spot = spot; this.settle(q); }
      }
    }
  }

  /** Someone comes down one of the hall's entrances from the street. */
  private arrive(bi: number): void {
    const ins = [...this.m.entrances.values()].filter((e) => e.box === bi && e.passage);
    if (!ins.length || this.waiting(bi) >= METRO_LIFE.perSide * 2) return;
    const P = ins[Math.floor(this.rnd() * ins.length)].passage!.pts;
    const b = this.m.boxes[bi];
    const n = P.length / 3, side = Math.sign(this.boxV(b, P[(n - 1) * 3], P[(n - 1) * 3 + 2])) || 1;
    // A step down into the opening (not on the street itself).
    const f = 0.15, x = P[0] + (P[3] - P[0]) * f, z = P[2] + (P[5] - P[2]) * f, y = P[1] + (P[4] - P[1]) * f;
    const q = this.spawn(x, y, z, Math.atan2(-(P[3] - P[0]), -(P[5] - P[2])), bi, side, 'walk');
    if (!q) return;
    const path: number[] = [];
    for (let i = 1; i < n; i++) path.push(P[i * 3], P[i * 3 + 2]);
    // Some cross to the far platform.
    const up = this.m.underpasses.get(bi);
    if (up && this.rnd() < METRO_LIFE.cross) { this.appendUnderpass(path, up, side); q.side = -side; this.stats.crossed++; }
    q.spot = this.pickSpot(bi, q.side);
    path.push(q.spot.x, q.spot.z);
    this.walk(q, path, 'wait');
  }

  /** Riders in a car coming near: sitting along the benches, a few standing by the doors. */
  private fillCar(c: MetroCar): void {
    const [lo, hi] = METRO_LIFE.riders;
    const n = lo + Math.floor(this.rnd() * (hi - lo + 1));
    const key = carKey(c);
    for (let i = 0; i < n; i++) {
      const sit = this.rnd() < 0.75;
      const at = sit ? this.freeSeat(key) : this.standPlace(key);
      if (!at) continue;
      const [x, z] = this.m.carWorld(c, at[0], at[1]);
      const q = this.spawn(x, c.y + CAR_FLOOR, z, 0, -1, 0, 'ride');
      if (!q) return;
      q.car = key; q.at = at; q.seated = sit;
    }
  }

  // ------------------------------------------------------------ stations and trains

  private waiting(bi: number, side = 0): number {
    let n = 0;
    for (const q of this.people) if (q.hall === bi && (side === 0 || q.side === side) && (q.mode === 'wait' || (q.mode === 'walk' && q.then === 'wait'))) n++;
    return n;
  }

  private boxV(b: Box, x: number, z: number): number { return -(x - b.cx) * b.uz + (z - b.cz) * b.ux; }
  private boxW(b: Box, u: number, v: number): [number, number] { return [b.cx + b.ux * u - b.uz * v, b.cz + b.uz * u + b.ux * v]; }

  /** A place to wait on a platform side: a free bench seat now and then, else a spot standing, facing the tracks. */
  private pickSpot(bi: number, side: number): { x: number; z: number; yaw: number; sit: boolean } {
    const b = this.m.boxes[bi];
    const yaw = Math.atan2(-b.uz * side, b.ux * side);
    if (this.rnd() < 0.35) {
      const seats = platformSeats(b).filter(([, v]) => Math.sign(v) === side).map(([u, v]) => this.boxW(b, u, v));
      const free = seats.filter(([x, z]) => !this.people.some((q) => q.spot?.sit && Math.hypot(q.spot.x - x, q.spot.z - z) < 0.3));
      if (free.length) { const [x, z] = free[Math.floor(this.rnd() * free.length)]; return { x, z, yaw, sit: true }; }
    }
    const u = (this.rnd() * 2 - 1) * (b.hu - 5), v = side * (PLATFORM_EDGE + 1.0 + this.rnd() * (PLATFORM_W - 3.3));
    const [x, z] = this.boxW(b, u, v);
    return { x, z, yaw: yaw + (this.rnd() - 0.5) * 1.2, sit: false };
  }

  /** The underpass walked from the platform side `side` to the other (its points from + to −). */
  private appendUnderpass(path: number[], up: Tube, side: number): void {
    const P = up.pts, n = P.length / 3;
    for (let k = 0; k < n; k++) {
      const i = side > 0 ? k : n - 1 - k;
      path.push(P[i * 3], P[i * 3 + 2]);
    }
  }

  /** The way out from a platform side: an entrance arriving on it (or the underpass and one opposite), up to the street. */
  private exitPath(bi: number, side: number, x: number, z: number): number[] | null {
    const b = this.m.boxes[bi];
    const ins = [...this.m.entrances.values()].filter((e) => e.box === bi && e.passage);
    const endSide = (P: number[]) => Math.sign(this.boxV(b, P[P.length - 3], P[P.length - 1]));
    const near = (list: typeof ins) => list.sort((p, q) => {
      const P = p.passage!.pts, Q = q.passage!.pts;
      return Math.hypot(P[P.length - 3] - x, P[P.length - 1] - z) - Math.hypot(Q[Q.length - 3] - x, Q[Q.length - 1] - z);
    })[0];
    const path: number[] = [];
    let e = near(ins.filter((e) => endSide(e.passage!.pts) === side));
    if (!e) {
      const up = this.m.underpasses.get(bi);
      e = near(ins.filter((e) => endSide(e.passage!.pts) === -side));
      if (!up || !e) return null;
      this.appendUnderpass(path, up, side);
    }
    const P = e.passage!.pts;
    for (let i = P.length / 3 - 1; i >= 0; i--) path.push(P[i * 3], P[i * 3 + 2]);
    return path;
  }

  /** Doors open at a lived-in station: some riders get off, the waiting get on. */
  private doorsOpen(c: MetroCar, bi: number): void {
    const key = carKey(c);
    for (const q of this.people) {
      if (q.car !== key || q.mode !== 'ride' || this.rnd() > METRO_LIFE.alight) continue;
      // To the nearest door, out onto the platform (the car's + v side), then up and out.
      const d = DOOR_U.reduce((p, s) => (Math.abs(s - q.at[0]) < Math.abs(p - q.at[0]) ? s : p));
      const exitPts: [number, number][] = [[d, Math.sign(q.at[1]) * 0.3], [d, 0.6], [d, CAR_W / 2 + 1.2]];
      const path: number[] = [];
      for (const [u, v] of exitPts) path.push(...this.m.carWorld(c, u, v));
      q.mode = 'alight'; q.hall = bi; q.side = c.dir; q.seated = false; q.t = 0;
      q.path = path; q.wp = 0; q.best = Infinity; q.stall = 0;
    }
    // Boarding: those waiting on this side (and not already on their way to another car).
    let n = 0;
    for (const q of this.people) {
      if (q.hall !== bi || q.side !== c.dir || q.mode !== 'wait' || this.rnd() > METRO_LIFE.board) continue;
      // The nearest car of the train (cars further along open too: each takes its own).
      let best: MetroCar | null = null, bd = Infinity;
      for (const o of this.m.cars) {
        if (o.line !== c.line || o.k !== c.k || !o.open) continue;
        const L = this.m.carLocal(o, q.a.x, q.a.y, q.a.z);
        const dd = Math.abs(L.u) + (Math.abs(L.u) > 9.25 ? 5 : 0);
        if (dd < bd) { bd = dd; best = o; }
      }
      if (!best || carKey(best) !== key) continue;
      const L = this.m.carLocal(best, q.a.x, q.a.y, q.a.z);
      const d = DOOR_U.reduce((p, s) => (Math.abs(s - L.u) < Math.abs(p - L.u) ? s : p));
      const at = (this.rnd() < 0.8 ? this.freeSeat(key) : null) ?? this.standPlace(key);
      if (!at) continue;
      q.seated = false;
      q.spot = null;
      q.car = key; q.at = at;
      q.mode = 'board';
      q.t = 0;
      const path: number[] = [];
      for (const [u, v] of [[d, CAR_W / 2 + 0.8], [d, 0.3], [at[0], at[1] * 0.45]] as [number, number][]) path.push(...this.m.carWorld(best, u, v));
      q.path = path; q.wp = 0; q.best = Infinity; q.stall = 0;
      if (++n > 40) break;
    }
  }

  private taken(key: string): [number, number][] {
    return this.people.filter((q) => q.car === key && (q.mode === 'ride' || q.mode === 'board')).map((q) => q.at);
  }

  private freeSeat(key: string): [number, number] | null {
    const used = this.taken(key);
    const free = TRAIN_SEATS.filter(([u, v]) => !used.some(([a, b]) => Math.abs(a - u) < 0.3 && Math.abs(b - v) < 0.3));
    return free.length ? free[Math.floor(this.rnd() * free.length)] : null;
  }

  private standPlace(key: string): [number, number] | null {
    const used = this.taken(key);
    const spots: [number, number][] = [];
    for (const d of DOOR_U) for (const du of [-0.45, 0.45]) for (const v of [-0.55, 0.55]) spots.push([d + du, v]);
    const free = spots.filter(([u, v]) => !used.some(([a, b]) => Math.abs(a - u) < 0.3 && Math.abs(b - v) < 0.3));
    return free.length ? free[Math.floor(this.rnd() * free.length)] : null;
  }

  // ------------------------------------------------------------ per frame

  private walk(q: Commuter, path: number[], then: Commuter['then']): void {
    q.mode = 'walk'; q.path = path; q.wp = 0; q.then = then; q.t = 0; q.best = Infinity; q.stall = 0;
    q.seated = false;
  }

  /** Steer along q.path; true when the end is reached. */
  private follow(q: Commuter, dt: number, speed: number): boolean {
    const a = q.a, act = a.actor!;
    const n = q.path.length / 2;
    while (q.wp < n) {
      const tx = q.path[q.wp * 2], tz = q.path[q.wp * 2 + 1];
      const d = Math.hypot(tx - a.x, tz - a.z);
      if (d > (q.wp === n - 1 ? 0.35 : 0.5)) {
        // No closer for a while (someone in the way, a corner): count it as passed.
        if (d < q.best - 0.2) { q.best = d; q.stall = 0; } else q.stall += dt;
        if (q.stall > 6) { q.wp++; q.best = Infinity; q.stall = 0; this.stats.stuck++; continue; }
        act.goal = { x: tx, z: tz };
        act.speed = speed;
        return false;
      }
      q.wp++; q.best = Infinity; q.stall = 0;
    }
    act.goal = null; act.speed = 0;
    return true;
  }

  private settle(q: Commuter): void {
    const a = q.a, act = a.actor!, s = q.spot!;
    q.mode = 'wait'; q.t = 0;
    act.goal = null; act.speed = 0;
    q.seated = s.sit;
    if (s.sit) { a.x = s.x; a.z = s.z; }
    a.heading = s.yaw;
  }

  private step(q: Commuter, dt: number, cars: Map<string, MetroCar>): void {
    const a = q.a, act = a.actor!;
    q.t += dt;
    act.move = null;
    if (q.mode !== 'ride') this.offTracks(q);
    switch (q.mode) {
      case 'walk': {
        if (!this.follow(q, dt, a.pref)) break;
        if (q.then === 'gone') { this.stats.left++; this.drop(q); break; }
        this.settle(q);
        break;
      }
      case 'wait': {
        const s = q.spot;
        if (!s) break;
        act.goal = null;
        if (q.seated) { a.x = s.x; a.z = s.z; a.heading = s.yaw; act.move = 'sit'; a.state = PState.Sit; }
        else if (Math.abs(a.heading - s.yaw) > 0.05) act.face = { x: a.x - Math.sin(s.yaw) * 5, y: a.y + 1.5, z: a.z - Math.cos(s.yaw) * 5 };
        break;
      }
      case 'board': {
        const c = cars.get(q.car);
        if (!c) { this.drop(q); break; }
        if (!c.open) {
          // The doors shut on the way: in the car already → ride along; else back to waiting (never
          // left standing on the car's floor when it pulls out: that dropped them onto the tracks).
          if (q.wp >= 2 || this.inCar(c, a)) { q.mode = 'ride'; q.hall = -1; q.seated = this.isSeat(q.at); this.stats.boarded++; }
          else this.backToWaiting(q);
          break;
        }
        if (c.left < DOOR_CLOSE + 0.8 && q.wp < 2) {
          // Too late: the doors are closing.
          if (q.wp < 1) { this.backToWaiting(q); break; }
        }
        if (this.follow(q, dt, a.pref * 1.1)) { q.mode = 'ride'; q.hall = -1; q.seated = this.isSeat(q.at); this.stats.boarded++; }
        break;
      }
      case 'ride': {
        const c = cars.get(q.car);
        if (!c) { this.drop(q); break; }
        const [x, z] = this.m.carWorld(c, q.at[0], q.at[1]);
        a.x = x; a.z = z; a.y = c.y + CAR_FLOOR;
        a.speed = 0; act.goal = null; act.speed = 0; act.face = null;
        if (q.seated) { a.heading = seatYaw(c, q.at[1]); act.move = 'sit'; a.state = PState.Sit; }
        else a.heading = Math.atan2(-c.dx, -c.dz) + (q.at[1] > 0 ? 0.6 : -0.6);
        break;
      }
      case 'alight': {
        const c = cars.get(q.car);
        if (!c || (!c.open && (q.wp < 2 || this.inCar(c, a)))) {
          // The doors shut before they were out: ride on (on their place in the car).
          if (c) { q.mode = 'ride'; q.hall = -1; } else this.drop(q);
          break;
        }
        if (!this.follow(q, dt, a.pref)) break;
        this.stats.alighted++;
        q.car = '';
        const path = this.exitPath(q.hall, q.side, a.x, a.z);
        if (path) this.walk(q, path, 'gone');
        else { q.spot = this.pickSpot(q.hall, q.side); this.walk(q, [q.spot.x, q.spot.z], 'wait'); }
        break;
      }
    }
  }

  /**
   * Down on the tracks after all (knocked off the platform, left over a car that pulled out): back up
   * onto the platform beside them, rather than walking the track bed with no way up.
   */
  private offTracks(q: Commuter): void {
    const a = q.a, b = this.m.boxes[q.hall];
    if (!b || a.y > b.y0 + PLATFORM_H - 0.5) return;
    const u = (a.x - b.cx) * b.ux + (a.z - b.cz) * b.uz, v = this.boxV(b, a.x, a.z);
    if (Math.abs(u) > b.hu || Math.abs(v) > PLATFORM_EDGE) return;
    const side = Math.sign(v) || q.side || 1;
    [a.x, a.z] = this.boxW(b, u, side * (PLATFORM_EDGE + 0.4));
    a.y = b.y0 + PLATFORM_H;
    a.vx = a.vz = a.vy = 0;
  }

  /** Standing on the car's floor (not yet out over the platform). */
  private inCar(c: MetroCar, a: { x: number; y: number; z: number }): boolean {
    const L = this.m.carLocal(c, a.x, a.y, a.z);
    return Math.abs(L.u) < CAR_L / 2 && Math.abs(L.v) < CAR_W / 2 + 0.1;
  }

  private isSeat(at: [number, number]): boolean {
    return TRAIN_SEATS.some(([u, v]) => Math.abs(u - at[0]) < 0.01 && Math.abs(v - at[1]) < 0.01);
  }

  private backToWaiting(q: Commuter): void {
    q.car = '';
    const b = this.m.boxes[q.hall];
    if (!b) { this.drop(q); return; }
    q.spot = this.pickSpot(q.hall, q.side);
    this.walk(q, [q.spot.x, q.spot.z], 'wait');
  }
}
