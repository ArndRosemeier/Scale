/**
 * The ghost tour guide: Ambrose Penhallow, the city's crier until 1887, a friendly ghost (neither
 * hero nor villain) who gives night tours. From dusk to the small hours, near the player, a tour
 * meets at a cemetery's main tomb (he rises out of it) or, in the old town, at a fountain, a statue
 * or an old lamp. A small group of tourists gathers; he leads them from stop to stop (graves,
 * houses, old corners), telling a story at each in three bubbles, and the tourists gasp, laugh,
 * clap and take photos. Between stops he glides straight to the next one, through walls and
 * houses, often mid-sentence, while his group walks round by the street; on the other side he
 * apologises ("I keep forgetting you need doors"). At the end he bows, thanks everyone and fades.
 *
 * He is not a pedestrian: his own Actors rig (bones and clips untouched), drawn see-through
 * (look.ts), floating a hand's width above the ground, no shadow, never in the way. Blows and powers
 * pass through him (he says so). The tourists are ordinary people driven as actors (GHOST_OWNER);
 * anything dangerous ends the tour: they run like everyone else and he fades away. He talks to the
 * player: invites them along, has a word for a flying, giant, tiny, famous or notorious hero, and
 * thanks those who stay for the whole tour.
 *
 * No lights (the lantern only glows), at most one tour at a time, only near the player.
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import { HumanoidRig } from '../../humanoid/client/HumanoidRig';
import { PState, type PedAgent } from '../../sim/Pedestrians';
import { Role, doorOf } from '../../sim/Population';
import { makeActor, attach, play, hold, goTo, stand, followRoute, GHOST_OWNER, type Actor } from '../../sim/actors/Actor';
import { Rng, deriveSeed, hash32 } from '../../core/rng';
import { angleDiff, smoothstep } from '../../core/math';
import { shaderCap } from '../../render/shaderCap';
import type { Stimulus } from '../Stimuli';
import type { ActionAnim } from '../../shared/types';
import { ghostAppearance, ghostOutfit, ghostify, setGhostFade } from './look';
import { GHOST_NAME, GHOST_TITLE, STORIES, TOURIST_LINES, ghostLine, type GhostTopic } from './lines';
import { cemeteryStops, crossesBuilding, headingTo, nightLeft, tourHours, tourSlot, type GravePiece } from './tour';

/** A tour starts within this of the player (m); one that ends up farther than DROP_R is called off. */
const FIND_R = 240;
const DROP_R = 230;
/** He is drawn within this (m); farther out he is only a faint figure nobody could make out. */
const DRAW_R = 95;
/** Gliding speed (m/s) and the tourists' walk. */
const GLIDE = 1.15, WALK = 1.3;
/** Seconds per story bubble, between stops at most, real seconds between tours. */
const LINE_T = 4.8, LEG_MAX = 50, REST: [number, number] = [70, 140];
/** Player lines within this (m); the invite within INVITE_R. */
const TALK_R = 18, INVITE_R = 13;

type Phase = 'off' | 'rise' | 'gather' | 'story' | 'leg' | 'farewell' | 'fade';
type StopKind = 'grave' | 'house' | 'old';

interface Stop {
  kind: StopKind;
  /** Where he stands and which way he faces (a heading: the model's front is −Z). */
  x: number; z: number; face: number;
  /** What he points at. */
  px: number; py: number; pz: number;
}

interface Tourist {
  a: PedAgent;
  act: Actor;
  phone: boolean;
  /** Where to stand at the current stop. */
  tx: number; tz: number;
  lineT: number;
}

interface Tour {
  seed: number;
  rng: Rng;
  cemetery: boolean;
  /** Rising from / sinking into the tomb (cemetery tours): its spot. */
  tomb: { x: number; z: number } | null;
  stops: Stop[];
  si: number;
  tourists: Tourist[];
  /** The current story (three lines) and the next line. */
  story: readonly [string, string, string] | null;
  line: number;
  /** This leg goes through a building (he glides through, they walk round). */
  phasing: boolean;
  /** Stops the player stood by for. */
  heard: number;
  said: Set<GhostTopic>;
  /** Started from the admin console: at any hour. */
  anyHour?: boolean;
}

export class GhostGuide {
  /** Off: no tours start (dev, tests). */
  enabled = true;
  readonly group = new THREE.Group();
  private rig: HumanoidRig | null = null;
  private ready = false;
  private compiling = false;
  /** Where he is (feet, with the hover), facing, the fade 0..1. */
  readonly pos = { x: 0, y: 0, z: 0 };
  private heading = 0;
  private fade = 0;
  private hover = 0;
  private sink = 0;
  private phase: Phase = 'off';
  private t = 0;
  private time = 0;
  private restT = 20;
  private tryT = 0;
  private tour: Tour | null = null;
  private action: ActionAnim | undefined;
  private look: [number, number, number] | undefined;
  private playerT = 0;
  private throughT = 0;
  private hitT = 0;
  private nextSeed = 1;
  private devDone = false;
  /** His speech-bubble anchor (Barks keeps its pause by this object). */
  private readonly anchor = { x: 0, y: 0, z: 0, alive: true };
  stats = { tours: 0, finished: 0, scared: 0, lines: 0, phased: 0 };

  constructor(private g: Game) {
    g.renderer.scene.add(this.group);
    g.stimuli.on((s) => this.onStimulus(s));
  }

  /** On a tour (or rising, fading): where he is, for tests and the admin console. */
  get active(): boolean { return this.phase !== 'off'; }

  update(dt: number): void {
    const g = this.g;
    if (!this.devDone) this.installDev();
    this.time += dt;
    this.playerT -= dt; this.throughT -= dt; this.hitT -= dt;
    if (this.phase === 'off') {
      this.restT -= dt;
      this.tryT -= dt;
      if (this.enabled && this.restT <= 0 && this.tryT <= 0) { this.tryT = 3; this.tryStart(); }
      this.draw(dt);
      return;
    }
    this.t += dt;
    const T = this.tour!;
    const p = g.player.pos;
    if (Math.hypot(p.x - this.pos.x, p.z - this.pos.z) > DROP_R) { this.end(false); return; }
    // Dawn: the tour ends where it is.
    if (!T.anyHour && !tourHours(g.sky.hoursAbs) && this.phase !== 'farewell' && this.phase !== 'fade') { this.say('dawn'); this.farewell(false); }
    // A giant in the street: the tourists run.
    if (!g.freeCam && g.player.height > 6 && Math.hypot(p.x - this.pos.x, p.z - this.pos.z) < 14 * g.player.height && T.tourists.length) this.scare(p.x, p.z);
    this.tourists(dt);
    switch (this.phase) {
      case 'rise': this.rising(); break;
      case 'gather': this.gathering(); break;
      case 'story': this.telling(); break;
      case 'leg': this.leg(dt); break;
      case 'farewell': this.farewelling(); break;
      case 'fade': if (this.fade <= 0.01) this.end(true); break;
    }
    this.player(dt);
    this.draw(dt);
  }

  // ================================================================== starting

  private tryStart(): void {
    const g = this.g, p = g.player.pos;
    if (!tourHours(g.sky.hoursAbs) || nightLeft(g.sky.hoursAbs) < 0.6) return;
    if (g.camRig.underground || g.player.height > 6 || g.intro) return;
    const seed = deriveSeed(g.settings.seed, 'ghost-tour', this.nextSeed);
    const plan = this.planCemetery(p.x, p.z, seed) ?? this.planOldTown(p.x, p.z, seed);
    if (plan) this.begin(plan, seed);
  }

  /** A tour from the nearest cemetery's main tomb (within FIND_R), or null. */
  private planCemetery(x: number, z: number, seed: number): Omit<Tour, 'tourists' | 'si' | 'story' | 'line' | 'phasing' | 'heard' | 'said'> | null {
    const g = this.g, rng = new Rng(seed);
    let tomb: { x: number; z: number; yaw: number; d: number } | null = null;
    g.props.query(x, z, FIND_R, (t) => {
      if (!t.kind.startsWith('furn:tomb:0')) return;
      const d = Math.hypot(t.x - x, t.z - z);
      if (!tomb || d < tomb.d) tomb = { x: t.x, z: t.z, yaw: t.yaw, d };
    });
    if (!tomb) return null;
    const tb = tomb as { x: number; z: number; yaw: number; d: number };
    const pieces: GravePiece[] = [];
    g.props.query(tb.x, tb.z, 45, (t) => {
      if (t.kind.startsWith('furn:gravestone:') || t.kind.startsWith('furn:grave:') || t.kind === 'furn:tomb:1') pieces.push({ x: t.x, z: t.z, yaw: t.yaw });
    });
    const ground = (x: number, z: number) => g.terrain.height(x, z);
    const stops: Stop[] = cemeteryStops(tb, pieces, (a) => rng.shuffle(a)).map((s, i) => ({ kind: 'grave', x: s.x, z: s.z, face: s.face, px: s.px, py: ground(s.px, s.pz) + (i === 0 ? 2 : 0.6), pz: s.pz }));
    const start = stops[0];
    if (stops.length < 3) return null;
    // Then a house or two outside the walls (often through the wall, or a house, to get there).
    const last = stops[stops.length - 1];
    // (Not far from the gate: the group walks back to the tomb at the end.)
    const home = (s: Stop | null) => !!s && Math.hypot(s.x - start.x, s.z - start.z) < 55;
    const house = this.houseStop(last.x, last.z, 22, 55, rng, stops);
    if (home(house)) {
      stops.push(house!);
      const h2 = this.houseStop(house!.x, house!.z, 20, 45, rng, stops);
      if (home(h2) && rng.chance(0.6)) stops.push(h2!);
    }
    // Back to the tomb to say goodbye (and sink into it).
    stops.push({ ...start });
    return { seed, rng, cemetery: true, tomb: { x: tb.x, z: tb.z }, stops };
  }

  /** In the old town: from a fountain, statue or old lamp, houses and corners round it. */
  private planOldTown(x: number, z: number, seed: number): Omit<Tour, 'tourists' | 'si' | 'story' | 'line' | 'phasing' | 'heard' | 'said'> | null {
    const g = this.g, rng = new Rng(seed);
    if (this.districtAt(x, z) !== 'oldtown') return null;
    const olds = this.oldSpots(x, z, 150);
    if (!olds.length) return null;
    const o = olds.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
    const stops: Stop[] = [o];
    for (let k = 0; k < 5 && stops.length < 5; k++) {
      const prev = stops[stops.length - 1];
      const next = rng.chance(0.65) ? this.houseStop(prev.x, prev.z, 20, 60, rng, stops) : this.oldStop(prev.x, prev.z, rng, stops);
      if (next) stops.push(next);
    }
    if (stops.length < 3) return null;
    return { seed, rng, cemetery: false, tomb: null, stops };
  }

  /** Fountains, statues and old lamps near a point, as stops. */
  private oldSpots(x: number, z: number, r: number): Stop[] {
    const g = this.g, out: Stop[] = [];
    g.props.query(x, z, r, (t) => {
      if (!(t.kind.startsWith('furn:fountain') || t.kind.startsWith('furn:statue') || t.kind.startsWith('furn:lampClassic'))) return;
      const big = !t.kind.startsWith('furn:lamp');
      const off = big ? 2.6 : 1.3, ang = t.yaw;
      const sx = t.x - Math.sin(ang) * off, sz = t.z - Math.cos(ang) * off;
      if (!g.world.standable(sx, sz)) return;
      out.push({ kind: 'old', x: sx, z: sz, face: ang, px: t.x, py: g.terrain.height(t.x, t.z) + (big ? 1.8 : 3.5), pz: t.z });
    });
    return out;
  }

  private oldStop(x: number, z: number, rng: Rng, taken: Stop[]): Stop | null {
    const c = this.oldSpots(x, z, 70).filter((s) => { const d = Math.hypot(s.x - x, s.z - z); return d > 18 && !taken.some((t) => Math.hypot(t.x - s.x, t.z - s.z) < 14); });
    return c.length ? rng.pick(c) : null;
  }

  /**
   * A house to stop at, r0 … r1 m away: its door, him a step out in front, pointing up the facade.
   * Now and then one that is reached through another building (the straight line crosses it).
   */
  private houseStop(x: number, z: number, r0: number, r1: number, rng: Rng, taken: Stop[]): Stop | null {
    const g = this.g, W = g.world;
    const through: Stop[] = [], open: Stop[] = [];
    for (const b of W.buildingsIn(x - r1, z - r1, x + r1, z + r1)) {
      if (!b.alive) continue;
      const d = doorOf(b.desc);
      const sx = d.x + d.nx * 1.2, sz = d.z + d.nz * 1.2, dd = Math.hypot(sx - x, sz - z);
      if (dd < r0 || dd > r1 || !W.standable(sx, sz)) continue;
      if (taken.some((t) => Math.hypot(t.x - sx, t.z - sz) < 14)) continue;
      const s: Stop = { kind: 'house', x: sx, z: sz, face: headingTo(sx, sz, sx + d.nx, sz + d.nz), px: d.x - d.nx * 0.5, py: g.terrain.height(d.x, d.z) + 4, pz: d.z - d.nz * 0.5 };
      (crossesBuilding(x, z, sx, sz, (px, pz) => !!W.buildingAt(px, pz)) ? through : open).push(s);
    }
    if (through.length && (rng.chance(0.7) || !open.length)) return rng.pick(through);
    return open.length ? rng.pick(open) : null;
  }

  private districtAt(x: number, z: number): string | null {
    let best: string | null = null, bd = Infinity;
    for (const c of this.g.macro.cells) {
      const d = Math.hypot(c.centroid[0] - x, c.centroid[1] - z);
      if (d < bd) { bd = d; best = c.district; }
    }
    return best;
  }

  private begin(plan: Omit<Tour, 'tourists' | 'si' | 'story' | 'line' | 'phasing' | 'heard' | 'said'>, _seed: number): void {
    const g = this.g;
    this.nextSeed++;
    const T: Tour = { ...plan, tourists: [], si: 0, story: null, line: 0, phasing: false, heard: 0, said: new Set() };
    this.tour = T;
    this.stats.tours++;
    const s0 = T.stops[0];
    // He appears at the tomb (cemetery) or on the spot, fading in.
    const from = T.tomb ?? s0;
    this.pos.x = from.x; this.pos.z = from.z;
    this.heading = s0.face;
    this.fade = 0;
    this.sink = T.tomb ? 1.1 : 0;
    this.phase = 'rise';
    this.t = 0;
    this.action = undefined;
    this.ensureRig();
    // The group: walking in from down the street when the spot is in view, else already there.
    const n = 4 + T.rng.int(0, 3);
    const seen = g.crime.visible(s0.x, g.terrain.height(s0.x, s0.z) + 1, s0.z);
    for (let i = 0; i < n; i++) {
      const slot = tourSlot(s0.x, s0.z, s0.face, i, n);
      let sx = slot.x, sz = slot.z;
      if (seen) {
        const ang = T.rng.float() * Math.PI * 2, r = 14 + T.rng.float() * 10;
        const wx = s0.x + Math.sin(ang) * r, wz = s0.z + Math.cos(ang) * r;
        if (g.world.standable(wx, wz)) { sx = wx; sz = wz; }
      }
      const t = this.spawnTourist(T, i, sx, sz, headingTo(sx, sz, s0.x, s0.z));
      if (t) { t.tx = slot.x; t.tz = slot.z; }
    }
  }

  private spawnTourist(T: Tour, i: number, x: number, z: number, heading: number): Tourist | null {
    const g = this.g;
    let cit = null;
    for (let k = 0; k < 20; k++) {
      const c = g.population.synthetic(hash32(T.seed * 31 + i * 7919 + k * 104729) || 1);
      if (c.role !== Role.Child) { cit = c; break; }
    }
    if (!cit) return null;
    const a = g.peds.spawnAt(cit, x, z, heading);
    if (!a) return null;
    const phone = T.rng.chance(0.4);
    const act = attach(a, makeActor('bystander', GHOST_OWNER, { title: 'Tourist', held: phone ? 'phone' : null, mood: 'happy' }));
    a.pref = 1.2;
    const t: Tourist = { a, act, phone, tx: x, tz: z, lineT: 6 + T.rng.float() * 10 };
    T.tourists.push(t);
    return t;
  }

  // ================================================================== the tour

  private rising(): void {
    const T = this.tour!, s0 = T.stops[0];
    this.fade = Math.min(1, this.t / 2.2);
    this.sink = T.tomb ? Math.max(0, 1.1 * (1 - this.t / 2.2)) : 0;
    if (T.tomb && this.t > 1.2) this.glideTo(s0.x, s0.z, GLIDE * 0.8, 1 / 60);
    if (this.t > 2.4) { this.phase = 'gather'; this.t = 0; this.say('welcome'); this.act('gesture_wave', 1.8); }
  }

  /** Waiting for the group at the meeting point (they walk in). */
  private gathering(): void {
    const T = this.tour!, s0 = T.stops[0];
    this.glideTo(s0.x, s0.z, GLIDE, 1 / 60);
    if (this.near(s0) && this.groupThere(0.7) || this.t > 30) {
      if (!T.tourists.length) { this.say('lost'); this.farewell(false); return; }
      this.startStory();
    }
  }

  private startStory(): void {
    const T = this.tour!, s = T.stops[T.si];
    const set = s.kind === 'grave' ? STORIES.graveStory : s.kind === 'house' ? STORIES.houseStory : STORIES.oldStory;
    T.story = T.rng.pick(set);
    T.line = 0;
    this.phase = 'story';
    this.t = LINE_T - 0.6;
    this.heading = s.face;
    this.act('gesture_point', 1.4);
    if (Math.hypot(this.g.player.pos.x - s.x, this.g.player.pos.z - s.z) < TALK_R && !this.g.freeCam) T.heard++;
  }

  private telling(): void {
    const T = this.tour!, s = T.stops[T.si];
    this.look = [s.px, s.py, s.pz];
    this.glideTo(s.x, s.z, 0.6, 1 / 60);
    if (!this.action || this.action.id === 'talk') this.hold('talk');
    if (this.t < LINE_T) return;
    this.t = 0;
    if (!T.story || T.line >= 3) {
      // Story over: on to the next stop (the last one is the goodbye).
      if (T.si >= T.stops.length - 2) { T.si = T.stops.length - 1; this.startLeg(); return; }
      T.si++;
      this.startLeg();
      return;
    }
    this.speak(T.story[T.line]);
    if (T.line === 0) this.act('gesture_point', 1.3);
    if (T.line === 2) {
      // The punchline: the group laughs and claps, a few take photos.
      for (const t of T.tourists) {
        const r = T.rng.float();
        if (r < 0.35) play(t.act, 'clap', 2.2);
        else if (r < 0.55) play(t.act, 'cheer', 1.6);
        if (T.rng.chance(0.25)) this.touristSay(t, T.rng.chance(0.5) ? TOURIST_LINES.laugh : TOURIST_LINES.clap);
      }
    } else if (T.line === 1 && T.rng.chance(0.4)) {
      this.act('gesture_shrug', 1.2);
      for (const t of T.tourists) if (T.rng.chance(0.3)) play(t.act, 'flinch', 0.7);
    }
    T.line++;
  }

  /** On to stop si: through a wall if that is the straight way, the group by the street. */
  private startLeg(): void {
    const g = this.g, T = this.tour!, s = T.stops[T.si];
    this.phase = 'leg';
    this.t = 0;
    T.phasing = crossesBuilding(this.pos.x, this.pos.z, s.x, s.z, (x, z) => !!g.world.buildingAt(x, z));
    if (T.phasing) { this.stats.phased++; this.say('phaseStart'); this.hold('talk', 3); }
    else this.say(T.si === T.stops.length - 1 ? 'follow' : 'start');
    const n = T.tourists.length;
    T.tourists.forEach((t, i) => {
      const slot = tourSlot(s.x, s.z, s.face, i, n);
      t.tx = slot.x; t.tz = slot.z;
      const a = t.a, act = t.act;
      act.route = crossesBuilding(a.x, a.z, slot.x, slot.z, (x, z) => !!g.world.buildingAt(x, z)) ? g.peds.buildRoute(a.x, a.z, slot.x, slot.z) : null;
      act.wp = 1;
      act.stuckT = 0;
      act.action = null;
    });
    if (T.phasing && T.tourists.length) this.touristSay(T.rng.pick(T.tourists), TOURIST_LINES.wall, 1.6);
  }

  private leg(_dt: number): void {
    const T = this.tour!, s = T.stops[T.si];
    this.look = undefined;
    if (!this.near(s)) {
      // Leading: not too far ahead of the group (through a wall he goes on regardless).
      const lag = T.phasing ? 0 : this.groupLag();
      this.glideTo(s.x, s.z, lag > 9 ? 0.2 : GLIDE, 1 / 60);
      return;
    }
    this.heading += angleDiff(this.heading, s.face) * 0.05;
    if (this.groupThere(0.65) || this.t > LEG_MAX || !T.tourists.length) {
      if (T.phasing) { this.say('phaseEnd'); this.act('bow', 1.2); T.phasing = false; this.t = -2.5; return; }
      if (this.t < 0) return;
      if (T.si === T.stops.length - 1) { this.farewell(true); return; }
      this.startStory();
    }
  }

  private farewell(done: boolean): void {
    const T = this.tour!;
    this.phase = 'farewell';
    this.t = 0;
    if (done) {
      this.say('farewell');
      this.act('bow', 2);
      this.stats.finished++;
      for (const t of T.tourists) if (T.rng.chance(0.7)) play(t.act, 'clap', 2.5);
    }
    T.story = null;
    if (done && T.heard >= 3 && T.stops.length >= 4) this.g.later.after(4.6, () => { if (this.tour === T) this.speak(ghostLine('thanks', () => T.rng.float()), true); });
  }

  private farewelling(): void {
    const T = this.tour!;
    if (this.t > 3) this.release(false);
    if (this.t > 6 || !T.tourists.length && this.t > 3) {
      this.phase = 'fade';
      this.t = 0;
    }
  }

  /** The tour is over: everyone goes; he is gone (and rests a while). */
  private end(finished: boolean): void {
    this.release(!finished);
    this.tour = null;
    this.phase = 'off';
    this.fade = 0;
    this.action = undefined;
    this.restT = REST[0] + new Rng(deriveSeed(this.g.settings.seed, 'ghost-rest', this.nextSeed)).float() * (REST[1] - REST[0]);
  }

  // ================================================================== the group

  private tourists(dt: number): void {
    const T = this.tour!, g = this.g;
    for (let i = T.tourists.length - 1; i >= 0; i--) {
      const t = T.tourists[i], a = t.a, act = t.act;
      if (!a.alive || a.actor !== act) { T.tourists.splice(i, 1); continue; }
      if (a.ragdoll) continue;
      // Hit, knocked down: this one runs (an ordinary passer-by from now on); the others gasp.
      if (act.hitByPlayer || a.state === PState.Down || act.state === 'down' || act.state === 'ko' || act.staggerT > 0) {
        T.tourists.splice(i, 1);
        this.handOver(a, true, g.player.pos.x, g.player.pos.z);
        for (const o of T.tourists) if (T.rng.chance(0.5)) play(o.act, 'flinch', 0.7);
        continue;
      }
      const d = Math.hypot(t.tx - a.x, t.tz - a.z);
      if (this.phase === 'farewell' || this.phase === 'fade') { stand(act); act.face = this.faceGhost(a); continue; }
      if (act.route && followRoute(a, act, WALK) && act.stuckT < 4) { this.chat(t, dt); continue; }
      act.route = null;
      if (d > 0.6 && act.stuckT < 3) { goTo(act, t.tx, t.tz, d > 2.5 ? WALK : 0.8); this.chat(t, dt); continue; }
      stand(act);
      act.face = this.faceGhost(a);
      // Watching: photos of the ghost now and then.
      if (t.phone && this.phase === 'story' && (!act.action || act.action.id === 'take_photo')) {
        if (T.rng.float() < dt * 0.12 || act.action?.id === 'take_photo') hold(act, 'take_photo', 1.4);
        if ((act.action?.age ?? 0) > 5) act.action = null;
      }
      this.chat(t, dt);
    }
  }

  private chat(t: Tourist, dt: number): void {
    t.lineT -= dt;
    if (t.lineT > 0) return;
    t.lineT = 14 + this.tour!.rng.float() * 18;
    if (this.phase === 'story' || this.phase === 'gather') this.touristSay(t, this.tour!.rng.chance(0.5) ? TOURIST_LINES.awe : TOURIST_LINES.gasp);
  }

  private touristSay(t: Tourist, lines: readonly string[], delay = 0): void {
    const T = this.tour!;
    const line = T.rng.pick(lines);
    const go = () => { if (t.a.alive && t.a.actor === t.act) this.g.barks.say(t.a, line, 8); };
    if (delay > 0) this.g.later.after(delay, go); else go();
  }

  private faceGhost(a: PedAgent): { x: number; y: number; z: number } {
    return { x: this.pos.x, y: this.pos.y + 1.6, z: this.pos.z };
  }

  /** Share of the group (at least `share`) standing at their places. */
  private groupThere(share: number): boolean {
    const L = this.tour!.tourists;
    if (!L.length) return true;
    let n = 0;
    for (const t of L) if (Math.hypot(t.tx - t.a.x, t.tz - t.a.z) < 1.6) n++;
    return n >= Math.ceil(L.length * share);
  }

  /** How far the group's middle is behind him (m). */
  private groupLag(): number {
    const L = this.tour!.tourists;
    if (!L.length) return 0;
    let x = 0, z = 0;
    for (const t of L) { x += t.a.x; z += t.a.z; }
    return Math.hypot(x / L.length - this.pos.x, z / L.length - this.pos.z);
  }

  /** Let the group go: walking off (or running, `flee`). */
  private release(flee: boolean, fx = this.pos.x, fz = this.pos.z): void {
    const T = this.tour;
    if (!T) return;
    for (const t of T.tourists) this.handOver(t.a, flee, fx, fz);
    T.tourists.length = 0;
  }

  private handOver(a: PedAgent, flee: boolean, fx: number, fz: number): void {
    const g = this.g;
    if (!a.alive || a.actor?.owner !== GHOST_OWNER) return;
    a.actor = undefined;
    // Off somewhere: a door down the street.
    const doors = g.world.buildingsIn(a.x - 60, a.z - 60, a.x + 60, a.z + 60).filter((b) => b.alive);
    if (doors.length) {
      const d = doorOf(doors[hash32(a.id * 13 + 7) % doors.length].desc);
      const r = g.peds.buildRoute(a.x, a.z, d.x, d.z);
      if (r) { a.route = r; a.wp = 1; a.dest = { x: d.x, z: d.z }; }
    }
    if (a.state === PState.Down) return;
    if (flee) { a.state = PState.Flee; a.fear = Math.max(a.fear, 1.1); a.fearX = fx; a.fearZ = fz; a.stateT = 0; }
    else { a.state = PState.Walk; a.stateT = 0; a.fear = 0; }
  }

  // ================================================================== danger, the player

  private onStimulus(s: Stimulus): void {
    if (!this.tour || this.phase === 'fade') return;
    const d = Math.hypot(this.pos.x - s.x, this.pos.z - s.z);
    switch (s.kind) {
      case 'blast': case 'collapse': case 'sonic': case 'roar': case 'threat': case 'gunfire':
        if (d < s.radius + 10) this.scare(s.x, s.z);
        break;
      case 'crash':
        if (d < 25) this.scare(s.x, s.z);
        break;
      case 'stomp':
        if ((s.size ?? 0) > 4 && d < s.radius) this.scare(s.x, s.z);
        break;
      case 'siren':
        if (s.evac && d < s.radius) this.scare(s.x, s.z);
        break;
      case 'power': case 'impact':
        // Right through him.
        if (d < 3 && this.hitT <= 0) { this.hitT = 8; this.say('hitThrough'); }
        else if (s.kind === 'power' && d < s.radius * 0.6) this.scare(s.x, s.z);
        break;
      default: break;
    }
  }

  /** Danger: the group runs, he sighs and fades away. */
  private scare(fx: number, fz: number): void {
    if (!this.tour || this.phase === 'fade') return;
    this.stats.scared++;
    this.release(true, fx, fz);
    this.say('scared');
    this.phase = 'fade';
    this.t = 0;
  }

  /** His words for the player. */
  private player(_dt: number): void {
    const g = this.g, P = g.player, T = this.tour!;
    if (g.freeCam || this.phase === 'fade' || this.phase === 'rise') return;
    const dp = Math.hypot(P.pos.x - this.pos.x, P.pos.z - this.pos.z);
    // Walked into him.
    if (dp < 0.75 && P.height < 2.5 && this.throughT <= 0) { this.throughT = 12; this.say('through'); return; }
    // (Not in the middle of a story bubble.)
    const midStory = this.phase === 'story' && T.line < 3 && LINE_T - this.t > 1.2;
    if (this.playerT > 0 || dp > TALK_R || midStory) return;
    const rep = g.crime?.rep.value ?? 0, wanted = g.crime?.justice.wanted ?? 0;
    let top: GhostTopic | null = null;
    if (P.flying) top = 'fly';
    else if (P.height > 2.4) top = 'giant';
    else if (P.height < 0.6 && dp < 8) top = 'tiny';
    else if (wanted > 0) top = 'wanted';
    else if (rep >= 40 && dp < 12) top = 'hero';
    else if (rep <= -40 && dp < 12) top = 'villain';
    else if (dp < INVITE_R && this.phase !== 'farewell') top = 'invite';
    if (!top || T.said.has(top)) return;
    if (this.say(top)) { T.said.add(top); this.playerT = 14; if (top === 'hero') for (const t of T.tourists) if (T.rng.chance(0.6)) play(t.act, 'clap', 2); }
  }

  // ================================================================== moving, talking

  private near(s: { x: number; z: number }): boolean {
    return Math.hypot(s.x - this.pos.x, s.z - this.pos.z) < 0.35;
  }

  private glideTo(x: number, z: number, speed: number, _f: number): void {
    const dx = x - this.pos.x, dz = z - this.pos.z, d = Math.hypot(dx, dz);
    const dt = this.lastDt;
    if (d < 0.05) return;
    const step = Math.min(d, speed * dt * (d < 0.8 ? Math.max(0.3, d / 0.8) : 1));
    this.pos.x += (dx / d) * step; this.pos.z += (dz / d) * step;
    if (d > 0.5) this.heading += angleDiff(this.heading, headingTo(0, 0, dx, dz)) * Math.min(1, dt * 3);
  }
  private lastDt = 1 / 60;

  private say(topic: Exclude<GhostTopic, 'graveStory' | 'houseStory' | 'oldStory'>): boolean {
    const T = this.tour;
    const r = T ? () => T.rng.float() : () => 0.5;
    return this.speak(ghostLine(topic, r));
  }

  /** A bubble over him (now, past the gap: his is the voice of the tour). */
  private speak(text: string, force = false): boolean {
    const B = this.g.barks;
    if (!B) return false;
    this.anchor.x = this.pos.x; this.anchor.y = this.pos.y; this.anchor.z = this.pos.z;
    const ok = B.sayAt(this.anchor, text, { pause: force ? 0 : 1, voice: true });
    if (ok) this.stats.lines++;
    return ok;
  }

  private act(id: string, dur: number): void {
    this.action = { id, t0: this.time, dur };
  }

  private hold(id: string, dur = 1.4): void {
    if (this.action?.id !== id || this.time > this.action.t0 + this.action.dur) this.action = { id, t0: this.time, dur };
    else this.action.dur = this.time - this.action.t0 + dur;
  }

  // ================================================================== drawing

  private ensureRig(): void {
    if (this.rig) return;
    const seed = deriveSeed(this.g.settings.seed, 'ghost-guide');
    const rig = new HumanoidRig(ghostAppearance(seed), { castShadow: false, fixedLod: 0, priority: 4 });
    rig.setEquipment(ghostOutfit(seed));
    // (Hidden by its object only: setVisible before it is dressed would leave the body hidden.)
    rig.object.visible = false;
    this.group.add(rig.object);
    this.rig = rig;
  }

  private draw(dt: number): void {
    this.lastDt = Math.min(0.1, dt);
    const g = this.g, r = this.rig;
    if (!r) return;
    // The ghost shaders: once dressed, made see-through and compiled in the background.
    if (r.dressed && !this.ready && !this.compiling) {
      ghostify(r.object);
      this.compiling = true;
      void shaderCap.slot()
        .then(() => (this.rig === r ? g.renderer.compileAsync(r.object) : null))
        .catch((e) => console.warn('[ghost] compile', e))
        .then(() => { this.ready = true; this.compiling = false; });
    }
    // (Anything new on the rig later: the same look.)
    if (this.ready && ghostify(r.object) > 0) console.warn('[ghost] late material');
    const want = this.phase === 'off' || this.phase === 'fade' ? 0 : this.phase === 'rise' ? this.fade : 1;
    if (this.phase !== 'rise') this.fade += (want - this.fade) * Math.min(1, dt * (want > this.fade ? 2 : 1.3));
    if (this.phase === 'fade' && this.tour?.tomb) this.sink = Math.min(1.2, this.sink + dt * 0.5);
    const cam = g.renderer.camera.position;
    const dc = Math.hypot(this.pos.x - cam.x, this.pos.z - cam.z);
    // A faint flicker, more so as he fades; farther out he thins away.
    const far = 1 - smoothstep(DRAW_R * 0.7, DRAW_R, dc);
    const flicker = 0.93 + 0.07 * Math.sin(this.time * 7.3) * Math.sin(this.time * 2.1);
    setGhostFade(this.fade * far * flicker);
    const show = this.ready && this.phase !== 'off' && this.fade > 0.02 && dc < DRAW_R && !g.camRig.underground;
    r.object.visible = show;
    if (!show) return;
    this.hover = 0.22 + Math.sin(this.time * 1.7) * 0.06;
    const ground = g.terrain.height(this.pos.x, this.pos.z) + g.world.surfaceOffset(this.pos.x, this.pos.z);
    this.pos.y = ground + this.hover - this.sink;
    this.anchor.x = this.pos.x; this.anchor.y = this.pos.y; this.anchor.z = this.pos.z;
    const act = this.action && this.time < this.action.t0 + this.action.dur ? this.action : undefined;
    const lookAt = this.look ?? this.lookAtGroup();
    r.update({ pos: [this.pos.x, this.pos.y, this.pos.z], vel: [0, 0, 0], yaw: this.heading, anim: { move: 'idle', action: act, mood: 'happy', lookAt }, flags: 0 }, dt, this.time, cam);
  }

  private lookAtGroup(): [number, number, number] | undefined {
    const g = this.g, p = g.player.pos;
    if (!g.freeCam && Math.hypot(p.x - this.pos.x, p.z - this.pos.z) < 8) return [p.x, p.y + g.player.height * 0.9, p.z];
    const L = this.tour?.tourists;
    if (!L?.length) return undefined;
    const t = L[Math.floor(this.time / 3) % L.length];
    return [t.a.x, t.a.y + 1.6, t.a.z];
  }

  // ================================================================== dev

  /** A tour right here (dev.ghost.tour): the nearest cemetery, else a walk round the houses. */
  tourHere(): string {
    const g = this.g, p = g.player.pos;
    if (this.tour) this.end(false);
    const seed = deriveSeed(g.settings.seed, 'ghost-tour-dev', this.nextSeed);
    let plan = this.planCemetery(p.x, p.z, seed) ?? this.planOldTown(p.x, p.z, seed);
    if (!plan) {
      // Anywhere: a few steps ahead, then houses.
      const fy = g.camRig.forwardYaw, rng = new Rng(seed);
      const x = p.x - Math.sin(fy) * 8, z = p.z - Math.cos(fy) * 8;
      const stops: Stop[] = [{ kind: 'old', x, z, face: fy + Math.PI, px: x, py: p.y + 2, pz: z }];
      for (let k = 0; k < 4; k++) { const prev = stops[stops.length - 1]; const h = this.houseStop(prev.x, prev.z, 18, 55, rng, stops); if (h) stops.push(h); }
      if (stops.length < 2) return 'no room for a tour here';
      plan = { seed, rng, cemetery: false, tomb: null, stops };
    }
    this.begin(plan, seed);
    if (this.tour) this.tour.anyHour = true;
    return `${GHOST_NAME}'s tour: ${plan.stops.length} stops${plan.cemetery ? ' from the cemetery' : ''}, ${this.tour?.tourists.length ?? 0} tourists`;
  }

  private installDev(): void {
    const dev = (window as unknown as { dev?: Record<string, unknown> }).dev;
    if (!dev) return;
    this.devDone = true;
    dev.ghost = {
      guide: this,
      /** dev.ghost.tour(): a tour starts by the player now (any hour). */
      tour: () => this.tourHere(),
      end: () => { this.end(false); return 'ended'; },
      on: (v = true) => (this.enabled = v),
      state: () => ({ name: GHOST_NAME, title: GHOST_TITLE, phase: this.phase, stop: this.tour ? `${this.tour.si + 1}/${this.tour.stops.length}` : null, phasing: this.tour?.phasing ?? false, tourists: this.tour?.tourists.length ?? 0, fade: +this.fade.toFixed(2), ready: this.ready, pos: [+this.pos.x.toFixed(1), +this.pos.y.toFixed(2), +this.pos.z.toFixed(1)], rest: Math.max(0, Math.round(this.restT)), ...this.stats }),
    };
  }
}
