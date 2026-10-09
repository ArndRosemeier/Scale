/**
 * The threat layer in the game (THREATS_PLAN §3–4): runs the City Threat Clock on played time,
 * karma earned and the player's chaos, stages its omens in the world, starts the events it
 * schedules near the player (or by hand: dev.threat.spawn), hands each to the city response and
 * marks it on the map and compass. Owns the rogue-machine controller of the near-future layer.
 *
 * Archetypes plug in through ARCHETYPE_IMPL (omens and the event itself): the robot malfunction
 * and the brood swarm (minor) and the Strider (major). The clock is saved per city (seed, size) and mode, like
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
import { AwakenedTree } from './AwakenedTree';
import type { StreetProp } from '../../props/PropRenderer';
import { treeModel } from '../../props/vegetation';
import { planStriderRoute, type StriderRoute } from './StriderRoute';
import { CreatureMesh } from './rig/CreatureMesh';
import { FacadeFires } from './FacadeFires';
import { PlayerRampage } from './PlayerRampage';
import { Brood, BroodGlimpse, broodOmen, type BroodOpts } from './Brood';
import { BroodMesh } from './brood/broodMesh';
import type { HitEffect } from './brood/BroodSim';
import type { Obstacle } from '../../world/Collision';
import { RunawayTeens, type TeenOpts } from '../aliens/RunawayTeens';
import { Burrower, BURROWER } from './burrower/Burrower';
import { WormMesh } from './burrower/WormMesh';
import { Sinkholes } from './burrower/Sinkholes';
import { DecalKind } from '../powers/ElementFx';

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
  // The Burrower: tunnels in from the hero's side of town; omens a rumble underfoot and potholes.
  burrower: {
    omen: (d, _site, kind, rng) => d.burrowerOmen(kind, rng),
    start: (d, _site, seed, opts) => {
      try {
        const b = new Burrower(d.g, d.sinkholes, seed, opts as { toward?: { x: number; z: number } });
        // (dev: { near: true } — it starts under the street nearest the hero.)
        if (opts.near) b.devNear();
        return b;
      } catch (err) { console.warn('[threats]', err); return null; }
    },
    fallback: ['rumble'],
  },
  // A rampaging giant player (started by HostilePlayer after its warnings, never by the clock).
  rampage: {
    omen: () => false,
    start: (d) => new PlayerRampage(d.g),
    fallback: [],
  },
  brood: {
    omen: (d, site, kind, rng) => broodOmen(d.g, site, kind, rng, d.glimpses),
    start: (d, site, seed, opts) => new Brood(d.g, site, seed, opts as BroodOpts),
    fallback: ['chitter', 'glimpse'],
  },
  // A villain boss's operation (crime/BossOp, started by the crime system: opts.ev is its BossEvent).
  boss: {
    omen: () => false,
    start: (_d, _site, _seed, opts) => (opts.ev as ThreatEvent | undefined) ?? null,
    fallback: [],
  },
  // A tree sung awake by the eco-radicals' Elder (crime/BossOp 'treewake': opts.prop is the tree;
  // from the console the nearest tree to the site). opts.ready skips its rise.
  tree: {
    omen: () => false,
    start: (d, site, seed, opts) => {
      let prop = (opts.prop as StreetProp | undefined) ?? null;
      // A real tree standing (no shrub): the nearest to the site, else the nearest to the hero.
      const near = (x: number, z: number, r: number) => {
        let bd = r, best: StreetProp | null = null;
        d.g.props.query(x, z, r, (p) => { const dd = Math.hypot(p.x - x, p.z - z); if (p.kind.startsWith('tree:') && !p.broken && dd < bd) { bd = dd; best = p; } });
        return best as StreetProp | null;
      };
      // Out in the country (forests, field edges): a countryside tree, taken off its tile.
      let wild = null as { x: number; z: number } | null;
      const wildNear = (x: number, z: number, r: number): StreetProp | null => {
        const w = d.g.countryside.nearestTree(x, z, r);
        if (!w) return null;
        const m = treeModel(w.species, w.variant);
        wild = w;
        return { kind: `tree:${w.species}:${w.variant}`, tree: true, x: w.x, y: w.y, z: w.z, yaw: w.yaw, scale: w.scale, color: [0, 0, 0], broken: false, breakable: 'topple', radius: m.trunkRadius * w.scale, height: m.height * w.scale };
      };
      // Closest first, city or country: the hero's own surroundings, then the site, then farther round the hero.
      const P = d.g.player.pos;
      prop ??= near(P.x, P.z, 25) ?? wildNear(P.x, P.z, 25) ?? near(site.x, site.z, 80) ?? wildNear(site.x, site.z, 80) ?? near(P.x, P.z, 400) ?? wildNear(P.x, P.z, 300);
      if (!prop) return null;
      const t = new AwakenedTree(d.g, prop, seed);
      const uprooted = wild as { x: number; z: number } | null;
      if (uprooted) d.g.countryside.uproot(uprooted.x, uprooted.z);
      if (opts.ready) t.devReady();
      return t;
    },
    fallback: [],
  },
  // The runaway teens' stolen saucer (game/aliens, ALIENS_PLAN §5); omens through the Wardens.
  teens: {
    omen: (d, _site, kind, rng) => d.g.wardens?.teenOmen(kind, rng) ?? false,
    start: (d, site, seed, opts) => new RunawayTeens(d.g, site, seed, opts as TeenOpts),
    fallback: ['zip', 'glyph'],
  },
  // The Murk breaking out of the sewers (started by the slime realm's war, never by the clock).
  murk: {
    omen: () => false,
    start: (d, site) => d.g.slimeRealm?.breachEvent(site) ?? null,
    fallback: [],
  },
};

/** A defeated monster's body as saves keep it (SaveBody). */
interface SavedBody { kind: string; x: number; z: number; yaw: number; side: number; s: number; downAt: number; cleared: number }

/** A wake on the river (an omen): foam drifting downstream for a while. */
interface Wake { x: number; z: number; dx: number; dz: number; t: number }

const SETTING_KEY = 'scale.threat.setting';
/** A finished event stays (powered-down machines, the response standing down) this long (s). */
const LINGER = 45;

/**
 * Around a big monster the city does not count the hero's collateral (crime/Justice): nobody expects
 * them to mind a lamp post while a monster tears the city down. Big: a body at least `minHeight` m
 * tall; around it: within `near` m + `perHeight` × its height of it, and for `linger` s after it
 * was last there (a body coming down, the last blows).
 */
export const MONSTER_GRACE = { minHeight: 8, near: 80, perHeight: 2.5, linger: 20 };

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
  /** The Burrower's skinned bodies (a live worm and one lying in the city), in the creatures' material. */
  readonly wormMesh: WormMesh;
  /** Holes in the street (the Burrower's breaches, its omen's potholes). */
  readonly sinkholes: Sinkholes;
  /** Dead worms lying in the city (gone after BURROWER.bodyHours game hours, when nobody is looking). */
  readonly wormRemains: Burrower[] = [];
  /** Every brood swarm's creatures (one instanced mesh). */
  readonly broodMesh: BroodMesh;
  /** The few creatures of a brood omen darting between manholes. */
  readonly glimpses: BroodGlimpse[] = [];
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
  /** Big monsters lately (MONSTER_GRACE): where each was last, its radius of grace and when. */
  private big = new Map<ThreatActor, { x: number; z: number; r: number; t: number }>();
  private now = 0;
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
    this.wormMesh = new WormMesh(this.mesh.material, 2);
    g.renderer.scene.add(this.wormMesh.group);
    this.sinkholes = new Sinkholes(g);
    this.broodMesh = new BroodMesh();
    g.renderer.scene.add(this.broodMesh.mesh);
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
    if (ref instanceof Burrower) return !ref.defeated;
    if (ref instanceof AwakenedTree) return !ref.defeated;
    const m = (ref as { mal?: { mode: string } }).mal;
    return !!m && m.mode === 'hostile';
  }

  /** Is a big monster about (MONSTER_GRACE) near this point? The player's collateral is not counted there. */
  bigMonsterNear(x: number, z: number): boolean {
    for (const b of this.big.values()) if (this.now - b.t <= MONSTER_GRACE.linger && Math.hypot(x - b.x, z - b.z) < b.r) return true;
    return false;
  }

  private trackBig(dt: number): void {
    this.now += dt;
    for (const a of this.actors()) {
      if (a.height < MONSTER_GRACE.minHeight) continue;
      this.big.set(a, { x: a.x, z: a.z, r: MONSTER_GRACE.near + MONSTER_GRACE.perHeight * a.height, t: this.now });
    }
    for (const [a, b] of this.big) if (this.now - b.t > MONSTER_GRACE.linger) this.big.delete(a);
  }

  /** The big threat bodies one can target and hurt now. */
  actors(): ThreatActor[] {
    const out: ThreatActor[] = [];
    // (Not the player's own body: a rampaging giant is the army's target, never their own.)
    for (const ev of this.events) if (ev.actors) for (const a of ev.actors) if (a.targetable && !a.self) out.push(a);
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

  /**
   * A hit on the brood's creatures round a point (punches and blasts via Game.strike, the powers via
   * Elements): every swarm there takes it. Returns the creatures hit (positions for effects).
   */
  broodHit(x: number, y: number, z: number, r: number, effect: HitEffect, dmg: number, fling: number): { x: number; y: number; z: number }[] {
    let out: { x: number; y: number; z: number }[] = [];
    for (const ev of this.events) {
      if (!(ev instanceof Brood) || Math.hypot(ev.x - x, ev.z - z) > BROOD_REACH + r) continue;
      const hit = ev.hit(x, y, z, r, effect, dmg, fling);
      if (hit.length) out = out.concat(hit.map((c) => ({ x: c.x, y: c.y + c.size * 0.2, z: c.z })));
    }
    return out;
  }

  /** Stage 3: the aftermath has carted a body away. */
  removeRemains(s: Strider): void {
    const i = this.remains.indexOf(s);
    if (i >= 0) this.remains.splice(i, 1);
  }

  private obstacles(x0: number, z0: number, x1: number, z1: number, out: (o: Obstacle) => void): void {
    for (const ev of this.events) if (ev instanceof Strider || ev instanceof Burrower) ev.obstacles(x0, z0, x1, z1, out);
    for (const w of this.wormRemains) w.obstacles(x0, z0, x1, z1, out);
    for (const r of this.remains) r.obstacles(x0, z0, x1, z1, out);
    // Awakened trees, walking or rooted where they were beaten.
    for (const ev of this.events) if (ev instanceof AwakenedTree) ev.obstacles(x0, z0, x1, z1, out);
    for (const t of AwakenedTree.grove()) t.obstacles(x0, z0, x1, z1, out);
  }

  update(dt: number): void {
    const t0 = performance.now();
    const g = this.g;
    this.rogue.update(dt);
    this.trackBig(dt);
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
        if (ev instanceof Burrower && ev.mode === 'dead') this.wormRemains.push(ev);
        ev.dispose(); this.ended.delete(ev); this.events.splice(i, 1);
      }
    }
    this.fires.update(dt);
    this.sinkholes.update(dt);
    this.wormsAfter(dt);
    // Trains held while a worm tunnels under the city.
    g.underground.metroHold = this.events.some((e) => e instanceof Burrower && e.active);
    for (let i = this.glimpses.length - 1; i >= 0; i--) { const gl = this.glimpses[i]; gl.update(dt); if (gl.done) this.glimpses.splice(i, 1); }
    this.updateWakes(dt);
    this.draw();
    this.markers(dt);
    this.saveT -= dt;
    if (this.saveT <= 0) { this.saveT = 15; this.save(); }
    if (!this.devDone) this.installDev();
    this.stats.msAvg = this.stats.msAvg * 0.95 + (performance.now() - t0) * 0.05;
  }

  /** Room for an event started from outside (a boss operation): nothing else running, events not switched off. */
  canHost(): boolean {
    return this.setting !== 'off' && !this.events.some((e) => e.active);
  }

  /** Events wait while the player is underground, indoors or a towering giant (nobody would see it). */
  private ready(): boolean {
    const g = this.g, p = g.player.pos;
    return !g.underground.feetUnder(p.x, p.y, p.z) && !g.indoorsAt(p.x, p.y + 0.5, p.z) && g.player.height < 12 && !this.events.some((e) => e.active);
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
      if (dist < rMin || dist > rMax || !W.standable(x, z)) continue;
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
    for (const t of AwakenedTree.grove()) list.push({ x: t.x, z: t.z, color: '#5a7d3a', kind: 'dot', place: true, title: 'A gnarled old tree — it walked here' });
    for (const r of this.remains) list.push({ x: r.x, z: r.z, color: '#8e8e93', kind: 'dot', place: true, title: r.cleared > 0 ? 'Fallen creature — being cleared away' : 'Fallen creature — cordoned off' });
    for (const w of this.wormRemains) list.push({ x: w.x, z: w.z, color: '#8e8e93', kind: 'dot', place: true, title: 'Fallen worm — cordoned off' });
    for (const ev of this.events) {
      if (ev instanceof Strider && ev.defeated) list.push({ x: ev.x, z: ev.z, color: '#8e8e93', kind: 'dot', place: true, title: 'Fallen creature' });
      if (ev instanceof Burrower && ev.defeated) list.push({ x: ev.x, z: ev.z, color: '#8e8e93', kind: 'dot', place: true, title: 'Fallen worm' });
      if (ev instanceof AwakenedTree && ev.defeated) list.push({ x: ev.x, z: ev.z, color: '#5a7d3a', kind: 'dot', place: true, title: 'A gnarled old tree — it walked here' });
      // (A rampaging player is the incident: no alert marker on themselves.)
      if (!ev.active || ev.archetype === 'rampage') continue;
      list.push({ x: ev.x, z: ev.z, color: '#ff3b30', kind: 'alert', title: (ev as ThreatEvent).title ?? ( ev.archetype === 'robots' ? 'Rogue robots — machines attacking people' : ev.archetype === 'strider' ? 'Giant creature — stay clear or fight it' : ev.archetype === 'murk' ? 'Creatures from below — attacking people' : ev.archetype === 'brood' ? 'A swarm from the sewers — creatures attacking people' : 'Threat'), always: true });
      if (ev instanceof RobotMalfunction) for (const m of ev.units) {
        if (m.out || m.mode !== 'hostile' || Math.hypot(m.obj.x - p.x, m.obj.z - p.z) > 250) continue;
        list.push({ x: m.obj.x, z: m.obj.z, color: '#ff6b5e', kind: 'dot', title: 'A rogue machine' });
      }
    }
    // (Kind and title in the key: a monster brought down turns from an alert into a dot on the same spot.)
    const key = list.map((m) => `${Math.round(m.x / 3)},${Math.round(m.z / 3)},${m.kind},${m.title?.length ?? 0}`).join(';');
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
    // Worms (a live one, a body lying in the street).
    const W = this.wormMesh;
    W.begin();
    for (const ev of this.events) if (ev instanceof Burrower) ev.draw(W);
    for (const w of this.wormRemains) w.draw(W);
    if (!this.g.gate.enabled) { const p = this.g.player.pos; W.warm(p.x, p.y - 2, p.z); }
    W.end();
    // The brood's creatures (and those of an omen).
    const B = this.broodMesh;
    B.begin();
    for (const ev of this.events) if (ev instanceof Brood) B.add(ev.sim);
    for (const gl of this.glimpses) B.add(gl.sim);
    if (!this.g.gate.enabled) { const p = this.g.player.pos; B.warm(p.x, p.y - 2, p.z); }
    B.end();
  }

  // ================================================================== the Burrower

  /** Dead worms lying in the city: gone after their hours when the camera is far (nobody sees it go). */
  private wormsAfter(dt: number): void {
    this.wormT -= dt;
    if (this.wormT > 0 || !this.wormRemains.length) return;
    this.wormT = 4;
    const c = this.g.renderer.camera.position, now = this.g.sky.hoursAbs;
    for (let i = this.wormRemains.length - 1; i >= 0; i--) {
      const w = this.wormRemains[i];
      if (now - w.downAt > BURROWER.bodyHours && Math.hypot(w.x - c.x, w.z - c.z) > 320) { this.wormRemains.splice(i, 1); this.note('worm body gone'); }
    }
  }
  private wormT = 0;

  /**
   * An omen of the Burrower: 'rumble' — a deep rumble under the street where the player is, cracks
   * running across the asphalt, dust from the gutters, people looking down, car alarms; 'pothole' —
   * a small hole caving in on a street near the player with a crack round it.
   */
  burrowerOmen(kind: string, rng: Rng): boolean {
    const g = this.g, p = g.player.pos, cam = g.renderer.camera.position;
    if (kind === 'pothole') {
      for (let k = 0; k < 8; k++) {
        const a = rng.range(0, Math.PI * 2), d = rng.range(18, 45);
        const site = this.sinkholes.site(p.x + Math.cos(a) * d, p.z + Math.sin(a) * d, rng.range(1.1, 1.7), true);
        if (!site) continue;
        const hole = this.sinkholes.open(site, (rng.float() * 2 ** 32) >>> 0, true);
        this.sinkholes.rimCracks(hole, 3, 600);
        const y = g.terrain.height(site.x, site.z);
        g.audio.play('tremor_rumble', site.x, y, site.z, 0.6, 0.6, 30, cam);
        g.stimuli.emit('tremor', site.x, y, site.z, 3, 120, { cause: 'threat' });
        return true;
      }
      return false;
    }
    // Rumble: low and long, the ground shudders, cracks run along the street.
    g.camRig.addShake(0.22);
    g.audio.play('burrower_rumble_far', p.x, p.y - 6, p.z, 0.9, 0.9 + rng.range(0, 0.15), 30, cam);
    g.stimuli.emit('tremor', p.x, p.y, p.z, 4, 380, { cause: 'threat' });
    const a = rng.range(0, Math.PI * 2);
    for (let i = 0; i < 4; i++) {
      const x = p.x + Math.cos(a) * (8 + i * 7), z = p.z + Math.sin(a) * (8 + i * 7);
      if (g.world.buildingAt(x, z)) break;
      const y = g.world.groundHeight(x, z);
      g.later.after(0.3 + i * 0.35, () => {
        g.elements.fx.decal(DecalKind.Crack, x, y + 0.05, z, 0, 1, 0, 8, 2.4, -a + rng.range(-0.3, 0.3), 240); // (along the line: long axis (cos yaw, −sin yaw))
        g.dust.burst(x, y + 0.2, z, 4, 1.5, 1.2, 1.2, 3, WORM_DUST, 0.15, 0.4);
      });
    }
    const cars = g.parkedCars.filter((v) => Math.hypot(v.x - p.x, v.z - p.z) < 90).sort(() => rng.float() - 0.5).slice(0, rng.int(1, 3));
    for (const v of cars) g.later.after(rng.range(0.5, 2), () => g.audio.play('car_alarm', v.x, v.y + 1, v.z, 0.6, 0.95 + Math.random() * 0.1, 8, g.renderer.camera.position));
    return true;
  }

  /** The running (or latest) worm. */
  burrower(): Burrower | null {
    for (let i = this.events.length - 1; i >= 0; i--) { const e = this.events[i]; if (e instanceof Burrower) return e; }
    return null;
  }

  private burrowerDev(): Record<string, unknown> {
    const B = () => this.burrower();
    return {
      status: () => B()?.snapshot() ?? 'no worm',
      breach: (atHero = false) => B()?.devBreach(atHero) ?? 'no worm',
      dive: () => B()?.devDive() ?? 'no worm',
      slam: () => B()?.devSlam() ?? 'no worm',
      skip: (m = 100) => B()?.devSkip(m) ?? 'no worm',
      damage: (zone: string | null = 'body', amount = 300) => { const b = B(); return b ? b.damage(zone, amount, { cause: 'player' }) : 'no worm'; },
      die: () => { const b = B(); if (!b) return 'no worm'; if (!b.surfaced) return 'not up'; b.damage('maw', 1e6, { cause: 'player' }); b.hp = 0; return b.mode; },
      retreat: () => { const b = B(); if (!b) return 'no worm'; b.shutdown(); return b.mode; },
      route: () => { const R = B()?.route; return R ? { start: R.start, end: R.end, length: Math.round(R.length), breaches: R.breaches.map(Math.round), points: R.pts.length / 2 } : null; },
      /** Show one of its omens now ('rumble' | 'pothole'). */
      omen: (kind = 'rumble') => this.burrowerOmen(kind, new Rng((Math.random() * 2 ** 32) >>> 0)),
      /** Open a sinkhole `dist` m ahead of the player (radius r). */
      hole: (dist = 20, r = 7) => {
        const fy = this.g.camRig.forwardYaw, P = this.g.player.pos;
        const site = this.sinkholes.site(P.x - Math.sin(fy) * dist, P.z - Math.cos(fy) * dist, r);
        if (!site) return 'no site';
        this.sinkholes.open(site, (Math.random() * 2 ** 32) >>> 0);
        return site;
      },
      holes: () => this.sinkholes.status(),
      tuning: BURROWER,
    };
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
    for (const v of cars) g.later.after(rng.range(0.2, 1.5), () => g.audio.play('car_alarm', v.x, v.y + 1, v.z, 0.6, 0.95 + Math.random() * 0.1, 8, g.renderer.camera.position));
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
   * one just brought down), a Strider on the move (resumed at its route position) and the holes in
   * the street. Robot malfunctions, a Burrower (alive or dead) and omens are not kept: they end
   * with the session.
   */
  saveState(): { clock: Record<string, unknown>; setting: CityEvents; remains: SavedBody[]; strider: { s: number; hp: number; mode: string; level: number } | null; sinkholes: number[][] } {
    const remains: SavedBody[] = [];
    let strider: { s: number; hp: number; mode: string; level: number } | null = null;
    for (const b of [...this.remains, ...this.events.filter((e): e is Strider => e instanceof Strider && e.defeated)]) {
      const st = b.saveState();
      remains.push({ kind: 'strider', x: st.x, z: st.z, yaw: st.yaw, side: st.side, s: st.s, downAt: Math.round(b.downAt * 1000) / 1000, cleared: Math.round(b.cleared * 1000) / 1000 });
    }
    for (const e of this.events) if (e instanceof Strider && e.active && (e.mode === 'emerge' || e.mode === 'advance' || e.mode === 'rampage')) { const st = e.saveState(); strider = { s: st.s, hp: st.hp, mode: st.mode, level: this.g.response.incidents.find((i) => i.ev === e)?.level ?? 0 }; }
    return { clock: { ...this.clock.state }, setting: this.setting, remains, strider, sinkholes: this.sinkholes.saveState() };
  }

  /** Saves: restore what `saveState` kept (on a fresh city: no events running yet). */
  restoreState(o: { clock: Record<string, unknown> | null; setting: string; remains: SavedBody[]; strider: { s: number; hp: number; mode: string; level?: number } | null; sinkholes?: number[][] }): void {
    const S = this.clock.state as unknown as Record<string, unknown>;
    if (o.clock && o.clock.v === 1) for (const k of Object.keys(S)) if (k in o.clock && (typeof o.clock[k] === typeof S[k] || o.clock[k] === null || S[k] === null)) S[k] = o.clock[k];
    if (o.setting === 'off' || o.setting === 'rare' || o.setting === 'normal' || o.setting === 'frequent') this.setting = o.setting;
    this.earned = this.chaos = -1;
    for (const r of this.remains.splice(0)) r.dispose();
    this.wormRemains.length = 0;
    this.sinkholes.restoreState(o.sinkholes ?? []);
    o.remains.forEach((b, i) => {
      if (b.kind !== 'strider') return;
      try {
        const s = new Strider(this.g, deriveSeed(this.g.settings.seed, 'remains', i));
        s.restoreDead(b);
        // When it came down (unknown in an old save: from now) and how much the crews took away.
        s.downAt = b.downAt >= 0 ? b.downAt : this.g.sky.hoursAbs;
        s.cleared = Math.max(0, Math.min(1, b.cleared ?? 0));
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

  /** The running (or latest) brood. */
  brood(): Brood | null {
    for (let i = this.events.length - 1; i >= 0; i--) { const e = this.events[i]; if (e instanceof Brood) return e; }
    return null;
  }

  private broodDev(): Record<string, unknown> {
    const B = () => this.brood();
    return {
      status: () => B()?.snapshot() ?? 'no brood',
      hit: (effect: HitEffect = 'blow', r = 6, dmg = 10) => { const p = this.g.player.pos; return this.broodHit(p.x, p.y + 0.5, p.z, r, effect, dmg, 6).length; },
      leave: () => { const b = B(); if (!b) return 'no brood'; b.shutdown(); return b.outcome; },
      player: (dist = 25) => {
        const b = B(); if (!b) return 'no brood';
        const p = this.g.player;
        const a = Math.atan2(p.pos.x - b.x, p.pos.z - b.z);
        const x = b.x + Math.sin(a) * dist, z = b.z + Math.cos(a) * dist;
        p.pos.set(x, this.g.world.groundHeight(x, z) + 0.05, z);
        p.vel.set(0, 0, 0);
        return { x: Math.round(x), z: Math.round(z) };
      },
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
        if (!ARCHETYPE_IMPL[kind]) return `unknown archetype '${kind}'`;
        const ev = this.start(kind, (Math.random() * 2 ** 32) >>> 0, o, at);
        if (ev) this.clock.ran(kind);
        return ev ? ev.snapshot() : kind === 'tree' ? 'no tree standing nearby' : `${kind} could not start here`;
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
      /** Show an omen now ('glitch' | 'drone' | 'billboard'; the brood's: 'chitter' | 'glimpse'). */
      omen: (kind = 'glitch') => kind === 'chitter' || kind === 'glimpse'
        ? broodOmen(g, this.siteFor(this.clock.state.n), kind, new Rng((Math.random() * 2 ** 32) >>> 0), this.glimpses)
        : robotOmen(g, this.rogue, this.siteFor(this.clock.state.n), kind, new Rng((Math.random() * 2 ** 32) >>> 0)),
      events: () => this.events.map((e) => e.snapshot()),
      /** Shut every running event down. */
      stop: () => { for (const e of this.events) if (e.active) e.shutdown(); return this.events.map((e) => e.outcome); },
      /**
       * The Strider: dev.threat.strider.status() · .roar(rear?) · .breathe() · .swipe(side) · .damage(zone, amount) ·
       * .expose(zone) · .die() · .retreat() · .skip(m) (along its route) · .route() · .omen(kind) · .player(dist)
       * (put the player near it, facing it).
       */
      strider: this.striderDev(),
      /**
       * The brood: dev.threat.brood.status() · .hit(effect, r, dmg) (round the player) · .leave() ·
       * .player(dist) (put the player near the swarm).
       */
      brood: this.broodDev(),
      /**
       * The Burrower: dev.threat.burrower.status() · .breach(atHero?) · .dive() · .slam() · .skip(m) · .damage(zone, amount) ·
       * .die() · .retreat() · .route() · .omen('rumble' | 'pothole') · .hole(dist, r) · .holes()
       */
      burrower: this.burrowerDev(),
      setting: (s?: CityEvents) => { if (s) this.setting = s; return this.setting; },
      log: () => this.log,
      stats: () => ({ ...this.stats, rogue: this.rogue.stats, machines: this.rogue.list.length }),
    };
  }
}

/** A brood's creatures range this far from its centre (m): hits further off skip it. */
const BROOD_REACH = 160;

const WORM_DUST = new THREE.Color(0.5, 0.46, 0.4);
const WAKE_A = new THREE.Color(0.86, 0.9, 0.92), WAKE_B = new THREE.Color(0.6, 0.68, 0.72);

function loadSetting(): CityEvents {
  try { const s = localStorage.getItem(SETTING_KEY); if (s === 'off' || s === 'rare' || s === 'normal' || s === 'frequent') return s; } catch { /* storage unavailable */ }
  return 'normal';
}
