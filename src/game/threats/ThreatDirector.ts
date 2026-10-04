/**
 * The threat layer in the game (THREATS_PLAN §3–4): runs the City Threat Clock on played time,
 * karma earned and the player's chaos, stages its omens in the world, starts the events it
 * schedules near the player (or by hand: dev.threat.spawn), hands each to the city response and
 * marks it on the map and compass. Owns the rogue-machine controller of the near-future layer.
 *
 * Archetypes plug in through ARCHETYPE_IMPL (omens and the event itself); Phase A has one, the
 * robot malfunction. The clock is saved per city (seed, size) and mode, like Progress; the
 * "City events" setting (off / rare / normal / frequent) is a player preference.
 */
import type { Game } from '../Game';
import { Rng, deriveSeed } from '../../core/rng';
import { doorOf } from '../../sim/Population';
import type { MapMarker } from '../../ui/map/GameMap';
import { ThreatClock, type CityEvents, type ClockSignal } from './ThreatClock';
import { RogueMachines } from './RogueMachines';
import { RobotMalfunction, robotOmen, type RobotEventOpts } from './RobotMalfunction';
import type { ThreatEvent } from './ThreatEvent';

/** How an archetype shows itself before it comes (omens) and how it starts. */
interface ArchetypeImpl {
  omen(d: ThreatDirector, site: { x: number; z: number }, kind: string, rng: Rng): boolean;
  start(d: ThreatDirector, site: { x: number; z: number }, seed: number, opts: Record<string, unknown>): ThreatEvent | null;
}

const ARCHETYPE_IMPL: Record<string, ArchetypeImpl> = {
  robots: {
    omen: (d, site, kind, rng) => robotOmen(d.g, d.rogue, site, kind, rng),
    start: (d, site, seed, opts) => new RobotMalfunction(d.g, d.rogue, site, seed, opts as RobotEventOpts),
  },
};

const SETTING_KEY = 'scale.threat.setting';
/** A finished event stays (powered-down machines, the response standing down) this long (s). */
const LINGER = 45;

export class ThreatDirector {
  readonly clock: ThreatClock;
  readonly rogue: RogueMachines;
  readonly events: ThreatEvent[] = [];
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
  }

  get setting(): CityEvents { return this.clock.setting; }
  set setting(s: CityEvents) {
    this.clock.setting = s;
    try { localStorage.setItem(SETTING_KEY, s); } catch { /* storage unavailable */ }
  }

  /** Is this object part of a threat (a machine gone rogue)? Fair game for the player. */
  isHostile(ref: object): boolean {
    const m = (ref as { mal?: { mode: string } }).mal;
    return !!m && m.mode === 'hostile';
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
      if (!ev.active && ev.t > (this.ended.get(ev) ?? ev.t) + LINGER) { ev.dispose(); this.ended.delete(ev); this.events.splice(i, 1); }
    }
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
      const kinds = [o.s.kind, 'glitch', 'drone', 'billboard'];
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
    for (const ev of this.events) {
      if (!ev.active) continue;
      list.push({ x: ev.x, z: ev.z, color: '#ff3b30', kind: 'alert', title: ev.archetype === 'robots' ? 'Rogue robots' : 'Threat', always: true });
      if (ev instanceof RobotMalfunction) for (const m of ev.units) {
        if (m.out || m.mode !== 'hostile' || Math.hypot(m.obj.x - p.x, m.obj.z - p.z) > 250) continue;
        list.push({ x: m.obj.x, z: m.obj.z, color: '#ff6b5e', kind: 'dot', title: '' });
      }
    }
    const key = list.map((m) => `${Math.round(m.x / 3)},${Math.round(m.z / 3)}`).join(';');
    if (key !== this.markKey) { this.markKey = key; this.g.map.setMarkers('threat', list); }
  }

  save(): void {
    try { localStorage.setItem(this.key, JSON.stringify(this.clock.state)); } catch { /* storage unavailable */ }
  }

  // ================================================================== dev console

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
      setting: (s?: CityEvents) => { if (s) this.setting = s; return this.setting; },
      log: () => this.log,
      stats: () => ({ ...this.stats, rogue: this.rogue.stats, machines: this.rogue.list.length }),
    };
  }
}

function loadSetting(): CityEvents {
  try { const s = localStorage.getItem(SETTING_KEY); if (s === 'off' || s === 'rare' || s === 'normal' || s === 'frequent') return s; } catch { /* storage unavailable */ }
  return 'normal';
}
