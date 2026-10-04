/**
 * People at the café and restaurant terraces (plan/terrace.ts) near the player.
 *
 * Who sits at which table when is a pure function of (seed, table, hour) (plan/eatery.ts
 * tableVisit): coffee in the morning, lunch and dinner peaks, bars late, empty when closed,
 * fewer outside after dark. Near the player those visits become people: a group walks in from
 * a door down the street, sits down (PState.Sit, the seated crowd pose / the rig's sitting
 * loop, chatting, a cup in hand at cafés), stays, stands up and walks off. A table that comes
 * into range in the middle of a visit is filled straight away. Now and then a waiter walks
 * between the door and the tables.
 *
 * Guests are ordinary pedestrians: Reactions scares them like everyone else — they jump up
 * and run (knocking their chair over now and then), stand and stare at a commotion and sit
 * down again, get knocked down. Budget: GUEST_CAP people, only while the street population
 * leaves room; awnings fall when the wall behind them goes.
 */
import { Pedestrians, PState, type PedAgent } from './Pedestrians';
import { Population, Role, doorOf, type Citizen } from './Population';
import type { CityStreamer, CellState } from '../stream/CityStreamer';
import type { WorldIndex, BuildingRef } from '../world/WorldIndex';
import type { Terrain } from '../world/terrain';
import type { MacroPlan, District } from '../plan/types';
import type { Destruction } from '../destruction/Destruction';
import type { PropRenderer } from '../props/PropRenderer';
import { PropType } from '../plan/cell';
import { CURB_H } from '../build/ground';
import { Eatery, EATERY, tableVisit } from '../plan/eatery';
import { TerraceKind, type EateryPlan } from '../plan/terrace';
import { deriveSeed, hash32, hashToFloat } from '../core/rng';

type Loop = { set(x: number, y: number, z: number, gain: number, rate?: number): void; stop(): void };

export interface TerraceDeps {
  seed: number;
  macro: MacroPlan;
  terrain: Terrain;
  world: WorldIndex;
  streamer: CityStreamer;
  peds: Pedestrians;
  pop: Population;
  props: PropRenderer;
  destruction: Destruction;
  /** Positional loop factory (Audio.loop), optional. */
  loop?: (id: string, refDist?: number) => Loop | null;
}

/** Terraces within ACTIVE_R m of the player are lived in; beyond DROP_R their people leave. */
const ACTIVE_R = 150;
const DROP_R = 185;
/** Most people at terraces at once, and the street population left room for them. */
const GUEST_CAP = 170;
const PEDS_ROOM = 2590;
/** Seconds (real time) a guest sits at least, however short the visit (walking in takes real time). */
const MIN_STAY = 25;
/** New guests walking in per update (route finding). */
const WALK_INS = 3;

const enum Phase { Arriving = 0, Settling = 1, Seated = 2, Leaving = 3 }

interface Table {
  key: number;
  x: number; z: number;
  /** Seat indices into the eatery's seats. */
  seats: number[];
  /** Visit served (window number) and its guests. */
  served: number;
  guests: PedAgent[];
  /** Range entered during this visit (fill it at once). */
  fresh: boolean;
  /** After a scare: no new guests before this (real seconds); then they walk in. */
  calm: number;
  walkIn: boolean;
}

interface Place {
  cs: CellState;
  ep: EateryPlan;
  district: District;
  tables: Table[];
  ref: BuildingRef | null;
  waiter: PedAgent | null;
  waiterT: number;
  /** Errands of the current waiter. */
  rounds: number;
  /** Awnings standing (props, see checkAwnings). */
  awningsUp: boolean;
  cx: number; cz: number;
}

interface Guest { place: Place; table: Table; seat: number; phase: Phase; t: number; leaveTo: { x: number; z: number } | null; cup: boolean }

export class Terraces {
  private places = new Map<number, Place>();
  private guests = new Map<PedAgent, Guest>();
  private waiters = new Map<PedAgent, Place>();
  private syncT = 0;
  private stepT = 0;
  private wallT = 0;
  private hours = 0;
  private now = 0;
  private murmur: Loop | null = null;
  private murmurTry = 0;
  stats = { places: 0, tables: 0, guests: 0, seated: 0, waiters: 0, evicted: 0 };
  /** Rain 0..1 (render/Weather): the terraces empty (guests go inside), and fill again once it is dry. */
  rain = 0;

  constructor(private d: TerraceDeps) {
    const prev = d.peds.onArrive;
    d.peds.onArrive = (a) => this.arrive(a) || (prev?.(a) ?? false);
  }

  /** Cup in hand (CrowdRenderer.heldFor): seated café guests and waiters; undefined: their own. */
  heldFor(a: PedAgent): string | null | undefined {
    if (this.waiters.has(a)) return 'coffee';
    const g = this.guests.get(a);
    if (!g || g.phase === Phase.Arriving) return undefined;
    return g.cup ? 'coffee' : null;
  }

  /** Seated people at a table with company chat now and then (CrowdRenderer.talking). */
  talking(a: PedAgent, time: number): boolean {
    const g = this.guests.get(a);
    if (!g || g.phase !== Phase.Seated || g.table.guests.length < 2) return false;
    return Math.sin(time * 0.45 + a.id * 1.7) > 0.15;
  }

  update(dt: number, hoursAbs: number, px: number, pz: number): void {
    this.hours = hoursAbs;
    this.now += dt;
    this.syncT -= dt;
    if (this.syncT <= 0) { this.syncT = 1; this.sync(px, pz); }
    // People settling into their chairs (a short slide onto the seat).
    for (const [a, g] of this.guests) {
      if (g.phase === Phase.Seated) { g.t += dt; continue; }
      if (g.phase !== Phase.Settling) continue;
      g.t += dt;
      const s = g.place.ep.seats, i = g.seat * 4;
      const k = Math.min(1, dt * 4);
      a.x += (s[i] - a.x) * k; a.z += (s[i + 1] - a.z) * k;
      let dh = s[i + 2] - a.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      a.heading += dh * k;
      if (g.t > 0.8) { g.phase = Phase.Seated; g.t = 0; }
    }
    this.stepT -= dt;
    if (this.stepT <= 0) {
      this.stepT = 0.5;
      // Forget those who have gone (walked off and in, or despawned far away).
      for (const [a, g] of this.guests) { if (g.phase === Phase.Leaving) g.t += 0.5; if (!a.alive || (g.phase === Phase.Leaving && g.t > 240)) this.guests.delete(a); }
      for (const a of this.waiters.keys()) if (!a.alive) this.waiters.delete(a);
      this.step(px, pz);
    }
    this.wallT -= dt;
    if (this.wallT <= 0) { this.wallT = 1.1; this.checkAwnings(); }
    this.sound(px, pz, dt);
  }

  // ------------------------------------------------------------------ places in range

  private sync(px: number, pz: number): void {
    const S = this.d.streamer.cells;
    for (const [id, cs] of S) {
      if (cs.status !== 'ready' || !cs.plan?.eateries.length) continue;
      const [x0, z0, x1, z1] = cs.plan.bounds;
      if (px < x0 - ACTIVE_R || px > x1 + ACTIVE_R || pz < z0 - ACTIVE_R || pz > z1 + ACTIVE_R) continue;
      cs.plan.eateries.forEach((ep, k) => {
        const key = id * 512 + k;
        if (this.places.has(key) || !ep.tables.length && !ep.awnings.length) return;
        const cx = ep.tables.length ? ep.tables[0] : ep.door[0], cz = ep.tables.length ? ep.tables[1] : ep.door[1];
        if (Math.hypot(cx - px, cz - pz) > ACTIVE_R) return;
        const tables: Table[] = [];
        for (let t = 0; t < ep.tables.length; t += 3) {
          const seats: number[] = [];
          for (let s = 0; s < ep.seats.length; s += 4) if (ep.seats[s + 3] === t / 3) seats.push(s / 4);
          tables.push({ key: deriveSeed(this.d.seed, 'table', id, ep.b, t), x: ep.tables[t], z: ep.tables[t + 1], seats, served: -1e9, guests: [], fresh: true, calm: 0, walkIn: false });
        }
        const b = cs.plan!.buildings[ep.b];
        const ref = this.d.world.buildingsIn(b.poly[0] - 0.5, b.poly[1] - 0.5, b.poly[0] + 0.5, b.poly[1] + 0.5).find((r) => r.cell === cs && r.index === ep.b) ?? null;
        this.places.set(key, { cs, ep, district: this.d.macro.cells[id]?.district ?? 'commercial', tables, ref, waiter: null, waiterT: hashToFloat(key) * 20, rounds: 0, awningsUp: ep.awnings.length > 0, cx, cz });
      });
    }
    for (const [key, p] of this.places) {
      const gone = S.get(p.cs.id) !== p.cs || p.cs.status !== 'ready';
      if (!gone && Math.hypot(p.cx - px, p.cz - pz) < DROP_R) continue;
      // Out of range: whoever still sits there leaves unseen.
      for (const t of p.tables) for (const a of t.guests) this.release(a, true);
      if (p.waiter) this.release(p.waiter, true);
      this.places.delete(key);
    }
  }

  // ------------------------------------------------------------------ guests

  private step(px: number, pz: number): void {
    const P = this.d.peds;
    let walkIns = 0, seated = 0, tablesN = 0;
    const hour = ((this.hours % 24) + 24) % 24;
    const dark = hour < 6.5 || hour > 21;
    for (const p of this.places.values()) {
      const near = Math.hypot(p.cx - px, p.cz - pz) < ACTIVE_R;
      let busy = 0;
      for (const t of p.tables) {
        tablesN++;
        // Who still belongs here.
        for (let i = t.guests.length - 1; i >= 0; i--) {
          const a = t.guests[i];
          const g = this.guests.get(a);
          if (!g || !a.alive) { t.guests.splice(i, 1); if (g) this.guests.delete(a); continue; }
          if (g.phase === Phase.Leaving) continue;
          if (this.scared(a, g)) { t.guests.splice(i, 1); continue; }
          if (g.phase === Phase.Seated || g.phase === Phase.Settling) seated++;
        }
        const v = tableVisit(this.d.seed, t.key, p.ep.kind, p.district, this.hours);
        // After dark people sit inside, except at bars and restaurants (and on warm squares).
        const outside = !dark || p.ep.kind === Eatery.Bar || p.ep.kind === Eatery.Restaurant || p.ep.kind === Eatery.Pizzeria
          ? true : hashToFloat(hash32(t.key + (v?.n ?? 0))) < (p.ep.terrace === TerraceKind.Square ? 0.55 : 0.3);
        // Rain: up and inside (under a parasol on a square some sit out a drizzle); back when it has stopped.
        const thr = 0.06 + hashToFloat(hash32(t.key * 7 + 3)) * (p.ep.terrace === TerraceKind.Square ? 0.3 : 0.12);
        if (this.rain >= thr) {
          for (const a of [...t.guests]) { const g = this.guests.get(a); if (g && g.phase !== Phase.Leaving) this.leaveInside(a); }
          if (t.served !== -1e9) { t.served = -1e9; t.walkIn = true; }
          continue;
        }
        const want = v && outside ? Math.min(v.guests, t.seats.length) : 0;
        if (want > 0) busy++;
        if (!v || !outside) {
          // The visit is over: stand up and go (together).
          // (Those who only just sat down — the walk in takes real time — stay a little first.)
          for (const a of [...t.guests]) { const g = this.guests.get(a); if (g && (g.phase === Phase.Seated && g.t >= MIN_STAY || !near)) this.leave(a); }
          t.fresh = false;
          continue;
        }
        if (t.served === v.n || !near || this.now < t.calm || this.rain >= thr * 0.4) continue;
        if (t.guests.length >= want) { t.served = v.n; continue; }
        if (this.guests.size >= GUEST_CAP) continue;
        // Under way for a while already (or just come into range): they are sitting there.
        const sitNow = (t.fresh || this.hours - v.from > 0.06) && !t.walkIn;
        if (!sitNow && walkIns >= WALK_INS) continue;
        // Within the street budget: a full street gives up its farthest walkers for them.
        if (!this.makeRoom(want - t.guests.length, px, pz)) continue;
        t.fresh = false;
        const free = t.seats.filter((s) => !t.guests.some((a) => this.guests.get(a)?.seat === s));
        const from = sitNow ? null : this.pickDoor(t.x, t.z, 15, 50, t.key + v.n);
        let route: Float32Array | null = null;
        if (from) { const s0 = free[0] * 4; route = P.buildRoute(from.x, from.z, p.ep.seats[s0], p.ep.seats[s0 + 1]); walkIns++; }
        for (let k = 0; k < want - t.guests.length && k < free.length; k++) {
          const c = this.citizen(deriveSeed(this.d.seed, 'guest', t.key, v.n, k));
          if (!c) continue;
          const si = free[k] * 4, S = p.ep.seats;
          const leaveTo = this.pickDoor(S[si], S[si + 1], 40, 140, t.key * 31 + v.n * 7 + k);
          const cup = !!EATERY[p.ep.kind]?.held && hashToFloat(hash32(c.seed + 5)) < 0.7;
          let a: PedAgent | null;
          if (route && from) {
            const jx = (k - 1) * 0.5;
            a = P.spawnAt(c, route[0] + jx, route[1], 0);
            if (!a) continue;
            a.route = Float32Array.from(route);
            a.route[a.route.length - 3] = S[si]; a.route[a.route.length - 2] = S[si + 1];
            a.wp = 1; a.state = PState.Walk; a.stateT = 0;
            this.guests.set(a, { place: p, table: t, seat: free[k], phase: Phase.Arriving, t: 0, leaveTo, cup });
          } else {
            a = P.spawnAt(c, S[si], S[si + 1], S[si + 2]);
            if (!a) continue;
            this.seat(a, S[si], S[si + 1], S[si + 2], leaveTo);
            this.guests.set(a, { place: p, table: t, seat: free[k], phase: Phase.Seated, t: 0, leaveTo, cup });
          }
          a.pref = Math.min(a.pref, 1.3);
          t.guests.push(a);
          t.served = v.n;
          t.walkIn = false;
        }
      }
      this.stepWaiter(p, busy, near);
    }
    this.stats.places = this.places.size;
    this.stats.tables = tablesN;
    this.stats.guests = this.guests.size;
    this.stats.seated = seated;
    this.stats.waiters = this.waiters.size;
  }

  /**
   * A guest no longer sitting quietly: one that stood up to stare sits down again when it is
   * over; one that ran or was knocked down or taken over (crime) is no longer a guest. True
   * when the guest left the table.
   */
  private scared(a: PedAgent, g: Guest): boolean {
    if (g.phase === Phase.Arriving) {
      if (a.state === PState.Flee || a.state === PState.Down || a.actor || a.ragdoll) { this.guests.delete(a); return true; }
      return false;
    }
    if (a.state === PState.Sit) return false;
    if (a.state === PState.Gawk || a.state === PState.Film) return false;
    const S = g.place.ep.seats, i = g.seat * 4;
    if ((a.state === PState.Walk || a.state === PState.Idle) && !a.actor && a.fear < 0.3 && Math.hypot(a.x - S[i], a.z - S[i + 1]) < 1.2) {
      this.seat(a, S[i], S[i + 1], S[i + 2], g.leaveTo);
      g.phase = Phase.Settling; g.t = 0;
      return false;
    }
    // Others take the table once it is calm again.
    g.table.calm = this.now + 20;
    g.table.served = -1e9;
    g.table.walkIn = true;
    // Up and away in a hurry: the chair goes over now and then.
    if ((a.state === PState.Flee || a.state === PState.Down) && hashToFloat(hash32(a.id * 13 + 7)) < 0.55) {
      const dx = S[i] - a.fearX, dz = S[i + 1] - a.fearZ, dl = Math.hypot(dx, dz) || 1;
      this.d.props.hit(S[i], this.d.terrain.height(S[i], S[i + 1]) + CURB_H + 0.5, S[i + 1], 0.15, (dx / dl) * 260, 40, (dz / dl) * 260);
    }
    this.guests.delete(a);
    return true;
  }

  /** Sit down at a seat; the way home is the route's end (a scare sends them there). */
  private seat(a: PedAgent, x: number, z: number, heading: number, leaveTo: { x: number; z: number } | null): void {
    a.state = PState.Sit;
    a.stateT = 0;
    a.speed = 0;
    a.heading = heading;
    a.x = x; a.z = z;
    a.onRoad = false;
    a.dest = null;
    const to = leaveTo ?? { x: x + 30, z };
    a.route = Float32Array.from([x, z, 0, to.x, to.z, 0]);
    a.wp = 1;
  }

  /** Stand up (or turn round on the way in) and walk off to a door down the street (and in). */
  private leave(a: PedAgent): void {
    const g = this.guests.get(a);
    if (!g) return;
    const i = g.table.guests.indexOf(a);
    if (i >= 0) g.table.guests.splice(i, 1);
    const was = g.phase;
    g.phase = Phase.Leaving;
    g.t = 0;
    if (a.state !== PState.Sit && !(was === Phase.Arriving && a.state === PState.Walk)) return;
    const to = g.leaveTo;
    const r = to ? this.d.peds.buildRoute(a.x, a.z, to.x, to.z) : null;
    if (!r) { a.alive = false; return; }
    a.route = r; a.wp = 1;
    a.state = PState.Walk; a.stateT = 0;
    a.dest = to;
  }

  /** Rain: get up and hurry in at the café's own door (and in). */
  private leaveInside(a: PedAgent): void {
    const g = this.guests.get(a);
    if (!g) return;
    g.leaveTo = { x: g.place.ep.door[0], z: g.place.ep.door[1] };
    a.pref = 1.9;
    this.leave(a);
  }

  /** Let go of an agent: gone (out of range) or left to the street. */
  private release(a: PedAgent, vanish: boolean): void {
    this.guests.delete(a);
    this.waiters.delete(a);
    if (vanish && !a.actor && a.state !== PState.Down && !a.ragdoll && a.state !== PState.Flee) a.alive = false;
  }

  /** End of a route: guests sit down, waiters turn round. */
  private arrive(a: PedAgent): boolean {
    const g = this.guests.get(a);
    if (g && g.phase === Phase.Arriving) {
      const S = g.place.ep.seats, i = g.seat * 4;
      if (Math.hypot(a.x - S[i], a.z - S[i + 1]) > 2.5) {
        // Stopped short (a crowd at the waypoint): the last bit straight on.
        a.route = Float32Array.from([a.x, a.z, 0, S[i], S[i + 1], 0]);
        a.wp = 1;
        return true;
      }
      a.state = PState.Sit;
      a.speed = 0;
      a.stateT = 0;
      const to = g.leaveTo ?? { x: S[i] + 30, z: S[i + 1] };
      a.route = Float32Array.from([S[i], S[i + 1], 0, to.x, to.z, 0]);
      a.wp = 1;
      g.phase = Phase.Settling; g.t = 0;
      return true;
    }
    const w = this.waiters.get(a);
    if (w) {
      // At a table or back at the door: a pause, then the next errand.
      const atDoor = Math.hypot(a.x - w.ep.door[0], a.z - w.ep.door[1]) < 2;
      const busy = w.tables.filter((t) => t.guests.some((x) => this.guests.get(x)?.phase === Phase.Seated));
      let tx = w.ep.door[0], tz = w.ep.door[1];
      if (atDoor && busy.length) {
        const t = busy[Math.floor(hashToFloat(hash32(a.id + Math.floor(this.hours * 60))) * busy.length)];
        // Stand beside the table, not on a chair.
        const ox = t.x - w.ep.door[0], oz = t.z - w.ep.door[1], ol = Math.hypot(ox, oz) || 1;
        tx = t.x - (ox / ol) * 0.9 + (-oz / ol) * 0.55; tz = t.z - (oz / ol) * 0.9 + (ox / ol) * 0.55;
      }
      // Back inside after a round or two (or when nobody is sitting outside any more).
      if (atDoor && (!busy.length || w.rounds++ >= 1 + (a.id % 3))) { this.release(a, false); a.alive = false; return true; }
      const r = w.ep.terrace === TerraceKind.Square ? this.d.peds.buildRoute(a.x, a.z, tx, tz) : null;
      a.route = r ?? Float32Array.from([a.x, a.z, 0, tx, tz, 0]);
      a.wp = 1;
      a.state = PState.Idle;
      a.stateT = atDoor ? -4 : 0;
      return true;
    }
    return false;
  }

  /** A waiter now and then while two or more tables are taken. */
  private stepWaiter(p: Place, busy: number, near: boolean): void {
    const w = p.waiter;
    if (w && (!w.alive || !this.waiters.has(w))) p.waiter = null;
    if (p.waiter || !near || busy < 2 || this.guests.size >= GUEST_CAP || this.d.peds.agents.length >= PEDS_ROOM + 20) return;
    p.waiterT -= 0.5;
    if (p.waiterT > 0) return;
    p.waiterT = 25 + hashToFloat(hash32(p.ep.b * 977 + Math.floor(this.hours * 4))) * 40;
    const c = this.citizen(deriveSeed(this.d.seed, 'waiter', p.cs.id, p.ep.b, Math.floor(this.hours / 6)), true);
    if (!c) return;
    const a = this.d.peds.spawnAt(c, p.ep.door[0], p.ep.door[1], 0);
    if (!a) return;
    a.route = Float32Array.from([a.x, a.z, 0, a.x, a.z, 0]);
    a.wp = 2; // at the end: the first errand is planned on arrival
    a.stateT = 0;
    a.state = PState.Walk;
    a.pref = 1.45;
    this.waiters.set(a, p);
    p.waiter = a;
    p.rounds = 0;
  }

  /**
   * Room for n more people within the pedestrian budget (PEDS_ROOM): when the street is full,
   * the farthest ordinary walkers (beyond 260 m, on their way) are let go — their schedules go
   * on unseen. False when there is no room.
   */
  private makeRoom(n: number, px: number, pz: number): boolean {
    const A = this.d.peds.agents;
    const over = A.length + n - PEDS_ROOM;
    if (over <= 0) return true;
    const far: { a: PedAgent; d: number }[] = [];
    for (const a of A) {
      if (!a.alive || a.actor || a.state !== PState.Walk || a.evac || this.guests.has(a) || this.waiters.has(a)) continue;
      const d = Math.hypot(a.x - px, a.z - pz);
      if (d > 260) far.push({ a, d });
    }
    if (far.length < over) return false;
    far.sort((p, q) => q.d - p.d);
    for (let k = 0; k < over; k++) far[k].a.alive = false;
    this.stats.evicted += over;
    return true;
  }

  /** A synthetic citizen (no children on their own). */
  private citizen(seed: number, worker = false): Citizen | null {
    for (let k = 0; k < 6; k++) {
      const c = this.d.pop.synthetic(hash32(seed + k * 7919));
      if (c.role === Role.Child || (worker && c.role === Role.Senior)) continue;
      return c;
    }
    return null;
  }

  /** The door of a building between r0 and r1 m away (deterministic pick), or null. */
  private pickDoor(x: number, z: number, r0: number, r1: number, h: number): { x: number; z: number } | null {
    const refs = this.d.world.buildingsIn(x - r1, z - r1, x + r1, z + r1);
    const c: { x: number; z: number }[] = [];
    for (const r of refs) {
      if (!r.alive) continue;
      const d = doorOf(r.desc);
      const dd = Math.hypot(d.x - x, d.z - z);
      if (dd >= r0 && dd <= r1) c.push(d);
    }
    return c.length ? c[hash32(h) % c.length] : null;
  }

  // ------------------------------------------------------------------ awnings, sound

  /** Awnings fall when the ground-floor wall behind them breaks (or the building goes). */
  private checkAwnings(): void {
    for (const p of this.places.values()) {
      if (!p.awningsUp || !p.ref) continue;
      const ep = p.ep, aw = ep.awnings;
      const L = this.d.destruction.layoutOf(p.ref);
      let any = false;
      for (let k = 0; k < aw.length; k += 3) {
        const u = aw[k], w = aw[k + 1];
        const x = ep.ax + ep.ux * u + ep.nx * 0.02, z = ep.az + ep.uz * u + ep.nz * 0.02;
        let standing = false, up = false;
        this.d.props.query(x, z, 0.3, (pr) => { if (pr.kind.startsWith('furn:awning') && !pr.broken && Math.hypot(pr.x - x, pr.z - z) < 0.2) standing = true; });
        if (!standing) continue;
        any = true;
        if (p.ref.alive) {
          for (const pn of L.panels) {
            if (pn.edge !== p.ref.desc.front || pn.floor !== 0 || pn.u0 > u + w / 2 || pn.u0 + pn.bayW < u - w / 2) continue;
            if (this.d.streamer.isAlive(p.cs, pn.e)) { up = true; break; }
          }
        }
        if (!up) this.d.props.hit(x, this.d.terrain.height(x, z) + CURB_H + 2.6, z, 0.4, ep.nx * 900, -300, ep.nz * 900);
      }
      if (!any) p.awningsUp = false;
    }
  }

  /** Murmur and cutlery of the nearest busy terrace. */
  private sound(px: number, pz: number, dt: number): void {
    if (!this.d.loop) return;
    let best: Place | null = null, bd = 45, n = 0;
    for (const p of this.places.values()) {
      const d = Math.hypot(p.cx - px, p.cz - pz);
      if (d >= bd) continue;
      let k = 0;
      for (const t of p.tables) for (const a of t.guests) if (this.guests.get(a)?.phase === Phase.Seated) k++;
      if (k >= 3) { best = p; bd = d; n = k; }
    }
    if (!this.murmur) {
      if (!best) return;
      this.murmurTry -= dt;
      if (this.murmurTry > 0) return;
      this.murmurTry = 2;
      this.murmur = this.d.loop('terrace_murmur', 6);
      if (!this.murmur) return;
    }
    if (best) this.murmur.set(best.cx, this.d.terrain.height(best.cx, best.cz) + 1.3, best.cz, Math.min(1, 0.25 + n / 14));
    else this.murmur.set(px, 0, pz, 0);
  }

  /** Terrace furniture props of the loaded plans (debug / tests): [table, chair, parasol, awning] counts. */
  countProps(): number[] {
    const out = [0, 0, 0, 0];
    for (const cs of this.d.streamer.cells.values()) {
      const P = cs.plan?.props;
      if (!P) continue;
      for (let i = 0; i < P.length; i += 6) {
        const t = P[i];
        if (t === PropType.CafeTable) out[0]++; else if (t === PropType.CafeChair) out[1]++; else if (t === PropType.Parasol) out[2]++; else if (t === PropType.Awning) out[3]++;
      }
    }
    return out;
  }
}
