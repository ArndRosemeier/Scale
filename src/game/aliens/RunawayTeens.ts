/**
 * Runaway teens (ALIENS_PLAN §5, phase 2): a minor event on the threat clock. Youngsters of the
 * Wardens' own kind have taken a saucer for a joyride. They keep low between the buildings, under
 * the roofs, where the station and the discs do not see them, and get up to mischief:
 *
 *  - a parked car lifted in the beam and dropped on a low roof;
 *  - a passer-by lifted up, tumbling, and set down in a fountain (in the street when there is none);
 *  - a big glowing glyph drawn on a facade.
 *
 * Expensive, mostly harmless; people film and laugh. The police come and get nowhere (it flies;
 * the response stops at level 2).
 *
 * The hero's job is to get it seen (teenRules): knock its three hover pods out (each one lost
 * lifts it higher; with none left it bobs up over the roofs like a cork), chase it into open
 * ground where there is no cover, come at it from below so it pops up out of reach, or drive it
 * into a disc's scan cone. Seen long enough, it is caught at once: a stasis field, a parent disc
 * drops on it from high up, lifts it in its beam and a stern tone rolls over the block. The hero
 * near when it was seen (or a pod down by their hand) gets the credit: karma, reputation, people
 * cheering, the news, and one more on the Wardens' quiet count of regard.
 *
 * Left alone, the teens zoom off home after a few minutes.
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import { Rng } from '../../core/rng';
import { clamp, smoothstep } from '../../core/math';
import { PState, type PedAgent } from '../../sim/Pedestrians';
import { VState, type Vehicle } from '../../sim/Traffic';
import { doorOf } from '../../sim/Population';
import { Role } from '../../sim/Population';
import type { Cause } from '../Stimuli';
import { DAMAGE_PER_IMPULSE, type DamageResult, type DamageSource, type ThreatActor, type ThreatEvent, type ThreatOutcome, type ThreatTarget, type ThreatZone } from '../threats/ThreatEvent';
import type { Disc } from './Discs';
import { TEEN_COLOURS } from './Glyphs';
import { TeenSaucer, SAUCER_R, POD_R } from './TeenSaucer';
import { TEENS, teenHeight, inOpen, seeStep, teenReward, teenLine, type TeenMoment } from './teenRules';

let EVENT_ID = 9000;

export interface TeenOpts {
  /** Seconds before they go home on their own. */
  duration?: number;
}

type Mode = 'joy' | 'prank' | 'flee' | 'held' | 'lifted' | 'home' | 'gone';
type Prank =
  | { kind: 'car'; v: Vehicle; roof: { x: number; y: number; z: number }; stage: 'go' | 'beam' | 'carry'; t: number }
  | { kind: 'person'; a: PedAgent; drop: { x: number; y: number; z: number; fountain: boolean }; stage: 'go' | 'beam' | 'carry' | 'lower'; t: number }
  | { kind: 'glyph'; at: { x: number; y: number; z: number; nx: number; nz: number }; stage: 'go' | 'draw'; t: number };

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

export class RunawayTeens implements ThreatEvent {
  readonly id = EVENT_ID++;
  readonly archetype = 'teens';
  readonly tier = 'minor' as const;
  readonly engageOnFoot = false;
  readonly ceiling = 2;
  readonly radius = 50;
  readonly title = 'Runaway saucer — chase it out from under the roofs';
  t = 0;
  active = true;
  outcome: ThreatOutcome | null = null;
  hurt = 0;
  readonly actors: ThreatActor[];
  readonly mesh = new TeenSaucer();
  /** Where the saucer is and how it moves. */
  x: number; y: number; z: number;
  vx = 0; vy = 0; vz = 0;
  mode: Mode = 'joy';
  /** The Wardens seeing it, 0..1 (teenRules.seeStep). */
  seen = 0;
  /** Pods: hit points left; who knocked each out. */
  readonly podHp = [TEENS.podHp, TEENS.podHp, TEENS.podHp];
  readonly podBy: (Cause | null)[] = [null, null, null];
  readonly stats = { pranks: 0, cars: 0, people: 0, glyphs: 0, flees: 0, dodges: 0, open: 0, cone: 0, pods: 0, credit: '' as string };
  private rng: Rng;
  private path: { x: number; z: number }[] = [];
  private pi = 0;
  private prank: Prank | null = null;
  private cover = 10;
  private coverT = 0;
  private ground = 0;
  private dodgeT = 0;
  private fleeCalm = 0;
  private planT = 0;
  private farT = 0;
  private maxT: number;
  private parent: Disc | null = null;
  private heldT = 0;
  private toned = false;
  private whine: ReturnType<Game['audio']['loop']> = null;
  private whineTry = 0;
  private remarkT = 4;
  private gawkT = 2;
  private beamTo: THREE.Vector3 | null = null;
  private beamK = 0;
  private wobble = 0;
  private told = false;

  constructor(private g: Game, site: { x: number; z: number }, seed: number, opts: TeenOpts = {}) {
    this.rng = new Rng(seed);
    this.maxT = opts.duration ?? TEENS.maxT;
    site = this.startSpot(site);
    this.x = site.x; this.z = site.z;
    this.ground = g.terrain.height(site.x, site.z);
    this.cover = this.coverAt(site.x, site.z);
    this.y = this.ground + teenHeight(this.cover, 0);
    g.wardens?.group.add(this.mesh.root);
    this.actors = [new SaucerActor(this)];
    this.joyride();
  }

  // ================================================================== the world round it

  /** How high the roofs round a point stand over the ground there (m). */
  private coverAt(x: number, z: number): number {
    const W = this.g.world, gh = this.g.terrain.height(x, z), R = TEENS.coverR;
    let top = W.groundHeight(x, z);
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; top = Math.max(top, W.groundHeight(x + Math.cos(a) * R, z + Math.sin(a) * R)); }
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + 0.3; top = Math.max(top, W.groundHeight(x + Math.cos(a) * R * 0.5, z + Math.sin(a) * R * 0.5)); }
    return Math.max(0, top - gh);
  }

  /**
   * Where they come down: the site if the roofs round it hide them, else the nearest well-covered
   * street node (a saucer starting over a park would be seen before its first prank).
   */
  private startSpot(site: { x: number; z: number }): { x: number; z: number } {
    if (this.coverAt(site.x, site.z) >= TEENS.startCover) return site;
    let best: { x: number; z: number } | null = null, bs = -Infinity;
    for (const n of this.g.net.nodes) {
      const d = Math.hypot(n.x - site.x, n.z - site.z);
      if (d > TEENS.startR || !n.edges.length) continue;
      const c = this.coverAt(n.x, n.z);
      if (c < TEENS.startCover) continue;
      const s = Math.min(c, 30) - d * 0.05;
      if (s > bs) { bs = s; best = { x: n.x, z: n.z }; }
    }
    return best ?? site;
  }

  get podsOut(): number { return this.podHp.filter((h) => h <= 0).length; }

  /** A route along the streets to a node (points every ~10 m), or null. */
  private routeTo(node: number): { x: number; z: number }[] | null {
    const net = this.g.net;
    const ne = net.nearestEdge(this.x, this.z, 150);
    if (!ne) return null;
    const from = net.edgeEndNear(ne.e, ne.s);
    const r = net.route(from, node, false, 6000);
    if (!r) return null;
    const pts: { x: number; z: number }[] = [{ x: net.nodes[from].x, z: net.nodes[from].z }];
    r.edges.forEach((eid, k) => {
      const e = net.edges[eid], n = e.pts.length / 2;
      for (let i = 1; i < n; i++) {
        const j = r.fwd[k] ? i : n - 1 - i;
        const x = e.pts[j * 2], z = e.pts[j * 2 + 1], last = pts[pts.length - 1];
        const L = Math.hypot(x - last.x, z - last.z);
        // Long straight stretches split into steps (the height follows the cover along them).
        for (let s = 10; s < L; s += 10) pts.push({ x: last.x + ((x - last.x) * s) / L, z: last.z + ((z - last.z) * s) / L });
        pts.push({ x, z });
      }
    });
    return pts;
  }

  /** A node in a ring round a point (optionally away from `from`), with cover over it if possible. */
  private pickNode(cx: number, cz: number, rMin: number, rMax: number, away: { x: number; z: number } | null): number {
    const net = this.g.net, N = net.nodes.length;
    let best = -1, bs = -Infinity;
    for (let k = 0; k < 60 && N; k++) {
      const i = this.rng.int(0, N - 1), n = net.nodes[i];
      const d = Math.hypot(n.x - cx, n.z - cz);
      if (d < rMin || d > rMax || !n.edges.length) continue;
      let s = this.rng.float();
      // Hurt (pods out), they keep to the tallest streets they can find.
      const hurt = this.podsOut > 0;
      const c = this.coverAt(n.x, n.z);
      if (c >= TEENS.routeCover) s += 1;
      if (hurt) s += Math.min(c, 30) / 6;
      if (away) {
        const ax = cx - away.x, az = cz - away.z, L = Math.hypot(ax, az) || 1;
        s += (((n.x - cx) * ax + (n.z - cz) * az) / (d * L)) * (hurt ? 0.8 : 1.5);
      }
      if (s > bs) { bs = s; best = i; }
    }
    return best;
  }

  private joyride(): void {
    this.mode = 'joy';
    // Round about where the hero is (they show off), along the streets.
    const P = this.g.player.pos, far = Math.hypot(P.x - this.x, P.z - this.z) > 220;
    const n = far ? this.pickNode(P.x, P.z, 60, 220, null) : this.pickNode(this.x, this.z, 140, 380, null);
    this.path = n >= 0 ? this.routeTo(n) ?? [] : [];
    this.pi = 0;
    // Nowhere to go (no streets loaded): a loop round where it is.
    if (!this.path.length) for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; this.path.push({ x: this.x + Math.cos(a) * 60, z: this.z + Math.sin(a) * 60 }); }
  }

  private flee(): void {
    const P = this.g.player.pos;
    if (this.mode !== 'flee') this.stats.flees++;
    this.mode = 'flee';
    this.dropCargo();
    this.prank = null;
    const hurt = this.podsOut > 0;
    const n = this.pickNode(this.x, this.z, hurt ? 40 : 110, hurt ? 220 : 320, { x: P.x, z: P.z });
    this.path = n >= 0 ? this.routeTo(n) ?? [] : [];
    this.pi = 0;
    this.planT = 4;
    if (!this.path.length) { const a = Math.atan2(this.z - P.z, this.x - P.x); this.path.push({ x: this.x + Math.cos(a) * 150, z: this.z + Math.sin(a) * 150 }); }
  }

  // ================================================================== mischief

  /** Pick something to do near where it is: a car on a roof, someone in a fountain, a glyph. */
  private startPrank(): boolean {
    const g = this.g, rng = this.rng;
    let kinds = rng.chance(0.45) ? ['car', 'person', 'glyph'] : rng.chance(0.5) ? ['person', 'glyph', 'car'] : ['glyph', 'car', 'person'];
    // Not the same trick twice running.
    if (this.lastPrank) kinds = [...kinds.filter((k) => k !== this.lastPrank), this.lastPrank];
    for (const k of kinds) {
      if (k === 'car') {
        const cars = g.parkedCars.filter((v) => v.alive && v.state !== VState.Wreck && v.state !== VState.Crushed && v.kind !== 'tank' && v.kind !== 'apc'
          && !g.vehicles.extra(v).body && Math.hypot(v.x - this.x, v.z - this.z) < 90 && Math.hypot(v.x - g.player.pos.x, v.z - g.player.pos.z) > 8);
        if (!cars.length) continue;
        const v = cars[rng.int(0, cars.length - 1)];
        const roof = this.lowRoof(v.x, v.z);
        if (!roof) continue;
        this.prank = { kind: 'car', v, roof, stage: 'go', t: 0 };
      } else if (k === 'person') {
        const people = g.peds.neighbours(this.x, this.z, 60, []).filter((a) => a.alive && !a.actor && !a.inside && !a.under && !a.hall && !a.ragdoll && !a.airborne
          && (a.state === PState.Walk || a.state === PState.Idle || a.state === PState.Wait || a.state === PState.Gawk || a.state === PState.Film));
        if (!people.length) continue;
        const a = people[rng.int(0, people.length - 1)];
        this.prank = { kind: 'person', a, drop: this.dropSpot(a.x, a.z), stage: 'go', t: 0 };
      } else {
        const at = this.facade();
        if (!at) continue;
        this.prank = { kind: 'glyph', at, stage: 'go', t: 0 };
      }
      this.mode = 'prank';
      this.lastPrank = k;
      this.stats.pranks++;
      return true;
    }
    return false;
  }

  /**
   * A low roof near a point to drop a car on: a building 5–16 m tall among taller ones (so the saucer
   * over it, 7 m up, still keeps under the roofs round it), its middle (y: the roof).
   */
  private lowRoof(x: number, z: number): { x: number; y: number; z: number } | null {
    const W = this.g.world;
    let best: { x: number; y: number; z: number } | null = null, bd = Infinity;
    for (const b of W.buildingsIn(x - 80, z - 80, x + 80, z + 80)) {
      if (!b.alive) continue;
      const h = b.top - b.base;
      if (h < 5 || h > 16) continue;
      const cx = (b.bounds[0] + b.bounds[2]) / 2, cz = (b.bounds[1] + b.bounds[3]) / 2;
      if (W.buildingAt(cx, cz) !== b || Math.abs(W.groundHeight(cx, cz) - b.top) > 1.5) continue;
      const d = Math.hypot(cx - x, cz - z);
      if (d < 15 || d > 80 || d >= bd) continue;
      const over = b.top - this.g.terrain.height(cx, cz) + 7;
      if (inOpen(over, this.coverAt(cx, cz))) continue;
      bd = d; best = { x: cx, y: b.top, z: cz };
    }
    return best;
  }

  /** Where to set someone down: a fountain within reach, else a street spot a little way off. */
  private dropSpot(x: number, z: number): { x: number; y: number; z: number; fountain: boolean } {
    const g = this.g;
    let best: { x: number; z: number } | null = null, bd = 170;
    g.props.query(x, z, 170, (p) => { if (p.kind.startsWith('furn:fountain') && !p.broken) { const d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; best = p; } } });
    const f = best as { x: number; z: number } | null;
    if (f) return { x: f.x + 1.3, y: g.terrain.height(f.x, f.z), z: f.z, fountain: true };
    const ne = g.net.nearestEdge(x + 35, z + 20, 80);
    if (ne) {
      const o = { x: 0, z: 0, dx: 0, dz: 0 };
      g.net.pointAt(g.net.edges[ne.e], ne.s, 0, o);
      return { x: o.x, y: g.terrain.height(o.x, o.z), z: o.z, fountain: false };
    }
    return { x, y: g.terrain.height(x, z), z, fountain: false };
  }

  /** A facade near the saucer to draw on (a street front, up the wall). */
  private facade(): { x: number; y: number; z: number; nx: number; nz: number } | null {
    const W = this.g.world;
    const cands: { x: number; y: number; z: number; nx: number; nz: number }[] = [];
    for (const b of W.buildingsIn(this.x - 70, this.z - 70, this.x + 70, this.z + 70)) {
      if (!b.alive || b.top - b.base < 10) continue;
      const d = doorOf(b.desc);
      const y = b.base + Math.min(b.top - b.base - 3, 6 + this.rng.range(0, 5));
      // Stand-off point clear of other buildings, and no street tree in front of the wall.
      if (!W.standable(d.x + d.nx * 8, d.z + d.nz * 8)) continue;
      let tree = false;
      for (const k of [2.5, 6]) this.g.props.query(d.x + d.nx * k, d.z + d.nz * k, 4, (p) => { if (!tree && !p.broken && p.kind.startsWith('tree:')) tree = true; });
      if (tree) continue;
      // One glyph per wall: not over one still glowing there.
      if (this.g.wardens?.glyphs.near(d.x, y, d.z, 9)) continue;
      cands.push({ x: d.x - d.nx * 0.8, y, z: d.z - d.nz * 0.8, nx: d.nx, nz: d.nz });
    }
    return cands.length ? cands[this.rng.int(0, cands.length - 1)] : null;
  }

  /** Let go of whatever it holds (caught, fleeing): a car falls, a person is lowered gently. */
  private dropCargo(): void {
    const p = this.prank;
    if (!p) return;
    if (p.kind === 'car' && p.stage !== 'go') this.releaseCar(p.v);
    if (p.kind === 'person' && (p.stage === 'carry' || p.stage === 'beam') && p.a.airborne) { this.lowering.push(p.a); }
    this.prank = null;
  }

  /** People being let down slowly after the saucer let go of them. */
  private lowering: PedAgent[] = [];
  private lastPrank: string | null = null;

  private releaseCar(v: Vehicle): void {
    const body = this.g.vehicles.extra(v).body;
    if (!body) return;
    body.setLinvel({ x: this.vx * 0.5, y: -1, z: this.vz * 0.5 }, true);
    body.setAngvel({ x: this.rng.range(-0.6, 0.6), y: this.rng.range(-1, 1), z: this.rng.range(-0.6, 0.6) }, true);
  }

  /** Hold a lifted car under the saucer (its body follows a spring towards the hold point). */
  private holdCar(v: Vehicle, dt: number): number {
    const body = this.g.vehicles.extra(v).body;
    if (!body) return Infinity;
    const t = body.translation();
    const hx = this.x, hy = this.y - 5, hz = this.z;
    const dx = hx - t.x, dy = hy - t.y, dz = hz - t.z, L = Math.hypot(dx, dy, dz);
    const sp = Math.min(14, L * 2.2);
    body.setLinvel({ x: (dx / (L || 1)) * sp + this.vx * 0.9, y: (dy / (L || 1)) * sp + 9.81 * dt, z: (dz / (L || 1)) * sp + this.vz * 0.9 }, true);
    const w = body.angvel();
    body.setAngvel({ x: w.x * 0.9, y: 0.5, z: w.z * 0.9 }, true);
    return L;
  }

  private stepPrank(dt: number, want: { x: number; z: number; h: number; v: number }): void {
    const p = this.prank!, g = this.g;
    p.t += dt;
    if (p.kind === 'car') {
      const v = p.v;
      if (p.stage === 'go') {
        want.x = v.x; want.z = v.z; want.h = Math.max(8, v.y + 8 - this.ground); want.v = TEENS.vCarry;
        if (Math.hypot(this.x - v.x, this.z - v.z) < 2.5 && Math.abs(this.y - (v.y + 8)) < 2.5) { p.stage = 'beam'; p.t = 0; this.zap(); }
        if (p.t > 25 || !v.alive) this.prank = null;
      } else if (p.stage === 'beam') {
        want.x = v.x; want.z = v.z; want.h = v.y + 8 - this.ground; want.v = 2;
        this.beam(v.x, v.y + 0.5, v.z);
        if (p.t > 0.8 && !g.vehicles.extra(v).body) {
          g.traffic.wreckIt(v);
          v.damage = 0.12;
          g.vehicles.makeWreck(v, v.x, v.y + 0.5, v.z, 0, 1, 0);
          g.physics.ensureGround(p.roof.x, p.roof.z, 20);
        }
        if (g.vehicles.extra(v).body && this.holdCar(v, dt) < 2.5) { p.stage = 'carry'; p.t = 0; }
        if (p.t > 8) { this.releaseCar(v); this.prank = null; }
      } else {
        // Over the roof, a little above it, and let go.
        want.x = p.roof.x; want.z = p.roof.z; want.h = p.roof.y + 7 - this.ground; want.v = TEENS.vCarry;
        const L = this.holdCar(v, dt);
        this.beam(v.x, v.y + 0.8, v.z);
        if ((Math.hypot(this.x - p.roof.x, this.z - p.roof.z) < 2 && L < 3) || p.t > 20) {
          this.releaseCar(v);
          v.damage = Math.max(v.damage, 0.25);
          this.stats.cars++;
          this.giggle();
          this.prank = null;
          g.consequences.record('body', 'car', 'wreck', p.roof.x, p.roof.z, v, 'threat');
        }
      }
    } else if (p.kind === 'person') {
      const a = p.a;
      if (p.stage === 'go') {
        want.x = a.x; want.z = a.z; want.h = a.y + 7 - this.ground; want.v = TEENS.vCarry;
        if (!a.alive || a.inside || a.actor || p.t > 25) { this.prank = null; return; }
        if (Math.hypot(this.x - a.x, this.z - a.z) < 2.5 && Math.abs(this.y - (a.y + 7)) < 2.5) { p.stage = 'beam'; p.t = 0; this.zap(); }
      } else if (p.stage === 'beam' || p.stage === 'carry') {
        if (p.stage === 'beam') { want.x = a.x; want.z = a.z; want.h = this.y - this.ground; want.v = 1; }
        else { want.x = p.drop.x; want.z = p.drop.z; want.h = Math.max(7, this.cover * 0.4); want.v = TEENS.vCarry * 0.8; }
        if (!a.airborne) {
          if (g.ragdolls.isActive(a)) g.ragdolls.release(a);
          a.ragdoll = false;
          a.airborne = true;
          a.fly = undefined;
          a.state = PState.Down;
          a.stateT = 0;
          this.say(a, this.rng.pick(['Whoa! Whoa! Put me down!', 'Hey! HEY!', 'Help! I\'m flying!', 'Not again!']), 'angry');
        }
        // Up into the beam, tumbling slowly.
        const hold = this.y - 4;
        a.y += clamp(hold - a.y, -dt * 3, dt * 3);
        a.x += (this.x - a.x) * Math.min(1, dt * 3);
        a.z += (this.z - a.z) * Math.min(1, dt * 3);
        a.heading += dt * 1.5;
        a.vx = a.vy = a.vz = 0;
        this.beam(a.x, a.y - 0.4, a.z);
        if (p.stage === 'beam' && p.t > 2.2) { p.stage = 'carry'; p.t = 0; }
        if (p.stage === 'carry' && (Math.hypot(this.x - p.drop.x, this.z - p.drop.z) < 2 || p.t > 25)) { p.stage = 'lower'; p.t = 0; }
      } else {
        // Lowered gently into the fountain (or onto the street), then gone again.
        want.x = p.drop.x; want.z = p.drop.z; want.h = this.y - this.ground; want.v = 1;
        this.beam(a.x, a.y - 0.4, a.z);
        if (this.lower(a, dt, p.drop.y)) {
          this.stats.people++;
          this.giggle();
          this.say(a, p.drop.fountain ? this.rng.pick(['…Really? A fountain?', 'I\'m soaked!', 'Oh, come ON.']) : this.rng.pick(['…Was that necessary?', 'My legs are shaking.']), 'angry');
          this.prank = null;
        }
      }
    } else {
      const at = p.at;
      const sx = at.x + at.nx * 9, sz = at.z + at.nz * 9;
      if (p.stage === 'go') {
        want.x = sx; want.z = sz; want.h = at.y - this.ground; want.v = TEENS.vCarry;
        if (Math.hypot(this.x - sx, this.z - sz) < 2.5 && Math.abs(this.y - at.y) < 3) { p.stage = 'draw'; p.t = 0; this.zap(); g.wardens?.glyphs.add(at.x, at.y, at.z, at.nx, at.nz, this.rng.range(5, 7.5), this.rng.int(0, 1 << 20), TEEN_COLOURS[this.rng.int(0, TEEN_COLOURS.length - 1)], 5.5, 600); }
        if (p.t > 25) this.prank = null;
      } else {
        want.x = sx; want.z = sz; want.h = at.y - this.ground; want.v = 1;
        // The beam scribbles over the wall.
        const s = Math.sin(p.t * 9) * 2.2, c = Math.cos(p.t * 6.3) * 2;
        this.beam(at.x - at.nz * s, at.y + c, at.z + at.nx * s);
        if (p.t > 6) { this.stats.glyphs++; this.giggle(); this.prank = null; }
      }
    }
  }

  /** Lower a person to the ground (true when down). */
  private lower(a: PedAgent, dt: number, gy: number): boolean {
    a.vx = a.vy = a.vz = 0;
    a.y = Math.max(gy, a.y - dt * 2.5);
    if (a.y > gy + 0.05) return false;
    a.airborne = false;
    a.state = PState.Flee;
    a.fear = 0.6; a.fearX = this.x; a.fearZ = this.z; a.stateT = 0;
    return true;
  }

  private beam(x: number, y: number, z: number): void {
    this.beamTo = (this.beamTo ?? new THREE.Vector3()).set(x, y, z);
  }

  // ================================================================== the event

  update(dt: number): void {
    this.t += dt;
    if (!this.active) return;
    const g = this.g, P = g.player.pos;
    this.beamTo = null;
    this.coverT -= dt;
    if (this.coverT <= 0) { this.coverT = 0.25; this.cover = this.coverAt(this.x, this.z); this.ground = g.terrain.height(this.x, this.z); }
    // People set down after it let go of them.
    for (let i = this.lowering.length - 1; i >= 0; i--) if (this.lower(this.lowering[i], dt, g.terrain.height(this.lowering[i].x, this.lowering[i].z))) this.lowering.splice(i, 1);
    const want = { x: this.x, z: this.z, h: teenHeight(this.cover, this.podsOut), v: TEENS.vJoy };
    const dHero = Math.hypot(P.x - this.x, P.y - this.y, P.z - this.z), hHero = Math.hypot(P.x - this.x, P.z - this.z);
    switch (this.mode) {
      case 'joy': case 'flee': case 'prank': {
        // The hero coming at them (closing in): off they go; a hero just
        // standing about is only stared at. Right under them: pop up out of reach.
        const V = g.player.vel, closing = ((this.x - P.x) * V.x + (this.y - P.y) * V.y + (this.z - P.z) * V.z) / (dHero || 1);
        const chased = closing > 3;
        if (dHero < TEENS.fleeR && chased && !g.freeCam) { if (this.mode !== 'flee' || this.planT <= 0) this.flee(); this.fleeCalm = 0; }
        if (hHero < TEENS.dodgeR && P.y < this.y - 1 && this.dodgeT <= 0) { this.dodgeT = TEENS.dodgeT; this.stats.dodges++; }
        if (this.mode === 'flee') {
          this.planT -= dt;
          this.fleeCalm = dHero > TEENS.fleeR * 2 ? this.fleeCalm + dt : 0;
          if (this.fleeCalm > 5) this.joyride();
        }
        if (this.mode === 'prank' && this.prank) this.stepPrank(dt, want);
        else if (this.mode === 'prank') this.joyride();
        if (this.mode !== 'prank') {
          // Along the path.
          while (this.pi < this.path.length && Math.hypot(this.path[this.pi].x - this.x, this.path[this.pi].z - this.z) < 9) this.pi++;
          if (this.pi >= this.path.length) {
            if (this.mode === 'flee') this.flee();
            else if (!(this.rng.chance(0.7) && this.startPrank())) this.joyride();
          } else { const q = this.path[this.pi]; want.x = q.x; want.z = q.z; }
          want.v = this.mode === 'flee' ? TEENS.vFlee : TEENS.vJoy;
        }
        if (this.dodgeT > 0) { this.dodgeT -= dt; want.h += TEENS.dodgeH * smoothstep(0, 0.6, Math.min(this.dodgeT, TEENS.dodgeT - this.dodgeT + 0.6)); }
        this.fly(dt, want);
        this.watch(dt);
        // Time to go home, or nobody is watching any more.
        this.farT = hHero > TEENS.farR ? this.farT + dt : 0;
        if (this.farT > TEENS.farT) this.finish('abandoned');
        else if (this.t > this.maxT) this.goHome();
        break;
      }
      case 'held': this.stepHeld(dt); break;
      case 'lifted': this.stepLifted(dt); break;
      case 'home': {
        // Up and away, fast.
        this.vy = Math.min(30, this.vy + dt * 12);
        this.y += this.vy * dt; this.x += this.vx * dt; this.z += this.vz * dt;
        if (this.y - this.ground > 350) this.finish('retreated');
        break;
      }
      case 'gone': break;
    }
    this.wobble += ((this.podsOut * 0.35 + (this.mode === 'held' ? 0.6 : 0)) - this.wobble) * Math.min(1, dt * 2);
    this.beamK += ((this.beamTo ? 1 : 0) - this.beamK) * Math.min(1, dt * 6);
    if (this.mode !== 'gone') {
      this.mesh.update(dt, this.x, this.y, this.z, this.vx, this.vz, this.wobble, this.mode === 'flee' || this.mode === 'held', dHero < 60 ? P : null);
      this.mesh.setBeam(this.beamTo, this.beamK);
    }
    this.sound(dt, dHero);
    this.people(dt);
  }

  /** Arrival steering at (want.x, want.z), the height over the ground, never inside a building. */
  private fly(dt: number, want: { x: number; z: number; h: number; v: number }): void {
    const ACC = 16;
    const ex = want.x - this.x, ez = want.z - this.z, L = Math.hypot(ex, ez);
    const sp = Math.min(want.v, Math.sqrt(2 * ACC * 0.5 * L));
    const dvx = (L > 1e-3 ? (ex / L) * sp : 0) - this.vx, dvz = (L > 1e-3 ? (ez / L) * sp : 0) - this.vz;
    const dv = Math.hypot(dvx, dvz), k = Math.min(1, (ACC * dt) / Math.max(1e-6, dv));
    this.vx += dvx * k; this.vz += dvz * k;
    const wantY = this.ground + want.h;
    this.vy += clamp(clamp((wantY - this.y) * 1.5, -12, 12) - this.vy, -ACC * dt, ACC * dt);
    this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;
    // Never into a wall: over whatever is here (it pops up over a roof it clips).
    const top = this.g.world.groundHeight(this.x, this.z);
    if (this.y < top + 1.2) { this.y = top + 1.2; this.vy = Math.max(0, this.vy); }
  }

  /** The Wardens' eyes: the open sky (the station sees it) and their discs' cones. */
  private watch(dt: number): void {
    const g = this.g;
    // Joyriding on their own they slip across open stretches before anyone looks; once a pod is
    // out, or the hero has them on the run, a moment in the open gives them away.
    const pressed = this.podsOut > 0 || this.mode === 'flee';
    const open = this.t > TEENS.graceT && pressed && inOpen(this.y - this.ground, this.cover);
    // A disc's cone catches them only when they are flustered (hurt or on the run): calm, they
    // slip out of a sweeping cone before it settles. Herding them into one is the hero's job.
    let cone = false;
    const W = g.wardens;
    if (W && pressed) for (const d of W.discs.list) if (d.cone > 0.5 && d.task !== 'parent' && W.discs.inCone(d, this.x, this.y, this.z)) { cone = true; break; }
    if (open) this.stats.open += dt;
    if (cone) this.stats.cone += dt;
    this.seen = seeStep(this.seen, dt, open, cone);
    if (this.seen >= 1) this.caught();
  }

  // ================================================================== caught

  private caught(): void {
    const g = this.g, P = g.player.pos;
    this.dropCargo();
    this.mode = 'held';
    this.heldT = 0;
    this.vx = this.vz = this.vy = 0;
    // Credit: pods the hero knocked out, or the hero right there when it was seen.
    const byHero = this.podBy.filter((c) => c === 'player').length;
    const near = Math.hypot(P.x - this.x, P.z - this.z) < TEENS.creditR;
    const r = teenReward(byHero, near);
    this.stats.credit = r.credit ?? 'none';
    if (r.credit && g.mode === 'normal') {
      g.crime.reward({ karma: r.karma, why: r.credit === 'caught' ? 'handed the runaway saucer to the Nannies' : 'chased the runaway saucer into the open', rep: r.rep, news: 'runaway saucer caught', stopped: true });
    }
    if (r.credit) g.wardens?.handOver();
    g.city?.report('teens', this.x, this.z, r.credit ? 'hero' : 'stopped');
    this.told = true;
    // A parent disc drops on it from high up.
    const W = g.wardens;
    const d = W ? W.discs.spawn(this.x, this.z, this.x, this.z, 'above', false, Math.random) : null;
    if (d) {
      d.x = this.x; d.z = this.z; d.y = this.y + TEENS.parentFrom; d.vy = -35; d.vx = d.vz = 0;
      d.task = 'parent'; d.mode = 'courier'; d.low = true; d.r = 9;
      d.tx = this.x; d.tz = this.z; d.alt = this.y - this.ground + TEENS.parentOver;
    }
    this.parent = d;
    this.zap();
  }

  /** In the stasis field, the parent coming down over it. */
  private stepHeld(dt: number): void {
    this.heldT += dt;
    this.mesh.setField(Math.min(1, this.heldT * 2));
    const d = this.parent;
    if (!d || d.gone) { if (this.heldT > 8) this.finish('stopped'); return; }
    d.mode = 'courier'; d.tx = this.x; d.tz = this.z; d.alt = this.y - this.ground + TEENS.parentOver;
    const over = Math.hypot(d.x - this.x, d.z - this.z) < 4 && d.y - this.y < TEENS.parentOver + 8;
    if (over) {
      d.coneOn = true; d.lookT = 0; d.aimX = this.x; d.aimY = this.y - 2; d.aimZ = this.z;
      if (!this.toned) {
        this.toned = true;
        const cam = this.g.renderer.camera.position;
        this.g.audio.play('ufo_stern', this.x, this.y, this.z, 1, 1, 90, cam);
        this.heldT = 0;
      }
      this.mesh.setTether(d.y - d.r * 0.2, Math.min(1, this.heldT * 2));
      if (this.heldT > 1.2) { this.mode = 'lifted'; this.heldT = 0; }
    }
    if (this.heldT > 25) this.finish('stopped');
  }

  /** Up into the parent disc. */
  private stepLifted(dt: number): void {
    const d = this.parent;
    this.heldT += dt;
    this.mesh.setField(1);
    if (d && !d.gone) {
      d.coneOn = true; d.aimX = this.x; d.aimY = this.y - 2; d.aimZ = this.z;
      const top = d.y - d.r * 0.2;
      this.y += Math.min(top - this.y, dt * ((top - this.y) / TEENS.liftT + 1.5));
      this.x += (d.x - this.x) * Math.min(1, dt); this.z += (d.z - this.z) * Math.min(1, dt);
      this.mesh.root.scale.setScalar(clamp((top - this.y) / 6, 0.15, 1));
      this.mesh.setTether(top);
      if (top - this.y < 1.5) {
        this.g.wardens?.discs.leave(d);
        this.finish('stopped');
      }
    } else this.finish('stopped');
  }

  private goHome(): void {
    this.dropCargo();
    this.mode = 'home';
    const P = this.g.player.pos, a = Math.atan2(this.z - P.z, this.x - P.x);
    this.vx = Math.cos(a) * 25; this.vz = Math.sin(a) * 25;
    this.giggle();
    if (!this.told) { this.told = true; this.g.city?.report('teens', this.x, this.z, 'none'); }
  }

  private finish(outcome: ThreatOutcome): void {
    if (!this.active) return;
    this.active = false;
    this.outcome = outcome;
    this.mode = 'gone';
    this.dropCargo();
    for (const a of this.lowering.splice(0)) { a.airborne = false; a.y = this.g.terrain.height(a.x, a.z); a.state = PState.Flee; }
    this.mesh.root.visible = false;
    this.mesh.setBeam(null);
    this.mesh.setTether(null);
    if (this.parent && !this.parent.gone && this.parent.task === 'parent') this.g.wardens?.discs.leave(this.parent);
    this.whine?.stop();
    this.whine = null;
  }

  // ================================================================== being hit

  /** Pod i takes damage (points); knocked out when its hit points are gone. */
  hitPod(i: number, amount: number, cause: Cause): DamageResult {
    const zone = (this.actors[0] as SaucerActor).zones[i + 1];
    if (this.podHp[i] <= 0 || this.mode === 'held' || this.mode === 'lifted') return { dealt: 0, zone, weak: false };
    this.podHp[i] -= amount;
    this.vy += 3; this.wobble = Math.min(1.5, this.wobble + 0.4);
    if (this.podHp[i] <= 0) this.podOut(i, cause);
    return { dealt: amount, zone, weak: false };
  }

  private podOut(i: number, cause: Cause): void {
    const g = this.g;
    this.podBy[i] = cause;
    this.stats.pods++;
    this.mesh.podOut(i);
    // Sparks and a puff of smoke, a pop, a lurch; it lets go of what it holds.
    const p = this.mesh.podPos(i, _w), fx = g.elements.fx;
    for (let k = 0; k < 14; k++) fx.glow(p.x, p.y, p.z, this.rng.range(-5, 5), this.rng.range(-2, 6), this.rng.range(-5, 5), 0.5, 0.25, 0.05, SPARK_A, SPARK_B);
    for (let k = 0; k < 6; k++) fx.soft(p.x, p.y, p.z, this.rng.range(-1, 1), this.rng.range(0, 1.5), this.rng.range(-1, 1), 2.2, 0.8, 2.6, SMOKE_A, SMOKE_B, 0.6, 0.6, -0.2);
    g.audio.play('teen_pod', p.x, p.y, p.z, 1, 0.9 + this.rng.range(0, 0.2), 25, g.renderer.camera.position);
    this.vy += 6;
    this.dropCargo();
    if (cause === 'player' && g.mode === 'normal') g.progress.addKarma(TEENS.karma.pod, 'knocked out a hover pod of the runaway saucer');
    // Hit, they bolt for the nearest tall street.
    if (this.mode === 'prank' || this.mode === 'joy' || this.mode === 'flee') this.flee();
  }

  // ================================================================== sounds and people

  private zap(): void {
    this.g.audio.play('teen_zap', this.x, this.y, this.z, 0.9, 0.95 + Math.random() * 0.1, 18, this.g.renderer.camera.position);
  }

  private giggle(): void {
    this.g.audio.play('teen_giggle', this.x, this.y, this.z, 0.9, 0.95 + Math.random() * 0.15, 16, this.g.renderer.camera.position);
  }

  private sound(dt: number, d: number): void {
    const g = this.g;
    if (this.mode === 'gone') return;
    if (!this.whine) {
      this.whineTry -= dt;
      if (this.whineTry > 0) return;
      this.whineTry = 1;
      this.whine = g.audio.loop('teen_whine', 14);
      if (!this.whine) return;
    }
    const sp = Math.hypot(this.vx, this.vz);
    const gain = (1 - smoothstep(120, 320, d)) * (this.mode === 'held' || this.mode === 'lifted' ? 0.4 : 1);
    this.whine.set(this.x, this.y, this.z, gain, 0.9 + sp * 0.012 + this.podsOut * 0.06 + Math.sin(this.t * 3) * 0.03);
  }

  private say(a: PedAgent, line: string, tone?: 'angry' | 'cheer'): void {
    this.g.barks.say(a, line, 30, tone);
  }

  /** People stop to film it at its mischief, and say what they think (and laugh when it is caught). */
  private people(dt: number): void {
    const g = this.g;
    if (!g.peds || this.mode === 'gone') return;
    this.gawkT -= dt;
    if (this.gawkT <= 0) {
      this.gawkT = 2.5;
      if (this.mode === 'prank' || this.mode === 'held' || this.mode === 'lifted') g.stimuli.emit('threat', this.x, this.ground + 1, this.z, 1, 28, { cause: 'threat' });
      gawkTeens(g, this.x, this.y, this.z, this.mode === 'held' || this.mode === 'lifted' ? 70 : 40);
    }
    this.remarkT -= dt;
    if (this.remarkT > 0) return;
    const m: TeenMoment = this.mode === 'held' || this.mode === 'lifted' ? 'caught' : 'prank';
    this.remarkT = m === 'caught' ? 2 : this.rng.range(5, 10);
    const cam = g.renderer.camera.position;
    if (Math.hypot(cam.x - this.x, cam.z - this.z) > 140 || !g.people) return;
    const near = g.peds.neighbours(cam.x, cam.z, 22, []).filter((a) => a.alive && !a.actor && !a.inside && !a.airborne && a.state !== PState.Down);
    if (!near.length) return;
    const a = near[this.rng.int(0, near.length - 1)];
    const line = teenLine(m, g.people.person(a.cit).temper, a.cit.role === Role.Child, this.rng.float());
    if (line) this.say(a, line, m === 'caught' ? 'cheer' : undefined);
  }

  // ================================================================== ThreatEvent

  strength(): number { return this.active ? 1 - this.podsOut / 3 : 0; }
  targetsNear(_x: number, _z: number, _r: number): ThreatTarget[] { return []; }
  strike(_t: ThreatTarget, _jx: number, _jy: number, _jz: number, _cause: Cause): void { /* out of an officer's reach */ }
  shutdown(): void { if (this.active && this.mode !== 'held' && this.mode !== 'lifted') this.goHome(); }

  dispose(): void {
    this.finish(this.outcome ?? 'abandoned');
    this.mesh.dispose();
  }

  /** Dev: where it is, what it is up to. */
  snapshot(): Record<string, unknown> {
    const p = this.prank;
    return {
      id: this.id, archetype: this.archetype, t: +this.t.toFixed(1), active: this.active, outcome: this.outcome, mode: this.mode,
      x: Math.round(this.x), y: +(this.y - this.ground).toFixed(1), z: Math.round(this.z), cover: +this.cover.toFixed(1), seen: +this.seen.toFixed(2),
      podHp: this.podHp.map((h) => +Math.max(0, h).toFixed(2)), prank: p ? `${p.kind}:${p.stage}` : null, path: `${this.pi}/${this.path.length}`,
      parent: this.parent ? { y: Math.round(this.parent.y), gone: this.parent.gone } : null, ...this.stats,
    };
  }

  /** Dev: knock pod i out (as the hero). */
  devPod(i: number): void { if (this.podHp[i] > 0) this.hitPod(i, 99, 'player'); }
  /** Dev: start a prank of a kind now, if one can be found. */
  devPrank(kind?: 'car' | 'person' | 'glyph'): string {
    if (!this.active || (this.mode !== 'joy' && this.mode !== 'prank' && this.mode !== 'flee')) return `not now (${this.mode})`;
    for (let k = 0; k < 12; k++) { this.prank = null; if (this.startPrank() && (!kind || this.prank!.kind === kind)) return `${this.prank!.kind}`; }
    this.prank = null; this.joyride();
    return 'nothing found';
  }
  /** Dev: the Wardens see it now. */
  devCatch(): void { if (this.active && this.mode !== 'held' && this.mode !== 'lifted' && this.mode !== 'gone') this.caught(); }
}

/** People within r stop and look up at it (filming), at most a crowd. */
function gawkTeens(g: Game, x: number, y: number, z: number, r: number): void {
  for (const a of g.peds.neighbours(x, z, r, [])) {
    if (!a.alive || a.actor || a.inside || a.airborne || a.ragdoll) continue;
    a.lookX = x; a.lookY = y; a.lookZ = z;
    a.glance = Math.max(a.glance ?? 0, 2.5);
  }
}

const SPARK_A = new THREE.Color(2.2, 1.6, 0.6), SPARK_B = new THREE.Color(1.4, 0.4, 0.15);
const SMOKE_A = new THREE.Color(0.25, 0.25, 0.27), SMOKE_B = new THREE.Color(0.45, 0.45, 0.47);

/** The saucer as a body one can target and hit: the hull (it shrugs most of that off) and three pods. */
class SaucerActor implements ThreatActor {
  readonly name = 'Runaway saucer';
  readonly zones: ThreatZone[];
  readonly aggro = new Map<string, number>();
  readonly height = 2.4;
  /** Biggest dimension at full size: across the rim (shrink ray). */
  readonly size = SAUCER_R * 2;
  /** Shrink ray: size factor (1 = full). */
  private sc = 1;

  constructor(private ev: RunawayTeens) {
    const z = (id: string, name: string, armour: number, r: number): ThreatZone => ({ id, name, armour, weak: false, exposed: false, x: 0, y: 0, z: 0, r, recent: 0 });
    this.zones = [z('hull', 'Hull', 0.97, SAUCER_R * 0.75), z('pod0', 'Hover pod', 0, POD_R + 0.35), z('pod1', 'Hover pod', 0, POD_R + 0.35), z('pod2', 'Hover pod', 0, POD_R + 0.35)];
  }

  get hp(): number { return this.ev.podHp.reduce((s, h) => s + Math.max(0, h), 0); }
  get maxHp(): number { return TEENS.podHp * 3; }
  get defeated(): boolean { return false; }
  get targetable(): boolean { return this.ev.active && (this.ev.mode === 'joy' || this.ev.mode === 'flee' || this.ev.mode === 'prank'); }
  get x(): number { return this.ev.x; }
  get y(): number { return this.ev.y - 1; }
  get z(): number { return this.ev.z; }

  /** Shrink ray: the body (hull, dome, pods) scales; the hit zones follow. */
  setScale(s: number): void {
    this.sc = s;
    this.ev.mesh.body.scale.setScalar(s);
  }

  /** Zones where they are now. */
  private place(): void {
    const e = this.ev, h = this.zones[0];
    h.x = e.x; h.y = e.y; h.z = e.z;
    h.r = SAUCER_R * 0.75 * this.sc;
    for (let i = 0; i < 3; i++) {
      const p = e.mesh.podPos(i, _v), zn = this.zones[i + 1];
      zn.x = p.x; zn.y = p.y; zn.z = p.z;
      zn.r = (POD_R + 0.35) * this.sc;
      zn.exposed = e.podHp[i] > 0;
    }
  }

  ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): { t: number; zone: ThreatZone } | null {
    this.place();
    let best: { t: number; zone: ThreatZone } | null = null;
    for (const zn of this.zones) {
      if (zn.id !== 'hull' && !zn.exposed) continue;
      // A flattened sphere for the hull, spheres for the pods.
      const sy = zn.id === 'hull' ? 3 : 1;
      const px = ox - zn.x, py = (oy - zn.y) * sy, pz = oz - zn.z, ddy = dy * sy;
      const a = dx * dx + ddy * ddy + dz * dz, b = px * dx + py * ddy + pz * dz, c = px * px + py * py + pz * pz - zn.r * zn.r;
      const disc = b * b - a * c;
      if (disc < 0) continue;
      const t = (-b - Math.sqrt(disc)) / a;
      if (t < 0 || t > maxT) continue;
      // A pod in front of the hull wins (it hangs below the rim).
      const tt = zn.id === 'hull' ? t + 0.4 : t;
      if (!best || tt < best.t) best = { t: tt, zone: zn };
    }
    return best;
  }

  zoneAt(x: number, y: number, z: number): { zone: ThreatZone; d: number } | null {
    this.place();
    let best: { zone: ThreatZone; d: number } | null = null;
    for (const zn of this.zones) {
      if (zn.id !== 'hull' && !zn.exposed) continue;
      const sy = zn.id === 'hull' ? 3 : 1;
      const d = Math.hypot(x - zn.x, (y - zn.y) * sy, z - zn.z) - zn.r;
      if (!best || d < best.d - (zn.id === 'hull' ? 0 : 0.6)) best = { zone: zn, d };
    }
    return best;
  }

  damage(zone: ThreatZone | string | null, amount: number, src: DamageSource): DamageResult {
    const e = this.ev;
    let zn = typeof zone === 'string' ? this.zones.find((z) => z.id === zone) ?? null : zone;
    if (!zn) zn = (src.x !== undefined ? this.zoneAt(src.x, src.y ?? e.y, src.z ?? e.z)?.zone : null) ?? this.zones[0];
    if (zn.id === 'hull') {
      // The hull shrugs it off; half of a heavy hit shakes the pod nearest where it came from.
      this.place();
      let bi = -1, bd = Infinity;
      for (let i = 0; i < 3; i++) {
        if (e.podHp[i] <= 0) continue;
        const p = this.zones[i + 1], d = Math.hypot((src.x ?? e.x) - p.x, (src.y ?? e.y) - p.y, (src.z ?? e.z) - p.z);
        if (d < bd) { bd = d; bi = i; }
      }
      e.vy += Math.min(4, amount * 2);
      if (bi < 0) return { dealt: 0, zone: zn, weak: false };
      const r = e.hitPod(bi, amount * 0.5, src.cause);
      return { dealt: r.dealt, zone: zn, weak: false };
    }
    const i = Number(zn.id.slice(3));
    zn.recent += amount;
    return e.hitPod(i, amount, src.cause);
  }

  blow(x: number, y: number, z: number, r: number, jx: number, jy: number, jz: number, src: DamageSource): DamageResult | null {
    if (!this.targetable) return null;
    const n = this.zoneAt(x, y, z);
    if (!n || n.d > r + 0.5) return null;
    const J = Math.hypot(jx, jy, jz);
    // A real knock shoves it too.
    this.ev.vx += (jx / 2500); this.ev.vz += (jz / 2500);
    return this.damage(n.zone, J * DAMAGE_PER_IMPULSE, { ...src, x: src.x ?? x, y: src.y ?? y, z: src.z ?? z });
  }

  conStrength(): number { return 3; }
}
