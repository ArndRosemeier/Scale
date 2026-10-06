/**
 * People inside the landmarks one can walk into (the town hall and the cathedral), near the player.
 *
 * Who is in there when follows the hour (HALL_HOURS): the cathedral has its priest from morning to
 * evening, services at nine and at six (the pews fill, the priest at the altar, servers in the
 * choir stalls), visitors through the day who stand at the windows, look up into the crossing and
 * rest in the pews, a few people praying in the evening. The town hall is open in office hours:
 * clerks at the information desk and the counter, people asking there and waiting on the
 * benches, visitors in the hall and on the galleries, the mayor and an aide in the office,
 * council sessions in the chamber, weddings in the wedding room; a porter at the desk at night.
 *
 * They are indoor people (PedAgent.inside) marked `hall`: the street layer leaves them alone and
 * this layer walks them along the landmark's nav graph (plan/landmarkParts LmInterior): in from a
 * door down the street, up the steps and in, to their seat or spot and on, and out again the
 * same way, back into street people. Shift starts and ends happen the same way. Frightened (a
 * blast, a monster, the hero smashing in) they run out; knocked down, they get up and run. A
 * landmark that comes into range is filled with whoever is due at once; out of range they go.
 */
import { Pedestrians, PState, type PedAgent } from './Pedestrians';
import { Population, Role, doorOf, type Citizen } from './Population';
import type { MacroPlan } from '../plan/types';
import type { Terrain } from '../world/terrain';
import type { WorldIndex } from '../world/WorldIndex';
import type { Landmark } from '../plan/landmarks';
import { landmarkInterior, type LmInterior, type SpotWho } from '../plan/landmarkParts';
import { hash32, hashCombine, hashToFloat } from '../core/rng';
import type { EquipmentVisuals, ItemVisual } from '../items/types';
import { cityOutfit } from '../humanoid/client/wardrobe';

/** What someone in a landmark is there as. */
export type HallRole = 'visitor' | 'faithful' | 'priest' | 'server' | 'clerk' | 'client' | 'mayor' | 'aide' | 'councillor' | 'registrar' | 'bride' | 'partner' | 'guest' | 'porter';

/** Landmarks within ACTIVE_R m of the player are lived in; beyond DROP_R their people go. */
const ACTIVE_R = 150;
const DROP_R = 190;
/** Walking pace indoors (m/s, by person), and running out. */
const PACE = [0.95, 1.3], RUN = 3.4;
/** Seconds (real time) at a spot: visitors standing, sitting; a visitor looks at this many things. */
const LOOK = [7, 22], REST = [25, 70], VISIT = [3, 6];
/** Arrivals: at most one per this many seconds per landmark (a group now and then). */
const ARRIVE_EVERY = 2.5;
/** Seconds lying before getting up (knocked down indoors). */
const GET_UP = 9;

/** The hours (game) of each landmark: who is due, from what share of their spots. */
export const HALL_HOURS = {
  cathedral: { open: [7, 21], priest: [7, 20], services: [[9, 10], [18, 19]] as [number, number][], pews: 0.45, visitors: 14, praying: 4 },
  townhall: { open: [8, 18], mayor: [9, 17], sessions: [[10, 12], [14, 16]] as [number, number][], weddings: [[11, 12], [13, 14], [15, 16]] as [number, number][], visitors: 9, waiting: 0.35, asking: 0.6, council: 0.75, guests: 0.65 },
};

export interface HallDeps {
  macro: MacroPlan;
  terrain: Terrain;
  world: WorldIndex;
  peds: Pedestrians;
  pop: Population;
  /** Floor height under a point (the landmark's solids), or -Infinity. */
  floor?: (x: number, y: number, z: number) => number;
  /** Share of a breakable landmark still standing (destruction/LandmarkWreck): 1 when whole. */
  standing?: (index: number) => number;
}

interface Hall {
  lm: Landmark;
  index: number;
  ins: LmInterior;
  church: boolean;
  on: boolean;
  guests: Set<Guest>;
  /** Who holds each spot. */
  taken: (Guest | null)[];
  /** Nav: neighbours with distances. */
  adj: { to: number; d: number }[][];
  /** Seconds to the next arrival; arrivals so far (citizen seeds). */
  arriveT: number;
  n: number;
  /** The first clerk spot (the information desk: the porter's at night). */
  desk: number;
}

const enum Mode { Approach = 0, Walk = 1, Stay = 2, Down = 3 }

interface Guest {
  a: PedAgent;
  hall: Hall;
  role: HallRole;
  /** Spot held (-1: none), and whether walking towards it / standing at it. */
  spot: number;
  mode: Mode;
  /** Waypoints (x, y, z) and the nav point of each (-1: a spot's way, the spot, the way out). */
  pts: number[];
  nodes: number[];
  wp: number;
  /** Start of the current leg. */
  sx: number; sy: number; sz: number;
  /** Last nav point reached. */
  at: number;
  /** On the spot's own way (between its nav point and the spot). */
  near: boolean;
  /** Seconds left at the spot; things left to look at (visitors). */
  t: number;
  left: number;
  /** Walking out (and away), running out. */
  out: boolean;
  run: boolean;
  pace: number;
  /** Paused (looking at a commotion) for this many seconds. */
  pause: number;
}

const hourIn = (h: number, [a, b]: number[]) => h >= a && h < b;

export class LandmarkCrowds {
  private halls: Hall[] = [];
  private byAgent = new Map<PedAgent, Guest>();
  private checkT = 0;
  private now = 0;
  private hour = 12;
  private day = 0;
  /** Is the player talking to this person (game/people)? They stay put meanwhile. */
  busy: ((a: PedAgent) => boolean) | null = null;
  stats = { halls: 0, people: 0, walking: 0, seated: 0 };

  constructor(private d: HallDeps) {
    (d.macro.landmarks ?? []).forEach((lm, index) => {
      if (lm.kind !== 'cathedral' && lm.kind !== 'townhall') return;
      const ins = landmarkInterior(lm, d.terrain);
      if (!ins || !ins.exits.length) return;
      const adj = ins.links.map((l, i) => l.map((to) => ({ to, d: Math.hypot(ins.nav[to * 3] - ins.nav[i * 3], ins.nav[to * 3 + 1] - ins.nav[i * 3 + 1], ins.nav[to * 3 + 2] - ins.nav[i * 3 + 2]) })));
      this.halls.push({
        lm, index, ins, church: lm.kind === 'cathedral', on: false, guests: new Set(), taken: ins.spots.map(() => null), adj,
        arriveT: 0, n: 0, desk: ins.spots.findIndex((s) => s.who === 'clerk'),
      });
    });
    const prev = d.peds.onArrive;
    d.peds.onArrive = (a) => this.arrive(a) || (prev?.(a) ?? false);
  }

  /** Who is in each landmark now, by role (dev.halls.list()). */
  report(): { name: string; kind: string; on: boolean; people: Record<string, number> }[] {
    return this.halls.map((h) => {
      const people: Record<string, number> = {};
      for (const g of h.guests) people[g.role] = (people[g.role] ?? 0) + 1;
      return { name: h.lm.name, kind: h.lm.kind, on: h.on, people };
    });
  }

  /** Just inside the door of the first landmark of a kind, facing in (dev.halls.go). */
  door(kind: 'cathedral' | 'townhall'): { x: number; y: number; z: number; yaw: number } | null {
    const h = this.halls.find((x) => x.lm.kind === kind);
    if (!h) return null;
    const [x, y, z] = this.nodeAt(h, h.ins.exits[0].node);
    // (Facing up the site's v axis: into the building.)
    const fx = -Math.sin(h.lm.angle), fz = Math.cos(h.lm.angle);
    return { x, y, z, yaw: Math.atan2(-fx, -fz) };
  }

  /** The role of a person in a landmark (null: not one of ours). */
  roleOf(a: PedAgent): HallRole | null {
    return this.byAgent.get(a)?.role ?? null;
  }

  /** What they wear for their role (CrowdRenderer.outfit): null for their own clothes. */
  outfit(a: PedAgent): EquipmentVisuals | null {
    const g = this.byAgent.get(a);
    return g ? outfitFor(g.role, a.cit) : null;
  }

  update(dt: number, hoursAbs: number, px: number, pz: number): void {
    this.now += dt;
    this.hour = ((hoursAbs % 24) + 24) % 24;
    this.day = Math.floor(hoursAbs / 24);
    this.checkT -= dt;
    if (this.checkT <= 0) {
      this.checkT = 0.5;
      for (const h of this.halls) {
        const dd = Math.hypot(h.lm.x - px, h.lm.z - pz);
        if (!h.on && dd < ACTIVE_R) this.open(h);
        else if (h.on && dd > DROP_R) this.close(h);
        if (h.on && this.d.standing && this.d.standing(h.index) < 0.85) this.panic(h);
        if (h.on) this.balance(h);
      }
    }
    let walking = 0, seated = 0, people = 0;
    for (const h of this.halls) {
      if (!h.on) continue;
      for (const g of [...h.guests]) {
        this.step(g, dt);
        if (!h.guests.has(g)) continue;
        people++;
        if (g.mode === Mode.Walk || g.mode === Mode.Approach) walking++;
        if (g.a.state === PState.Sit) seated++;
      }
    }
    this.stats = { halls: this.halls.filter((h) => h.on).length, people, walking, seated };
  }

  // ------------------------------------------------------------------ who is due

  /** How many of each role the landmark wants now. */
  private wanted(h: Hall): Map<HallRole, number> {
    const w = new Map<HallRole, number>(), hr = this.hour, S = h.ins.spots;
    const count = (who: SpotWho) => S.reduce((n, s) => n + (s.who === who ? 1 : 0), 0);
    if (this.d.standing && this.d.standing(h.index) < 0.85) return w;
    if (h.church) {
      const C = HALL_HOURS.cathedral;
      // (The faithful come a little early.)
      const service = C.services.some(([a, b]) => hourIn(hr, [a - 0.25, b]));
      if (hourIn(hr, C.priest)) w.set('priest', 1);
      if (service) {
        w.set('server', Math.min(2, count('server')));
        w.set('faithful', Math.min(70, Math.round(count('faithful') * C.pews)));
      } else if (hourIn(hr, C.open)) w.set('faithful', Math.min(count('faithful'), C.praying - (hr > 19 ? 2 : 0)));
      else if (hr >= 21 && hr < 23) w.set('faithful', 1);
      if (hourIn(hr, C.open)) {
        // Busiest in the middle of the day; fewer during a service.
        const peak = hr >= 10 && hr < 17 ? 1 : 0.5;
        const room = Math.max(0.6, Math.min(1.4, count('visitor') / 16));
        w.set('visitor', Math.round(C.visitors * peak * room * (service ? 0.5 : 1)));
      }
    } else {
      const T = HALL_HOURS.townhall;
      if (hourIn(hr, T.open)) {
        w.set('clerk', count('clerk'));
        // (Clients: some at the counter or the desk, some waiting.)
        const asking = S.filter((s) => s.who === 'client' && !s.sit).length, waiting = S.filter((s) => s.who === 'client' && s.sit).length;
        w.set('client', Math.round(asking * T.asking + waiting * T.waiting));
        w.set('visitor', Math.round(T.visitors * Math.max(0.5, Math.min(1.3, count('visitor') / 20))));
        if (hourIn(hr, T.mayor)) { w.set('mayor', Math.min(1, count('mayor'))); w.set('aide', Math.min(1, count('aide'))); }
        if (T.sessions.some((s) => hourIn(hr, s))) w.set('councillor', Math.round(count('councillor') * T.council));
        if (count('couple') >= 2 && T.weddings.some((s) => hourIn(hr, s))) {
          w.set('bride', 1); w.set('partner', 1); w.set('registrar', Math.min(1, count('registrar')));
          w.set('guest', Math.round(count('guest') * T.guests));
        }
      } else if (h.desk >= 0) w.set('porter', 1);
    }
    return w;
  }

  /** The spot kinds a role uses. */
  private spotsFor(h: Hall, role: HallRole): SpotWho[] {
    switch (role) {
      case 'visitor': return h.church ? ['visitor', 'faithful'] : ['visitor'];
      case 'bride': case 'partner': return ['couple'];
      case 'porter': return ['clerk'];
      default: return [role as SpotWho];
    }
  }

  /** Arrivals and departures towards what is due (and a whole set of people at once on opening). */
  private balance(h: Hall, fill = false): void {
    const want = this.wanted(h), have = new Map<HallRole, number>();
    for (const g of h.guests) if (!g.out) have.set(g.role, (have.get(g.role) ?? 0) + 1);
    // Too many: the extra ones leave (visitors and the last to come first).
    for (const g of [...h.guests]) {
      const n = have.get(g.role) ?? 0;
      if (g.out || n <= (want.get(g.role) ?? 0)) continue;
      have.set(g.role, n - 1);
      if (fill) this.drop(g);
      else if (g.mode === Mode.Stay) {
        // (Not all at once at the end of a service: within half a minute.)
        g.out = true;
        g.t = Math.min(g.t, hashToFloat(hash32(g.a.id * 5 + 1)) * 30);
      } else this.leave(g);
    }
    h.arriveT -= 0.5;
    // Arrivals come faster when many are due (a service, a session, a wedding).
    let due = 0;
    for (const [role, n] of want) due += Math.max(0, n - (have.get(role) ?? 0));
    for (const [role, n] of want) {
      let k = n - (have.get(role) ?? 0);
      while (k-- > 0) {
        if (!fill && h.arriveT > 0) return;
        if (!this.add(h, role, fill)) break;
        if (!fill) h.arriveT = (ARRIVE_EVERY / Math.min(5, 1 + due / 6)) * (0.4 + hashToFloat(hash32(h.n * 31 + 7)) * 1.2);
      }
    }
  }

  private open(h: Hall): void {
    h.on = true;
    h.arriveT = 0;
    this.balance(h, true);
  }

  private close(h: Hall): void {
    h.on = false;
    for (const g of [...h.guests]) this.drop(g);
  }

  /** Everyone out (the building is coming down). */
  private panic(h: Hall): void {
    for (const g of h.guests) if (!g.run && g.mode !== Mode.Approach && g.mode !== Mode.Down) { g.a.fear = Math.max(g.a.fear, 1); this.flee(g); }
  }

  // ------------------------------------------------------------------ people

  /**
   * A citizen for a role: the same staff every day (the priest, the mayor, the porter; clerks and
   * councillors by their seat), visitors, the faithful, clients and wedding parties new ones.
   */
  private citizen(h: Hall, role: HallRole, spot: number): Citizen | null {
    const staff = !NEW_EACH_TIME.has(role), key = role === 'clerk' || role === 'councillor' || role === 'server' ? spot : 0;
    for (let k = 0; k < 8; k++) {
      const seed = staff ? hash32(hashCombine(hashCombine(h.lm.seed, ROLE_SEED[role]), key * 131 + k)) : hash32(hashCombine(hashCombine(h.lm.seed ^ 0x4a11, this.day), h.n * 977 + k));
      const c = this.d.pop.synthetic(seed);
      if (c.role === Role.Child && (staff || role === 'guest' || role === 'bride' || role === 'partner' || hashToFloat(seed) < 0.6)) continue;
      if (role === 'bride' && c.gender >= 0.5) continue;
      if ((role === 'clerk' || role === 'aide' || role === 'server' || role === 'porter') && c.role === Role.Senior) continue;
      return c;
    }
    return null;
  }

  /** A free spot of these kinds (null: none), nearest to the door's way first for arrivals. */
  private freeSpot(h: Hall, kinds: SpotWho[], key: number, role: HallRole): number {
    const S = h.ins.spots, free: number[] = [];
    for (let i = 0; i < S.length; i++) if (!h.taken[i] && kinds.includes(S[i].who)) free.push(i);
    if (!free.length) return -1;
    // The priest at a service: behind the altar (the first priest spot); the porter: the desk.
    if (role === 'priest' && HALL_HOURS.cathedral.services.some((s) => hourIn(this.hour, s)) && free.includes(S.findIndex((s) => s.who === 'priest'))) return S.findIndex((s) => s.who === 'priest');
    if (role === 'porter') return free.includes(h.desk) ? h.desk : -1;
    // Visitors mostly stand and look (a pew now and then).
    if (role === 'visitor' && h.church) {
      const look = free.filter((i) => S[i].who === 'visitor');
      if (look.length && hashToFloat(hash32(key + 3)) < 0.75) return look[hash32(key) % look.length];
    }
    return free[hash32(key) % free.length];
  }

  /** Someone new: placed straight at their spot (fill) or walking in from down the street. */
  private add(h: Hall, role: HallRole, fill: boolean): boolean {
    const key = h.n++;
    const spot = this.freeSpot(h, this.spotsFor(h, role), hash32(key * 7 + h.lm.seed), role);
    if (spot < 0 && role !== 'visitor') return false;
    const c = this.citizen(h, role, spot);
    if (!c) return false;
    const pace = PACE[0] + hashToFloat(c.seed) * (PACE[1] - PACE[0]);
    const S = h.ins.spots;
    if (fill) {
      // Already there: at the spot, or (a visitor between things) somewhere along the ways.
      let x: number, y: number, z: number, yaw = 0;
      if (spot >= 0) { const s = S[spot]; x = s.x; y = s.y; z = s.z; yaw = s.h; }
      else {
        const i = hash32(key + 11) % h.ins.links.length, N = h.ins.nav;
        x = N[i * 3]; y = N[i * 3 + 1]; z = N[i * 3 + 2]; yaw = hashToFloat(key) * 6.28;
      }
      const a = this.d.peds.spawnInside(c, x, y, z, yaw, spot >= 0 && S[spot].sit ? 'sit' : 'stand');
      if (!a) return false;
      a.hall = true;
      const g = this.guest(h, a, role, pace);
      g.at = spot >= 0 ? S[spot].node : hash32(key + 11) % h.ins.links.length;
      if (spot >= 0) { this.claim(g, spot); this.settle(g, true); }
      else this.next(g);
      return true;
    }
    // Walking in: from a door down the street to the foot of the steps (a street walker till then).
    const ex = h.ins.exits[0], P = ex.pts, fx = P[P.length - 3], fz = P[P.length - 1];
    const from = this.pickDoor(fx, fz, 35, 110, key + h.lm.seed);
    let a: PedAgent | null = null;
    if (from) {
      const r = this.d.peds.buildRoute(from.x, from.z, fx, fz);
      if (r) {
        a = this.d.peds.spawnAt(c, from.x, from.z, 0);
        if (a) {
          const L = r.length;
          a.route = Math.hypot(r[L - 3] - fx, r[L - 2] - fz) > 1.5 ? Float32Array.from([...r, fx, fz, 0]) : r;
          a.wp = 1; a.state = PState.Walk; a.dest = { x: fx, z: fz }; a.pref = 1.2 + pace * 0.2;
        }
      }
    }
    if (!a) return false;
    const g = this.guest(h, a, role, pace);
    g.mode = Mode.Approach;
    if (spot >= 0) this.claim(g, spot);
    return true;
  }

  private guest(h: Hall, a: PedAgent, role: HallRole, pace: number): Guest {
    const g: Guest = {
      a, hall: h, role, spot: -1, mode: Mode.Stay, pts: [], nodes: [], wp: 0, sx: a.x, sy: a.y, sz: a.z, at: h.ins.exits[0].node,
      near: false, t: 0, left: role === 'visitor' ? VISIT[0] + (hash32(a.cit.seed) % (VISIT[1] - VISIT[0] + 1)) : 1, out: false, run: false, pace, pause: 0,
    };
    h.guests.add(g);
    this.byAgent.set(a, g);
    return g;
  }

  private claim(g: Guest, spot: number): void {
    if (g.spot >= 0 && g.hall.taken[g.spot] === g) g.hall.taken[g.spot] = null;
    g.spot = spot;
    if (spot >= 0) g.hall.taken[spot] = g;
  }

  /** Let go of a guest: gone (out of range), or handed back to the street. */
  private release(g: Guest, vanish: boolean): void {
    this.claim(g, -1);
    g.hall.guests.delete(g);
    this.byAgent.delete(g.a);
    if (vanish) g.a.alive = false;
  }

  private drop(g: Guest): void {
    // (Someone lying on the floor or running stays theirs till then: only the calm vanish.)
    this.release(g, true);
  }

  /** A street walker reached the foot of the steps: in they go. */
  private arrive(a: PedAgent): boolean {
    const g = this.byAgent.get(a);
    if (!g || g.mode !== Mode.Approach) return false;
    const h = g.hall, ex = h.ins.exits[0], P = ex.pts;
    a.inside = true;
    a.hall = true;
    a.floorY = a.y;
    a.dest = null;
    a.onRoad = false;
    // Up the steps and in at the door, then on.
    const pts: number[] = [], nodes: number[] = [];
    for (let i = P.length - 6; i >= 0; i -= 3) { pts.push(P[i], P[i + 1], P[i + 2]); nodes.push(-1); }
    pts.push(...this.nodeAt(h, ex.node)); nodes.push(ex.node);
    g.at = ex.node;
    this.walk(g, pts, nodes);
    this.onward(g, true);
    return true;
  }

  // ------------------------------------------------------------------ walking

  private nodeAt(h: Hall, i: number): [number, number, number] {
    const N = h.ins.nav;
    return [N[i * 3], N[i * 3 + 1], N[i * 3 + 2]];
  }

  /** Nav points from a to b (Dijkstra on the small graph), a excluded. */
  private route(h: Hall, a: number, b: number): number[] {
    if (a === b) return [];
    const n = h.adj.length, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), done = new Uint8Array(n);
    dist[a] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0 || u === b) break;
      done[u] = 1;
      for (const { to, d } of h.adj[u]) if (dist[u] + d < dist[to]) { dist[to] = dist[u] + d; prev[to] = u; }
    }
    if (prev[b] < 0) return [];
    const out: number[] = [];
    for (let v = b; v !== a; v = prev[v]) out.push(v);
    return out.reverse();
  }

  /** Start walking a list of waypoints (appended to what is queued when `append`). */
  private walk(g: Guest, pts: number[], nodes: number[], append = false): void {
    if (append && g.mode === Mode.Walk) { g.pts.push(...pts); g.nodes.push(...nodes); return; }
    g.pts = pts; g.nodes = nodes; g.wp = 0;
    g.sx = g.a.x; g.sy = g.a.y; g.sz = g.a.z;
    g.mode = Mode.Walk;
    const a = g.a;
    a.state = PState.Walk; a.stateT = 0; a.glance = 0;
  }

  /** The way from where they are (off their spot first) to nav point `to`, as waypoints. */
  private wayTo(g: Guest, to: number): { pts: number[]; nodes: number[] } {
    const h = g.hall, pts: number[] = [], nodes: number[] = [];
    let from = g.at;
    if (g.near && g.spot >= 0) {
      // Back along the spot's way to its nav point.
      const s = h.ins.spots[g.spot];
      for (let i = s.via.length - 2; i >= 0; i -= 2) { pts.push(s.via[i], s.y, s.via[i + 1]); nodes.push(-1); }
      pts.push(...this.nodeAt(h, s.node)); nodes.push(s.node);
      from = s.node;
    } else if (g.mode === Mode.Walk && g.wp < g.nodes.length && g.nodes[g.wp] >= 0) {
      // Mid-leg: on to the nav point ahead first.
      from = g.nodes[g.wp];
      pts.push(...this.nodeAt(h, from)); nodes.push(from);
    } else {
      // (Standing at or near the last nav point: back onto it first.)
      pts.push(...this.nodeAt(h, from)); nodes.push(from);
    }
    for (const n of this.route(h, from, to)) { pts.push(...this.nodeAt(h, n)); nodes.push(n); }
    return { pts, nodes };
  }

  /** After reaching a nav point or arriving: on to the spot (or a new one, or out). */
  private onward(g: Guest, append: boolean): void {
    const h = g.hall;
    if (g.spot < 0 && g.role === 'visitor') {
      const s = this.freeSpot(h, this.spotsFor(h, 'visitor'), hash32(g.a.id * 13 + h.n++), 'visitor');
      if (s >= 0) this.claim(g, s);
    }
    if (g.spot < 0) { if (!append) this.next(g); return; }
    const s = h.ins.spots[g.spot];
    const pts: number[] = [], nodes: number[] = [];
    for (const n of this.route(h, append ? g.nodes[g.nodes.length - 1] ?? g.at : g.at, s.node)) { pts.push(...this.nodeAt(h, n)); nodes.push(n); }
    for (let i = 0; i < s.via.length; i += 2) { pts.push(s.via[i], s.y, s.via[i + 1]); nodes.push(-1); }
    pts.push(s.x, s.y, s.z); nodes.push(-2);
    this.walk(g, pts, nodes, append);
  }

  /** A visitor done with a spot: the next thing to look at, or out. Others: back to their spot. */
  private next(g: Guest): void {
    if (g.out) return this.leave(g);
    if (g.role === 'visitor') {
      if (--g.left <= 0) return this.leave(g);
      const prev = g.spot;
      const s = this.freeSpot(g.hall, this.spotsFor(g.hall, 'visitor'), hash32(g.a.id * 17 + g.hall.n++), 'visitor');
      if (s < 0 || s === prev) {
        // Nothing free: a stroll to a nav point and a look round there.
        const { pts, nodes } = this.wayTo(g, hash32(g.a.id + g.hall.n++) % g.hall.adj.length);
        this.claim(g, -1);
        g.near = false;
        this.walk(g, pts, nodes);
        return;
      }
      const { pts, nodes } = this.wayTo(g, g.hall.ins.spots[s].node);
      g.near = false;
      this.claim(g, s);
      this.walk(g, pts, nodes);
      this.onward(g, true);
      return;
    }
    if (g.spot >= 0 && g.role !== 'faithful' && g.role !== 'client') { this.settle(g, false); return; }
    this.leave(g);
  }

  /** Out the door, down the steps and away (running when `run`). */
  private leave(g: Guest): void {
    if (g.mode === Mode.Approach) { this.release(g, false); return; }
    g.out = true;
    const h = g.hall, ex = h.ins.exits[0];
    const { pts, nodes } = this.wayTo(g, ex.node);
    this.claim(g, -1);
    g.near = false;
    pts.push(...ex.pts);
    for (let i = 0; i < ex.pts.length; i += 3) nodes.push(-3);
    this.walk(g, pts, nodes);
  }

  private flee(g: Guest): void {
    if (g.run) return;
    g.run = true;
    g.pause = 0;
    // (On the way out already: just faster.)
    if (!g.out || g.mode === Mode.Stay) this.leave(g);
  }

  /** At the spot: sit or stand, facing its way, looking at its thing; for how long. */
  private settle(g: Guest, placed: boolean): void {
    const a = g.a, s = g.hall.ins.spots[g.spot];
    g.mode = Mode.Stay;
    g.near = true;
    a.x = s.x; a.z = s.z; a.y = s.y; a.floorY = s.y;
    a.heading = s.h;
    a.speed = 0;
    a.state = s.sit ? PState.Sit : PState.Idle;
    a.stateT = 0;
    if (s.look) { a.glance = 1e9; a.lookX = s.look[0]; a.lookY = s.look[1]; a.lookZ = s.look[2]; } else a.glance = 0;
    const r = hashToFloat(hash32(a.id * 7 + g.hall.n));
    // (Placed on opening: part of their stay is over already.)
    const f = placed ? r : 1;
    // (Staff, a service, a session, a wedding: till it is over. Prayers and errands: a while.)
    g.t = g.role === 'visitor' ? (s.sit ? REST[0] + r * (REST[1] - REST[0]) : LOOK[0] + r * (LOOK[1] - LOOK[0])) * f
      : g.role === 'faithful' && !HALL_HOURS.cathedral.services.some((v) => hourIn(this.hour, v)) ? (60 + r * 140) * f
        : g.role === 'client' ? (s.sit ? 50 + r * 120 : 25 + r * 50) * f
          : Infinity;
  }

  /** The end of the way: at the spot, at a nav point, or out at the foot of the steps. */
  private reached(g: Guest): void {
    const a = g.a;
    if (g.out) {
      // Back to the street: to a door down the street (and in), or running from whatever it was.
      this.release(g, false);
      a.inside = false; a.hall = false; a.floorY = undefined; a.glance = 0; a.gx = 1e9;
      const to = this.pickDoor(a.x, a.z, 50, 160, a.id * 3 + g.hall.n);
      const r = to ? this.d.peds.buildRoute(a.x, a.z, to.x, to.z) : null;
      if (!r) { a.alive = false; return; }
      a.route = r; a.wp = 1; a.dest = to; a.stateT = 0;
      a.state = g.run && a.fear > 0.3 ? PState.Flee : PState.Walk;
      if (a.state === PState.Flee) { a.fearX = g.hall.lm.x; a.fearZ = g.hall.lm.z; }
      return;
    }
    if (g.nodes[g.nodes.length - 1] === -2 && g.spot >= 0) { this.settle(g, false); return; }
    // A stroll's end: look round a little, then on.
    g.mode = Mode.Stay;
    a.speed = 0; a.state = PState.Idle;
    g.t = LOOK[0] + hashToFloat(hash32(a.id + g.hall.n)) * (LOOK[1] - LOOK[0]) * 0.5;
  }

  private step(g: Guest, dt: number): void {
    const a = g.a;
    if (!a.alive) { this.release(g, false); return; }
    if (g.mode === Mode.Approach) {
      // A street walker on the way: scared off or knocked down, they are not coming.
      if (a.state === PState.Flee || a.state === PState.Down || a.actor || a.ragdoll) this.release(g, false);
      return;
    }
    if (a.state === PState.Down) {
      if (g.mode !== Mode.Down) { g.mode = Mode.Down; this.claim(g, -1); g.near = false; g.run = false; }
      // Up again after a while, and out.
      if (a.stateT > GET_UP && a.vy === 0) { a.state = PState.Idle; a.stateT = 0; a.fear = Math.max(a.fear, 1); a.y = a.floorY ?? a.y; this.nearestNode(g); this.flee(g); }
      return;
    }
    if (g.mode === Mode.Down) return;
    if (this.busy?.(a)) { a.speed = 0; return; }
    if (a.fear > 0.5 && !g.run) this.flee(g);
    // A commotion: stop and look a few seconds (then on).
    if (!g.run && (a.state === PState.Gawk || a.state === PState.Film)) { g.pause = 4 + hashToFloat(a.id) * 3; a.glance = g.pause; }
    if (g.pause > 0) {
      g.pause -= dt;
      a.speed = 0;
      const s = g.spot >= 0 && g.near && g.mode === Mode.Stay ? g.hall.ins.spots[g.spot] : null;
      a.state = s?.sit ? PState.Sit : PState.Idle;
      if (g.pause <= 0) {
        // Back to what they were doing (and looking at).
        if (g.mode === Mode.Walk) a.state = PState.Walk;
        if (s?.look) { a.glance = 1e9; a.lookX = s.look[0]; a.lookY = s.look[1]; a.lookZ = s.look[2]; } else a.glance = 0;
      }
      return;
    }
    if (g.mode === Mode.Stay) {
      a.speed = 0;
      if (a.state !== PState.Sit && a.state !== PState.Idle) a.state = g.spot >= 0 && g.hall.ins.spots[g.spot].sit && g.near ? PState.Sit : PState.Idle;
      g.t -= dt;
      if (g.t <= 0) this.next(g);
      return;
    }
    // Walking.
    const P = g.pts;
    if (g.wp * 3 >= P.length) { a.speed = 0; this.reached(g); return; }
    const tx = P[g.wp * 3], ty = P[g.wp * 3 + 1], tz = P[g.wp * 3 + 2];
    const dx = tx - a.x, dz = tz - a.z, d = Math.hypot(dx, dz);
    const sp = g.run ? RUN : g.pace, mv = sp * dt;
    a.state = PState.Walk;
    if (d <= mv) {
      a.x = tx; a.z = tz; a.y = ty;
      const nd = g.nodes[g.wp];
      if (nd >= 0) { g.at = nd; g.near = false; }
      if (g.spot >= 0 && nd === g.hall.ins.spots[g.spot].node && !g.out) g.near = true;
      g.sx = tx; g.sy = ty; g.sz = tz;
      g.wp++;
      if (g.wp * 3 >= P.length) { a.speed = 0; this.reached(g); }
      return;
    }
    a.x += (dx / d) * mv; a.z += (dz / d) * mv;
    const L = Math.hypot(tx - g.sx, tz - g.sz) || 1;
    let y = g.sy + (ty - g.sy) * Math.max(0, Math.min(1, 1 - (d - mv) / L));
    // (On the floor where there is one near the line: steps and stairs read as steps.)
    const f = this.d.floor?.(a.x, y + 0.3, a.z) ?? -Infinity;
    if (f > -Infinity && Math.abs(f - y) < 0.3) y = f;
    a.y = y;
    a.floorY = y;
    a.speed = sp;
    a.phase += sp * dt;
    const want = Math.atan2(-dx, -dz);
    let dh = want - a.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    a.heading += dh * Math.min(1, dt * 8);
  }

  /** After a fall: the nearest nav point on their level is where they go on from. */
  private nearestNode(g: Guest): void {
    const N = g.hall.ins.nav, a = g.a;
    let best = g.at, bd = Infinity;
    for (let i = 0; i < N.length / 3; i++) {
      const dy = Math.abs(N[i * 3 + 1] - a.y);
      if (dy > 1) continue;
      const dd = Math.hypot(N[i * 3] - a.x, N[i * 3 + 2] - a.z);
      if (dd < bd) { bd = dd; best = i; }
    }
    g.at = best;
    g.mode = Mode.Stay;
    g.near = false;
  }

  /** The door of a building between r0 and r1 m away (deterministic pick), or null. */
  private pickDoor(x: number, z: number, r0: number, r1: number, h: number): { x: number; z: number } | null {
    const refs = this.d.world.buildingsIn(x - r1, z - r1, x + r1, z + r1);
    const c: { x: number; z: number }[] = [];
    for (const r of refs) {
      if (!r.alive) continue;
      const dd = doorOf(r.desc), d = Math.hypot(dd.x - x, dd.z - z);
      if (d >= r0 && d <= r1) c.push(dd);
    }
    return c.length ? c[hash32(h) % c.length] : null;
  }
}

// ------------------------------------------------------------------ clothes

/** Roles filled by someone new each time (the rest are the same people every day). */
const NEW_EACH_TIME = new Set<HallRole>(['visitor', 'faithful', 'client', 'guest', 'bride', 'partner']);

const ROLE_SEED: Record<HallRole, number> = {
  visitor: 1, faithful: 2, priest: 3, server: 4, clerk: 5, client: 6, mayor: 7, aide: 8, councillor: 9, registrar: 10, bride: 11, partner: 12, guest: 13, porter: 14,
};

type C3 = [number, number, number];
const vis = (seed: number, primary: C3, secondary: C3 = primary, pattern = 'plain'): ItemVisual =>
  ({ shape: 'cloth', seed, primary, secondary, accent: secondary, material: pattern, glow: 0, glowColor: [0, 0, 0], wear: 0.05, style: '' });
const BLACK: C3 = [0.06, 0.06, 0.07], WHITE: C3 = [0.95, 0.95, 0.93];

const outfits = new Map<number, EquipmentVisuals | null>();

/** Work clothes by role (the priest's black, the clerks' suits, the bride's white). */
function outfitFor(role: HallRole, c: Citizen): EquipmentVisuals | null {
  const key = c.id * 16 + ROLE_SEED[role];
  if (outfits.has(key)) return outfits.get(key)!;
  const s = c.seed;
  let eq: EquipmentVisuals | null = null;
  switch (role) {
    case 'priest':
      eq = { chest: { defId: 'shirt', visual: vis(s, BLACK) }, back: { defId: 'coat', visual: vis(s + 1, BLACK) }, legs: { defId: 'trousers', visual: vis(s + 2, BLACK) }, feet: { defId: 'shoes', visual: vis(s + 3, BLACK) } };
      break;
    case 'server':
      eq = { chest: { defId: 'shirt', visual: vis(s, WHITE) }, legs: { defId: 'trousers', visual: vis(s + 2, BLACK) }, feet: { defId: 'shoes', visual: vis(s + 3, BLACK) } };
      break;
    case 'bride':
      eq = { chest: { defId: 'dress', visual: vis(s, [0.98, 0.97, 0.94], [0.95, 0.93, 0.88]) }, feet: { defId: 'shoes', visual: vis(s + 3, WHITE) } };
      break;
    case 'partner': {
      const suit: C3 = [0.1, 0.1, 0.13];
      eq = { chest: { defId: 'shirt', visual: vis(s, WHITE) }, back: { defId: 'suitjacket', visual: vis(s + 1, suit) }, legs: { defId: 'trousers', visual: vis(s + 2, suit) }, feet: { defId: 'shoes', visual: vis(s + 3, BLACK) } };
      break;
    }
    case 'porter': {
      const navy: C3 = [0.1, 0.13, 0.25];
      eq = { chest: { defId: 'shirt', visual: vis(s, [0.75, 0.8, 0.9]) }, back: { defId: 'jacket', visual: vis(s + 1, navy) }, legs: { defId: 'trousers', visual: vis(s + 2, navy) }, feet: { defId: 'shoes', visual: vis(s + 3, BLACK) }, head: { defId: 'cap', visual: vis(s + 4, navy) } };
      break;
    }
    case 'clerk': case 'mayor': case 'aide': case 'registrar': case 'councillor':
      eq = cityOutfit(s, c.gender, c.age, role === 'clerk' ? 0.85 : 1.6, 0);
      break;
    case 'guest':
      eq = cityOutfit(s, c.gender, c.age, 1.2, 0);
      break;
  }
  outfits.set(key, eq);
  if (outfits.size > 4000) outfits.clear();
  return eq;
}
