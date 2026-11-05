/**
 * Leo Lightly, the man who can't land (see plan.ts for who he is and the pure rules).
 *
 * By day, near the player's position in his home park, the family is out: Mia (12) walks from spot
 * to spot holding the string, Ben (8) trots beside her, and Leo floats a metre up behind them like
 * a balloon. He waves at passers-by, chats in speech bubbles and gets filmed a lot. Nobody is
 * there at night, on wet days, or one day in six.
 *
 * Windy days: a gust can tear the string out of Mia's hand. Leo tumbles off (treading the air) onto
 * a roof downwind and sits there. The kids run to the street below, and after a few seconds a fire
 * engine comes with its siren. A firefighter climbs its turntable ladder, takes the string, climbs
 * down with Leo in tow and hands him back to Mia. The hero can beat them to it: touch Leo and you
 * hold the string; bring him back to Mia for a little karma and reputation.
 *
 * Hit him and he spins loose too; knocked down, he floats back up afterwards. Real danger (a
 * blast, a roar, gunfire) and the family hurries home. Actors on owner FLOATER_OWNER; no lights.
 */
import * as THREE from 'three';
import type { Game } from '../../Game';
import { PState, canGawk, type PedAgent } from '../../../sim/Pedestrians';
import { Role, doorOf, type Citizen } from '../../../sim/Population';
import { makeActor, attach, play, hold, stand, goTo, followRoute, lookAt, tickActor, FLOATER_OWNER, type Actor } from '../../../sim/actors/Actor';
import { VState, type Vehicle } from '../../../sim/Traffic';
import { Rng, deriveSeed, hash32 } from '../../../core/rng';
import { clamp, lerp, smoothstep, angleDiff } from '../../../core/math';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { pointInPoly } from '../../../core/geom2';
import type { Stimulus } from '../../Stimuli';
import type { EquipmentVisuals } from '../../../items/types';
import type { CellState } from '../../../stream/CityStreamer';
import { streetSites, SiteKind } from '../../street/cast';
import { parked } from '../../aftermath/park';
import { firefighterOutfit } from '../../aftermath/FireCrew';
import { FLOATER, floaterHome, outingAt, slotOf, spotOf, gustChance, tetherStep, type Body3 } from './plan';
import { floaterLine, type FloaterTopic } from './lines';

/** The family is lived in within ACTIVE_R m of the player; beyond DROP_R (unseen) they go. */
const ACTIVE_R = 190, DROP_R = 240;
/** The hero takes the string within this of his middle (m); hands him back within this of Mia. */
const TAKE_R = 2.4, HAND_R = 4;
/** Seconds stuck on a roof before the fire engine is called; most seconds before giving up on it. */
const CALL_AFTER = 6, ENGINE_MAX = 150;
const CLIMB_SPEED = 1.4;

type Mode = 'out' | 'loose' | 'stuck' | 'hero' | 'leave';
type Holder = { kind: 'kid'; a: PedAgent } | { kind: 'ff'; a: PedAgent } | { kind: 'hero' } | null;

interface Spot { x: number; z: number }
interface Roof { x: number; y: number; z: number; edgeX: number; edgeZ: number; nx: number; nz: number; belowX: number; belowZ: number; ground: number }
interface Engine {
  car: Vehicle; crew: PedAgent[]; loop: ReturnType<Game['audio']['loop']>;
  phase: 'drive' | 'ladder' | 'up' | 'down' | 'hand' | 'pack' | 'off';
  t: number; ladder: THREE.Group | null; base: THREE.Vector3; top: THREE.Vector3; ext: number;
}

const _v = new THREE.Vector3(), _w = new THREE.Vector3();

export class Floater {
  leo: PedAgent | null = null;
  mia: PedAgent | null = null;
  ben: PedAgent | null = null;
  mode: Mode = 'out';
  private holder: Holder = null;
  private body: Body3 = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
  private home: { x: number; z: number; cell: number };
  private cells = new Map<number, { cs: CellState; spots: Spot[] }>();
  private spots: Spot[] = [];
  private spot = -1;
  private linger = 0;
  private rng: Rng;
  private time = 0;
  private syncT = 0;
  private calmT = FLOATER.gustCalm;
  private talkT = 8;
  private kidT = 14;
  private waveT = 3;
  private playerT = 0;
  private watchT = 2;
  private said = new Set<FloaterTopic>();
  private watchers: PedAgent[] = [];
  private tmp: PedAgent[] = [];
  /** Loose flight: from, to, seconds, length; then stuck on `roof` (or back to Mia without one). */
  private flight: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; t: number; dur: number; toKid: boolean } | null = null;
  private roof: Roof | null = null;
  private stuckT = 0;
  private engine: Engine | null = null;
  private devDone = false;
  private hits = 0;
  private string: THREE.Line;
  private pts: Float32Array;
  readonly group = new THREE.Group();
  /** Out regardless of the hour and the weather (dev). */
  force = false;
  enabled = true;
  stats = { spawned: 0, gusts: 0, stuck: 0, engines: 0, byFire: 0, byHero: 0, lines: 0, filmed: 0 };

  constructor(private g: Game) {
    this.home = floaterHome(g.macro);
    this.rng = new Rng(deriveSeed(g.settings.seed, 'floater'));
    g.renderer.scene.add(this.group);
    const N = 14;
    this.pts = new Float32Array(N * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pts, 3));
    this.string = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xf2efe6 }));
    this.string.frustumCulled = false;
    this.string.visible = false;
    // The ends follow the hands and the ankle as drawn this frame (no lag behind a flying hero).
    this.string.onBeforeRender = () => this.drawString();
    this.group.add(this.string);
    g.stimuli.on((s) => this.onStimulus(s));
  }

  // ================================================================== per frame

  update(dt: number): void {
    const g = this.g;
    if (!this.devDone) this.installDev();
    this.time += dt;
    this.calmT -= dt;
    this.syncT -= dt;
    if (this.syncT <= 0) { this.syncT = 1; this.sync(); }
    if (!this.leo) { this.string.visible = false; this.tickEngine(dt); return; }
    const leo = this.leo, act = leo.actor;
    if (!leo.alive || !act || act.owner !== FLOATER_OWNER) { this.despawn(); return; }
    for (const a of [leo, this.mia, this.ben]) if (a?.actor) tickActor(a.actor, dt);
    this.checkKids();
    // Knocked down or a ragdoll: lies there (the one time he lands), then floats up again.
    if (leo.ragdoll || leo.state === PState.Down) { act.memo.downed = 1; this.string.visible = false; this.tickEngine(dt); return; }
    if (act.memo.downed) { act.memo.downed = 0; this.getUp(); }
    if (act.hitByPlayer) { act.hitByPlayer = false; this.hit(); }
    switch (this.mode) {
      case 'out': this.out(dt); break;
      case 'leave': this.leave(dt); break;
      case 'loose': this.loose(dt); break;
      case 'stuck': this.stuck(dt); break;
      case 'hero': this.heroTow(dt); break;
    }
    this.tickEngine(dt);
    if (this.mode !== 'loose') this.floatOn(dt);
    this.chatter(dt);
    this.watch(dt);
    this.string.visible = true;
  }

  // ================================================================== who is where

  private focus(): { x: number; z: number } {
    const p = this.g.freeCam ? this.g.renderer.camera.position : this.g.player.pos;
    return { x: p.x, z: p.z };
  }

  private outNow(): boolean {
    const g = this.g;
    return this.force || outingAt(g.settings.seed, g.sky.hoursAbs, g.weather.p.rain);
  }

  private sync(): void {
    const g = this.g, f = this.focus(), H = this.home;
    const dHome = Math.hypot(f.x - H.x, f.z - H.z);
    // Spots in the loaded cells round his home (planned one cell per tick).
    let planned = 0;
    for (const [id, cs] of g.streamer.cells) {
      if (cs.status !== 'ready' || !cs.plan || this.cells.get(id)?.cs === cs) continue;
      const [x0, z0, x1, z1] = cs.plan.bounds;
      if (H.x < x0 - FLOATER.homeR || H.x > x1 + FLOATER.homeR || H.z < z0 - FLOATER.homeR || H.z > z1 + FLOATER.homeR) continue;
      if (planned++ > 0) break;
      const all = streetSites(cs.plan).filter((s) => Math.hypot(s.x - H.x, s.z - H.z) < FLOATER.homeR);
      const green = all.filter((s) => s.kind === SiteKind.Park || s.kind === SiteKind.Plaza);
      this.cells.set(id, { cs, spots: (green.length ? green : all).map((s) => ({ x: s.x, z: s.z })) });
    }
    for (const [id, c] of this.cells) if (g.streamer.cells.get(id) !== c.cs) this.cells.delete(id);
    this.spots = [...this.cells.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, c]) => c.spots);
    if (this.leo) {
      const d = Math.hypot(this.leo.x - f.x, this.leo.z - f.z);
      if (d > DROP_R && !g.crime.visible(this.leo.x, this.leo.y + 1, this.leo.z) && !this.engine && this.mode !== 'hero') this.despawn();
      else if (this.mode === 'out' && !this.outNow()) this.goHome();
      return;
    }
    if (!this.enabled || !this.outNow() || g.camRig.underground || this.spots.length === 0) return;
    if (dHome > ACTIVE_R + FLOATER.homeR && !this.force) return;
    // Where they are this slot; if that is in view, another spot out of view.
    const n = this.spots.length;
    let k = spotOf(g.settings.seed, slotOf(g.sky.hoursAbs), n);
    const seen = (s: Spot) => g.crime.visible(s.x, g.world.groundHeight(s.x, s.z) + 1.5, s.z) && Math.hypot(s.x - f.x, s.z - f.z) < 120;
    if (Math.hypot(this.spots[k].x - f.x, this.spots[k].z - f.z) > ACTIVE_R) return;
    if (seen(this.spots[k])) {
      for (let j = 1; j < n; j++) { const s = this.spots[(k + j) % n]; if (!seen(s) && Math.hypot(s.x - f.x, s.z - f.z) < ACTIVE_R) { k = (k + j) % n; break; } }
    }
    this.spawn(this.spots[k].x, this.spots[k].z, k);
  }

  // ================================================================== the family

  private person(seed: number, role: Role, gender: number, age: number): Citizen {
    const c = this.g.population.synthetic(hash32(seed) || 1);
    return { ...c, id: c.id, role, gender, age, nerve: 0.3, curiosity: 0.5 };
  }

  /** The family at (x, z), Leo floating behind Mia. Returns false when there was no room. */
  spawn(x: number, z: number, spot = -1, face = this.rng.range(0, Math.PI * 2)): boolean {
    const g = this.g, P = g.peds, s0 = deriveSeed(g.settings.seed, 'floater-family');
    const leoC = this.person(s0 + 1, Role.Adult, 0.92, 0.38), miaC = this.person(s0 + 2, Role.Child, 0.12, 0.15), benC = this.person(s0 + 3, Role.Child, 0.88, 0.1);
    const mia = P.spawnAt(miaC, x, z, face);
    if (!mia) return false;
    const ben = P.spawnAt(benC, x + Math.cos(face) * 0.9, z - Math.sin(face) * 0.9, face);
    const lx = x + Math.sin(face) * 1.8, lz = z + Math.cos(face) * 1.8;
    const leo = P.spawnAt(leoC, lx, lz, face);
    if (!leo || !ben) { for (const a of [mia, ben, leo]) if (a) a.alive = false; return false; }
    attach(mia, makeActor('bystander', FLOATER_OWNER, { title: 'Mia Lightly', outfit: kidOutfit(s0 + 2, [0.85, 0.3, 0.42], true), held: null, mood: 'happy' }));
    attach(ben, makeActor('bystander', FLOATER_OWNER, { title: 'Ben Lightly', outfit: kidOutfit(s0 + 3, [0.2, 0.5, 0.85], false), held: null, mood: 'happy' }));
    attach(leo, makeActor('bystander', FLOATER_OWNER, { title: 'Leo Lightly', outfit: leoOutfit(s0 + 1), held: null, mood: 'happy', hp: 60, maxHp: 60 }));
    mia.pref = ben.pref = 1.1;
    const gy = g.world.groundHeight(lx, lz);
    leo.airborne = true;
    leo.fly = { tilt: 0, bank: 0, boost: 0 };
    leo.state = PState.Idle;
    leo.gx = 1e9;
    leo.y = gy + FLOATER.hover;
    this.body = { x: lx, y: leo.y, z: lz, vx: 0, vy: 0, vz: 0 };
    this.leo = leo; this.mia = mia; this.ben = ben;
    this.holder = { kind: 'kid', a: mia };
    this.mode = 'out';
    this.spot = spot;
    this.linger = this.rng.range(15, 40);
    this.said.clear();
    this.hits = 0;
    this.stats.spawned++;
    return true;
  }

  private despawn(): void {
    for (const a of [this.leo, this.mia, this.ben]) if (a?.actor?.owner === FLOATER_OWNER) a.alive = false;
    this.leo = this.mia = this.ben = null;
    this.holder = null;
    this.flight = null; this.roof = null;
    this.watchers.length = 0;
    this.string.visible = false;
    if (this.engine && this.engine.phase !== 'off') this.packUp(this.engine, true);
  }

  /** A kid down, gone or taken over: the other one holds on; with neither, he drifts off. */
  private checkKids(): void {
    const ok = (a: PedAgent | null) => !!a && a.alive && a.actor?.owner === FLOATER_OWNER && a.state !== PState.Down && !a.ragdoll;
    for (const k of ['mia', 'ben'] as const) {
      const a = this[k];
      if (a && !ok(a)) {
        if (a.actor?.owner === FLOATER_OWNER && a.alive) a.actor.hitByPlayer = false;
        if (a.actor?.hitByPlayer || a.state === PState.Down || a.ragdoll) this.goHome(true);
      }
    }
    if (this.holder?.kind === 'kid' && !ok(this.holder.a)) {
      const other = this.holder.a === this.mia ? this.ben : this.mia;
      this.holder = ok(other) ? { kind: 'kid', a: other! } : null;
      if (!this.holder && this.mode !== 'loose') this.blowAway('gust');
    }
  }

  // ================================================================== out on the string

  private out(dt: number): void {
    const g = this.g, mia = this.kid();
    if (!mia) return;
    const ma = mia.actor!;
    // Walking to the next spot, or lingering there.
    if (ma.route) {
      if (!followRoute(mia, ma, 1.05)) { ma.route = null; this.linger = this.rng.range(25, 70); }
    } else {
      stand(ma);
      this.linger -= dt;
      if (this.linger <= 0 && this.spots.length > 1) {
        const n = this.spots.length;
        let k = spotOf(g.settings.seed, slotOf(g.sky.hoursAbs) + this.rng.int(0, 5), n);
        if (k === this.spot) k = (k + 1) % n;
        const s = this.spots[k];
        const r = g.peds.buildRoute(mia.x, mia.z, s.x, s.z);
        if (r && r.length >= 6) { ma.route = r; ma.wp = 1; this.spot = k; } else this.linger = 10;
      }
      // Standing: Mia turns to her dad now and then.
      if (Math.sin(this.time * 0.4 + 1) > 0.6 && this.leo) lookAt(ma, this.leo.x, this.leo.y + 1.5, this.leo.z);
      else ma.face = null;
    }
    this.holdPose(mia);
    this.benFollow(dt);
    // Gusts on windy days.
    if (this.calmT <= 0 && this.rng.float() < gustChance(g.weather.p.wind, dt)) this.blowAway('gust');
  }

  /** The kid holding the string: the arm back behind her while she walks, up towards him when she stands. */
  private holdPose(a: PedAgent): void {
    const act = a.actor!;
    if (act.action && act.action.id !== 'tow_string' && act.action.id !== 'hold_string') return;
    hold(act, a.speed > 0.3 ? 'tow_string' : 'hold_string', 1.5);
  }

  private benFollow(_dt: number): void {
    const ben = this.ben, mia = this.mia;
    if (!ben?.actor || !mia || this.holder?.kind === 'kid' && this.holder.a === ben) return;
    const act = ben.actor;
    // Beside Mia, on her right.
    const h = mia.heading, tx = mia.x + Math.cos(h) * 1.0, tz = mia.z - Math.sin(h) * 1.0;
    const d = Math.hypot(tx - ben.x, tz - ben.z);
    if (d > 0.5) goTo(act, tx, tz, clamp(d * 1.2, 0.6, d > 4 ? 3 : 1.6));
    else { stand(act); if (this.leo) lookAt(act, this.leo.x, this.leo.y + 1.4, this.leo.z); }
  }

  private kid(): PedAgent | null {
    return this.holder?.kind === 'kid' ? this.holder.a : this.mia?.alive ? this.mia : null;
  }

  // ================================================================== Leo's body

  /** The hand holding the string (drawn pose if there is a rig, else a guess), or null. */
  private hand(out: THREE.Vector3): THREE.Vector3 | null {
    const H = this.holder, g = this.g;
    if (!H) return null;
    if (H.kind === 'hero') {
      const s = g.player.rig.getSocket('hand.R');
      if (s) return s.getWorldPosition(out);
      const p = g.player.pos;
      return out.set(p.x, p.y + g.player.height * 0.55, p.z);
    }
    const a = H.a, rig = g.crowd.rigFor(a.id), s = rig?.getSocket('hand.R');
    if (s && rig!.object.visible) return s.getWorldPosition(out);
    const h = a.heading, back = a.speed > 0.3 ? 0.3 : -0.35, up = H.kind === 'ff' ? 1.6 : 1.05;
    return out.set(a.x + Math.cos(h) * 0.22 + Math.sin(h) * back, a.y + up, a.z - Math.sin(h) * 0.22 + Math.cos(h) * back);
  }

  /** His ankle (the string is tied to his right ankle). */
  private ankle(out: THREE.Vector3): THREE.Vector3 {
    const leo = this.leo!, rig = this.g.crowd.rigFor(leo.id);
    const b = rig?.char && rig.object.visible ? rig.char.bone('foot.R') : null;
    if (b) return b.getWorldPosition(out);
    return out.set(leo.x, leo.y + 0.1, leo.z);
  }

  /** On a string or hovering: the tether, the hover spring, the wind; facing and pose. */
  private floatOn(dt: number): void {
    const g = this.g, leo = this.leo!, b = this.body, act = leo.actor!;
    const hand = this.mode === 'stuck' ? null : this.hand(_v);
    const floor = this.mode === 'stuck' && this.roof ? this.roof.y : g.world.groundHeight(b.x, b.z, b.y + 0.6);
    const bob = Math.sin(this.time * 1.3) * 0.07 + Math.sin(this.time * 0.47) * 0.05;
    const W = g.weather.p.wind, wd = g.weather.windDir;
    const push = (0.15 + W * 1.2) * (0.6 + 0.4 * Math.sin(this.time * 0.9));
    const wind = { x: Math.cos(wd) * push, z: Math.sin(wd) * push };
    if (this.mode === 'stuck' && this.roof) {
      // Pinned against something on the roof: bobbing in place.
      const R = this.roof;
      b.vx += (R.x - b.x) * 4 * dt; b.vz += (R.z - b.z) * 4 * dt;
    }
    const px = b.x, pz = b.z;
    const held = !!hand && !(this.holder?.kind === 'ff' && this.engine?.phase === 'down');
    tetherStep(b, hand, FLOATER.string, floor + FLOATER.hover + bob, wind, dt);
    // On the way down a ladder the firefighter pulls him along: the string, not the hover.
    if (hand && !held) { const want = hand.y + 0.3; if (b.y > want) b.y = lerp(b.y, want, 1 - Math.exp(-3 * dt)); }
    // Not into walls: a façade higher than his feet stops him.
    if (this.mode !== 'stuck' && g.world.groundHeight(b.x, b.z, b.y + 0.6) > b.y + 0.4) { b.x = px; b.z = pz; b.vx *= -0.3; b.vz *= -0.3; }
    leo.x = b.x; leo.y = b.y; leo.z = b.z;
    leo.vx = b.vx; leo.vy = b.vy; leo.vz = b.vz;
    const hs = Math.hypot(b.vx, b.vz);
    leo.speed = hs;
    leo.airborne = true;
    act.move = null;
    // Facing: the way he drifts when towed, else whoever he waves at (or the kid).
    let face: { x: number; z: number } | null = null;
    if (act.face) face = act.face;
    else if (hand && hs < 0.4) face = { x: hand.x, z: hand.z };
    const want = face ? Math.atan2(-(face.x - leo.x), -(face.z - leo.z)) : hs > 0.4 ? Math.atan2(-b.vx, -b.vz) : leo.heading;
    leo.heading += angleDiff(leo.heading, want) * (1 - Math.exp(-2.5 * dt));
    leo.fly = { tilt: clamp(hs * 0.06, 0, 0.14), bank: 0, boost: 0 };
  }

  // ================================================================== blown away

  /** Torn loose (a gust, a blow): he tumbles off onto a roof downwind (or just away and back). */
  private blowAway(why: 'gust' | 'hit'): void {
    const g = this.g, leo = this.leo;
    if (!leo || this.mode === 'loose' || this.mode === 'stuck') return;
    this.calmT = FLOATER.gustCalm;
    this.stats.gusts++;
    const ex = this.holder;
    this.holder = null;
    if (ex?.kind === 'kid') { ex.a.actor!.action = null; this.say(ex.a, 'kidGust', 3); }
    if (why === 'gust') this.say(leo, 'gust', 3);
    const roof = this.findRoof();
    const b = this.body;
    if (roof) {
      this.roof = roof;
      const d = Math.hypot(roof.x - b.x, roof.z - b.z);
      this.flight = { x0: b.x, y0: b.y, z0: b.z, x1: roof.x, y1: roof.y + FLOATER.hover, z1: roof.z, t: 0, dur: clamp(d / 3.5, 4, 14), toKid: false };
    } else {
      // Nowhere to snag: up and away a little, then the wind drops and he drifts back to the kids.
      const wd = g.weather.windDir;
      this.roof = null;
      this.flight = { x0: b.x, y0: b.y, z0: b.z, x1: b.x + Math.cos(wd) * 18, y1: b.y + 9, z1: b.z + Math.sin(wd) * 18, t: 0, dur: 7, toKid: false };
    }
    this.mode = 'loose';
  }

  private loose(dt: number): void {
    const g = this.g, leo = this.leo!, act = leo.actor!, F = this.flight;
    if (!F) { this.mode = 'stuck'; return; }
    F.t += dt;
    const u = clamp(F.t / F.dur, 0, 1), e = smoothstep(0, 1, u);
    // Back to Mia: the end follows her hand.
    if (F.toKid) { const h = this.kid() ? this.handOf(this.kid()!, _w) : null; if (h) { F.x1 = h.x; F.y1 = h.y + 0.5; F.z1 = h.z; } }
    const top = Math.max(F.y0, F.y1) + (F.toKid ? 1 : 4);
    const x = lerp(F.x0, F.x1, e), z = lerp(F.z0, F.z1, e);
    const y = (1 - u) * (1 - u) * F.y0 + 2 * u * (1 - u) * top + u * u * F.y1 + Math.sin(F.t * 5) * 0.15;
    const b = this.body;
    b.vx = (x - b.x) / Math.max(dt, 1e-3); b.vy = (y - b.y) / Math.max(dt, 1e-3); b.vz = (z - b.z) / Math.max(dt, 1e-3);
    b.x = x; b.y = y; b.z = z;
    leo.x = x; leo.y = y; leo.z = z;
    leo.vx = b.vx; leo.vy = 0; leo.vz = b.vz;
    leo.speed = 0;
    leo.airborne = true;
    // Treading the air, turning slowly.
    leo.fly = undefined;
    act.move = 'swim';
    leo.heading += dt * 1.2;
    act.mood = 'surprised';
    // The kids run after him.
    this.kidsTo(F.x1, F.z1, dt, 2.6);
    if (u >= 1) {
      this.flight = null;
      act.move = null;
      act.mood = 'happy';
      if (F.toKid && this.kid()) { this.holder = { kind: 'kid', a: this.kid()! }; this.mode = 'out'; this.say(leo, 'wave', 4); return; }
      if (!this.roof) {
        // Hung in the air a moment; the wind drops, back down to the kids.
        const k = this.kid();
        if (k) { const h = this.handOf(k, _w); this.flight = { x0: x, y0: y, z0: z, x1: h.x, y1: h.y + 0.5, z1: h.z, t: 0, dur: 9, toKid: true }; }
        else this.goHome();
        return;
      }
      this.mode = 'stuck';
      this.stuckT = 0;
      this.stats.stuck++;
      this.say(leo, 'stuck', 4);
      const p = g.player.pos;
      if (Math.hypot(p.x - x, p.z - z) < 160 && !g.freeCam) g.powerHud?.toast('A gust has blown <b>Leo Lightly</b>, the man who can\'t land, onto a roof.', 'info', 5200);
    }
  }

  private handOf(a: PedAgent, out: THREE.Vector3): THREE.Vector3 {
    const keep = this.holder;
    this.holder = { kind: 'kid', a };
    const h = this.hand(out)!;
    this.holder = keep;
    return h;
  }

  /** A roof downwind (15–70 m), with the street under its edge close to a road. */
  private findRoof(): Roof | null {
    const g = this.g, b = this.body, W = g.world, wd = g.weather.windDir;
    const ux = Math.cos(wd), uz = Math.sin(wd);
    let best: Roof | null = null, bs = -Infinity;
    for (const ref of W.buildingsIn(b.x - 70, b.z - 70, b.x + 70, b.z + 70)) {
      if (!ref.alive) continue;
      const P = ref.poly, n = P.length / 2;
      // The edge nearest him.
      let ex = 0, ez = 0, ed = Infinity, nx = 0, nz = 0;
      for (let i = 0; i < n; i++) {
        const ax = P[i * 2], az = P[i * 2 + 1], bx = P[((i + 1) % n) * 2], bz = P[((i + 1) % n) * 2 + 1];
        const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
        const t = clamp(((b.x - ax) * dx + (b.z - az) * dz) / L2, 0.15, 0.85);
        const qx = ax + dx * t, qz = az + dz * t, d = Math.hypot(qx - b.x, qz - b.z);
        if (d < ed) { ed = d; ex = qx; ez = qz; const L = Math.sqrt(L2); nx = dz / L; nz = -dx / L; }
      }
      // Outward normal (away from the inside).
      if (pointInPoly(P, ex + nx * 0.5, ez + nz * 0.5)) { nx = -nx; nz = -nz; }
      if (ed < 12 || ed > 70) continue;
      const ix = ex - nx * 1.4, iz = ez - nz * 1.4;
      if (W.buildingAt(ix, iz) !== ref) continue;
      const y = W.groundHeight(ix, iz, ref.top + 5), ground = W.groundHeight(ex + nx * 3, ez + nz * 3);
      const h = y - ground;
      if (h < 5 || h > 22) continue;
      const bx = ex + nx * 4, bz = ez + nz * 4;
      if (!W.standable(bx, bz)) continue;
      const down = ((ix - b.x) * ux + (iz - b.z) * uz) / ed;
      const score = down * 2 - ed / 40 - Math.abs(h - 14) / 20;
      if (score > bs) { bs = score; best = { x: ix, y, z: iz, edgeX: ex, edgeZ: ez, nx, nz, belowX: bx, belowZ: bz, ground }; }
    }
    return best;
  }

  /** The kids run or walk to (x, z) and look up. */
  private kidsTo(x: number, z: number, _dt: number, speed: number): void {
    for (const [a, off] of [[this.mia, 0], [this.ben, 1.2]] as [PedAgent | null, number][]) {
      if (!a?.actor || a.actor.route) continue;
      const act = a.actor, tx = x + off, tz = z + off * 0.5;
      const d = Math.hypot(tx - a.x, tz - a.z);
      if (d > 1) goTo(act, tx, tz, d > 6 ? speed : 1.2);
      else { stand(act); if (this.leo) lookAt(act, this.leo.x, this.leo.y + 1.2, this.leo.z); }
    }
  }

  // ================================================================== stuck on a roof

  private stuck(dt: number): void {
    const g = this.g, R = this.roof!, leo = this.leo!;
    this.stuckT += dt;
    this.kidsTo(R.belowX, R.belowZ, dt, 2.4);
    const mia = this.mia;
    if (mia?.actor && !mia.actor.goal && this.rng.float() < dt / 9) play(mia.actor, 'gesture_point', 2.2);
    if (this.stuckT > 4 && this.rng.float() < dt / 12) this.say(this.rng.float() < 0.5 ? leo : (mia ?? leo), this.rng.float() < 0.5 && mia ? 'kidBelow' : 'stuck', 6);
    if (!this.engine && this.stuckT > CALL_AFTER) this.callEngine();
    // The firefighter at the top of the ladder takes the string.
    const E = this.engine;
    if (E && E.phase === 'up' && E.crew[0]?.actor && (E.crew[0].actor.memo.lad ?? 0) >= 0.97) {
      this.holder = { kind: 'ff', a: E.crew[0] };
      E.phase = 'down';
      this.mode = 'out';
      this.roof = null;
      this.say(E.crew[0], 'ffTop', 4);
    }
    // Waiting much too long (no engine got through): the wind drops and he drifts down to the kids.
    if (this.stuckT > ENGINE_MAX + 30 && (!E || E.phase === 'drive')) {
      if (E) this.packUp(E, true);
      this.backToKid();
    }
  }

  private backToKid(): void {
    const k = this.kid(), b = this.body;
    if (!k) { this.goHome(); return; }
    const h = this.handOf(k, _w);
    this.roof = null;
    this.flight = { x0: b.x, y0: b.y, z0: b.z, x1: h.x, y1: h.y + 0.5, z1: h.z, t: 0, dur: 10, toKid: true };
    this.mode = 'loose';
  }

  // ================================================================== the fire engine

  private callEngine(): void {
    const g = this.g, R = this.roof!, net = g.net;
    const ne = net.nearestEdge(R.belowX, R.belowZ, 45);
    if (!ne) { this.stuckT = -1e9; return; }
    const o = { x: 0, z: 0, dx: 0, dz: 0 };
    net.pointAt(net.edges[ne.e], ne.s, 0, o);
    const a = this.rng.range(0, Math.PI * 2);
    const car = g.traffic.spawnVehicle('firetruck', o.x + Math.cos(a) * 260, o.z + Math.sin(a) * 260, 120, o);
    if (!car) { this.stuckT = CALL_AFTER - 5; return; }
    car.task = { x: o.x, z: o.z, arrived: false };
    car.siren = true; car.fear = 0; car.state = VState.Drive; car.vmax = 16;
    g.traffic.sendTo(car, o.x, o.z);
    this.engine = { car, crew: [], loop: g.audio.loop('siren_loop', 30), phase: 'drive', t: 0, ladder: null, base: new THREE.Vector3(), top: new THREE.Vector3(), ext: 0 };
    this.stats.engines++;
  }

  private tickEngine(dt: number): void {
    const E = this.engine, g = this.g;
    if (!E) return;
    const car = E.car;
    E.t += dt;
    E.loop?.set(car.x, car.y + 1.6, car.z, car.siren ? 0.8 : 0);
    if (!car.alive || car.state >= VState.Wreck) { this.packUp(E, true); return; }
    switch (E.phase) {
      case 'drive': {
        if (E.t > ENGINE_MAX) { this.packUp(E, true); return; }
        if (!this.roof || this.mode !== 'stuck') { this.packUp(E, true); return; }
        if (!parked(car, dt, 30)) return;
        car.siren = false; car.fear = 0.5;
        const R = this.roof;
        // The ladder stands in the street below the edge, leaning on the façade.
        const lean = clamp((R.y - R.ground) * 0.22, 1.2, 4.5);
        E.base.set(R.edgeX + R.nx * lean, R.ground, R.edgeZ + R.nz * lean);
        E.top.set(R.edgeX + R.nx * 0.3, R.y + 0.5, R.edgeZ + R.nz * 0.3);
        this.crewOut(E);
        if (!E.crew.length) { this.packUp(E, true); return; }
        E.ladder = makeLadder(E.base.distanceTo(E.top));
        E.ladder.position.copy(E.base);
        E.ladder.lookAt(E.top);
        E.ladder.scale.set(1, 1, 0.05);
        this.group.add(E.ladder);
        E.phase = 'ladder'; E.t = 0;
        this.say(E.crew[0], 'ff', 4);
        return;
      }
      case 'ladder': {
        E.ext = Math.min(1, E.t / 5);
        E.ladder!.scale.z = Math.max(0.05, E.ext);
        for (const a of E.crew) if (a.actor) { stand(a.actor); lookAt(a.actor, E.top.x, E.top.y, E.top.z); }
        const ff = E.crew[0];
        if (ff?.actor) { const d = Math.hypot(E.base.x - ff.x, E.base.z - ff.z); if (d > 0.8) goTo(ff.actor, E.base.x, E.base.z, 1.6); }
        if (ff && E.t > 25 && Math.hypot(E.base.x - ff.x, E.base.z - ff.z) > 0.8) { ff.x = E.base.x; ff.z = E.base.z; }
        if (E.ext >= 1 && ff && Math.hypot(E.base.x - ff.x, E.base.z - ff.z) <= 0.8) { E.phase = 'up'; E.t = 0; ff.airborne = true; ff.fly = undefined; ff.state = PState.Idle; ff.gx = 1e9; }
        return;
      }
      case 'up': case 'down': {
        const ff = E.crew[0];
        if (!ff?.alive || !ff.actor) { this.packUp(E, true); if (this.mode === 'out' && this.holder?.kind === 'ff') this.backToKid(); return; }
        if (E.phase === 'up' && this.mode !== 'stuck') E.phase = 'down';
        if (E.phase === 'down' && this.holder?.kind !== 'ff' && this.mode === 'stuck') E.phase = 'up';
        const L = E.base.distanceTo(E.top);
        if (!Number.isFinite(L) || L < 0.5 || E.t > L / CLIMB_SPEED + 20) { this.packUp(E, true); if (this.mode === 'stuck' || this.holder?.kind === 'ff') { this.holder = null; this.backToKid(); } return; }
        const at = (ff.actor.memo.lad ?? 0) + (E.phase === 'up' ? 1 : -1) * CLIMB_SPEED * dt / L;
        ff.actor.memo.lad = clamp(at, 0, 1);
        _v.lerpVectors(E.base, E.top, ff.actor.memo.lad);
        const dy = (E.top.y - E.base.y) / L * CLIMB_SPEED * (E.phase === 'up' ? 1 : -1);
        ff.x = _v.x; ff.z = _v.z; ff.y = _v.y - 0.15;
        ff.vx = 0; ff.vz = 0; ff.vy = dy;
        ff.speed = 0;
        ff.heading = Math.atan2(-(E.top.x - E.base.x), -(E.top.z - E.base.z));
        ff.actor.move = 'climb';
        ff.actor.face = null;
        if (E.phase === 'down' && ff.actor.memo.lad <= 0) {
          // Off the ladder, on to Mia.
          ff.airborne = false; ff.actor.move = null; ff.vy = 0;
          ff.y = g.world.groundHeight(E.base.x, E.base.z);
          ff.x = E.base.x; ff.z = E.base.z;
          E.phase = this.holder?.kind === 'ff' ? 'hand' : 'pack'; E.t = 0;
        }
        return;
      }
      case 'hand': {
        const ff = E.crew[0], k = this.mia?.alive ? this.mia : this.ben;
        if (!ff?.actor || !k || this.holder?.kind !== 'ff') { E.phase = 'pack'; E.t = 0; return; }
        const d = Math.hypot(k.x - ff.x, k.z - ff.z);
        if (d > 1.4 && E.t < 40) { goTo(ff.actor, k.x, k.z, 1.4); return; }
        stand(ff.actor);
        this.holder = { kind: 'kid', a: k };
        this.mode = 'out';
        this.stats.byFire++;
        this.say(ff, 'ffHand', 4);
        if (this.leo) this.g.later.after(2.5, () => { if (this.leo) this.say(this.leo, 'wave', 4); });
        k.actor!.route = null;
        this.linger = this.rng.range(20, 40);
        E.phase = 'pack'; E.t = 0;
        return;
      }
      case 'pack': {
        E.ladder && (E.ladder.scale.z = Math.max(0.05, 1 - E.t / 3));
        for (const a of E.crew) if (a.actor) { const d = Math.hypot(car.x - a.x, car.z - a.z); if (d > 2.2) goTo(a.actor, car.x, car.z, 1.5); else a.alive = false; }
        if (E.t > 3 && E.crew.every((a) => !a.alive)) this.packUp(E, false);
        else if (E.t > 25) this.packUp(E, false);
        return;
      }
      case 'off': return;
    }
  }

  private crewOut(E: Engine): void {
    const g = this.g, car = E.car;
    for (let i = 0; i < 2; i++) {
      const c = g.population.synthetic(hash32(car.id * 977 + i * 31 + 23) || 1);
      // (Parked far off, out of sight: they are simply at the ladder's spot already.)
      const far = Math.hypot(car.x - E.base.x, car.z - E.base.z) > 45 && !g.crime.visible(car.x, car.y + 1, car.z) && !g.crime.visible(E.base.x, E.base.y + 1, E.base.z);
      const ox = far ? E.base.x : car.x, oz = far ? E.base.z : car.z;
      const a = g.peds.spawnAt(c, ox + Math.cos(car.yaw) * (i ? 1.6 : -1.6), oz - Math.sin(car.yaw) * (i ? 1.6 : -1.6), car.yaw, false);
      if (!a) break;
      attach(a, makeActor('worker', FLOATER_OWNER, { outfit: firefighterOutfit(c.seed), mood: 'happy', held: null, title: 'Firefighter' }));
      E.crew.push(a);
    }
  }

  /** The crew gone, the ladder down; the engine drives off. */
  private packUp(E: Engine, now: boolean): void {
    for (const a of E.crew) if (a.actor?.owner === FLOATER_OWNER) a.alive = false;
    E.crew.length = 0;
    E.loop?.stop();
    if (E.ladder) { E.ladder.removeFromParent(); E.ladder.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); }); E.ladder = null; }
    const car = E.car;
    if (car.alive) {
      car.siren = false; car.fear = 0; car.task = undefined; car.state = VState.Drive;
      if (now && !this.g.crime.visible(car.x, car.y + 1, car.z)) car.alive = false;
    }
    E.phase = 'off';
    if (this.holder?.kind === 'ff') this.holder = null;
    this.engine = null;
  }

  // ================================================================== the hero

  /** Touching him (loose or stuck): the hero takes the string. */
  private heroTouch(): boolean {
    const g = this.g, leo = this.leo!, p = g.player.pos;
    if (g.freeCam || g.player.height > 2.4) return false;
    const d = Math.hypot(p.x - leo.x, p.y + g.player.height * 0.5 - (leo.y + 0.9), p.z - leo.z);
    return d < TAKE_R;
  }

  private heroTow(dt: number): void {
    const g = this.g, leo = this.leo!, k = this.kid();
    const h = this.hand(_v);
    // Torn off the hero (a teleport, a portal, a power that moved them).
    if (!h || Math.hypot(h.x - leo.x, h.y - leo.y, h.z - leo.z) > 25) { this.holder = null; this.backToKid(); return; }
    if (k) {
      this.kidsTo(g.player.pos.x + 1.5, g.player.pos.z + 1.5, dt, 1.6);
      const p = g.player.pos;
      if (Math.hypot(p.x - k.x, p.z - k.z) < HAND_R && Math.hypot(leo.x - k.x, leo.z - k.z) < HAND_R + 2 && Math.abs(p.y - k.y) < 3) {
        this.holder = { kind: 'kid', a: k };
        this.mode = 'out';
        this.stats.byHero++;
        k.actor!.route = null;
        this.linger = this.rng.range(20, 40);
        this.say(leo, 'heroHand', 4);
        g.later.after(1.8, () => { if (this.mia?.alive) this.say(this.mia, 'kidThanks', 4); });
        if (this.ben?.actor) play(this.ben.actor, 'cheer', 2);
        g.crime.reward({ karma: 15, rep: 2, why: 'Brought Leo Lightly back to his kids', news: 'brought the floating man down to his kids', count: 'deeds' });
      }
    }
  }

  // ================================================================== trouble

  private hit(): void {
    const leo = this.leo!;
    this.hits++;
    this.say(leo, 'hit', 2);
    play(leo.actor!, 'flinch', 0.6);
    if (this.mode === 'out' || this.mode === 'leave') this.blowAway('hit');
  }

  /** After lying on the ground: up again, then back to the string. */
  private getUp(): void {
    const leo = this.leo!;
    leo.state = PState.Idle;
    leo.airborne = true;
    leo.gx = 1e9;
    this.body = { x: leo.x, y: leo.y, z: leo.z, vx: 0, vy: 1, vz: 0 };
    if (this.holder?.kind === 'hero') this.holder = null;
    if (this.mode === 'stuck' || this.mode === 'loose' || !this.holder) this.backToKid();
  }

  private onStimulus(s: Stimulus): void {
    const leo = this.leo;
    if (!leo || this.mode === 'leave') return;
    const d = Math.hypot(leo.x - s.x, leo.z - s.z);
    if (d > s.radius) return;
    switch (s.kind) {
      case 'blast': case 'collapse': case 'roar': case 'threat': case 'gunfire': case 'sonic':
        this.say(leo, 'menace', 3);
        this.goHome(true);
        break;
      default: break;
    }
  }

  /** The family goes home (hurrying when scared); out of sight they are gone. */
  private goHome(hurry = false): void {
    if (!this.leo || this.mode === 'leave') return;
    if (this.mode === 'loose' || this.mode === 'stuck' || this.mode === 'hero') { if (!hurry) return; }
    const g = this.g, mia = this.kid();
    this.mode = 'leave';
    this.leaveSpeed = hurry ? 2.6 : 1.05;
    if (this.holder?.kind !== 'kid' && mia) this.holder = { kind: 'kid', a: mia };
    if (!hurry) this.say(this.leo, 'home', 5);
    const door = this.pickDoor(this.home.x, this.home.z, 10, 200, deriveSeed(g.settings.seed, 'floater-door'));
    if (mia?.actor && door) { const r = g.peds.buildRoute(mia.x, mia.z, door.x, door.z); mia.actor.route = r && r.length >= 6 ? r : null; mia.actor.wp = 1; }
    if (this.engine) this.packUp(this.engine, true);
    this.flight = null; this.roof = null;
  }
  private leaveSpeed = 1.05;

  private leave(dt: number): void {
    const g = this.g, mia = this.kid();
    if (!mia?.actor) { this.despawn(); return; }
    const act = mia.actor;
    const going = act.route ? followRoute(mia, act, this.leaveSpeed) : false;
    this.holdPose(mia);
    this.benFollow(dt);
    const f = this.focus(), dp = Math.hypot(mia.x - f.x, mia.z - f.z);
    if ((!going && !g.crime.visible(mia.x, mia.y + 1, mia.z)) || (dp > 70 && !g.crime.visible(mia.x, mia.y + 1, mia.z)) || (!going && dp > 30)) this.despawn();
  }

  private pickDoor(x: number, z: number, r0: number, r1: number, h: number): { x: number; z: number } | null {
    const out: { x: number; z: number }[] = [];
    for (const r of this.g.world.buildingsIn(x - r1, z - r1, x + r1, z + r1)) {
      if (!r.alive) continue;
      const d = doorOf(r.desc), dd = Math.hypot(d.x - x, d.z - z);
      if (dd >= r0 && dd <= r1) out.push(d);
    }
    return out.length ? out[hash32(h) % out.length] : null;
  }

  // ================================================================== talk, waves, cameras

  private say(a: PedAgent, topic: FloaterTopic, pause = 4): boolean {
    const ok = this.g.barks.say(a, floaterLine(topic, () => this.rng.float()), pause);
    if (ok) this.stats.lines++;
    return ok;
  }

  private chatter(dt: number): void {
    const g = this.g, leo = this.leo!, act = leo.actor!, P = g.player, p = P.pos;
    const dp = Math.hypot(p.x - leo.x, p.z - leo.z);
    // The hero takes the string when they touch him off it.
    if ((this.mode === 'loose' || this.mode === 'stuck' || (this.mode === 'out' && this.holder?.kind === 'ff')) && this.heroTouch()) {
      this.holder = { kind: 'hero' };
      this.mode = 'hero';
      this.flight = null; this.roof = null;
      act.move = null;
      if (this.engine) this.packUp(this.engine, true);
      this.say(leo, 'heroTake', 4);
      return;
    }
    if (dp > 60) return;
    this.talkT -= dt; this.kidT -= dt; this.waveT -= dt; this.playerT -= dt;
    if (this.mode !== 'out') return;
    // Lines for the hero (once each).
    if (this.playerT <= 0 && !g.freeCam) {
      const rep = g.crime?.rep.value ?? 0;
      const t: FloaterTopic | null = P.flying && dp < 30 ? 'fly' : P.height > 2.4 && dp < 40 ? 'giant' : P.height < 0.6 && dp < 8 ? 'tiny' : dp < 14 ? (rep < -30 ? 'menace' : rep > 25 ? 'hero' : null) : null;
      if (t && !this.said.has(t) && this.say(leo, t, 5)) { this.said.add(t); this.playerT = 20; play(act, 'gesture_wave', 2.6); lookAt(act, p.x, p.y + 1.6, p.z); g.later.after(3, () => { if (this.leo?.actor) this.leo.actor.face = null; }); return; }
    }
    // Waving at passers-by.
    if (this.waveT <= 0) {
      this.waveT = 1;
      const w = g.peds.nearest(leo.x, leo.z, 8, (o) => !o.actor && o.state === PState.Walk && !o.inside);
      if (w && this.rng.float() < 0.35) {
        this.waveT = this.rng.range(7, 14);
        play(act, 'gesture_wave', 2.6);
        lookAt(act, w.x, w.y + 1.6, w.z);
        g.later.after(2.8, () => { if (this.leo?.actor) this.leo.actor.face = null; });
        if (this.rng.float() < 0.35) this.say(leo, 'wave', 4);
        // Waved at, they wave back.
        w.helped = true; w.state = PState.Idle; w.stateT = 0; w.speed = 0;
        w.heading = Math.atan2(-(leo.x - w.x), -(leo.z - w.z));
      }
    }
    if (this.talkT <= 0) { this.talkT = this.rng.range(14, 26); this.say(leo, 'patter', 5); }
    if (this.kidT <= 0 && this.mia) { this.kidT = this.rng.range(20, 36); this.say(this.rng.float() < 0.6 ? this.mia : this.ben ?? this.mia, this.kid()?.speed ? 'kid' : 'kidStop', 5); }
  }

  /** Passers-by stop and film him (a few, the curious ones). */
  private watch(dt: number): void {
    this.watchT -= dt;
    if (this.watchT > 0) return;
    this.watchT = 1.5;
    const leo = this.leo!;
    for (let i = this.watchers.length - 1; i >= 0; i--) {
      const w = this.watchers[i];
      if (!w.alive || w.actor || (w.state !== PState.Gawk && w.state !== PState.Film)) this.watchers.splice(i, 1);
      else { w.lookX = leo.x; w.lookY = leo.y + 1; w.lookZ = leo.z; }
    }
    if (this.watchers.length >= 5) return;
    for (const w of this.g.peds.neighbours(leo.x, leo.z, 14, this.tmp)) {
      if (this.watchers.length >= 5) break;
      if (w.actor || w.inside || w.evac || w.onRoad || w.state !== PState.Walk || w.fear > 0.2 || !canGawk(w)) continue;
      if (w.cit.curiosity < 0.35 || this.rng.float() > 0.3) continue;
      w.state = this.rng.float() < 0.6 ? PState.Film : PState.Gawk; w.stateT = 0;
      w.lookX = leo.x; w.lookY = leo.y + 1; w.lookZ = leo.z;
      this.watchers.push(w);
      if (w.state === PState.Film) this.stats.filmed++;
    }
  }

  // ================================================================== the string

  private drawString(): void {
    const leo = this.leo;
    if (!leo) return;
    const A = this.ankle(_w).clone();
    const H = this.hand(_v);
    const N = this.pts.length / 3, P = this.pts;
    if (H) {
      // From the hand to the ankle, sagging a little when slack.
      const d = H.distanceTo(A), sag = Math.min(0.22, Math.max(0, FLOATER.string - d) * 0.12) + 0.02;
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        P[i * 3] = lerp(H.x, A.x, t); P[i * 3 + 1] = lerp(H.y, A.y, t) - Math.sin(t * Math.PI) * sag; P[i * 3 + 2] = lerp(H.z, A.z, t);
      }
    } else {
      // Dangling from the ankle, swaying in the wind.
      const wd = this.g.weather.windDir, w = 0.3 + this.g.weather.p.wind;
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1), s = Math.sin(this.time * 2.1 + t * 3) * 0.12 * t;
        P[i * 3] = A.x + Math.cos(wd) * w * t * t * 0.8 + s; P[i * 3 + 1] = A.y - t * FLOATER.string * 0.95; P[i * 3 + 2] = A.z + Math.sin(wd) * w * t * t * 0.8 - s;
      }
    }
    const pos = this.string.geometry.getAttribute('position') as THREE.BufferAttribute;
    pos.needsUpdate = true;
  }

  // ================================================================== dev

  status(): Record<string, unknown> {
    const p = this.g.player.pos, l = this.leo;
    return {
      mode: this.mode, out: this.outNow(), home: [Math.round(this.home.x), Math.round(this.home.z)], spots: this.spots.length,
      leo: l ? { at: [Math.round(l.x), +(l.y - this.g.world.groundHeight(l.x, l.z)).toFixed(2), Math.round(l.z)], d: Math.round(Math.hypot(l.x - p.x, l.z - p.z)) } : null,
      holder: this.holder?.kind ?? null, engine: this.engine ? { phase: this.engine.phase, t: Math.round(this.engine.t) } : null,
      ...this.stats,
    };
  }

  /** The family `dist` m ahead of the player (out, whatever the hour). */
  here(dist = 9): string {
    const g = this.g, p = g.player.pos, fy = g.camRig.forwardYaw;
    this.force = true;
    let x = p.x - Math.sin(fy) * dist, z = p.z - Math.cos(fy) * dist;
    for (let k = 0; k < 8 && !g.world.standable(x, z); k++) { const a = fy + (k + 1) * 0.7; x = p.x - Math.sin(a) * dist; z = p.z - Math.cos(a) * dist; }
    if (this.leo && this.mia && this.ben) {
      // Already out: bring them here.
      const gy = g.world.groundHeight(x, z);
      for (const [a, ox] of [[this.mia, 0], [this.ben, 0.9]] as [PedAgent, number][]) { a.x = x + ox; a.z = z; a.y = gy; if (a.actor) { a.actor.route = null; stand(a.actor); } }
      this.body = { x: x - 1.8, y: gy + FLOATER.hover, z, vx: 0, vy: 0, vz: 0 };
      this.leo.x = x - 1.8; this.leo.z = z; this.leo.y = gy + FLOATER.hover;
      return `the Lightlys moved to ${x.toFixed(0)}, ${z.toFixed(0)}`;
    }
    return this.spawn(x, z, -1, Math.atan2(-(p.x - x), -(p.z - z)) + Math.PI / 2) ? `the Lightlys at ${x.toFixed(0)}, ${z.toFixed(0)}` : 'no room';
  }

  private installDev(): void {
    const dev = (window as unknown as { dev?: Record<string, unknown> }).dev;
    if (!dev) return;
    this.devDone = true;
    dev.floater = {
      sys: this,
      status: () => this.status(),
      /** dev.floater.here(9): the family 9 m ahead. */
      here: (d = 9) => this.here(d),
      /** dev.floater.go(): the player to his home park (the family out). */
      go: () => {
        this.force = true;
        const H = this.home, gy = this.g.world.groundHeight(H.x, H.z);
        this.g.player.pos.set(H.x, gy + 0.2, H.z);
        this.g.player.vel.set(0, 0, 0);
        return { home: [Math.round(H.x), Math.round(H.z)] };
      },
      /** dev.floater.gust(): a gust tears him loose now. */
      gust: () => { if (!this.leo) return 'nobody out'; this.calmT = 0; this.blowAway('gust'); return this.roof ? 'onto a roof' : 'up and back'; },
      /** dev.floater.engine(): call the engine at once (stuck on a roof). */
      engine: () => { if (this.mode !== 'stuck') return 'not stuck'; this.stuckT = CALL_AFTER + 1; return 'called'; },
      clear: () => { this.despawn(); this.force = false; return 'gone'; },
      on: (v = true) => (this.enabled = v),
    };
  }
}

type RGB = [number, number, number];
const cloth = (seed: number, p: RGB, s: RGB = p) => ({ shape: 'cloth', seed, primary: p, secondary: s, accent: s, material: 'plain', glow: 0 });

/** Leo: a mustard fisherman's sweater, brown wool trousers, brown shoes, a flat cap. */
function leoOutfit(seed: number): EquipmentVisuals {
  return {
    chest: { defId: 'sweater', visual: cloth(seed + 1, [0.78, 0.6, 0.22]) },
    legs: { defId: 'trousers', visual: cloth(seed + 2, [0.36, 0.26, 0.17]) },
    feet: { defId: 'shoes', visual: cloth(seed + 3, [0.3, 0.18, 0.1]) },
    head: { defId: 'cap', visual: cloth(seed + 4, [0.42, 0.36, 0.3]) },
  } as unknown as EquipmentVisuals;
}

/** The kids: a T-shirt, shorts or jeans, trainers. */
function kidOutfit(seed: number, top: RGB, girl: boolean): EquipmentVisuals {
  return {
    chest: { defId: 'tshirt', visual: cloth(seed + 1, top) },
    legs: { defId: girl ? 'jeans' : 'shorts', visual: cloth(seed + 2, girl ? [0.25, 0.32, 0.5] : [0.3, 0.35, 0.25]) },
    feet: { defId: 'sneakers', visual: cloth(seed + 3, [0.92, 0.92, 0.9]) },
  } as unknown as EquipmentVisuals;
}

let ladderMat: THREE.MeshStandardMaterial | null = null;

/** The turntable ladder: two rails with rungs along +Z, `len` m long (scaled in z to extend it). */
function makeLadder(len: number): THREE.Group {
  ladderMat ??= new THREE.MeshStandardMaterial({ color: 0xc9ccd0, metalness: 0.6, roughness: 0.4 });
  const g = new THREE.Group();
  const geos: THREE.BufferGeometry[] = [];
  for (const sx of [-0.28, 0.28]) { const r = new THREE.BoxGeometry(0.06, 0.1, len); r.translate(sx, 0, len / 2); geos.push(r); }
  for (let z = 0.3; z < len - 0.1; z += 0.36) { const r = new THREE.BoxGeometry(0.56, 0.04, 0.04); r.translate(0, 0, z); geos.push(r); }
  // One mesh for all (one draw).
  const merged = mergeGeometries(geos)!;
  for (const q of geos) q.dispose();
  const m = new THREE.Mesh(merged, ladderMat);
  m.castShadow = true;
  g.add(m);
  return g;
}
