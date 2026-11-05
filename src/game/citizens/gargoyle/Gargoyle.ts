/**
 * The retired cathedral gargoyle: a well-known citizen with a supernatural quirk, neither hero nor
 * villain. For six hundred years it was a waterspout on the cathedral; since they put in a
 * drainpipe it is retired, and very much alive.
 *
 *   by day     stone on its ledge (a buttress top by the west front, `gargoylePlan`), as still as the
 *              statue it is supposed to be. Come right up to it (fly up) and it whispers, or winks.
 *   at dusk    it wakes (stretches, shakes off the dust, the eyes light up amber), spreads its wings
 *              and glides down to its spot on the square beside the steps.
 *   at night   it squats there and gossips with the pigeons (they gather round it), strolls about
 *              the square, chats with the hero (E): who it is, the pigeons' gossip (the rumour going
 *              round about a gang's hideout when there is one: a clue in the tracker), its tours.
 *              Passers-by stop to look and take photos.
 *   tours      at 22:00, midnight and 2:00 it gives a night tour: a few passers-by follow it to the
 *              sights nearby (the cathedral first, then the nearest landmarks), it points and talks
 *              at each one, and walks them back. The hero can tag along.
 *   trouble    a blast, a roar, gunfire nearby: "Statue! I'm a statue!" and it flies back up to its
 *              ledge and stays stone for a while. Ordinary people on its tour run like everyone else.
 *   at dawn    back up to the ledge before the sun is up.
 *
 * Far from the hero nothing is simulated: it is simply where its hours put it. The body is a small
 * skinned creature (gargoyleRig / gargoyleSkin) in the creatures' one shared material.
 */
import type { Game } from '../../Game';
import { PState, canGawk, isBystander, type PedAgent } from '../../../sim/Pedestrians';
import { makeActor, attach, release, goTo, stand, play, GARGOYLE_OWNER, type Actor } from '../../../sim/actors/Actor';
import { landmarkInterior } from '../../../plan/landmarkParts';
import { Rng, deriveSeed } from '../../../core/rng';
import { angleDiff, clamp, lerp, smoothstep } from '../../../core/math';
import type { Stimulus } from '../../Stimuli';
import type { ThreadInfo } from '../../story/knowledge';
import { sayStory } from '../../story/storyVoice';
import { GargoyleRig } from './gargoyleRig';
import { GargoyleMesh } from './GargoyleMesh';
import { gargoyleHome, awakeAt, tourStarting, tourAnnounce, tourStops, GARGOYLE_PLAN, type GargoyleHome, type TourStop } from './gargoylePlan';
import { gargoyleLine, stopLines, churchLines, rumourLine, GARGOYLE_NAMES, type GargoyleTopic } from './gargoyleLines';

/** Simulated within this of the camera (m); drawn within DRAW_R. */
const LIVE_R = 320, DRAW_R = 260;
/** Walking speed (m/s), gliding (m/s), talking reach for E (m). */
const WALK = 1.15, GLIDE = 6.5, TALK_R = 2.6;
/** Its bubbles hang this high over its feet (crouched / standing). */
const HEAD = 1.45;
/** Stone for this long after a scare (s). */
const SCARE_T = 75;
/** Most passers-by on a tour. */
const TOURISTS = 5;

type Mode = 'stone' | 'wake' | 'glide' | 'ground';
type Doing = 'sit' | 'stroll' | 'tour' | 'home';

interface Tour {
  stops: TourStop[];
  i: number;
  phase: 'walk' | 'talk';
  lines: string[];
  li: number;
  lineT: number;
  people: PedAgent[];
  /** Seconds the hero was with the group. */
  with: number;
  t: number;
}

export const GARGOYLE_THREAD = 'citizen:gargoyle';

export class Gargoyle {
  readonly home: GargoyleHome | null;
  readonly name: string;
  readonly rig = new GargoyleRig();
  private mesh: GargoyleMesh | null = null;
  private rng: Rng;
  private church: string;

  mode: Mode = 'stone';
  doing: Doing = 'sit';
  private t = 0;
  private x = 0; private y = 0; private z = 0; private yaw = 0;
  /** Gliding: from, to, how long; up to the ledge (or down to the square). */
  private glide = { ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, dur: 1, up: false };
  private path: number[] = [];
  private pi = 0;
  private doT = 0;
  private tour: Tour | null = null;
  private prevHour = -1;
  /** Mouth (talking) and line cooldowns. */
  private talkT = 0;
  private chatT = 4;
  private playerT = 0;
  private whisperT = 0;
  private scareT = 0;
  private convo = 0;
  private said = new Set<GargoyleTopic>();
  private watchT = 0;
  private feedT = 0;
  private wasRain = false;
  /** Bubble anchors: its feet, a pigeon at its feet. */
  readonly anchor = { x: 0, y: 0, z: 0, alive: true, actor: null as Actor | null };
  private pigeon = { x: 0, y: 0, z: 0 };
  private devDone = false;
  stats = { tours: 0, tourists: 0, lines: 0, scares: 0, glides: 0, talks: 0 };

  constructor(private g: Game) {
    const seed = g.settings.seed;
    this.rng = new Rng(deriveSeed(seed, 'gargoyle'));
    this.home = gargoyleHome(seed, g.macro.landmarks ?? [], (lm) => landmarkInterior(lm, g.terrain));
    this.name = GARGOYLE_NAMES[this.rng.int(0, GARGOYLE_NAMES.length - 1)];
    this.church = this.home?.lm.name ?? 'the cathedral';
    if (!this.home) return;
    // (The creatures' shared material: no program of its own; compiled during the warm-up already.)
    this.mesh = new GargoyleMesh(g.threats.mesh.material);
    g.renderer.scene.add(this.mesh.mesh);
    g.stimuli.on((s) => this.onStimulus(s));
    this.toPerch();
  }

  private get perch() { return this.home!.perch; }
  private spotY(): number { const s = this.home!.spot; return this.g.world.groundHeight(s.x, s.z); }
  private get facts() { return { name: this.name, church: this.church, street: this.g.people?.streetAt(this.x, this.z) ?? undefined }; }

  /** Stone on the ledge. */
  private toPerch(): void {
    const p = this.perch;
    this.x = p.x; this.y = p.y; this.z = p.z; this.yaw = p.h + Math.PI;
    this.mode = 'stone'; this.t = 0;
  }

  /** Squatting on its spot on the square. */
  private toSpot(): void {
    const s = this.home!.spot;
    this.x = s.x; this.z = s.z; this.y = this.spotY(); this.yaw = s.h + Math.PI;
    this.mode = 'ground'; this.doing = 'sit'; this.doT = 20 + this.rng.float() * 30; this.t = 0;
  }

  // ================================================================== per frame

  update(dt: number): void {
    if (!this.home) return;
    const g = this.g;
    if (!this.devDone) this.installDev();
    const hour = g.sky.hour;
    if (this.prevHour < 0) this.prevHour = hour;
    const cam = g.renderer.camera.position;
    const dCam = Math.hypot(cam.x - this.x, cam.z - this.z), dHome = Math.hypot(cam.x - this.home.spot.x, cam.z - this.home.spot.z);
    this.scareT = Math.max(0, this.scareT - dt);
    this.whisperT -= dt; this.playerT -= dt;
    // Far away: simply where its hours put it.
    if (Math.min(dCam, dHome) > LIVE_R) {
      if (this.tour) this.endTour(false);
      const awake = awakeAt(hour) && this.scareT <= 0;
      if (awake && this.mode !== 'ground') this.toSpot();
      else if (!awake && this.mode !== 'stone') this.toPerch();
      this.prevHour = hour;
      this.mesh?.hide();
      return;
    }
    this.t += dt;
    this.talkT = Math.max(0, this.talkT - dt);
    const r = this.rig;
    r.t += dt;
    switch (this.mode) {
      case 'stone': this.stone(hour); break;
      case 'wake': this.waking(); break;
      case 'glide': this.gliding(dt); break;
      case 'ground': this.ground(dt, hour); break;
    }
    this.prevHour = hour;
    // The body.
    r.x = this.x; r.z = this.z;
    if (this.mode !== 'glide') r.feet = this.y; else { r.feet = null; r.y = this.y; }
    r.yaw = this.yaw;
    r.gape = this.talkT > 0 ? 0.25 + 0.25 * Math.sin(r.t * 13) : 0;
    r.place();
    this.anchor.x = this.x; this.anchor.y = this.y; this.anchor.z = this.z;
    if (!this.mesh) return;
    if (!g.gate.enabled) this.mesh.warm(g.player.pos.x, g.player.pos.y - 2, g.player.pos.z);
    else if (dCam < DRAW_R) this.mesh.draw(r);
    else this.mesh.hide();
  }

  // ------------------------------------------------------------------ stone, waking, gliding

  private stone(hour: number): void {
    const r = this.rig, g = this.g, P = g.player;
    Object.assign(r, { crouch: 1, rest: 1, fold: 1, curl: 1, walk: 0, wave: 0, aim: 0, stretch: 0, lean: 0, pitch: 0, eyes: 0, still: true, look: null });
    const p = this.perch;
    this.x = p.x; this.y = p.y; this.z = p.z; this.yaw = p.h + Math.PI;
    // The hero right by it (flown up to its ledge): a whisper now and then, a wink.
    const d = Math.hypot(P.pos.x - p.x, P.pos.y - p.y, P.pos.z - p.z);
    if (!g.freeCam && d < 5 && this.whisperT <= 0) {
      this.whisperT = 25;
      if (this.rng.chance(0.6)) this.whisper();
    }
    if (awakeAt(hour) && this.scareT <= 0) { this.mode = 'wake'; this.t = 0; this.said.clear(); }
  }

  /** By day: just a whisper, and the eyes flicker. */
  private whisper(): void {
    this.say('whisper', 6);
    this.rig.eyes = 0.8;
  }

  private waking(): void {
    const r = this.rig, t = this.t, g = this.g;
    r.still = false;
    if (t < 0.05) g.audio?.play('dig_rubble', this.x, this.y + 0.6, this.z, 0.22, 1.7, 3, g.renderer.camera.position);
    // Stretch up (arms and wings), shake, settle.
    const up = smoothstep(0.3, 1.5, t) * (1 - smoothstep(2.6, 3.6, t));
    Object.assign(r, { crouch: 1 - up * 0.8, rest: 1 - up, stretch: up, fold: 1 - up * 0.85, curl: 1 - up, eyes: smoothstep(0, 1.5, t) * 0.6 });
    r.roll = Math.sin(t * 22) * 0.05 * smoothstep(3.0, 3.3, t) * (1 - smoothstep(3.6, 3.9, t));
    if (t > 1 && !this.said.has('wake')) { this.said.add('wake'); this.say('wake', 8); }
    if (t > 4.4) { r.roll = 0; this.startGlide(false); }
  }

  private startGlide(up: boolean): void {
    const s = this.home!.spot, p = this.perch;
    const G = this.glide;
    G.ax = this.x; G.ay = this.y; G.az = this.z;
    if (up) { G.bx = p.x; G.by = p.y; G.bz = p.z; } else { G.bx = s.x; G.by = this.spotY(); G.bz = s.z; }
    G.up = up;
    G.dur = Math.max(2.5, Math.hypot(G.bx - G.ax, G.by - G.ay, G.bz - G.az) / GLIDE);
    this.mode = 'glide'; this.t = 0;
    this.stats.glides++;
    const g = this.g;
    g.audio?.play('roc_flap', this.x, this.y + 0.8, this.z, 0.3, 2.4, 4, g.renderer.camera.position);
  }

  private gliding(dt: number): void {
    const G = this.glide, r = this.rig, s = clamp(this.t / G.dur, 0, 1);
    const e = s * s * (3 - 2 * s);
    // Down: a long dip with a flare before landing; up: a climb with beats, a hop onto the ledge.
    const arc = G.up ? Math.sin(s * Math.PI) * 2.5 : Math.sin(s * Math.PI) * 1.2;
    this.x = lerp(G.ax, G.bx, e); this.z = lerp(G.az, G.bz, e);
    // (The pelvis rides above the feet line by ~0.6 m in flight.)
    this.y = lerp(G.ay, G.by, G.up ? Math.sqrt(s) : e) + arc + 0.6;
    const dx = G.bx - G.ax, dz = G.bz - G.az;
    if (Math.hypot(dx, dz) > 0.5) this.yaw = Math.atan2(dx, dz);
    const flare = smoothstep(0.8, 1, s);
    Object.assign(r, { crouch: 0, rest: 0, stretch: 0, wave: 0, aim: 0, curl: 0, fold: flare * 0.6, eyes: 0.6, still: false, look: null });
    r.pitch = lerp(G.up ? 0.7 : 1.15, 0.1, flare);
    r.beat = G.up ? 1 : 0.35 + flare * 0.6;
    r.flap += dt * (G.up ? 11 : 7);
    if (s >= 1) {
      r.pitch = 0; r.beat = 0;
      this.y = G.by;
      if (G.up) { this.toPerch(); this.rig.eyes = 0; }
      else { this.toSpot(); this.g.audio?.play('dig_rubble', this.x, this.y, this.z, 0.18, 2.2, 3, this.g.renderer.camera.position); }
    }
  }

  // ------------------------------------------------------------------ on the square

  private ground(dt: number, hour: number): void {
    const g = this.g, r = this.rig, P = g.player;
    r.still = false; r.pitch = 0; r.beat = 0; r.eyes = 0.6;
    const dp = Math.hypot(P.pos.x - this.x, P.pos.z - this.z);
    const heroNear = !g.freeCam && dp < 10 && Math.abs(P.pos.y - this.y) < 4;
    // Tours: announced, then started (it walks back to its spot first).
    const ann = tourAnnounce(this.prevHour, hour);
    if (ann !== null && this.doing !== 'tour') this.say('announce', 6);
    if (tourStarting(this.prevHour, hour) !== null && this.doing !== 'tour') this.startTour();
    // Dawn: home, and up.
    if (!awakeAt(hour) && this.doing !== 'tour') {
      if (this.walkHome(dt)) { this.say('dawn', 6); this.startGlide(true); }
      return;
    }
    switch (this.doing) {
      case 'sit': this.sit(dt, heroNear, dp); break;
      case 'stroll': if (this.walk(dt)) { this.doing = 'home'; this.routeTo(this.home!.spot.x, this.home!.spot.z, false); } break;
      case 'home': if (this.walk(dt)) this.toSpot(); break;
      case 'tour': this.touring(dt); break;
    }
    // Hero lines: flying past, a giant, the rain.
    if (this.playerT <= 0 && !g.freeCam) {
      if (P.flying && dp < 25 && !this.said.has('fly')) { this.said.add('fly'); this.say('fly', 8); this.playerT = 12; }
      else if (P.height > 2.4 && dp < 30 && !this.said.has('giant')) { this.said.add('giant'); this.say('giant', 8); this.playerT = 12; }
    }
    const rain = (g.terraces?.rain ?? 0) > 0.3;
    if (rain && !this.wasRain && dp < 40) this.say('rain', 8);
    this.wasRain = rain;
    this.gawkers(dt);
    // Look at the hero when they are close (or at the one it talks to on a tour).
    if (heroNear && dp < 8 && this.doing !== 'tour') r.look = { x: P.pos.x, y: P.pos.y + P.height * 0.9, z: P.pos.z };
  }

  private sit(dt: number, heroNear: boolean, dp: number): void {
    const r = this.rig, g = this.g;
    Object.assign(r, { crouch: lerp(r.crouch, 1, Math.min(1, dt * 3)), rest: 1, fold: 1, curl: 1, walk: 0, stretch: 0, aim: 0, lean: 0 });
    r.wave = Math.max(0, r.wave - dt * 1.5);
    r.look = null;
    // Pigeons round its feet, now and then.
    this.feedT -= dt;
    const fx = this.x + Math.sin(this.yaw) * 1.4, fz = this.z + Math.cos(this.yaw) * 1.4;
    if (this.feedT <= 0) {
      this.feedT = 30;
      if (g.birds.groundNear(fx, fz, 3) < 4) g.birds.feed(fx, fz, 1.6, 6 + this.rng.int(0, 5));
    }
    // Gossip with the pigeons (the hero near enough to hear): its line, a coo back.
    this.chatT -= dt;
    if (this.chatT <= 0 && dp < 30) {
      this.chatT = 9 + this.rng.float() * 8;
      r.look = { x: fx, y: this.y + 0.1, z: fz };
      if (this.say('pigeons', 6)) {
        this.pigeon.x = fx; this.pigeon.y = this.y; this.pigeon.z = fz;
        g.later.after(2.2, () => { g.barks?.sayAt(this.pigeon, gargoyleLine('coo', this.rng.float(), this.facts)!, { head: 0.6, animal: true, pause: 3 }); });
      }
    }
    // Greet the hero walking up (once a night) with a wave.
    if (heroNear && dp < 6 && !this.said.has('greet') && !this.said.has('again')) {
      this.said.add('again');
      r.wave = 1;
      this.say(this.met() ? 'again' : 'greet', 8);
      if (!this.met()) this.meet();
    }
    this.doT -= dt;
    if (this.doT <= 0 && !heroNear) {
      // A stroll round the square.
      const s = this.home!.spot, a = this.rng.float() * Math.PI * 2, d = 4 + this.rng.float() * 8;
      const tx = s.x + Math.sin(a) * d, tz = s.z + Math.cos(a) * d;
      this.doT = 25 + this.rng.float() * 40;
      if (!this.g.world.buildingAt(tx, tz)) { this.doing = 'stroll'; this.path = [tx, tz]; this.pi = 0; }
    }
  }

  /** Passers-by stop to look at it and take photos. */
  private gawkers(dt: number): void {
    this.watchT -= dt;
    if (this.watchT > 0) return;
    this.watchT = 3;
    const g = this.g;
    const w = g.peds.nearest(this.x, this.z, 14, (a) => isBystander(a) && !a.onRoad && a.state === PState.Walk && a.fear < 0.2 && canGawk(a) && a.cit.curiosity > 0.45);
    if (!w || this.rng.float() > 0.5) return;
    w.state = this.rng.chance(0.5) ? PState.Film : PState.Gawk; w.stateT = 0;
    w.lookX = this.x; w.lookY = this.y + 0.8; w.lookZ = this.z;
  }

  // ------------------------------------------------------------------ walking

  /** Walk the path (x, z pairs); true when it is used up. */
  private walk(dt: number, speed = WALK): boolean {
    const r = this.rig;
    Object.assign(r, { crouch: lerp(r.crouch, 0.3, Math.min(1, dt * 3)), rest: 0, fold: 0.95, curl: 0, stretch: 0 });
    while (this.pi < this.path.length / 2) {
      const tx = this.path[this.pi * 2], tz = this.path[this.pi * 2 + 1];
      const dx = tx - this.x, dz = tz - this.z, d = Math.hypot(dx, dz);
      if (d < 0.35) { this.pi++; continue; }
      const step = Math.min(d, speed * dt);
      this.x += (dx / d) * step; this.z += (dz / d) * step;
      this.y = this.g.world.groundHeight(this.x, this.z, this.y + 1);
      const want = Math.atan2(dx, dz);
      this.yaw += clamp(angleDiff(this.yaw, want), -4 * dt, 4 * dt);
      r.walk = Math.min(1, r.walk + dt * 3);
      r.phase += dt * speed * 6.5;
      return false;
    }
    r.walk = Math.max(0, r.walk - dt * 4);
    return true;
  }

  /** A path to (x, z): along the sidewalks when it is far, straight across a square when near. */
  private routeTo(x: number, z: number, streets: boolean): void {
    this.path = [];
    this.pi = 0;
    const R = streets && Math.hypot(x - this.x, z - this.z) > 30 ? this.g.peds.buildRoute(this.x, this.z, x, z) : null;
    if (R) for (let i = 0; i < R.length; i += 3) this.path.push(R[i], R[i + 1]);
    this.path.push(x, z);
  }

  /** Back to its spot (true: there). */
  private walkHome(dt: number): boolean {
    const s = this.home!.spot;
    if (Math.hypot(s.x - this.x, s.z - this.z) < 0.5) return true;
    if (this.doing !== 'home') { this.doing = 'home'; this.routeTo(s.x, s.z, true); }
    return this.walk(dt);
  }

  // ------------------------------------------------------------------ night tours

  private startTour(): void {
    const g = this.g, h = this.home!;
    const stops = tourStops(h, g.macro.landmarks ?? [], this.extraSights());
    this.tour = { stops, i: 0, phase: 'walk', lines: [], li: 0, lineT: 0, people: [], with: 0, t: 0 };
    this.doing = 'tour';
    this.routeTo(h.spot.x, h.spot.z, true);
    this.stats.tours++;
    // A few passers-by come along (the curious ones).
    for (const a of g.peds.neighbours(this.x, this.z, 28, [])) {
      if (this.tour.people.length >= TOURISTS) break;
      if (!isBystander(a) || a.onRoad || a.fear > 0.2 || a.cit.curiosity < 0.3 || !canGawk(a)) continue;
      attach(a, makeActor('bystander', GARGOYLE_OWNER, { title: 'On the night tour', held: null }));
      a.pref = 1.4;
      this.tour.people.push(a);
      this.stats.tourists++;
    }
    const P = g.player.pos;
    this.say(Math.hypot(P.x - this.x, P.z - this.z) < 30 && !this.tour.people.length ? 'nobody' : 'tourStart', 4);
  }

  private touring(dt: number): void {
    const T = this.tour!, g = this.g, r = this.rig, P = g.player.pos;
    T.t += dt;
    if (Math.hypot(P.x - this.x, P.z - this.z) < 25 && !g.freeCam) T.with += dt;
    if (T.phase === 'walk') {
      r.aim = Math.max(0, r.aim - dt * 2);
      if (this.walk(dt)) {
        T.phase = 'talk'; T.li = 0; T.lineT = 0.8;
        const s = T.stops[T.i];
        T.lines = s.kind === 'church' ? churchLines(this.facts) : stopLines(s.kind, s.name, this.facts);
      } else if (this.chatT <= 0) { this.chatT = 14 + this.rng.float() * 8; this.say('walk', 6); }
      this.chatT -= dt;
    } else {
      // At a sight: face it, point, tell its lines.
      const s = T.stops[T.i];
      Object.assign(r, { crouch: lerp(r.crouch, 0.25, Math.min(1, dt * 3)), rest: 0, walk: Math.max(0, r.walk - dt * 4), fold: 0.9, curl: 0.3 });
      const want = Math.atan2(s.look.x - this.x, s.look.z - this.z);
      this.yaw += clamp(angleDiff(this.yaw, want), -2.5 * dt, 2.5 * dt);
      r.look = { x: s.look.x, y: this.y + 6, z: s.look.z };
      r.aim = T.li === 0 ? Math.min(1, r.aim + dt * 2) : Math.max(0, r.aim - dt * 1.5);
      T.lineT -= dt;
      if (T.lineT <= 0) {
        if (T.li < T.lines.length) {
          // (Said when it can be seen; the line moves on either way.)
          this.sayText(T.lines[T.li], 4);
          T.li++;
          T.lineT = 6.5;
        } else {
          T.i++;
          if (T.i >= T.stops.length) { this.endTour(true); return; }
          T.phase = 'walk';
          this.routeTo(T.stops[T.i].x, T.stops[T.i].z, true);
          this.chatT = 3;
          this.sayText(gargoyleLine('walk', this.rng.float(), this.facts)!, 4);
        }
      }
    }
    this.tourists(dt, T);
  }

  /** The followers: a little group behind it; at a sight they look and take photos. */
  private tourists(dt: number, T: Tour): void {
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    for (let i = T.people.length - 1; i >= 0; i--) {
      const a = T.people[i], act = a.actor;
      if (!a.alive || !act || act.owner !== GARGOYLE_OWNER || a.state === PState.Down) { T.people.splice(i, 1); continue; }
      const row = 1.8 + Math.floor(i / 3) * 1.1, side = ((i % 3) - 1) * 1.1;
      const talk = T.phase === 'talk';
      // Walking: behind it; at a sight: a half ring in front of it, looking at the sight.
      const tx = talk ? this.x + fx * 2.2 - fz * side * 1.3 : this.x - fx * row + fz * side;
      const tz = talk ? this.z + fz * 2.2 + fx * side * 1.3 : this.z - fz * row - fx * side;
      const d = Math.hypot(tx - a.x, tz - a.z);
      if (d > 1.2) goTo(act, tx, tz, d > 8 ? 2.6 : 1.45);
      else stand(act);
      act.face = talk ? { x: this.x, y: this.y + 1, z: this.z } : null;
      act.memo.photoT = (act.memo.photoT ?? 3 + i) - dt;
      if (talk && d < 2 && act.memo.photoT <= 0 && !act.action) { act.memo.photoT = 10 + this.rng.float() * 10; play(act, 'take_photo', 2.5); }
    }
  }

  /** Sights besides the landmarks: the metro stations (their entrances). */
  private extraSights(): TourStop[] {
    return (this.g.macro.metroStations ?? []).map((s) => ({ kind: 'station', name: `${s.name} station`, x: s.x, z: s.z, look: { x: s.x, z: s.z } }));
  }

  private endTour(told: boolean): void {
    const T = this.tour;
    if (!T) return;
    for (const a of T.people) if (a.actor?.owner === GARGOYLE_OWNER) release(a);
    this.tour = null;
    if (!told) { this.doing = 'home'; return; }
    this.say('tourEnd', 6);
    // The hero came along most of the way: noted in the tracker.
    if (T.with > T.t * 0.5 && T.t > 30) this.note(`Went on ${this.name}'s night tour: ${T.stops.map((s) => s.name).join(', ')}.`);
    this.doing = 'home';
    this.routeTo(this.home!.spot.x, this.home!.spot.z, true);
  }

  // ------------------------------------------------------------------ trouble

  private onStimulus(s: Stimulus): void {
    if (this.mode === 'stone' || !this.home) return;
    const d = Math.hypot(s.x - this.x, s.z - this.z);
    if (d > Math.min(s.radius, 60)) return;
    switch (s.kind) {
      case 'blast': case 'collapse': case 'sonic': case 'roar': case 'threat': case 'gunfire': break;
      case 'power': if (d > 20) return; break;
      case 'stomp': if ((s.size ?? 0) < 4) return; break;
      default: return;
    }
    this.scare();
  }

  /** Back up to the ledge, stone for a while. */
  private scare(): void {
    if (this.mode === 'glide' && this.glide.up) return;
    this.stats.scares++;
    this.endTour(false);
    this.sayText(gargoyleLine('danger', this.rng.float(), this.facts)!, 4, true);
    this.scareT = SCARE_T;
    this.startGlide(true);
  }

  // ------------------------------------------------------------------ the hero (E)

  private met(): boolean { return !!this.g.story?.know.threads.has(GARGOYLE_THREAD); }

  private thread(): ThreadInfo { return { id: GARGOYLE_THREAD, tab: 'people', title: `${this.name}, the ${this.home?.lm.kind === 'townhall' ? 'town hall' : 'cathedral'} gargoyle`, glyph: '♜', color: '#b8b2a4' }; }

  private note(text: string): void {
    this.g.story?.note(this.thread(), text, { src: 'heard', x: this.home!.spot.x, z: this.home!.spot.z });
  }

  private meet(): void {
    this.note(`Met ${this.name}, a retired stone gargoyle: stone on ${this.church} by day, down on the square at night. Night tours at 22:00, midnight and 2:00 from its steps.`);
    this.g.story?.place(GARGOYLE_THREAD, { x: this.home!.spot.x, z: this.home!.spot.z, label: `${this.name}'s spot (at night)` });
  }

  /** Can the hero talk to it now (where they stand)? */
  private reach(): boolean {
    if (!this.home || this.g.freeCam) return false;
    const P = this.g.player;
    if (P.height > 2.4 || this.mode === 'glide' || this.mode === 'wake') return false;
    return Math.hypot(P.pos.x - this.x, P.pos.z - this.z) < TALK_R + P.radius && Math.abs(P.pos.y - this.y) < 2;
  }

  hint(): string | null {
    if (!this.reach()) return null;
    return this.mode === 'stone' ? 'Press <b>E</b> to look at the gargoyle' : `Press <b>E</b> to talk to ${this.met() ? this.name : 'the gargoyle'}`;
  }

  /** E by it: a line of the talk (true: E was used). */
  use(): boolean {
    if (!this.reach()) return false;
    const g = this.g, P = g.player.pos;
    this.stats.talks++;
    g.gm?.met('people');
    if (this.mode === 'stone') { this.whisper(); return true; }
    this.rig.look = { x: P.x, y: P.y + 1.5, z: P.z };
    const tx = P.x - this.x, tz = P.z - this.z;
    if (this.doing !== 'tour') this.yaw = Math.atan2(tx, tz);
    if (this.doing === 'tour') { this.sayText(gargoyleLine('busy', this.rng.float(), this.facts)!, 2, true); return true; }
    if (!this.met()) { this.sayText(gargoyleLine('greet', this.rng.float(), this.facts)!, 2, true); this.meet(); this.convo = 0; return true; }
    // Round the topics: the pigeons' gossip (the rumour first, while there is one), its tours, the hero.
    const step = this.convo++ % 4;
    if (step === 0 || step === 2) {
      const R = step === 0 ? g.gm?.rumourNow() : null;
      if (R) {
        const line = rumourLine(R.text);
        this.talkT = 3;
        sayStory(g, this.anchor, line, R.info.color ?? '#d8b56a', R.info.glyph ?? '');
        g.gm!.heard(R.text);
        return true;
      }
      this.sayText(gargoyleLine('gossip', this.rng.float(), this.facts)!, 2, true);
    } else if (step === 1) this.sayText(gargoyleLine('tourInfo', this.rng.float(), this.facts)!, 2, true);
    else {
      const rep = g.crime?.rep.value ?? 0;
      this.sayText(gargoyleLine(rep >= 40 ? 'hero' : rep <= -40 ? 'villain' : 'gossip', this.rng.float(), this.facts)!, 2, true);
    }
    return true;
  }

  // ------------------------------------------------------------------ talk

  private say(topic: GargoyleTopic, pause: number): boolean {
    const line = gargoyleLine(topic, this.rng.float(), this.facts);
    return line ? this.sayText(line, pause) : false;
  }

  /** A bubble over its head (`force`: past the gap between bubbles, as an answer to the hero). */
  private sayText(text: string, pause: number, force = false): boolean {
    const ok = this.g.barks?.sayAt(this.anchor, text, { head: this.rig.crouch > 0.6 ? HEAD - 0.3 : HEAD, pause, voice: force }) ?? false;
    if (ok) { this.stats.lines++; this.talkT = Math.min(4, 0.8 + text.length * 0.04); }
    return ok;
  }

  // ------------------------------------------------------------------ dev

  /** Where it is and what it does (dev, tests). */
  status(): { name: string; mode: Mode; doing: Doing; x: number; y: number; z: number; tour: { stop: number; of: number; people: number } | null; home: string | null } {
    const T = this.tour;
    return { name: this.name, mode: this.mode, doing: this.doing, x: +this.x.toFixed(1), y: +this.y.toFixed(1), z: +this.z.toFixed(1), tour: T ? { stop: T.i, of: T.stops.length, people: T.people.length } : null, home: this.home?.lm.name ?? null };
  }

  private installDev(): void {
    this.devDone = true;
    const dev = (window as unknown as { dev?: Record<string, unknown> }).dev;
    if (!dev || !this.home) return;
    const g = this.g;
    dev.gargoyle = {
      status: () => this.status(),
      /** Put the hero in front of it (on the square at night, below its ledge by day). */
      go: () => {
        const s = this.mode === 'stone' ? this.perch : { x: this.x, y: this.y, z: this.z, h: this.yaw - Math.PI };
        const f = { x: -Math.sin(s.h), z: -Math.cos(s.h) };
        const x = s.x + f.x * 3, z = s.z + f.z * 3;
        g.player.pos.set(x, this.mode === 'stone' ? s.y : g.world.groundHeight(x, z), z);
        return this.status();
      },
      wake: () => { this.scareT = 0; if (this.mode === 'stone') { this.mode = 'wake'; this.t = 0; } return this.status(); },
      land: () => { this.scareT = 0; this.toSpot(); return this.status(); },
      tour: () => { if (this.mode !== 'ground') this.toSpot(); this.startTour(); return this.status(); },
      scare: () => { this.scare(); return this.status(); },
      stops: () => tourStops(this.home!, g.macro.landmarks ?? [], this.extraSights()).map((s) => `${s.kind} ${s.name}`),
      stats: () => this.stats,
      plan: GARGOYLE_PLAN,
    };
  }
}
