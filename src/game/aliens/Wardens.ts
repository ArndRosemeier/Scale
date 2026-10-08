/**
 * The Wardens ("the Nannies"), ALIENS_PLAN phase 1: the established aliens in the sky over the
 * city. They never meddle in human affairs; they watch.
 *
 *  - The station hangs in the same part of the sky all the time (Station).
 *  - Discs cross the sky; how many is random and never explained (wardenRules: a handful, some
 *    stretches none, now and then a swarm of a hundred or more, then nothing). Some come down to
 *    hang over a street and sweep a scan cone over it; two or three gather high over an incident
 *    and watch it to the end; one may hang over a landmark for hours; a hero doing something
 *    spectacular gets a cone turned on them for a moment (Discs).
 *  - Walkers are set down on squares by a disc's beam, stand there for a while, and are lifted
 *    away again (Walker).
 *  - People look up, stop to film a walker and keep their distance from it, and say what they
 *    think of the Nannies; the news has the swarms, the walkers and the long stares; the talk menu
 *    has lines about them.
 *  - Sounds: a low chord at the nearest disc, a soft rising tone when a cone comes on.
 *  - Phase 2: the runaway teens (RunawayTeens, an event on the threat clock) draw glowing glyphs on
 *    facades (Glyphs, kept here); their omens are a saucer zipping past low and a fresh glyph. A
 *    disc never watches their incident from above (the Nannies do not know), but the discs hang
 *    and scan more often round it. Handing the saucer over adds to the Wardens' quiet regard.
 *
 * The schedule follows from the seed and the game clock; only the regard is saved (per city).
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import { PState, type PedAgent } from '../../sim/Pedestrians';
import { Role } from '../../sim/Population';
import { Rng, deriveSeed } from '../../core/rng';
import { doorOf } from '../../sim/Population';
import { smoothstep } from '../../core/math';
import { glanceAt, gawkAt } from '../../future/attention';
import { groundBlocked, interiorPoint } from '../abilities/cores';
import type { Obstacle } from '../../world/Collision';
import { Station } from './Station';
import { Discs, SKY_R, type Disc } from './Discs';
import { Walker, WALKER_H, DROP_H } from './Walker';
import { WARDENS, discPlan, walkerVisit, stareVisit, nannyLine, type DiscPlan, type NannyMoment } from './wardenRules';
import { Glyphs, TEEN_COLOURS } from './Glyphs';
import { TeenSaucer } from './TeenSaucer';
import { RunawayTeens } from './RunawayTeens';
import { freshRegard, handOver, readRegard, type Regard } from './teenRules';

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const rnd = () => Math.random();

/** A disc's courier height over a square while it lowers or lifts a walker (m above the ground). */
const COURIER_ALT = DROP_H + WALKER_H + 4;
/** Radius people keep from a walker (m). */
const WALKER_RING = 2.4;

interface Visit {
  w: Walker;
  courier: Disc | null;
  /** The visit is ending: the courier comes to lift it away. */
  leaving: boolean;
  told: boolean;
}

export class Wardens {
  readonly station: Station;
  readonly discs: Discs;
  readonly group = new THREE.Group();
  /** The runaway teens' glyphs on the facades. */
  readonly glyphs = new Glyphs();
  /** The Wardens' quiet count of the problems the hero handed them (saved per city). */
  regard: Regard = freshRegard();
  /** A saucer zipping past (an omen of the runaway teens). */
  private flybys: { s: TeenSaucer; pts: { x: number; y: number; z: number }[]; t: number; dur: number }[] = [];
  private plan: DiscPlan = { count: 0, swarm: null, slot: -1 };
  private filled = false;
  private spawnT = 0;
  private leaveT = 0;
  private hoverT = 5;
  private lookCd = 20;
  private visits: Visit[] = [];
  /** Walker visits already played or skipped (by start hour). */
  private handled = new Set<number>();
  private stareKey = -1;
  private remarkT = 6;
  private gawkT = 4;
  private glanceT = 0;
  private momentNow: NannyMoment | null = null;
  private hum: ReturnType<Game['audio']['loop']> = null;
  private humTry = 0;
  private lastSwarm = -1;
  private devDone = false;
  /** Dev: a forced number of discs (null: the schedule), a forced swarm. */
  private force: number | null = null;
  private forceSwarm = false;
  stats = { spawned: 0, left: 0, hovers: 0, looks: 0, watches: 0, walkers: 0, remarks: 0, scans: 0, stares: 0 };

  constructor(private g: Game) {
    this.station = new Station(g.settings.seed);
    this.discs = new Discs({
      ground: (x, z) => g.terrain.height(x, z),
      top: (x, z) => g.world.groundHeight(x, z),
    });
    this.discs.onScan = (d) => this.scanned(d);
    this.group.add(this.station.group, this.discs.group, this.glyphs.group);
    g.renderer.scene.add(this.group);
    try { this.regard = readRegard(JSON.parse(localStorage.getItem(this.key()) ?? 'null')); } catch { /* storage unavailable */ }
    // The walkers: solid for the hero, a ring people keep clear of.
    g.collision.obstacleProviders.push((x0, z0, x1, z1, out) => this.obstacles(x0, z0, x1, z1, out));
  }

  /** A walker (staged by the warm-up so its materials are compiled before it first comes down). */
  static warmupObject(): THREE.Object3D {
    const o = new THREE.Group();
    o.add(new Walker(0, 0, 0, 1, 0).root, new TeenSaucer().root);
    return o;
  }

  update(dt: number): void {
    const g = this.g, cam = g.renderer.camera;
    if (!this.devDone) this.installDev();
    const now = g.sky.hoursAbs;
    const fx = cam.position.x, fz = cam.position.z;
    this.station.update(dt, cam, g.sky);
    this.plan = discPlan(g.settings.seed, now);
    if (this.forceSwarm && !this.plan.swarm) this.plan = { count: 120, swarm: { start: now, end: now + 1 }, slot: this.plan.slot };
    if (this.force !== null) this.plan = { ...this.plan, count: this.force };
    this.news(now);
    this.population(dt, fx, fz);
    this.tasks(dt, now, fx, fz);
    this.hovers(dt, fx, fz);
    this.lookAtHero(dt);
    this.discs.update(dt, fx, fz, rnd);
    this.walkers(dt, now);
    this.people(dt);
    this.sound(dt);
    this.updateFlybys(dt);
    const day = smoothstep(-0.12, 0.15, g.sky.sunDir.y);
    this.glyphs.update(dt, 1 - day);
    // Underground nothing of the sky shows (the station hides itself).
    this.discs.group.visible = g.sky.underground < 0.5;
    this.discs.draw(day, cam.position);
  }

  // ================================================================== how many

  /** Keep the number of free discs at the schedule's: new ones fly in (a swarm fast), spare ones leave. */
  private population(dt: number, fx: number, fz: number): void {
    const N = this.plan.count, swarm = !!this.plan.swarm;
    const free = this.discs.free();
    if (!this.filled) {
      // The first look at the sky: they are already about.
      this.filled = true;
      for (let i = free.length; i < N; i++) this.add(fx, fz, 'mid', swarm);
      return;
    }
    if (free.length < N) {
      this.spawnT -= dt;
      if (this.spawnT <= 0) {
        this.spawnT = swarm ? rand(0.15, 0.5) : rand(4, 14);
        this.add(fx, fz, Math.random() < (swarm ? 0.55 : 0.35) ? 'above' : 'edge', swarm);
      }
    } else if (free.length > N) {
      this.leaveT -= dt;
      if (this.leaveT <= 0) {
        // The farthest goes (a swarm thins out quickly once it is over); swarm members first.
        this.leaveT = N === 0 && free.length > 8 ? rand(0.2, 0.6) : rand(2, 6);
        let best: Disc | null = null, bs = -1;
        for (const d of free) {
          const s = Math.hypot(d.x - fx, d.z - fz) + (d.swarm !== swarm ? 5000 : 0);
          if (s > bs) { bs = s; best = d; }
        }
        if (best) { this.discs.leave(best); this.stats.left++; }
      }
    } else this.spawnT = Math.max(this.spawnT, 1);
  }

  private add(fx: number, fz: number, from: 'edge' | 'above' | 'mid', swarm: boolean): Disc | null {
    // Most cross near the hero, so the sky has them where one looks.
    const a = rnd() * Math.PI * 2, rr = Math.random() < 0.6 ? rand(80, 700) : rand(300, SKY_R * 0.8);
    const tx = fx + Math.cos(a) * rr, tz = fz + Math.sin(a) * rr;
    let d: Disc | null;
    if (from === 'mid') {
      d = this.discs.spawn(fx, fz, tx, tz, 'edge', swarm, rnd);
      if (d) {
        const b = rnd() * Math.PI * 2, r2 = rand(200, SKY_R * 0.85);
        d.x = fx + Math.cos(b) * r2; d.z = fz + Math.sin(b) * r2;
        d.y = this.g.terrain.height(d.x, d.z) + d.alt;
      }
    } else d = this.discs.spawn(fx, fz, tx, tz, from, swarm, rnd);
    if (d) this.stats.spawned++;
    return d;
  }

  // ================================================================== watching

  /** Discs kept by a task: over incidents (watching to the end), over a landmark (a long stare). */
  private tasks(dt: number, now: number, fx: number, fz: number): void {
    const g = this.g;
    const want = new Map<string, { x: number; z: number; n: number }>();
    for (const inc of g.response?.incidents ?? []) {
      // (The runaway teens: the Nannies do not know about them.)
      if (inc.closed || inc.level < 1 || inc.ev.archetype === 'teens') continue;
      const n = WARDENS.watchers[Math.min(inc.level, WARDENS.watchers.length - 1)];
      if (n > 0 && Math.hypot(inc.ev.x - fx, inc.ev.z - fz) < SKY_R * 0.85) want.set(`i${inc.ev.id}`, { x: inc.ev.x, z: inc.ev.z, n });
    }
    // A long stare at a landmark (seeded per day).
    const st = stareVisit(g.settings.seed, Math.floor(now / 24));
    const lms = g.macro.landmarks.filter((l) => l.cell >= 0);
    if (st && now >= st.start && now < st.end && lms.length) {
      const lm = lms[st.pick % lms.length];
      if (Math.hypot(lm.x - fx, lm.z - fz) < SKY_R * 0.85) want.set('stare', { x: lm.x, z: lm.z, n: 1 });
      if (this.stareKey !== st.start) {
        this.stareKey = st.start;
        this.stats.stares++;
        if (g.city && Math.hypot(lm.x - g.player.pos.x, lm.z - g.player.pos.z) < 3000) g.city.report('stare', lm.x, lm.z);
      }
    }
    // Release discs whose task is over.
    for (const d of this.discs.list) {
      if (!d.task || d.task.startsWith('courier') || d.task === 'parent') continue;
      const key = d.task.split('#')[0];
      const w = want.get(key);
      if (!w || Number(d.task.split('#')[1]) >= w.n) { d.task = null; d.mode = 'cruise'; d.coneOn = false; d.alt = 260 + rnd() * 170; }
    }
    // Fill the tasks: a free disc nearby goes, or one comes down from above.
    const t = this.g.sky.hoursAbs * 3600 * 0.0004;
    for (const [key, w] of want) {
      for (let k = 0; k < w.n; k++) {
        const tag = `${key}#${k}`;
        let d = this.discs.list.find((q) => q.task === tag) ?? null;
        if (!d) {
          d = this.discs.free().sort((p, q) => Math.hypot(p.x - w.x, p.z - w.z) - Math.hypot(q.x - w.x, q.z - w.z))[0] ?? null;
          if (d && Math.hypot(d.x - w.x, d.z - w.z) > 1500) d = null;
          d ??= this.discs.spawn(fx, fz, w.x, w.z, 'above', false, rnd);
          if (!d) continue;
          d.task = tag;
          d.coneOn = false;
          if (key !== 'stare') this.stats.watches++;
        }
        if (key === 'stare') {
          d.mode = 'stare';
          d.tx = w.x; d.tz = w.z;
          d.alt = 140;
          // Its cone comes and goes over the hours.
          if (Math.random() < dt / 40) { d.coneOn = !d.coneOn; d.cx = w.x; d.cz = w.z; d.cr = 30; if (d.coneOn) this.scanned(d); }
        } else {
          // High over it in a loose ring that turns slowly; no cone, no help.
          d.mode = 'watch';
          const a = (k / w.n) * Math.PI * 2 + t;
          d.tx = w.x + Math.cos(a) * 95; d.tz = w.z + Math.sin(a) * 95;
          d.alt = 270 + k * 30;
        }
      }
    }
  }

  /** Now and then a free disc comes down to hang over a street and scan it. */
  private hovers(dt: number, fx: number, fz: number): void {
    this.hoverT -= dt;
    if (this.hoverT > 0) return;
    const swarm = !!this.plan.swarm;
    // Runaway teens about: the discs sense something and hang and scan round there more often.
    const teens = this.teens();
    this.hoverT = swarm ? rand(2, 6) : teens ? rand(5, 12) : rand(12, 35);
    const busy = this.discs.list.filter((d) => d.mode === 'hover').length;
    if (busy >= (swarm ? 12 : teens ? 3 : 2)) return;
    let cands = this.discs.free().filter((d) => d.mode === 'cruise' && Math.hypot(d.x - fx, d.z - fz) < 1300);
    // (None near the teens: one comes down from above.)
    if (teens && !cands.length) { const n = this.add(teens.x, teens.z, 'above', false); if (n) cands = [n]; }
    if (!cands.length) return;
    const d = cands[Math.floor(rnd() * cands.length)];
    // Where it is heading, a little ahead; over the street rather than on the hero's head.
    let x = d.x + d.vx * 10, z = d.z + d.vz * 10;
    if (teens) { const a = rnd() * Math.PI * 2, r = rand(60, 220); x = teens.x + Math.cos(a) * r; z = teens.z + Math.sin(a) * r; }
    if (Math.hypot(x - fx, z - fz) < 60) { x += 120; z += 60; }
    this.discs.hover(d, x, z, rand(25, 80), rand(110, 200), rnd);
    this.stats.hovers++;
  }

  /** A hero doing something spectacular (high in the air, giant-sized) gets a cone turned on them for a moment. */
  private lookAtHero(dt: number): void {
    const g = this.g, P = g.player;
    this.lookCd -= dt;
    if (this.lookCd > 0 || g.freeCam || g.intro?.active) return;
    const high = P.flying && P.pos.y - g.terrain.height(P.pos.x, P.pos.z) > 70;
    if (!high && P.height < 18) return;
    let best: Disc | null = null, bd = 750;
    for (const d of this.discs.list) {
      if (d.mode === 'leave' || d.mode === 'courier' || d.mode === 'stare') continue;
      const dd = Math.hypot(d.x - P.pos.x, d.y - P.pos.y, d.z - P.pos.z);
      if (dd < bd) { bd = dd; best = d; }
    }
    if (!best) { this.lookCd = 8; return; }
    this.lookCd = rand(40, 80);
    this.discs.look(best, P.pos.x, P.pos.y + P.height * 0.5, P.pos.z, rand(3.5, 5));
    this.stats.looks++;
  }

  private scanned(d: Disc): void {
    this.stats.scans++;
    const cam = this.g.renderer.camera.position;
    if (Math.hypot(d.x - cam.x, d.y - cam.y, d.z - cam.z) < 700) this.g.audio.play('ufo_scan', d.x, d.y, d.z, 0.9, 0.9 + Math.random() * 0.2, 60, cam);
  }

  // ================================================================== walkers

  private walkers(dt: number, now: number): void {
    const g = this.g, P = g.player.pos;
    // A visit due this hour (or one that began last hour and is still on).
    for (const h of [Math.floor(now) - 1, Math.floor(now)]) {
      const v = walkerVisit(g.settings.seed, h);
      if (!v || this.handled.has(v.start) || now < v.start || now >= v.end) continue;
      this.handled.add(v.start);
      if (this.visits.length < 2 && !g.freeCam && !g.intro?.active) this.startVisit(v.seed, v.end);
    }
    for (let i = this.visits.length - 1; i >= 0; i--) {
      const vi = this.visits[i], w = vi.w;
      const far = Math.hypot(w.x - P.x, w.z - P.z) > 800;
      // Out of sight and done: just gone.
      if (far && (now >= w.until || w.phase === 'wait')) { this.endVisit(i); continue; }
      if (!vi.leaving && now >= w.until && w.grounded) { vi.leaving = true; vi.courier = null; }
      // The courier: comes down over the square, beams, rises again.
      if ((w.phase === 'wait' || vi.leaving) && !vi.courier) {
        vi.courier = this.discs.spawn(g.renderer.camera.position.x, g.renderer.camera.position.z, w.x, w.z, 'above', false, rnd);
        if (vi.courier) vi.courier.task = 'courier';
      }
      const c = vi.courier;
      if (c) {
        c.mode = 'courier'; c.tx = w.homeX; c.tz = w.homeZ; c.alt = COURIER_ALT;
        if (vi.leaving) { c.tx = w.x; c.tz = w.z; }
        // (It may hang higher than it wants over a tall neighbour: the beam is just longer.)
        const over = Math.hypot(c.x - c.tx, c.z - c.tz) < 5 && c.y - (w.y + COURIER_ALT) > -6 && Math.abs(c.vy) < 1.5;
        if (over) {
          w.ceiling = Math.max(DROP_H, c.y - c.r * 0.2 - w.y - WALKER_H - 1);
          c.coneOn = true;
          c.aimX = w.x; c.aimY = w.y; c.aimZ = w.z;
          c.lookT = 0;
          if (w.phase === 'wait') { w.phase = 'descend'; w.lift = w.ceiling; this.scanned(c); }
          if (vi.leaving && w.grounded) { w.phase = 'ascend'; this.scanned(c); }
        }
        // Set down: the disc goes on its way. Lifted away: it leaves with it.
        if (w.phase === 'stand' && !vi.leaving) { c.coneOn = false; c.task = null; c.mode = 'cruise'; c.alt = 280; vi.courier = null; }
        if (w.phase === 'gone') { this.discs.leave(c); this.endVisit(i); continue; }
        if (c.gone) vi.courier = null;
      }
      w.update(dt, P.x, P.y, P.z);
      if (w.grounded && !vi.told && Math.hypot(w.x - P.x, w.z - P.z) < 400) {
        vi.told = true;
        g.city?.report('walker', w.x, w.z);
      }
    }
    // People keep clear of a walker standing on the square.
    g.peds.extraObstacles = this.visits.filter((v) => v.w.grounded || v.w.lift < 3).map((v) => ({ x: v.w.x, z: v.w.z, r: WALKER_RING }));
  }

  /** Find a square or a park near the hero (not on top of them), clear of everything, and start a visit there. */
  private startVisit(seed: number, until: number): boolean {
    const g = this.g, P = g.player.pos;
    if (g.underground.isUnder(P.x, P.y + 0.5, P.z)) return false;
    const r = new Rng(deriveSeed(seed, 'spot'));
    const cells = [...g.streamer.cells.values()].filter((c) => c.plan && (c.plan.plazas.length || c.plan.parks.length));
    r.shuffle(cells);
    for (const c of cells) {
      const plan = c.plan!;
      for (const sh of [...plan.plazas, ...plan.parks]) {
        if (sh.outer.length < 6) continue;
        const blocked = (x: number, z: number) => {
          for (let k = 0; k < 5; k++) {
            const a = (k / 4) * Math.PI * 2, rr = k === 4 ? 0 : 3;
            if (groundBlocked(plan, g.terrain, x + Math.cos(a) * rr, z + Math.sin(a) * rr)) return true;
          }
          return g.world.groundHeight(x, z) > g.terrain.height(x, z) + 0.6;
        };
        const pt = interiorPoint(sh.outer, sh.holes, r, blocked);
        if (!pt) continue;
        const d = Math.hypot(pt[0] - P.x, pt[1] - P.z);
        if (d < 60 || d > 340) continue;
        const y = g.world.groundHeight(pt[0], pt[1]);
        const w = new Walker(pt[0], y, pt[1], seed, until);
        this.group.add(w.root);
        this.visits.push({ w, courier: null, leaving: false, told: false });
        this.stats.walkers++;
        return true;
      }
    }
    return false;
  }

  private endVisit(i: number): void {
    const vi = this.visits[i];
    if (vi.courier && !vi.courier.gone) this.discs.leave(vi.courier);
    vi.w.dispose();
    this.visits.splice(i, 1);
  }

  private obstacles(x0: number, z0: number, x1: number, z1: number, out: (o: Obstacle) => void): void {
    for (const v of this.visits) {
      const w = v.w;
      if (!w.grounded || w.x < x0 - 1 || w.x > x1 + 1 || w.z < z0 - 1 || w.z > z1 + 1) continue;
      out({ cyl: true, x: w.x, z: w.z, r: 0.45, hx: 0, hz: 0, ux: 1, uz: 0, y0: w.y, y1: w.y + WALKER_H });
    }
  }

  // ================================================================== the runaway teens

  /** The runaway saucer out on its joyride now, if any. */
  teens(): RunawayTeens | null {
    for (const e of this.g.threats?.events ?? []) if (e instanceof RunawayTeens && e.active && e.mode !== 'held' && e.mode !== 'lifted') return e;
    return null;
  }

  /** The running (or latest) runaway saucer (dev). */
  private latestTeens(): RunawayTeens | null {
    const ev = this.g.threats?.events ?? [];
    for (let i = ev.length - 1; i >= 0; i--) if (ev[i] instanceof RunawayTeens) return ev[i] as RunawayTeens;
    return null;
  }

  private key(): string { return `scale.wardens.v1.${this.g.mode}.${this.g.settings.seed}.${this.g.settings.size.toFixed(2)}`; }

  /** The hero handed the Wardens one of their problems. */
  handOver(): void {
    this.regard = handOver(this.regard);
    try { localStorage.setItem(this.key(), JSON.stringify(this.regard)); } catch { /* storage unavailable */ }
  }

  save(): Regard { return { ...this.regard }; }

  restore(raw: unknown): void {
    this.regard = raw ? readRegard(raw) : freshRegard();
    try { localStorage.setItem(this.key(), JSON.stringify(this.regard)); } catch { /* storage unavailable */ }
  }

  /**
   * An omen of the runaway teens near the hero: 'zip' — a scuffed little saucer streaks past low
   * along the street and is gone; 'glyph' — a fresh glowing glyph on a facade nearby. False when
   * there is nothing to show it on.
   */
  teenOmen(kind: string, rng: Rng): boolean {
    const g = this.g, P = g.player.pos;
    if (kind === 'glyph') {
      const cands: { x: number; y: number; z: number; nx: number; nz: number }[] = [];
      for (const b of g.world.buildingsIn(P.x - 110, P.z - 110, P.x + 110, P.z + 110)) {
        if (!b.alive || b.top - b.base < 10) continue;
        const d = doorOf(b.desc), dist = Math.hypot(d.x - P.x, d.z - P.z);
        if (dist < 25 || dist > 110 || g.world.buildingAt(d.x + d.nx * 8, d.z + d.nz * 8)) continue;
        // Facing the hero, roughly.
        if ((P.x - d.x) * d.nx + (P.z - d.z) * d.nz < 0) continue;
        cands.push({ x: d.x - d.nx * 0.8, y: b.base + Math.min(b.top - b.base - 3, 7), z: d.z - d.nz * 0.8, nx: d.nx, nz: d.nz });
      }
      if (!cands.length) return false;
      const c = cands[rng.int(0, cands.length - 1)];
      this.glyphs.add(c.x, c.y, c.z, c.nx, c.nz, rng.range(5, 7), rng.int(0, 1 << 20), TEEN_COLOURS[rng.int(0, TEEN_COLOURS.length - 1)], 0.6, 900);
      return true;
    }
    // A low streak along the nearest street, past the hero.
    const ne = g.net.nearestEdge(P.x, P.z, 60);
    if (!ne || g.underground.isUnder(P.x, P.y + 0.5, P.z)) return false;
    const e = g.net.edges[ne.e], o = { x: 0, z: 0, dx: 0, dz: 0 };
    g.net.pointAt(e, ne.s, 0, o);
    const dir = rng.chance(0.5) ? 1 : -1, pts: { x: number; y: number; z: number }[] = [];
    for (let k = -6; k <= 6; k++) {
      const x = o.x + o.dx * k * 20 * dir, z = o.z + o.dz * k * 20 * dir;
      pts.push({ x, y: g.terrain.height(x, z) + 9 + Math.sin(k * 0.7) * 2, z });
    }
    const s = new TeenSaucer();
    this.group.add(s.root);
    this.flybys.push({ s, pts, t: 0, dur: 4.5 });
    g.audio.play('teen_giggle', o.x, pts[6].y, o.z, 0.7, 1.1, 20, g.renderer.camera.position);
    g.audio.play('teen_zap', o.x, pts[6].y, o.z, 0.5, 1.3, 20, g.renderer.camera.position);
    glanceAt(g.peds, o.x, pts[6].y, o.z, 50, 0.8, 77);
    return true;
  }

  private updateFlybys(dt: number): void {
    for (let i = this.flybys.length - 1; i >= 0; i--) {
      const f = this.flybys[i];
      f.t += dt;
      const u = Math.min(1, f.t / f.dur) * (f.pts.length - 1), k = Math.min(f.pts.length - 2, Math.floor(u)), w = u - k;
      const a = f.pts[k], b = f.pts[k + 1];
      const x = a.x + (b.x - a.x) * w, y = a.y + (b.y - a.y) * w, z = a.z + (b.z - a.z) * w;
      const v = (f.pts.length - 1) / f.dur * 20;
      f.s.update(dt, x, y, z, ((b.x - a.x) / 20) * v, ((b.z - a.z) / 20) * v, 0.2, true, null);
      if (f.t >= f.dur) { f.s.dispose(); this.flybys.splice(i, 1); }
    }
  }

  // ================================================================== people

  /** What there is to talk about near a point: a swarm, a walker, a disc hanging or scanning, or null. */
  momentAt(x: number, z: number): NannyMoment | null {
    if (this.plan.swarm && this.discs.list.length > 30) return 'swarm';
    if (this.visits.some((v) => v.w.grounded && Math.hypot(v.w.x - x, v.w.z - z) < 45)) return 'walker';
    for (const d of this.discs.list) {
      if ((d.cone > 0.2 || d.mode === 'watch' || d.mode === 'stare') && Math.hypot(d.x - x, d.z - z) < 600) return 'disc';
    }
    return this.discs.list.some((d) => Math.hypot(d.x - x, d.z - z) < 900) ? 'sky' : null;
  }

  /** People look up at a scanning disc, gather round a walker to film it, and say what they think. */
  private people(dt: number): void {
    const g = this.g, cam = g.renderer.camera.position;
    if (!g.peds) return;
    // Glances up at a cone sweeping their street.
    this.glanceT -= dt;
    if (this.glanceT <= 0) {
      this.glanceT = 0.5;
      for (const d of this.discs.list) {
        if (d.cone < 0.5 || Math.hypot(d.aimX - cam.x, d.aimZ - cam.z) > 250) continue;
        glanceAt(g.peds, d.x, d.y, d.z, 60, 0.45, d.id + Math.floor(g.sky.hoursAbs * 60));
      }
    }
    this.gawkT -= dt;
    if (this.gawkT <= 0) {
      this.gawkT = rand(6, 12);
      for (const v of this.visits) {
        const w = v.w;
        if (w.phase === 'descend' || w.phase === 'ascend') gawkAt(g.peds, w.x, w.y + w.lift + 2, w.z, 40, 0.9);
        else if (w.grounded && Math.hypot(w.x - cam.x, w.z - cam.z) < 120) gawkAt(g.peds, w.x, w.y + WALKER_H - 0.4, w.z, 22, 0.45);
      }
    }
    // A word about them now and then (the more going on, the more often).
    this.remarkT -= dt;
    if (this.remarkT > 0) return;
    const m = this.momentAt(cam.x, cam.z);
    this.momentNow = m;
    this.remarkT = m === 'swarm' || m === 'walker' ? rand(7, 14) : m === 'disc' ? rand(10, 20) : rand(60, 120);
    if (!m || !g.people || g.map?.open) return;
    const near: PedAgent[] = [];
    for (const a of g.peds.neighbours(cam.x, cam.z, 16, [])) {
      if (a.actor || a.inside || !a.alive || (a.state !== PState.Walk && a.state !== PState.Idle && a.state !== PState.Wait && a.state !== PState.Gawk && a.state !== PState.Film)) continue;
      near.push(a);
    }
    if (!near.length) return;
    const a = near[Math.floor(rnd() * near.length)];
    const p = g.people.person(a.cit);
    const line = nannyLine(m, p.temper, a.cit.role === Role.Child, rnd());
    if (line && g.barks.say(a, line, 30)) this.stats.remarks++;
  }

  // ================================================================== news and sound

  private news(now: number): void {
    const sw = this.plan.swarm;
    if (!sw || sw.start === this.lastSwarm) return;
    this.lastSwarm = sw.start;
    // (Told once, when it begins or when one is found going on.)
    if (now - sw.start < 2 && this.g.city) this.g.city.report('swarm', this.g.player.pos.x, this.g.player.pos.z);
  }

  /** The low chord at the nearest disc. */
  private sound(dt: number): void {
    const g = this.g, cam = g.renderer.camera.position;
    let best: Disc | null = null, bd = 520;
    for (const d of this.discs.list) {
      const dd = Math.hypot(d.x - cam.x, d.y - cam.y, d.z - cam.z);
      if (dd < bd) { bd = dd; best = d; }
    }
    if (!best || g.sky.underground > 0.5) {
      if (this.hum) this.hum.set(cam.x, cam.y + 100, cam.z, 0);
      return;
    }
    if (!this.hum) {
      this.humTry -= dt;
      if (this.humTry > 0) return;
      this.humTry = 2;
      this.hum = g.audio.loop('ufo_hum', 40);
      if (!this.hum) return;
    }
    // Louder the closer; a swarm adds to it.
    const n = this.plan.swarm ? 1.4 : 1;
    this.hum.set(best.x, best.y, best.z, n * (1 - smoothstep(150, 520, bd)) * (1 - g.sky.indoor * 0.6), 0.97 + (best.id % 7) * 0.01);
  }

  // ================================================================== dev

  status(): Record<string, unknown> {
    const modes: Record<string, number> = {};
    for (const d of this.discs.list) modes[d.mode] = (modes[d.mode] ?? 0) + 1;
    return {
      plan: { count: this.plan.count, swarm: this.plan.swarm }, discs: this.discs.list.length, modes, moment: this.momentNow,
      walkers: this.visits.map((v) => ({ x: Math.round(v.w.x), z: Math.round(v.w.z), phase: v.w.phase, until: +v.w.until.toFixed(2), courier: !!v.courier })),
      station: { dir: this.station.dir.toArray().map((v) => +v.toFixed(3)) }, stats: this.stats, regard: this.regard, glyphs: this.glyphs.count,
    };
  }

  private installDev(): void {
    this.devDone = true;
    const dev = (window as unknown as { dev?: Record<string, unknown> }).dev;
    if (!dev) return;
    dev.wardens = {
      status: () => this.status(),
      /** Force a number of discs (null: the schedule again). */
      count: (n: number | null) => { this.force = n; return this.status(); },
      swarm: (on = true) => { this.forceSwarm = on; return this.status(); },
      /** A walker set down near the hero now (for `mins` game minutes). */
      walker: (mins = 30) => { const ok = this.startVisit(Math.floor(Math.random() * 1e9), this.g.sky.hoursAbs + mins / 60); return ok ? this.status() : 'no free square or park within 60–340 m'; },
      /** The nearest free disc comes to hang over a point near the hero. */
      hover: () => {
        const P = this.g.player.pos;
        const d = this.discs.free().sort((p, q) => Math.hypot(p.x - P.x, p.z - P.z) - Math.hypot(q.x - P.x, q.z - P.z))[0] ?? this.add(P.x, P.z, 'above', false);
        if (!d) return null;
        this.discs.hover(d, P.x + 40, P.z + 40, 90, 120, rnd);
        return { id: d.id, x: Math.round(d.x), z: Math.round(d.z) };
      },
      look: () => { this.lookCd = 0; return 'next spectacular moment (high in the air or giant) gets a look'; },
      /**
       * The runaway teens (start them with dev.threat.spawn('teens', { dist: 80 })): .status() · .pod(i)
       * (knock pod i out as the hero) · .prank(kind?) ('car' | 'person' | 'glyph') · .catch() (seen now) ·
       * .omen(kind) ('zip' | 'glyph').
       */
      teens: {
        status: () => this.latestTeens()?.snapshot() ?? 'no runaway saucer',
        pod: (i = 0) => { const t = this.latestTeens(); if (!t) return 'no runaway saucer'; t.devPod(i); return t.snapshot(); },
        prank: (kind?: 'car' | 'person' | 'glyph') => this.latestTeens()?.devPrank(kind) ?? 'no runaway saucer',
        catch: () => { const t = this.latestTeens(); if (!t) return 'no runaway saucer'; t.devCatch(); return t.snapshot(); },
        omen: (kind = 'zip') => this.teenOmen(kind, new Rng((Math.random() * 2 ** 32) >>> 0)),
      },
    };
  }
}
