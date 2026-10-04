/**
 * The threat layer in the game (THREATS_PLAN §3–4): runs the City Threat Clock on played time,
 * karma earned and the player's chaos, stages its omens in the world, starts the events it
 * schedules near the player (or by hand: dev.threat.spawn), hands each to the city response and
 * marks it on the map and compass. Owns the rogue-machine controller of the near-future layer.
 *
 * Archetypes plug in through ARCHETYPE_IMPL (omens and the event itself): the robot malfunction
 * (minor) and the Strider (major). The clock is saved per city (seed, size) and mode, like
 * Progress; the "City events" setting (off / rare / normal / frequent) is a player preference.
 *
 * Big threats are actors (ThreatActor): the director lists them for targeting, routes blows to
 * them, draws every creature's rig parts in one shared batch (CreatureMesh), lets their bodies be
 * obstacles, and keeps the body of a defeated monster in the city (`remains`, for the aftermath).
 * Burning facades (FacadeFires) live here too.
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import { Rng, deriveSeed } from '../../core/rng';
import { doorOf } from '../../sim/Population';
import type { MapMarker } from '../../ui/map/GameMap';
import { ThreatClock, type CityEvents, type ClockSignal } from './ThreatClock';
import { RogueMachines } from './RogueMachines';
import { RobotMalfunction, robotOmen, type RobotEventOpts } from './RobotMalfunction';
import type { DamageResult, DamageSource, ThreatActor, ThreatEvent } from './ThreatEvent';
import { Strider, STRIDER, STRIDER_RIG, type StriderOpts } from './Strider';
import { planStriderRoute, type StriderRoute } from './StriderRoute';
import { CreatureMesh } from './rig/CreatureMesh';
import { FacadeFires } from './FacadeFires';
import type { Obstacle } from '../../world/Collision';

/** How an archetype shows itself before it comes (omens) and how it starts. */
interface ArchetypeImpl {
  omen(d: ThreatDirector, site: { x: number; z: number }, kind: string, rng: Rng): boolean;
  start(d: ThreatDirector, site: { x: number; z: number }, seed: number, opts: Record<string, unknown>): ThreatEvent | null;
  /** Omen kinds to try when the planned one finds nothing to show itself on. */
  fallback: string[];
}

const ARCHETYPE_IMPL: Record<string, ArchetypeImpl> = {
  robots: {
    omen: (d, site, kind, rng) => robotOmen(d.g, d.rogue, site, kind, rng),
    start: (d, site, seed, opts) => new RobotMalfunction(d.g, d.rogue, site, seed, opts as RobotEventOpts),
    fallback: ['glitch', 'drone', 'billboard'],
  },
  strider: {
    omen: (d, _site, kind, rng) => d.striderOmen(kind, rng),
    start: (d, _site, seed, opts) => {
      try {
        const s = new Strider(d.g, seed, opts as StriderOpts);
        s.onDefeated = (b) => d.onDefeated?.(b);
        return s;
      } catch (err) { console.warn('[threats]', err); return null; }
    },
    fallback: ['tremor'],
  },
};

/** A wake on the river (an omen): foam drifting downstream for a while. */
interface Wake { x: number; z: number; dx: number; dz: number; t: number }

const SETTING_KEY = 'scale.threat.setting';
/** A finished event stays (powered-down machines, the response standing down) this long (s). */
const LINGER = 45;

export class ThreatDirector {
  readonly clock: ThreatClock;
  readonly rogue: RogueMachines;
  readonly events: ThreatEvent[] = [];
  /** Bodies of defeated monsters lying in the city (the aftermath removes them: `removeRemains`). */
  readonly remains: Strider[] = [];
  /** Stage 3 hook: a monster was brought down (its body is in `remains` once the event is wound up). */
  onDefeated: ((s: Strider) => void) | null = null;
  /** Every creature's rig parts (one batch, one shared material). */
  readonly mesh: CreatureMesh;
  /** Facades set burning (breath, later crashes and shells). */
  readonly fires: FacadeFires;
  private wakes: Wake[] = [];
  private striderRoute: StriderRoute | null | undefined;
  private readonly key: string;
  /** The site of the event being heralded (chosen with its first omen). */
  private site: { x: number; z: number; n: number } | null = null;
  /** Omens waiting for something to show them on (nothing suitable about yet). */
  private omens: { s: Extract<ClockSignal, { type: 'omen' }>; t: number; tries: number }[] = [];
  /** When each finished event ended (its own clock). */
  private ended = new Map<ThreatEvent, number>();
  private earned = -1;
  private chaos = -1;
  private saveT = 15;
  private markT = 0;
  private markKey = '';
  private devDone = false;
  readonly log: { t: number; what: string }[] = [];
  stats = { omens: 0, omensShown: 0, events: 0, msAvg: 0 };

  constructor(readonly g: Game) {
    this.key = `scale.threat.v1.${g.mode}.${g.settings.seed}.${g.settings.size.toFixed(2)}`;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(this.key) ?? 'null'); } catch { /* storage unavailable */ }
    this.clock = new ThreatClock(g.settings.seed, saved);
    this.clock.setting = loadSetting();
    this.rogue = new RogueMachines(g);
    g.future.malfunction = this.rogue;
    // Two Striders' skinned bodies (the climax budget, THREATS_PLAN §4: a live one and a body lying
    // in the city); the skin is built now and the program compiles during the warm-up.
    this.mesh = new CreatureMesh([{ def: STRIDER_RIG, count: 2, name: 'strider' }]);
    g.renderer.scene.add(this.mesh.group);
    this.fires = new FacadeFires(g.elements.fx, g.destruction, g.renderer.camera);
    // Their bodies stand in the player's way.
    g.collision.obstacleProviders.push((x0, z0, x1, z1, out) => this.obstacles(x0, z0, x1, z1, out));
  }

  get setting(): CityEvents { return this.clock.setting; }
  set setting(s: CityEvents) {
    this.clock.setting = s;
    try { localStorage.setItem(SETTING_KEY, s); } catch { /* storage unavailable */ }
  }

  /** Is this object part of a threat (a machine gone rogue, a monster)? Fair game for the player. */
  isHostile(ref: object): boolean {
    if (ref instanceof Strider) return true;
    const m = (ref as { mal?: { mode: string } }).mal;
    return !!m && m.mode === 'hostile';
  }

  /** The big threat bodies one can target and hurt now. */
  actors(): ThreatActor[] {
    const out: ThreatActor[] = [];
    for (const ev of this.events) if (ev.actors) for (const a of ev.actors) if (a.targetable) out.push(a);
    return out;
  }

  /** A physical blow at a point (a punch, a giant's stomp) on whichever threat body is there. */
  blow(x: number, y: number, z: number, r: number, jx: number, jy: number, jz: number, src: DamageSource): DamageResult | null {
    let best: DamageResult | null = null;
    for (const a of this.actors()) {
      if (Math.hypot(a.x - x, a.z - z) > a.height * 3 + r) continue;
      const res = a.blow(x, y, z, r, jx, jy, jz, src);
      if (res && (!best || res.dealt > best.dealt)) best = res;
    }
    return best;
  }

  /** Stage 3: the aftermath has carted a body away. */
  removeRemains(s: Strider): void {
    const i = this.remains.indexOf(s);
    if (i >= 0) this.remains.splice(i, 1);
  }

  private obstacles(x0: number, z0: number, x1: number, z1: number, out: (o: Obstacle) => void): void {
    for (const ev of this.events) if (ev instanceof Strider) ev.obstacles(x0, z0, x1, z1, out);
    for (const r of this.remains) r.obstacles(x0, z0, x1, z1, out);
  }

  update(dt: number): void {
    const t0 = performance.now();
    const g = this.g;
    this.rogue.update(dt);
    // What drives the clock: karma earned, the player's own collateral.
    const earned = g.progress.earned, chaos = g.consequences.totals.player;
    const dk = this.earned < 0 ? 0 : earned - this.earned, dc = this.chaos < 0 ? 0 : chaos - this.chaos;
    this.earned = earned; this.chaos = chaos;
    for (const s of this.clock.tick(dt, dk, dc, this.ready())) {
      if (s.type === 'omen') { this.stats.omens++; this.omens.push({ s, t: 0, tries: 0 }); }
      else this.start(s.archetype, s.seed, {}, null);
    }
    this.showOmens(dt);
    for (let i = this.events.length - 1; i >= 0; i--) {
      const ev = this.events[i];
      const was = ev.active;
      ev.update(dt);
      if (was && !ev.active) { this.note(`${ev.archetype} #${ev.id} ${ev.outcome}`); this.ended.set(ev, ev.t); }
      if (!ev.active && ev.t > (this.ended.get(ev) ?? ev.t) + LINGER) {
        // A defeated monster's body stays in the city.
        if (ev instanceof Strider && ev.defeated) this.remains.push(ev);
        ev.dispose(); this.ended.delete(ev); this.events.splice(i, 1);
      }
    }
    this.fires.update(dt);
    this.updateWakes(dt);
    this.draw();
    this.markers(dt);
    this.saveT -= dt;
    if (this.saveT <= 0) { this.saveT = 15; this.save(); }
    if (!this.devDone) this.installDev();
    this.stats.msAvg = this.stats.msAvg * 0.95 + (performance.now() - t0) * 0.05;
  }

  /** Events wait while the player is underground, indoors or a towering giant (nobody would see it). */
  private ready(): boolean {
    const g = this.g, p = g.player.pos;
    return !g.underground.isUnder(p.x, p.y + 0.5, p.z) && !g.interiors.insideAt(p.x, p.y + 0.5, p.z) && g.player.height < 12 && !this.events.some((e) => e.active);
  }

  private showOmens(dt: number): void {
    for (let i = this.omens.length - 1; i >= 0; i--) {
      const o = this.omens[i];
      o.t -= dt;
      if (o.t > 0) continue;
      o.t = 1.5;
      const impl = ARCHETYPE_IMPL[o.s.archetype];
      if (!impl) { this.omens.splice(i, 1); continue; }
      const site = this.siteFor(o.s.n);
      const rng = new Rng(o.s.seed);
      const kinds = [o.s.kind, ...impl.fallback];
      let shown = false;
      for (const k of kinds) if (impl.omen(this, site, k, rng)) { shown = true; this.note(`omen ${o.s.archetype}:${k}`); break; }
      // Nothing to show it on (an empty street): try again for a while, then let it pass.
      if (shown) { this.stats.omensShown++; this.omens.splice(i, 1); }
      else if (++o.tries > 20) this.omens.splice(i, 1);
    }
  }

  /** The heralded event's site: kept while the player stays in the district, else picked anew. */
  private siteFor(n: number): { x: number; z: number } {
    const p = this.g.player.pos;
    if (!this.site || this.site.n !== n || Math.hypot(this.site.x - p.x, this.site.z - p.z) > 380) {
      const s = this.pickSite(new Rng(deriveSeed(this.g.settings.seed, 'threat-site', n, Math.floor(p.x / 100), Math.floor(p.z / 100))));
      this.site = { ...s, n };
    }
    return this.site;
  }

  /** A busy spot (shop fronts) 70–200 m from the player, in the open street. */
  pickSite(rng: Rng, rMin = 70, rMax = 200): { x: number; z: number } {
    const g = this.g, p = g.player.pos, W = g.world;
    const doors: { x: number; z: number }[] = [];
    for (const r of W.buildingsIn(p.x - rMax, p.z - rMax, p.x + rMax, p.z + rMax)) {
      if (!r.alive || !(r.desc.shopfront || r.desc.use === 'retail')) continue;
      const d = doorOf(r.desc), x = d.x + d.nx * 3, z = d.z + d.nz * 3, dist = Math.hypot(x - p.x, z - p.z);
      if (dist < rMin || dist > rMax || W.buildingAt(x, z)) continue;
      doors.push({ x, z });
    }
    if (doors.length) return doors[rng.int(0, doors.length - 1)];
    // No shops about: a street point in a random direction.
    const a = rng.range(0, Math.PI * 2), r = (rMin + rMax) / 2;
    const ne = g.net.nearestEdge(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r, 120);
    if (!ne) return { x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r };
    const o = { x: 0, z: 0, dx: 0, dz: 0 };
    g.net.pointAt(g.net.edges[ne.e], ne.s, 0, o);
    return { x: o.x, z: o.z };
  }

  /**
   * Start an event of an archetype (the clock's, or dev.threat.spawn): at `at`, or at the
   * heralded site when the player is near it, else near the player.
   */
  start(archetype: string, seed: number, opts: Record<string, unknown>, at: { x: number; z: number } | null): ThreatEvent | null {
    const impl = ARCHETYPE_IMPL[archetype];
    if (!impl) return null;
    const p = this.g.player.pos;
    const site = at ?? (this.site && Math.hypot(this.site.x - p.x, this.site.z - p.z) < 350 ? this.site : this.pickSite(new Rng(seed)));
    const ev = impl.start(this, site, seed, opts);
    if (!ev) return null;
    this.events.push(ev);
    this.site = null;
    this.omens.length = 0;
    this.stats.events++;
    this.g.response.open(ev);
    this.note(`${archetype} #${ev.id} at ${Math.round(site.x)},${Math.round(site.z)}`);
    this.save();
    return ev;
  }

  private note(what: string): void {
    this.log.push({ t: +this.clock.state.played.toFixed(0), what });
    if (this.log.length > 40) this.log.shift();
  }

  /** The incident on the map, minimap and compass (at any distance), its machines as red dots. */
  private markers(dt: number): void {
    this.markT -= dt;
    if (this.markT > 0) return;
    this.markT = 0.5;
    const list: MapMarker[] = [];
    const p = this.g.player.pos;
    for (const r of this.remains) list.push({ x: r.x, z: r.z, color: '#8e8e93', kind: 'dot', title: 'Fallen creature' });
    for (const ev of this.events) {
      if (ev instanceof Strider && ev.defeated) list.push({ x: ev.x, z: ev.z, color: '#8e8e93', kind: 'dot', title: 'Fallen creature' });
      if (!ev.active) continue;
      list.push({ x: ev.x, z: ev.z, color: '#ff3b30', kind: 'alert', title: ev.archetype === 'robots' ? 'Rogue robots — machines attacking people' : ev.archetype === 'strider' ? 'Giant creature — stay clear or fight it' : 'Threat', always: true });
      if (ev instanceof RobotMalfunction) for (const m of ev.units) {
        if (m.out || m.mode !== 'hostile' || Math.hypot(m.obj.x - p.x, m.obj.z - p.z) > 250) continue;
        list.push({ x: m.obj.x, z: m.obj.z, color: '#ff6b5e', kind: 'dot', title: 'A rogue machine' });
      }
    }
    const key = list.map((m) => `${Math.round(m.x / 3)},${Math.round(m.z / 3)}`).join(';');
    if (key !== this.markKey) { this.markKey = key; this.g.map.setMarkers('threat', list); }
  }

  save(): void {
    try { localStorage.setItem(this.key, JSON.stringify(this.clock.state)); } catch { /* storage unavailable */ }
  }

  /** Every creature's parts into the shared batch (living ones, bodies lying in the city). */
  private draw(): void {
    const M = this.mesh;
    M.begin();
    for (const ev of this.events) if (ev instanceof Strider) ev.draw(M);
    for (const r of this.remains) r.draw(M);
    // During the start-up warm-up a speck of a body is drawn (under the player, too small to see),
    // so the creature program and its shadow variant compile behind the loading screen.
    if (!this.g.gate.enabled) {
      const p = this.g.player.pos;
      M.warm(p.x, p.y - 2, p.z);
    }
    M.end();
  }

  // ================================================================== the Strider's omens

  /** Where this city's Strider would rise (the seed's river spot), cached. */
  striderStart(): StriderRoute | null {
    if (this.striderRoute === undefined) this.striderRoute = planStriderRoute(this.g.macro, this.g.terrain);
    return this.striderRoute;
  }

  /**
   * An omen of the Strider: 'tremor' — a micro-quake where the player is (a shudder, a low rumble,
   * birds lifting off, people stopping to look round, car alarms going off); 'wake' — a strange wake
   * on the river where it will rise, foam drifting downstream, felt as a faint tremor on the banks.
   */
  striderOmen(kind: string, rng: Rng): boolean {
    const g = this.g, p = g.player.pos, cam = g.renderer.camera.position;
    if (kind === 'wake') {
      const R = this.striderStart();
      if (!R) return false;
      const r = g.terrain.rivers[R.river];
      // Downstream along the river at the spot.
      const w = g.terrain.water(R.start.x, R.start.z);
      let dx = 1, dz = 0;
      if (r && w.river === R.river) {
        const P = r.pts;
        let bi = 0, bd = Infinity;
        for (let i = 0; i + 1 < P.length / 2; i++) { const d = Math.hypot(P[i * 2] - R.start.x, P[i * 2 + 1] - R.start.z); if (d < bd) { bd = d; bi = i; } }
        dx = P[bi * 2 + 2] - P[bi * 2]; dz = P[bi * 2 + 3] - P[bi * 2 + 1];
        const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      }
      this.wakes.push({ x: R.start.x, z: R.start.z, dx, dz, t: 28 });
      g.stimuli.emit('tremor', R.start.x, g.terrain.waterLevel(R.start.x, R.start.z), R.start.z, 3, 500, { cause: 'threat' });
      return true;
    }
    // Tremor: a shudder, a rumble, birds, people looking round, car alarms.
    g.camRig.addShake(0.18);
    g.audio.play('tremor_rumble', p.x, p.y, p.z, 0.8, 0.9 + rng.range(0, 0.2), 30, cam);
    g.stimuli.emit('tremor', p.x, p.y, p.z, 4, 420, { cause: 'threat' });
    const cars = g.parkedCars.filter((v) => Math.hypot(v.x - p.x, v.z - p.z) < 110).sort(() => rng.float() - 0.5).slice(0, rng.int(2, 4));
    for (const v of cars) setTimeout(() => g.audio.play('car_alarm', v.x, v.y + 1, v.z, 0.6, 0.95 + Math.random() * 0.1, 8, g.renderer.camera.position), rng.range(200, 1500));
    return true;
  }

  private updateWakes(dt: number): void {
    if (!this.wakes.length) return;
    const g = this.g, fx = g.elements.fx, c = g.renderer.camera.position;
    for (let i = this.wakes.length - 1; i >= 0; i--) {
      const w = this.wakes[i];
      w.t -= dt;
      if (w.t <= 0) { this.wakes.splice(i, 1); continue; }
      // Something big under the surface: a long V of foam moving slowly downstream.
      w.x += w.dx * dt * 2.2; w.z += w.dz * dt * 2.2;
      if (Math.hypot(w.x - c.x, w.z - c.z) > 1200) continue;
      const wl = g.terrain.waterLevel(w.x, w.z);
      if (!isFinite(wl)) continue;
      for (let k = 0; k < 3; k++) {
        const back = Math.random() * 30, side = (Math.random() < 0.5 ? -1 : 1) * back * 0.45;
        const x = w.x - w.dx * back - w.dz * side, z = w.z - w.dz * back + w.dx * side;
        fx.soft(x, wl + 0.15, z, w.dx * 0.5, 0.05, w.dz * 0.5, 4, 1.5, 3.5, WAKE_A, WAKE_B, 0.5, 0.3, 0);
      }
    }
  }

  // ================================================================== saves

  /**
   * Saves: the clock, the setting, the bodies of defeated monsters (those lying in the city and
   * one just brought down) and a Strider on the move (resumed at its route position). Robot
   * malfunctions and omens are not kept: they end with the session.
   */
  saveState(): { clock: Record<string, unknown>; setting: CityEvents; remains: { kind: string; x: number; z: number; yaw: number; side: number; s: number }[]; strider: { s: number; hp: number; mode: string; level: number } | null } {
    const remains: { kind: string; x: number; z: number; yaw: number; side: number; s: number }[] = [];
    let strider: { s: number; hp: number; mode: string; level: number } | null = null;
    for (const b of [...this.remains, ...this.events.filter((e): e is Strider => e instanceof Strider && e.defeated)]) remains.push({ kind: 'strider', ...b.saveState() });
    for (const e of this.events) if (e instanceof Strider && e.active && (e.mode === 'emerge' || e.mode === 'advance' || e.mode === 'rampage')) { const st = e.saveState(); strider = { s: st.s, hp: st.hp, mode: st.mode, level: this.g.response.incidents.find((i) => i.ev === e)?.level ?? 0 }; }
    return { clock: { ...this.clock.state }, setting: this.setting, remains, strider };
  }

  /** Saves: restore what `saveState` kept (on a fresh city: no events running yet). */
  restoreState(o: { clock: Record<string, unknown> | null; setting: string; remains: { kind: string; x: number; z: number; yaw: number; side: number; s: number }[]; strider: { s: number; hp: number; mode: string; level?: number } | null }): void {
    const S = this.clock.state as unknown as Record<string, unknown>;
    if (o.clock && o.clock.v === 1) for (const k of Object.keys(S)) if (k in o.clock && (typeof o.clock[k] === typeof S[k] || o.clock[k] === null || S[k] === null)) S[k] = o.clock[k];
    if (o.setting === 'off' || o.setting === 'rare' || o.setting === 'normal' || o.setting === 'frequent') this.setting = o.setting;
    this.earned = this.chaos = -1;
    for (const r of this.remains.splice(0)) r.dispose();
    o.remains.forEach((b, i) => {
      if (b.kind !== 'strider') return;
      try {
        const s = new Strider(this.g, deriveSeed(this.g.settings.seed, 'remains', i));
        s.restoreDead(b);
        this.remains.push(s);
      } catch (err) { console.warn('[threats] could not lay the body back', err); }
    });
    if (o.strider) {
      const ev = this.start('strider', deriveSeed(this.g.settings.seed, 'threat', this.clock.state.n, 'resumed'), {}, null);
      if (ev instanceof Strider) ev.restoreWalking(o.strider);
      // The response back at its level (the army's units come in anew: they are not kept).
      if (ev && (o.strider.level ?? 0) > 0) this.g.response.setLevel(o.strider.level ?? 0);
    }
    this.save();
  }

  // ================================================================== dev console

  /** The running (or latest) Strider. */
  strider(): Strider | null {
    for (let i = this.events.length - 1; i >= 0; i--) { const e = this.events[i]; if (e instanceof Strider) return e; }
    return null;
  }

  private striderDev(): Record<string, unknown> {
    const S = () => this.strider();
    return {
      status: () => S()?.snapshot() ?? 'no strider',
      roar: (rear = false) => { const s = S(); if (!s) return 'no strider'; s.devRoar(rear); return s.act; },
      breathe: () => { const s = S(); if (!s) return 'no strider'; s.devBreathe(); return s.act; },
      swipe: (side = 1) => { const s = S(); if (!s) return 'no strider'; s.devSwipe(side); return s.act; },
      damage: (zone: string | null = 'back', amount = 300) => { const s = S(); return s ? s.damage(zone, amount, { cause: 'player' }) : 'no strider'; },
      expose: (zone = 'throat') => { const s = S(); if (!s) return 'no strider'; const z = s.zone(zone); z.exposed = true; return z; },
      die: () => { const s = S(); if (!s) return 'no strider'; s.damage(null, 1e6, { cause: 'player' }); s.hp = 0; return s.mode; },
      retreat: () => { const s = S(); if (!s) return 'no strider'; s.shutdown(); return s.mode; },
      skip: (m = 100) => { const s = S(); if (!s) return 'no strider'; s.devSkip(m); return Math.round(s.s); },
      /** Show one of its omens now ('tremor' | 'wake'). */
      omen: (kind = 'tremor') => this.striderOmen(kind, new Rng((Math.random() * 2 ** 32) >>> 0)),
      route: () => { const R = S()?.route ?? this.striderStart(); return R ? { start: R.start, end: R.end, length: Math.round(R.length), landS: R.landS, onArterials: Math.round(R.onArterials), points: R.pts.length / 2 } : null; },
      /** Put the player `dist` m from it (on the ground, facing it). */
      player: (dist = 120) => { const s = S(); if (!s) return 'no strider'; return s.devPlayerNear(dist); },
      tuning: STRIDER,
    };
  }

  private installDev(): void {
    const dev = (window as unknown as { dev?: Record<string, unknown> }).dev;
    if (!dev) return;
    this.devDone = true;
    const g = this.g;
    dev.threat = {
      director: this,
      /**
       * Start an event now: dev.threat.spawn('robots', { dist: 60, robots: 10, bots: 2, drones: 5, duration: 300 })
       * (dist: metres ahead along the view; at: { x, z }).
       */
      spawn: (kind = 'robots', o: Record<string, unknown> = {}) => {
        let at = (o.at as { x: number; z: number } | undefined) ?? null;
        if (!at && typeof o.dist === 'number') { const fy = g.camRig.forwardYaw; at = { x: g.player.pos.x - Math.sin(fy) * o.dist, z: g.player.pos.z - Math.cos(fy) * o.dist }; }
        const ev = this.start(kind, (Math.random() * 2 ** 32) >>> 0, o, at);
        if (ev) this.clock.ran(kind);
        return ev ? ev.snapshot() : 'unknown archetype';
      },
      /**
       * The clock: no argument → status; a number → play that many seconds (1 s steps, omens and
       * events happen); { setting } / { played, pressure } → set them.
       */
      clock: (a?: number | { setting?: CityEvents; played?: number; pressure?: number }) => {
        if (typeof a === 'number') {
          const out: string[] = [];
          for (let s = 0; s < a; s++) for (const sig of this.clock.tick(1, 0, 0, this.ready())) {
            out.push(`${Math.round(this.clock.state.played)} s: ${sig.type} ${sig.archetype}${sig.type === 'omen' ? ':' + sig.kind : ''}`);
            if (sig.type === 'omen') this.omens.push({ s: sig, t: 0, tries: 0 }); else this.start(sig.archetype, sig.seed, {}, null);
          }
          return { signals: out, status: this.clock.status() };
        }
        if (a?.setting) this.setting = a.setting;
        if (a?.played !== undefined) this.clock.state.played = a.played;
        if (a?.pressure !== undefined) this.clock.state.pressure = a.pressure;
        return this.clock.status();
      },
      /** Show an omen now ('glitch' | 'drone' | 'billboard'). */
      omen: (kind = 'glitch') => robotOmen(g, this.rogue, this.siteFor(this.clock.state.n), kind, new Rng((Math.random() * 2 ** 32) >>> 0)),
      events: () => this.events.map((e) => e.snapshot()),
      /** Shut every running event down. */
      stop: () => { for (const e of this.events) if (e.active) e.shutdown(); return this.events.map((e) => e.outcome); },
      /**
       * The Strider: dev.threat.strider.status() · .roar(rear?) · .breathe() · .swipe(side) · .damage(zone, amount) ·
       * .expose(zone) · .die() · .retreat() · .skip(m) (along its route) · .route() · .omen(kind) · .player(dist)
       * (put the player near it, facing it).
       */
      strider: this.striderDev(),
      setting: (s?: CityEvents) => { if (s) this.setting = s; return this.setting; },
      log: () => this.log,
      stats: () => ({ ...this.stats, rogue: this.rogue.stats, machines: this.rogue.list.length }),
    };
  }
}

const WAKE_A = new THREE.Color(0.86, 0.9, 0.92), WAKE_B = new THREE.Color(0.6, 0.68, 0.72);

function loadSetting(): CityEvents {
  try { const s = localStorage.getItem(SETTING_KEY); if (s === 'off' || s === 'rare' || s === 'normal' || s === 'frequent') return s; } catch { /* storage unavailable */ }
  return 'normal';
}
