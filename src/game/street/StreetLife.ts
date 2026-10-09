/**
 * Street life: eccentric characters at plazas, park paths, metro entrances and wide sidewalks near
 * the player — a doomsayer in a sandwich board, a busker with an open guitar case, a living statue
 * (silver or gold) that moves when you come close, a mime trapped in a box, a juggler, street
 * dancers (a crew with a boombox now and then), a chicken mascot handing out flyers, a conspiracy
 * theorist in a tinfoil hat, the pigeon lady, a sleepwalker in pyjamas at night, a lost tourist
 * with a huge map, a neon jogger.
 *
 * Who is where when is pure and seeded (cast.ts: sites from the cell plan, a roll per site and
 * 1.5 h slot, by time of day and district); here the casting comes alive near the player: people
 * walk in (or are simply there when the spot was out of view), set up, perform, talk (speech
 * bubbles: their own patter and lines for the player — flying past, a giant, tiny, a hero, a
 * menace, wanted), draw a few watchers (ordinary passers-by stopping to look) who drop a coin now
 * and then, pack up when their slot is over or it rains, and leave down the street.
 *
 * They are actors (sim/actors, owner STREET_OWNER: own budget, the crime layer leaves them be)
 * while they perform. Anything dangerous — a blast, a roar, a power, gunfire, a giant player, a
 * punch — ends the act: they become ordinary pedestrians at once, so Reactions makes them run
 * (and knocks them down) like everyone else; their things stay on the pavement for a while.
 * No lights; at most MAX_CHARS characters (a dance crew counts once), only near the player.
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import { PState, canGawk, type PedAgent } from '../../sim/Pedestrians';
import { Role, doorOf, type Citizen } from '../../sim/Population';
import { makeActor, attach, hold, play, goTo, stand, followRoute, STREET_OWNER, type Actor } from '../../sim/actors/Actor';
import { Rng, deriveSeed, hash32 } from '../../core/rng';
import { statusOf } from '../../shared/status';
import type { Stimulus } from '../Stimuli';
import type { District } from '../../plan/types';
import type { LiveStream } from '../../audio/Audio';
import { eateryName } from '../../plan/eatery';
import type { CellState } from '../../stream/CityStreamer';
import { STREET_KINDS, STREET_KIND_LIST, SiteKind, streetCast, streetSites, type StreetKind, type StreetSite, type StreetCast } from './cast';
import { lineFor, type LineTopic } from './lines';
import { costumeFor, musicianCostume, paintAppearance, type Paint } from './costume';
import { guitarCase, hat, boombox, bandGear, balls as makeBalls, type Gear } from './gear';

/** The street bands' styles (their pieces: public/music/live.json `bands`) and their level. */
const BAND_STYLES = ['folk', 'bossa', 'swing'] as const;
const BAND_GAIN = 0.5;
/** Sites within ACTIVE_R m of the player are lived in; characters beyond DROP_R leave (unseen). */
const ACTIVE_R = 120;
const DROP_R = 165;
/** Characters at once (a crew counts once) and real seconds one stays at least. */
const MAX_CHARS = 8;
const MIN_STAY = 75;
/** No two of a kind closer than this (m). */
const SAME_KIND_R = 100;
/** Player lines within this (m); the doomsayer is heard farther. */
const TALK_R = 20;
/** Most watchers a performer draws. */
const WATCHERS: Partial<Record<StreetKind, number>> = { busker: 4, band: 7, juggler: 6, dancer: 6, statue: 3, mime: 4, preacher: 2 };
/** Seconds between their own lines (random within). */
const PATTER: Record<StreetKind, [number, number]> = {
  preacher: [5, 8], busker: [16, 26], band: [18, 28], statue: [1e9, 1e9], mime: [24, 38], juggler: [14, 22], dancer: [12, 20], mascot: [10, 16],
  conspiracy: [8, 13], pigeons: [14, 22], sleepwalker: [11, 18], tourist: [12, 20], jogger: [1e9, 1e9],
};

type Phase = 'arrive' | 'perform' | 'leave';

interface Char {
  id: number;
  kind: StreetKind;
  site: StreetSite;
  cast: StreetCast | null;
  district: District;
  a: PedAgent;
  act: Actor;
  /** A dance crew's other members. */
  crew: PedAgent[];
  rng: Rng;
  phase: Phase;
  /** Seconds in the phase; alive. */
  t: number;
  life: number;
  talkT: number;
  /** Cooldown of lines for the player; topics said once already. */
  playerT: number;
  said: Set<LineTopic>;
  gear: Gear | null;
  balls: THREE.Mesh[];
  coins: number;
  /** A name to drop (the tourist's destination, the mascot's restaurant). */
  place: string;
  watchers: PedAgent[];
  /** Small per-kind state. */
  m: Record<string, number>;
  /** Someone the mascot or the tourist is going up to. */
  mark: PedAgent | null;
  /** Walkers (jogger, sleepwalker, the way in and out): the route. */
  route: Float32Array | null;
  /** Where they go when it is over. */
  home: { x: number; z: number } | null;
}

interface SiteCell { cs: CellState; sites: StreetSite[]; district: District }

export class StreetLife {
  readonly chars: Char[] = [];
  private cells = new Map<number, SiteCell>();
  private paints = new Map<number, Paint>();
  private leftovers: { gear: Gear; t: number }[] = [];
  private nextId = 1;
  private syncT = 0;
  private time = 0;
  private devDone = false;
  private guitar: { set(x: number, y: number, z: number, gain: number, rate?: number): void; stop(): void } | null = null;
  private beat: { set(x: number, y: number, z: number, gain: number, rate?: number): void; stop(): void } | null = null;
  private loopTry = 0;
  readonly group = new THREE.Group();
  private tmp: PedAgent[] = [];
  /** Off: nobody new turns up (dev, tests). */
  enabled = true;
  stats = { spawned: 0, panicked: 0, left: 0, coins: 0, lines: 0, sites: 0 };

  constructor(private g: Game) {
    g.renderer.scene.add(this.group);
    g.stimuli.on((s) => this.onStimulus(s));
    // Body paint: statues and mimes (looks are built once, from here).
    const prev = g.crowd.appearance;
    g.crowd.appearance = (a, app) => { prev?.(a, app); const p = this.paints.get(a.cit.id); if (p) paintAppearance(app, p); };
  }

  update(dt: number): void {
    const g = this.g;
    if (!this.devDone) this.installDev();
    this.time += dt;
    this.syncT -= dt;
    if (this.syncT <= 0) { this.syncT = 1; this.sync(); }
    for (let i = this.chars.length - 1; i >= 0; i--) {
      const c = this.chars[i];
      if (!this.chars.includes(c)) continue;
      this.step(c, dt);
    }
    for (let i = this.leftovers.length - 1; i >= 0; i--) {
      const L = this.leftovers[i];
      L.t += dt;
      const o = L.gear.object;
      if (L.t > 45 && !g.crime.visible(o.position.x, o.position.y + 0.2, o.position.z)) { o.removeFromParent(); this.leftovers.splice(i, 1); }
    }
    this.sound(dt);
  }

  // ================================================================== who is where

  private focus(): { x: number; z: number } {
    const p = this.g.freeCam ? this.g.renderer.camera.position : this.g.player.pos;
    return { x: p.x, z: p.z };
  }

  private sync(): void {
    const g = this.g, S = g.streamer.cells, f = this.focus();
    // Sites of the loaded cells near the player (planned once per cell, one new cell per tick).
    let planned = 0;
    for (const [id, cs] of S) {
      if (cs.status !== 'ready' || !cs.plan || this.cells.get(id)?.cs === cs) continue;
      const [x0, z0, x1, z1] = cs.plan.bounds;
      if (f.x < x0 - ACTIVE_R || f.x > x1 + ACTIVE_R || f.z < z0 - ACTIVE_R || f.z > z1 + ACTIVE_R) continue;
      if (planned++ > 0) break;
      this.cells.set(id, { cs, sites: streetSites(cs.plan), district: g.macro.cells[id]?.district ?? cs.plan.district });
    }
    for (const [id, sc] of this.cells) if (S.get(id) !== sc.cs) this.cells.delete(id);
    let nSites = 0;
    for (const sc of this.cells.values()) nSites += sc.sites.length;
    this.stats.sites = nSites;
    const hours = g.sky.hoursAbs;
    const rain = g.terraces?.rain ?? 0;
    // Those whose time is up, who are out in the rain, or far away.
    for (const c of [...this.chars]) {
      const d = Math.hypot(c.a.x - f.x, c.a.z - f.z);
      if (d > DROP_R && !g.crime.visible(c.a.x, c.a.y + 1, c.a.z)) { this.vanish(c); continue; }
      if (c.phase === 'leave' || !c.cast) continue;
      const now = streetCast(g.settings.seed, c.site, c.district, hours);
      const over = !now || now.kind !== c.kind || now.slot !== c.cast.slot;
      const wet = rain > 0.25 && !STREET_KINDS[c.kind].rainproof;
      if ((over && c.life > MIN_STAY) || wet) this.leave(c);
    }
    if (!this.enabled || g.camRig.underground || this.chars.length >= MAX_CHARS || this.time < this.calmAt) return;
    // Who should be here: the nearest free site with somebody cast for it now.
    let best: { site: StreetSite; cast: StreetCast; district: District; d: number } | null = null;
    for (const sc of this.cells.values()) {
      for (const site of sc.sites) {
        const d = Math.hypot(site.x - f.x, site.z - f.z);
        if (d > ACTIVE_R || d < 6 || (best && d >= best.d)) continue;
        if (this.chars.some((c) => c.site.key === site.key)) continue;
        const cast = streetCast(g.settings.seed, site, sc.district, hours);
        if (!cast || (rain > 0.25 && !STREET_KINDS[cast.kind].rainproof)) continue;
        if (this.chars.some((c) => c.kind === cast.kind && Math.hypot(c.site.x - site.x, c.site.z - site.z) < SAME_KIND_R)) continue;
        // Left (or fled) this slot already: not back before the next one.
        if (this.gone.has(site.key * 64 + (cast.slot & 63))) continue;
        best = { site, cast, district: sc.district, d };
      }
    }
    if (best) this.spawn(best.site, best.cast.kind, best.cast.seed, best.cast, best.district);
  }

  /** After a scare nobody new sets up for a while (real seconds, `time`). */
  private calmAt = 0;
  /** Sites whose character of the current slot already left (key × 64 + slot). */
  private gone = new Set<number>();

  // ================================================================== spawning

  /** A synthetic citizen suited to the part. */
  private citizen(kind: StreetKind, seed: number): Citizen | null {
    const pop = this.g.population;
    let fallback: Citizen | null = null;
    for (let k = 0; k < 40; k++) {
      const c = pop.synthetic(hash32(seed + k * 7919) || 1);
      if (c.role === Role.Child) continue;
      fallback ??= c;
      if (kind === 'pigeons' ? c.role !== Role.Senior || c.gender > 0.5 : kind === 'sleepwalker' || kind === 'tourist' || kind === 'preacher' || kind === 'conspiracy' ? false : c.role === Role.Senior) continue;
      return c;
    }
    return fallback;
  }

  private spawn(site: StreetSite, kind: StreetKind, seed: number, cast: StreetCast | null, district: District, walkIn = true): Char | null {
    const g = this.g, P = g.peds;
    const c = this.citizen(kind, seed);
    if (!c) return null;
    const rng = new Rng(seed);
    // Seen from here: they walk in from a door down the street; else they are simply there.
    const f = this.focus();
    const seen = walkIn && Math.hypot(site.x - f.x, site.z - f.z) < 95 && g.crime.visible(site.x, g.world.groundHeight(site.x, site.z) + 1, site.z);
    let route: Float32Array | null = null;
    if (seen) {
      const door = this.pickDoor(site.x, site.z, 18, 50, seed);
      route = door ? P.buildRoute(door.x, door.z, site.x, site.z) : null;
    }
    const x = route ? route[0] : site.x, z = route ? route[1] : site.z;
    const a = P.spawnAt(c, x, z, site.face);
    if (!a) return null;
    const cos = costumeFor(kind, c.seed, c.gender < 0.5);
    this.paints.set(c.id, cos.paint);
    const act = attach(a, makeActor('bystander', STREET_OWNER, { title: STREET_KINDS[kind].title, outfit: cos.eq, held: cos.held, hp: 40, maxHp: 40 }));
    a.pref = 1.3;
    const ch: Char = {
      id: this.nextId++, kind, site, cast, district, a, act, crew: [], rng, phase: 'arrive', t: 0, life: 0,
      talkT: 2 + rng.float() * 4, playerT: 0, said: new Set(), gear: null, balls: [], coins: rng.int(1, 5),
      place: this.placeFor(kind, site, rng), watchers: [], m: {}, mark: null, route: null, home: this.pickDoor(site.x, site.z, 40, 140, seed + 7),
    };
    if (route) { act.route = route; act.wp = 1; }
    this.chars.push(ch);
    this.stats.spawned++;
    return ch;
  }

  /** The door of a building between r0 and r1 m away (deterministic pick), or null. */
  private pickDoor(x: number, z: number, r0: number, r1: number, h: number): { x: number; z: number } | null {
    const out: { x: number; z: number }[] = [];
    for (const r of this.g.world.buildingsIn(x - r1, z - r1, x + r1, z + r1)) {
      if (!r.alive) continue;
      const d = doorOf(r.desc), dd = Math.hypot(d.x - x, d.z - z);
      if (dd >= r0 && dd <= r1) out.push(d);
    }
    return out.length ? out[hash32(h) % out.length] : null;
  }

  /** A name worth dropping near the site: a café down the street, a metro station, a district. */
  private placeFor(kind: StreetKind, site: StreetSite, rng: Rng): string {
    const g = this.g;
    const eats: string[] = [];
    for (const [id, cs] of g.streamer.cells) {
      const P = cs.plan;
      if (!P?.eateries.length) continue;
      const [x0, z0, x1, z1] = P.bounds;
      if (site.x < x0 - 300 || site.x > x1 + 300 || site.z < z0 - 300 || site.z > z1 + 300) continue;
      for (const ep of P.eateries) {
        const d = Math.hypot(ep.door[0] - site.x, ep.door[1] - site.z);
        if (d < (kind === 'mascot' ? 220 : 600) && d > 25) eats.push(eateryName(g.settings.seed, id, ep.b, ep.kind));
      }
    }
    if (kind === 'mascot') return eats.length ? rng.pick(eats) : 'Cluck Palace';
    const stations = g.macro.metroStations.filter((s) => Math.hypot(s.x - site.x, s.z - site.z) > 150 && Math.hypot(s.x - site.x, s.z - site.z) < 2000).map((s) => `${s.name} station`);
    const pool = [...eats.slice(0, 6), ...stations.slice(0, 6), 'the old town', 'the river', 'the big tower'];
    return rng.pick(pool);
  }

  // ================================================================== per frame

  private step(c: Char, dt: number): void {
    const g = this.g, a = c.a, act = c.act;
    c.life += dt;
    c.t += dt;
    if (!a.alive) { this.drop(c); return; }
    // Taken over by something else (a ragdoll, another owner): no longer ours.
    if (a.actor !== act) { this.forget(c); return; }
    if (a.ragdoll) return;
    if ((statusOf(a)?.frozen ?? 0) > 0) return;
    // Hit, knocked down, staggered: the act is over.
    if (act.hitByPlayer || a.state === PState.Down || act.state === 'down' || act.state === 'ko' || act.staggerT > 0 || c.crew.some((o) => o.actor?.hitByPlayer || o.state === PState.Down)) {
      this.say(c, 'hit', 4);
      const p = g.player.pos;
      this.panic(c, p.x, p.z);
      return;
    }
    // A giant in the street: run.
    const P = g.player, dp = Math.hypot(P.pos.x - a.x, P.pos.z - a.z);
    if (!g.freeCam && P.height > 6 && dp < 14 * P.height) { this.panic(c, P.pos.x, P.pos.z); return; }
    c.playerT -= dt;
    if (c.phase === 'arrive') this.arrive(c, dt);
    else if (c.phase === 'leave') this.leaving(c);
    else {
      this.perform(c, dt);
      this.talk(c, dt, dp);
      this.watch(c, dt);
    }
  }

  private arrive(c: Char, _dt: number): void {
    const a = c.a, act = c.act, s = c.site;
    if (act.route && followRoute(a, act, 1.35)) {
      if (act.stuckT > 4) act.route = null;
      return;
    }
    act.route = null;
    const d = Math.hypot(s.x - a.x, s.z - a.z);
    if (d > 0.5 && c.t < 25 && act.stuckT < 3) { goTo(act, s.x, s.z, d > 3 ? 1.3 : 0.8); return; }
    this.start(c);
  }

  /** At the spot: set up (gear down, birds in, a route for the walkers) and begin. */
  private start(c: Char): void {
    const g = this.g, a = c.a, act = c.act;
    stand(act);
    c.phase = 'perform';
    c.t = 0;
    a.heading = c.site.face;
    const ahead = (d: number) => ({ x: a.x - Math.sin(a.heading) * d, z: a.z - Math.cos(a.heading) * d });
    const put = (gear: Gear, d: number, side = 0) => {
      const p = ahead(d);
      const x = p.x + Math.cos(a.heading) * side, z = p.z - Math.sin(a.heading) * side;
      // (On the same pavement as the performer: a.y is its height there.)
      gear.object.position.set(x, a.y, z);
      gear.object.rotation.y = a.heading;
      gear.setCoins(c.coins);
      this.group.add(gear.object);
      c.gear = gear;
    };
    act.face = { ...ahead(4), y: a.y + 1.5 };
    switch (c.kind) {
      case 'busker': put(guitarCase(), 1.1); break;
      case 'juggler': put(hat(0x3a2a1e), 1.0, 0.5); c.balls = makeBalls(3, c.id); for (const b of c.balls) this.group.add(b); c.m.dropT = 30 + c.rng.float() * 30; break;
      case 'statue': put(hat(), 0.75); c.m.pose = c.rng.chance(0.5) ? 1 : 0; break;
      case 'mime': if (c.rng.chance(0.6)) put(hat(0x111111), 1.0, -0.4); break;
      case 'pigeons': c.m.feedT = 0; break;
      case 'dancer': this.crewUp(c); break;
      case 'band': this.bandUp(c); break;
      case 'conspiracy': c.m.dir = c.rng.chance(0.5) ? 1 : -1; c.m.pause = 2; break;
      case 'jogger': case 'sleepwalker': this.planLoop(c); break;
      case 'mascot': c.m.next = 2; break;
      case 'tourist': c.m.mode = 0; c.m.next = 6 + c.rng.float() * 6; break;
      default: break;
    }
  }

  /** The dance crew: two more dancers round a boombox (on plazas and in parks now and then). */
  private crewUp(c: Char): void {
    const g = this.g, a = c.a;
    if (c.site.kind === SiteKind.Sidewalk || c.site.kind === SiteKind.Metro || !c.rng.chance(0.55)) return;
    const cx = a.x - Math.sin(a.heading) * 1.6, cz = a.z - Math.cos(a.heading) * 1.6;
    const box = boombox();
    box.object.position.set(cx, a.y, cz);
    box.object.rotation.y = a.heading + Math.PI;
    this.group.add(box.object);
    c.gear = box;
    for (let k = 1; k <= 2; k++) {
      const ang = a.heading + Math.PI + (k === 1 ? 2.1 : -2.1);
      const x = cx - Math.sin(ang) * 1.6, z = cz - Math.cos(ang) * 1.6;
      if (!g.world.standable(x, z)) continue;
      const cit = this.citizen('dancer', hash32(c.id * 31 + k * 977 + 5));
      if (!cit) continue;
      const o = g.peds.spawnAt(cit, x, z, Math.atan2(-(cx - x), -(cz - z)));
      if (!o) continue;
      const cos = costumeFor('dancer', cit.seed, cit.gender < 0.5);
      this.paints.set(cit.id, null);
      attach(o, makeActor('bystander', STREET_OWNER, { title: 'Street dancer', outfit: cos.eq, held: null, face: { x: cx, y: o.y + 1.4, z: cz } }));
      c.crew.push(o);
    }
    if (c.crew.length) c.m.crew = 1;
  }

  /**
   * A street band: the leader on guitar with the case open in front, a bassist to the right and a
   * cajón player sitting on the box behind to the left. The style of music is the band's (by seed).
   */
  private bandUp(c: Char): void {
    const g = this.g, a = c.a, h = a.heading;
    const gear = bandGear();
    gear.object.position.set(a.x, a.y, a.z);
    gear.object.rotation.y = h;
    gear.setCoins(c.coins);
    this.group.add(gear.object);
    c.gear = gear;
    c.m.style = hash32(c.id * 977 + (c.cast?.seed ?? 0)) % 3;
    const at = (side: number, back: number) => ({ x: a.x + Math.cos(h) * side + Math.sin(h) * back, z: a.z - Math.sin(h) * side + Math.cos(h) * back });
    for (const [part, side, back] of [['bass', 1.5, 0.3], ['cajon', -1.45, 0.65]] as const) {
      const p = at(side, back);
      if (!g.world.standable(p.x, p.z)) continue;
      const cit = this.citizen('band', hash32(c.id * 31 + side * 100 + 11));
      if (!cit) continue;
      const o = g.peds.spawnAt(cit, p.x, p.z, h);
      if (!o) continue;
      const cos = musicianCostume(part, cit.seed, cit.gender < 0.5, false);
      this.paints.set(cit.id, null);
      const act = attach(o, makeActor('bystander', STREET_OWNER, { title: 'Street band', outfit: cos.eq, held: null, face: { x: p.x - Math.sin(h) * 4, y: o.y + 1.4, z: p.z - Math.cos(h) * 4 } }));
      act.memo.part = part === 'bass' ? 1 : 2;
      c.crew.push(o);
    }
  }

  /** Jogger and sleepwalker: a route out to a point down the streets and back, round and round. */
  private planLoop(c: Char): void {
    const a = c.a;
    const far = c.kind === 'jogger' ? [90, 170] : [35, 70];
    const to = this.pickDoor(a.x, a.z, far[0], far[1], c.id * 13 + 1);
    const r = to ? this.g.peds.buildRoute(a.x, a.z, to.x, to.z) : null;
    c.route = r;
    c.act.route = r ? Float32Array.from(r) : null;
    c.act.wp = 1;
    c.m.back = 0;
  }

  // ------------------------------------------------------------------ the acts

  /** Keep a looping act going (unless a one-shot gesture is playing). */
  private loop(c: Char, id: string, act = c.act): void {
    if (!act.action || act.action.id === id) hold(act, id, 1.4);
  }

  private faceNear(c: Char, r: number): boolean {
    const g = this.g, a = c.a, p = g.player.pos;
    if (!g.freeCam && Math.hypot(p.x - a.x, p.z - a.z) < r) { c.act.face = { x: p.x, y: p.y + g.player.height * 0.85, z: p.z }; return true; }
    c.act.face = { x: a.x - Math.sin(c.site.face) * 4, y: a.y + 1.5, z: a.z - Math.cos(c.site.face) * 4 };
    return false;
  }

  private perform(c: Char, dt: number): void {
    const g = this.g, a = c.a, act = c.act;
    const p = g.player.pos, dp = Math.hypot(p.x - a.x, p.z - a.z);
    switch (c.kind) {
      case 'preacher': this.faceNear(c, 16); act.mood = 'angry'; this.loop(c, 'preach'); break;
      case 'busker': {
        this.faceNear(c, 10);
        act.mood = 'happy';
        // A short break between songs: a bow and a thank-you.
        c.m.songT = (c.m.songT ?? 40 + c.rng.float() * 30) - dt;
        if (c.m.songT <= 0) { c.m.songT = 45 + c.rng.float() * 35; play(act, 'bow', 1.8); this.say(c, 'own', 8); }
        if (!act.action || act.action.id === 'play_guitar') this.loop(c, 'play_guitar');
        break;
      }
      case 'band': {
        this.faceNear(c, 9);
        act.mood = 'happy';
        // Between songs: the leader bows, says something; the others keep still a moment.
        c.m.songT = (c.m.songT ?? 50 + c.rng.float() * 30) - dt;
        if (c.m.songT <= 0) { c.m.songT = 55 + c.rng.float() * 40; play(act, 'bow', 1.8); this.say(c, 'own', 8); }
        if (!act.action || act.action.id === 'play_guitar') this.loop(c, 'play_guitar');
        for (const o of c.crew) {
          const oa = o.actor;
          if (!o.alive || !oa) continue;
          oa.mood = 'happy';
          if (oa.memo.part === 2) { oa.move = 'sit'; this.loop(c, 'play_cajon', oa); } else this.loop(c, 'play_guitar', oa);
        }
        break;
      }
      case 'statue': this.statue(c, dt, dp); break;
      case 'mime': this.faceNear(c, 9); this.loop(c, 'mime_box'); break;
      case 'juggler': this.juggler(c, dt); break;
      case 'dancer':
        this.faceNear(c, 8);
        this.loop(c, 'dance');
        for (const o of c.crew) if (o.alive && o.actor) { this.loop(c, 'dance', o.actor); o.actor.mood = 'happy'; }
        break;
      case 'mascot': this.mascot(c, dt, dp); break;
      case 'conspiracy': this.conspiracy(c, dt); break;
      case 'pigeons': {
        this.faceNear(c, 0);
        this.loop(c, 'feed_birds');
        c.m.feedT -= dt;
        if (c.m.feedT <= 0) {
          c.m.feedT = 25;
          const fx = a.x - Math.sin(a.heading) * 2.2, fz = a.z - Math.cos(a.heading) * 2.2;
          if (g.birds.groundNear(fx, fz, 3) < 4) g.birds.feed(fx, fz, 1.5, 8 + c.rng.int(0, 6));
        }
        break;
      }
      case 'sleepwalker': this.sleepwalker(c, dt, dp); break;
      case 'tourist': this.tourist(c, dt, dp); break;
      case 'jogger': this.jogger(c, dp); break;
    }
  }

  /**
   * Perfectly still (a statue's pose), until someone comes close: the player standing right by it,
   * or now and then a passer-by — then a sudden move and a "BOO!", and back to stone.
   */
  private statue(c: Char, dt: number, dp: number): void {
    const g = this.g, a = c.a, act = c.act, P = g.player;
    const pose = c.m.pose ? 'statue_thinker' : 'statue_salute';
    act.mood = 'neutral';
    act.face = { x: a.x - Math.sin(a.heading) * 6, y: a.y + 1.7, z: a.z - Math.cos(a.heading) * 6 };
    a.heading = c.site.face;
    c.m.cd = (c.m.cd ?? 3) - dt;
    if (!act.action || act.action.id === pose) hold(act, pose, 1.4);
    if (c.m.cd > 0) return;
    // The player right by it, on foot.
    if (!g.freeCam && dp < 2.4 && P.height < 2.5 && !P.flying) {
      c.m.near = (c.m.near ?? 0) + dt;
      if (c.m.near > 1.1) {
        c.m.near = 0; c.m.cd = 18;
        play(act, c.rng.chance(0.5) ? 'gesture_wave' : 'bow', 1.5);
        act.face = { x: P.pos.x, y: P.pos.y + 1.6, z: P.pos.z };
        this.say(c, 'special', 4);
      }
      return;
    }
    c.m.near = 0;
    // A passer-by brushing past: BOO.
    for (const o of g.peds.neighbours(a.x, a.z, 1.8, this.tmp)) {
      if (o === a || o.actor || o.inside || o.state !== PState.Walk || o.fear > 0.2) continue;
      if (c.rng.float() > 0.35) { c.m.cd = 4; return; }
      c.m.cd = 20;
      play(act, 'gesture_point', 1.0);
      act.face = { x: o.x, y: o.y + 1.6, z: o.z };
      this.say(c, 'special', 4);
      // Startled: a jump back, stare, a word.
      o.fear = 0.45; o.fearX = a.x; o.fearZ = a.z;
      o.state = PState.Gawk; o.stateT = 0;
      o.lookX = a.x; o.lookY = a.y + 1.6; o.lookZ = a.z;
      const dx = o.x - a.x, dz = o.z - a.z, dl = Math.hypot(dx, dz) || 1;
      o.x += (dx / dl) * 0.35; o.z += (dz / dl) * 0.35;
      this.g.later.after(0.45, () => { if (o.alive) this.g.barks.say(o, c.rng.pick(['Aah!', 'It MOVED!', 'Jesus!', 'Don\'t DO that!']), 10); });
      return;
    }
  }

  /** Three balls in a cascade over the hands; now and then one gets away. */
  private juggler(c: Char, dt: number): void {
    const g = this.g, a = c.a, act = c.act;
    this.faceNear(c, 9);
    act.mood = 'focused';
    const m = c.m;
    m.dropT -= dt;
    const fx = -Math.sin(a.heading), fz = -Math.cos(a.heading), rx = Math.cos(a.heading), rz = -Math.sin(a.heading);
    const rig = !!g.crowd.rigFor(a.id);
    const handY = a.y + 1.17, fwd = 0.3, side = 0.36;
    if (m.drop) {
      // A ball loose: it falls, bounces and rolls; the juggler shrugs, fetches it, comes back.
      const b = c.balls[0];
      m.bt = (m.bt ?? 0) + dt;
      m.vy -= 9.81 * dt;
      b.position.x += m.vx * dt; b.position.z += m.vz * dt; b.position.y += m.vy * dt;
      const gy = a.y + 0.045;
      if (b.position.y < gy) { b.position.y = gy; m.vy = Math.abs(m.vy) * 0.45 < 0.4 ? 0 : Math.abs(m.vy) * 0.45; m.vx *= 0.7; m.vz *= 0.7; }
      if (m.bt > 1.4 && m.drop === 1) { m.drop = 2; }
      if (m.drop === 2) {
        const d = Math.hypot(b.position.x - a.x, b.position.z - a.z);
        if (d > 0.7 && act.stuckT < 3) goTo(act, b.position.x, b.position.z, 1.2);
        else { stand(act); play(act, 'pickup', 1.1); m.drop = 3; m.bt = 0; }
      } else if (m.drop === 3 && m.bt > 0.9) {
        m.drop = 4;
      } else if (m.drop === 4) {
        b.position.set(a.x, a.y + 1, a.z);
        const d = Math.hypot(c.site.x - a.x, c.site.z - a.z);
        if (d > 0.4 && act.stuckT < 3) goTo(act, c.site.x, c.site.z, 1.0);
        else { stand(act); a.heading = c.site.face; m.drop = 0; m.dropT = 35 + c.rng.float() * 40; }
      }
    } else {
      if (!act.action || act.action.id === 'juggle') this.loop(c, 'juggle');
      if (m.dropT <= 0 && act.action?.id === 'juggle') {
        m.drop = 1; m.bt = 0;
        const b = c.balls[0];
        m.vx = fx * 1.6 + rx * (c.rng.float() - 0.5); m.vz = fz * 1.6 + rz * (c.rng.float() - 0.5); m.vy = 1.5;
        b.position.set(a.x + fx * fwd, handY + 0.4, a.z + fz * fwd);
        play(act, 'gesture_shrug', 1.3);
        this.say(c, 'special', 5);
      }
    }
    // The cascade (only with the full rig: the far crowd shows no hands for it).
    const t = this.time * 1.25;
    for (let k = 0; k < c.balls.length; k++) {
      const b = c.balls[k];
      const juggling = !m.drop && (!act.action || act.action.id === 'juggle');
      if (k === 0 && m.drop) { b.visible = true; continue; }
      b.visible = rig && juggling;
      if (!b.visible) continue;
      // Ball k: 0..1 in the air left → right, 1..1.5 in the right hand, 1.5..2.5 right → left, 2.5..3 left hand.
      const u = ((t + k) % 3 + 3) % 3;
      let s: number, y: number;
      if (u < 1) { s = -1 + 2 * u; y = 0.55 * 4 * u * (1 - u); } else if (u < 1.5) { s = 1; y = -0.05 * Math.sin((u - 1) * 2 * Math.PI); } else if (u < 2.5) { const w = u - 1.5; s = 1 - 2 * w; y = 0.55 * 4 * w * (1 - w); } else { s = -1; y = -0.05 * Math.sin((u - 2.5) * 2 * Math.PI); }
      b.position.set(a.x + fx * fwd + rx * side * s, handY + y, a.z + fz * fwd + rz * side * s);
    }
    // Applause at the end of a routine with a few watching.
    m.showT = (m.showT ?? 25) - dt;
    if (m.showT <= 0 && !m.drop) {
      m.showT = 30 + c.rng.float() * 25;
      if (this.watching(c) >= 2) {
        play(act, 'bow', 1.6);
        g.audio.play('crowd_cheer', a.x, a.y + 1.5, a.z, 0.35, 1.1, 4, g.renderer.camera.position);
      }
    }
  }

  /** The chicken: up to passers-by with a flyer, back to the corner; the player gets one too. */
  private mascot(c: Char, dt: number, dp: number): void {
    const g = this.g, a = c.a, act = c.act, m = c.m;
    act.mood = 'happy';
    m.next -= dt;
    const o = c.mark;
    if (o) {
      const isPlayer = m.player === 1;
      const tx = isPlayer ? g.player.pos.x : o.x, tz = isPlayer ? g.player.pos.z : o.z;
      const d = Math.hypot(tx - a.x, tz - a.z);
      m.markT = (m.markT ?? 0) + dt;
      if (!isPlayer && (!o.alive || o.actor || o.state === PState.Flee)) { c.mark = null; return; }
      if (m.offer) {
        act.face = { x: tx, y: a.y + 1.4, z: tz };
        if (m.markT > 2) { c.mark = null; m.offer = 0; act.held = null; m.next = 4 + c.rng.float() * 5; }
        return;
      }
      if (d > 1.3 && m.markT < 6 && act.stuckT < 2.5) { goTo(act, tx, tz, 1.6); return; }
      stand(act);
      if (d > 2.2) { c.mark = null; m.next = 2; return; }
      // Here you go.
      m.offer = 1; m.markT = 0;
      act.held = 'flyer';
      play(act, 'offer', 1.8);
      act.face = { x: tx, y: a.y + 1.4, z: tz };
      if (isPlayer) this.say(c, 'greet', 6);
      else {
        this.say(c, 'special', 6);
        // They stop for a moment and take it (or not).
        o.state = PState.Idle; o.stateT = 6 + (o.look % 7) - 2.2;
        o.lookX = a.x; o.lookY = a.y + 1.5; o.lookZ = a.z;
      }
      return;
    }
    // Back to the corner between flyers.
    const ds = Math.hypot(c.site.x - a.x, c.site.z - a.z);
    if (ds > 1.2) { goTo(act, c.site.x, c.site.z, 1.2); return; }
    stand(act);
    this.faceNear(c, 10);
    if (m.next > 0) { if (!act.action && c.rng.float() < dt * 0.15) play(act, 'gesture_wave', 1.6); return; }
    // The player close by and not given one lately; else a passer-by.
    // (The player as the mark: `mark` holds the mascot itself as a placeholder, m.player says who.)
    if (!g.freeCam && dp < 6 && this.time > (m.playerAt ?? -1e9) + 40) { c.mark = a; m.player = 1; m.markT = 0; m.playerAt = this.time; return; }
    m.player = 0;
    for (const w of g.peds.neighbours(a.x, a.z, 9, this.tmp)) {
      if (w === a || w.actor || w.inside || w.state !== PState.Walk || w.onRoad || w.fear > 0.2) continue;
      c.mark = w; m.markT = 0; m.next = 0;
      return;
    }
    m.next = 2;
  }

  /** Pacing up and down the pavement, preaching to nobody. */
  private conspiracy(c: Char, dt: number): void {
    const a = c.a, act = c.act, m = c.m;
    act.mood = 'surprised';
    const tx = -Math.cos(c.site.face), tz = Math.sin(c.site.face);
    if (m.pause > 0) {
      m.pause -= dt;
      stand(act);
      this.faceNear(c, 12);
      this.loop(c, 'talk');
      return;
    }
    const gx = c.site.x + tx * 3.5 * m.dir, gz = c.site.z + tz * 3.5 * m.dir;
    if (Math.hypot(gx - a.x, gz - a.z) > 0.4 && act.stuckT < 2) { goTo(act, gx, gz, 0.95); return; }
    m.dir = -m.dir;
    m.pause = 3 + c.rng.float() * 5;
  }

  /** Arms out, eyes shut, along the pavement and back; bumps into the player and mumbles. */
  private sleepwalker(c: Char, dt: number, dp: number): void {
    const g = this.g, a = c.a, act = c.act, m = c.m;
    act.mood = 'neutral';
    this.loop(c, 'sleepwalk');
    m.stop = (m.stop ?? 0) - dt;
    if (!g.freeCam && dp < 1.6 && m.stop < -6) { m.stop = 3.5; this.say(c, 'greet', 5); }
    if (m.stop > 0) { stand(act); act.face = { x: g.player.pos.x, y: g.player.pos.y + 1.6, z: g.player.pos.z }; return; }
    act.face = null;
    if (!act.route) { stand(act); return; }
    if (!followRoute(a, act, 0.55) || act.stuckT > 4) this.turnBack(c);
  }

  /** The jogger's laps; a word in passing. */
  private jogger(c: Char, dp: number): void {
    const g = this.g, a = c.a, act = c.act;
    act.mood = 'focused';
    act.face = null;
    if (!act.route) { this.planLoop(c); if (!act.route) { stand(act); return; } }
    if (!followRoute(a, act, 3.3) || act.stuckT > 3) this.turnBack(c);
    if (!g.freeCam && dp < 7 && c.playerT <= 0) {
      const top = this.playerTopic(c, dp);
      if (this.say(c, top ?? 'own', 6)) c.playerT = 14;
    }
  }

  /** Walkers at the end of their route: back the way they came. */
  private turnBack(c: Char): void {
    const R = c.act.route;
    if (!R) return;
    const n = R.length / 3, out = new Float32Array(R.length);
    for (let i = 0; i < n; i++) { out[i * 3] = R[(n - 1 - i) * 3]; out[i * 3 + 1] = R[(n - 1 - i) * 3 + 1]; out[i * 3 + 2] = R[(n - 1 - i) * 3 + 2]; }
    out[0] = c.a.x; out[1] = c.a.z;
    c.act.route = out; c.act.wp = 1;
    c.act.stuckT = 0;
  }

  /** Map in hand, wandering about the spot; asks the way (the player first). */
  private tourist(c: Char, dt: number, dp: number): void {
    const g = this.g, a = c.a, act = c.act, m = c.m;
    act.mood = 'surprised';
    m.next -= dt;
    if (m.mode === 1) {
      // Wandering to a spot nearby.
      const d = Math.hypot(m.tx - a.x, m.tz - a.z);
      if (d > 0.5 && m.next > 0 && act.stuckT < 2) { goTo(act, m.tx, m.tz, 1.05); this.loop(c, 'read_map'); return; }
      stand(act); m.mode = 0; m.next = 7 + c.rng.float() * 8;
    }
    if (m.mode === 2) {
      // Going up to the player.
      const p = g.player.pos, d = Math.hypot(p.x - a.x, p.z - a.z);
      if (d > 1.8 && d < 12 && m.next > 0 && act.stuckT < 2) { goTo(act, p.x, p.z, 1.3); return; }
      stand(act); m.mode = 0; m.next = 8;
      if (d <= 2.6) { act.face = { x: p.x, y: p.y + 1.6, z: p.z }; play(act, 'gesture_point', 1.4); this.say(c, 'greet', 6); }
      return;
    }
    if (!act.action || act.action.id === 'read_map') this.loop(c, 'read_map');
    if (!g.freeCam && dp < 8 && dp > 2 && this.time > (m.askedAt ?? -1e9) + 45) { m.mode = 2; m.next = 8; m.askedAt = this.time; return; }
    if (m.next > 0) { this.faceNear(c, 3); return; }
    // Somewhere else round here (along the pavement, or anywhere on a plaza).
    const s = c.site, along = s.kind === SiteKind.Plaza || s.kind === SiteKind.Park ? c.rng.float() * Math.PI * 2 : (c.rng.chance(0.5) ? -Math.PI / 2 : Math.PI / 2) + s.face;
    const r = 3 + c.rng.float() * 7;
    const tx = s.x - Math.sin(along) * r, tz = s.z - Math.cos(along) * r;
    if (g.world.buildingAt(tx, tz)) { m.next = 2; return; }
    m.tx = tx; m.tz = tz; m.mode = 1; m.next = 12;
  }

  // ------------------------------------------------------------------ watchers, talk

  private watching(c: Char): number {
    const a = c.a;
    let n = 0;
    for (let i = c.watchers.length - 1; i >= 0; i--) {
      const w = c.watchers[i];
      const still = w.alive && !w.actor && (w.state === PState.Gawk || w.state === PState.Film) && Math.hypot(w.lookX - a.x, w.lookZ - a.z) < 1.5;
      if (still) { n++; continue; }
      c.watchers.splice(i, 1);
      // Walking on after watching: a coin in the hat now and then.
      if (w.alive && w.state === PState.Walk && c.gear && (c.kind === 'busker' || c.kind === 'band' || c.kind === 'juggler' || c.kind === 'statue' || c.kind === 'mime') && c.rng.float() < 0.4) this.coin(c);
    }
    return n;
  }

  /** Passers-by stop to watch (a few, the curious ones); the busker's crowd is a small one. */
  private watch(c: Char, dt: number): void {
    const cap = WATCHERS[c.kind];
    if (!cap) return;
    c.m.watchT = (c.m.watchT ?? 1) - dt;
    if (c.m.watchT > 0) return;
    c.m.watchT = 1.5;
    const a = c.a;
    let n = this.watching(c);
    if (n >= cap) return;
    for (const w of this.g.peds.neighbours(a.x, a.z, 11, this.tmp)) {
      if (n >= cap) break;
      if (w === a || w.actor || w.inside || w.evac || w.onRoad || w.state !== PState.Walk || w.fear > 0.2 || !canGawk(w)) continue;
      if (w.cit.curiosity < 0.3 || c.rng.float() > 0.35) continue;
      w.state = PState.Gawk; w.stateT = 0;
      w.lookX = a.x; w.lookY = a.y + 1.5; w.lookZ = a.z;
      c.watchers.push(w);
      n++;
    }
  }

  private coin(c: Char): void {
    const g = this.g, o = c.gear!.object.position;
    c.coins++;
    c.gear!.setCoins(c.coins);
    this.stats.coins++;
    g.audio.play('street_coin', o.x, o.y + 0.1, o.z, 0.5, 0.9 + Math.random() * 0.25, 3, g.renderer.camera.position);
    if (c.kind === 'busker' || c.kind === 'band' || c.kind === 'statue') this.say(c, 'special', 10);
  }

  /** What to say to the player now (null: nothing in particular). */
  private playerTopic(c: Char, dp: number): LineTopic | null {
    const g = this.g, P = g.player;
    if (g.freeCam) return null;
    const rep = g.crime?.rep.value ?? 0, wanted = g.crime?.justice.wanted ?? 0;
    if (P.flying && dp < 30) return 'fly';
    if (P.height > 2.4) return 'giant';
    if (P.height < 0.6 && dp < 8) return 'tiny';
    if (dp > TALK_R) return null;
    if (wanted > 0 && !c.said.has('wanted')) return 'wanted';
    if (rep >= 40 && !c.said.has('hero') && dp < 12) return 'hero';
    if (rep <= -40 && !c.said.has('villain') && dp < 12) return 'villain';
    if (dp < 6 && !c.said.has('greet')) return 'greet';
    return null;
  }

  private talk(c: Char, dt: number, dp: number): void {
    c.talkT -= dt;
    if (c.talkT > 0) return;
    const top = c.playerT <= 0 ? this.playerTopic(c, dp) : null;
    const loud = c.kind === 'preacher' || c.kind === 'conspiracy';
    if (!top && dp > (loud ? 40 : TALK_R)) { c.talkT = 1; return; }
    const [lo, hi] = PATTER[c.kind];
    if (!top && lo > 1e8) { c.talkT = 5; return; }
    const ok = this.say(c, top ?? 'own', top ? 6 : lo * 0.8);
    if (!ok) { c.talkT = 0.7; return; }
    if (top) { c.said.add(top); c.playerT = 15; }
    c.talkT = lo + c.rng.float() * (hi - lo);
  }

  /** A line over the character (false: not shown — out of view, or too many bubbles). */
  private say(c: Char, topic: LineTopic, pause: number): boolean {
    const line = lineFor(c.kind, topic, () => c.rng.float(), c.place);
    if (!line) return false;
    const ok = this.g.barks.say(c.a, line, pause);
    if (ok) this.stats.lines++;
    return ok;
  }

  // ================================================================== endings

  /** Danger near the characters: whatever it is, the act is over (ordinary people run from it). */
  private onStimulus(s: Stimulus): void {
    if (!this.chars.length) return;
    for (const c of [...this.chars]) {
      const d = Math.hypot(c.a.x - s.x, c.a.z - s.z);
      if (d > s.radius) continue;
      const prox = 1 - d / s.radius;
      switch (s.kind) {
        case 'blast': case 'collapse': case 'sonic': case 'roar': case 'threat': case 'gunfire':
          this.panic(c, s.x, s.z);
          break;
        case 'power':
          if (prox > 0.25) this.panic(c, s.x, s.z);
          break;
        case 'crash':
          if (d < 25) this.panic(c, s.x, s.z);
          break;
        case 'stomp':
          if ((s.size ?? 0) > 4 && prox > 0.2) this.panic(c, s.x, s.z);
          break;
        case 'siren':
          // Civil defence: pack up and go with everyone else (Reactions sends them to the metro).
          if (s.evac) this.handOver(c, false, s.x, s.z);
          break;
        case 'impact': case 'glass':
          if (d < 12 && c.phase === 'perform' && !c.act.action?.id.startsWith('statue')) play(c.act, 'flinch', 0.6);
          break;
        default: break;
      }
    }
  }

  /** Run for it (a line first): an ordinary pedestrian from now on; the things stay where they are. */
  private panic(c: Char, fx: number, fz: number): void {
    if (!this.chars.includes(c)) return;
    this.say(c, 'panic', 4);
    this.stats.panicked++;
    this.calmAt = this.time + 60;
    this.handOver(c, true, fx, fz);
  }

  /**
   * End of the act: everyone is handed back to the street (fleeing from fx, fz, or walking off home),
   * the things left behind for a while, the site taken for the rest of the slot.
   */
  private handOver(c: Char, flee: boolean, fx: number, fz: number): void {
    const home = c.home;
    for (const o of [c.a, ...c.crew]) {
      if (!o.alive || !o.actor || (o.actor.owner !== STREET_OWNER)) continue;
      o.actor = undefined;
      if (home) { const r = this.g.peds.buildRoute(o.x, o.z, home.x, home.z); if (r) { o.route = r; o.wp = 1; o.dest = home; } }
      if (o.state === PState.Down) continue;
      if (flee) { o.state = PState.Flee; o.fear = Math.max(o.fear, 1.1); o.fearX = fx; o.fearZ = fz; o.stateT = 0; }
      else { o.state = PState.Walk; o.stateT = 0; o.fear = 0; }
    }
    if (c.gear) this.leftovers.push({ gear: c.gear, t: 0 });
    c.gear = null;
    this.drop(c);
  }

  /** Time's up (or rain): pick up the things and walk off. */
  private leave(c: Char): void {
    if (c.phase === 'leave') return;
    c.phase = 'leave';
    c.t = 0;
    stand(c.act);
    if (c.gear) play(c.act, 'pickup', 1.2);
    this.say(c, 'leave', 6);
  }

  private leaving(c: Char): void {
    if (c.t < 1.3) return;
    if (c.gear) { c.gear.object.removeFromParent(); c.gear = null; }
    this.stats.left++;
    this.handOver(c, false, c.a.x, c.a.z);
  }

  /** Gone (unseen, far away): the person and the things. */
  private vanish(c: Char): void {
    for (const o of [c.a, ...c.crew]) if (o.actor?.owner === STREET_OWNER) o.alive = false;
    this.drop(c);
  }

  /** Someone else has the person now (a ragdoll owner, another system): let go of it. */
  private forget(c: Char): void {
    if (c.gear) this.leftovers.push({ gear: c.gear, t: 0 });
    c.gear = null;
    for (const o of c.crew) if (o.actor?.owner === STREET_OWNER) { o.actor = undefined; o.state = PState.Walk; }
    this.drop(c);
  }

  /** Off the list: the gear and balls go, the slot is marked done. */
  private drop(c: Char): void {
    const i = this.chars.indexOf(c);
    if (i >= 0) this.chars.splice(i, 1);
    if (c.gear) c.gear.object.removeFromParent();
    for (const b of c.balls) b.removeFromParent();
    c.balls = [];
    // (A crew still on the job when its leader is gone goes too.)
    for (const o of c.crew) if (o.alive && o.actor?.owner === STREET_OWNER) o.alive = false;
    if (c.cast) this.gone.add(c.site.key * 64 + (c.cast.slot & 63));
    if (this.gone.size > 4000) this.gone.clear();
  }

  // ================================================================== sound

  /**
   * The nearest busker's guitar, the nearest crew's boombox (one positional loop each) and the
   * nearest street band (its piece streamed: public/music/live.json `bands`; until there is one, the
   * busker's guitar loop stands in).
   */
  private sound(dt: number): void {
    const g = this.g, cam = g.renderer.camera.position;
    let bus: Char | null = null, crew: Char | null = null, band: Char | null = null, bd = 45, cd = 45, nd = 60;
    for (const c of this.chars) {
      if (c.phase !== 'perform') continue;
      const d = Math.hypot(c.a.x - cam.x, c.a.z - cam.z);
      if (c.kind === 'busker' && d < bd && c.act.action?.id === 'play_guitar') { bus = c; bd = d; }
      if (c.kind === 'dancer' && c.m.crew && c.gear && d < cd) { crew = c; cd = d; }
      if (c.kind === 'band' && d < nd && c.act.action?.id === 'play_guitar') { band = c; nd = d; }
    }
    // The band's piece (or, with none, the guitar loop: unless a busker is nearer).
    const style = band ? BAND_STYLES[band.m.style ?? 0] : null;
    const file = style ? g.concert?.bandFile(style) ?? null : null;
    if (band && !file && (!bus || nd < bd)) { bus = band; bd = nd; }
    this.bandSound(band && file ? band : null, file);
    this.loopTry -= dt;
    if ((bus && !this.guitar) || (crew && !this.beat)) {
      if (this.loopTry <= 0) {
        this.loopTry = 2;
        if (bus && !this.guitar) this.guitar = g.audio.loop('street_guitar', 5);
        if (crew && !this.beat) this.beat = g.audio.loop('street_beat', 6);
      }
    }
    if (this.guitar) { if (bus) this.guitar.set(bus.a.x, bus.a.y + 1.1, bus.a.z, 0.8); else this.guitar.set(cam.x, -1000, cam.z, 0); }
    if (this.beat) { const o = crew?.gear?.object.position; if (o) this.beat.set(o.x, o.y + 0.3, o.z, 0.75); else this.beat.set(cam.x, -1000, cam.z, 0); }
  }

  /** The street band's streamed piece: started when one plays near, moved with it, stopped when it is gone. */
  private bandSound(c: Char | null, file: string | null): void {
    const b = this.band;
    if (b && (!c || b.file !== file || b.char !== c)) { b.s.fade(1.5); const s = b.s; this.g.later.after(2, () => s.stop()); this.band = null; }
    if (!c || !file) return;
    if (!this.band) {
      const s = this.g.audio.stream(file, { refDist: 6, rolloff: 1.2, loop: true, cat: 'voices', offset: (c.id * 37) % 40 });
      if (!s) return;
      this.band = { s, file, char: c };
    }
    this.band.s.set(c.a.x, c.a.y + 1.1, c.a.z, BAND_GAIN);
  }
  private band: { s: LiveStream; file: string; char: Char } | null = null;

  // ================================================================== dev

  /** Someone right now, `dist` m ahead of the player (dev.street.spawn). */
  spawnNear(kind: StreetKind, dist = 7): string {
    const g = this.g, p = g.player.pos, fy = g.camRig.forwardYaw;
    let x = p.x - Math.sin(fy) * dist, z = p.z - Math.cos(fy) * dist;
    for (let k = 0; k < 8 && !g.world.standable(x, z); k++) { const a = fy + (k + 1) * 0.7; x = p.x - Math.sin(a) * dist; z = p.z - Math.cos(a) * dist; }
    // Onto the nearest sidewalk (not the carriageway).
    const r = g.peds.buildRoute(x, z, x + 1, z + 1);
    // (A route starts at the point itself, then joins its sidewalk.)
    if (r && r.length >= 6 && Math.hypot(r[3] - x, r[4] - z) < 25 && !g.world.buildingAt(r[3], r[4])) { x = r[3]; z = r[4]; }
    const site: StreetSite = { key: -this.nextId, kind: SiteKind.Plaza, x, z, face: Math.atan2(-(p.x - x), -(p.z - z)), cell: -1 };
    const seed = deriveSeed(g.settings.seed, 'street-dev', this.nextId, kind);
    const c = this.spawn(site, kind, seed, null, 'commercial', false);
    if (!c) return 'no room';
    c.a.heading = site.face;
    return `${STREET_KINDS[kind].title} at ${x.toFixed(0)}, ${z.toFixed(0)}`;
  }

  private installDev(): void {
    const dev = (window as unknown as { dev?: Record<string, unknown> }).dev;
    if (!dev) return;
    this.devDone = true;
    dev.street = {
      life: this,
      kinds: STREET_KIND_LIST,
      /** dev.street.spawn('busker', 8): a street character 8 m ahead. */
      spawn: (kind: StreetKind = 'busker', dist = 7) => (STREET_KINDS[kind] ? this.spawnNear(kind, dist) : `kinds: ${STREET_KIND_LIST.join(', ')}`),
      list: () => this.chars.map((c) => ({ kind: c.kind, phase: c.phase, d: Math.round(Math.hypot(c.a.x - this.g.player.pos.x, c.a.z - this.g.player.pos.z)), watchers: c.watchers.length, coins: c.coins, crew: c.crew.length, place: c.place })),
      clear: () => { for (const c of [...this.chars]) this.vanish(c); return 'cleared'; },
      on: (v = true) => (this.enabled = v),
      stats: () => ({ ...this.stats, active: this.chars.length }),
      sites: () => { const f = this.focus(); const out: { kind: string; d: number; cast: string | null }[] = []; for (const sc of this.cells.values()) for (const s of sc.sites) { const d = Math.hypot(s.x - f.x, s.z - f.z); if (d < ACTIVE_R) out.push({ kind: ['plaza', 'park', 'metro', 'sidewalk'][s.kind], d: Math.round(d), cast: streetCast(this.g.settings.seed, s, sc.district, this.g.sky.hoursAbs)?.kind ?? null }); } return out.sort((p, q) => p.d - q.d); },
    };
  }
}
