/**
 * The magnetic grandma: a well-known old lady of the city. Years ago one of the crystals made her
 * magnetic: not a hero, not a villain, just cheerful about it. Every day (8:30–12:30, 14:00–18:30)
 * she does her rounds of the shops in her neighbourhood (plan.ts picks it per city), and whatever
 * is made of metal near her flies to her and sticks: cutlery from the café tables, tins from the
 * shop doors, keys out of passers-by's pockets (she hands those back), a spanner off the street and
 * now and then a whole bicycle. When she clanks too much she stops and shakes it all off onto the
 * pavement. Passers-by stop, point and take photos.
 *
 * What sticks rides on her rig's sockets (CrowdRenderer.rigOf; humanoid sockets: nothing on her
 * skeleton is changed), so it moves with her walk. Far away she is a crowd figure and the pieces
 * are not drawn. Danger (a blast, a power, gunfire, a punch) ends her day: everything drops, she
 * runs like anyone else and is back tomorrow.
 *
 * She is an actor (GRANDMA_OWNER: her own budget, the crime layer leaves her be). The first time the
 * hero meets her, the tracker's People tab gets her, with her neighbourhood on the map.
 */
import * as THREE from 'three';
import type { Game } from '../../Game';
import { PState, canGawk, isBystander, type PedAgent } from '../../../sim/Pedestrians';
import { Role, doorOf, type Citizen } from '../../../sim/Population';
import { makeActor, attach, hold, play, goTo, stand, followRoute, GRANDMA_OWNER, type Actor } from '../../../sim/actors/Actor';
import { Rng, deriveSeed, hash32 } from '../../../core/rng';
import { statusOf } from '../../../shared/status';
import type { Stimulus } from '../../Stimuli';
import type { ThreadInfo } from '../../story/knowledge';
import { nameOf } from '../../people/identity';
import { PropType } from '../../../plan/cell';
import type { HumanoidRig } from '../../../humanoid/client/HumanoidRig';
import type { Character } from '../../../humanoid/client/Character';
import { JUNK, SMALL_JUNK, junkMesh, type JunkKind } from './junk';
import { grandmaLine, WATCHER_LINES, type GrandmaTopic } from './lines';
import { grandmaHome, grandmaOut, grandmaHoursText, grandmaName, grandmaTitle, dayOf, freeSpot, type FitLike, type GrandmaHome, type Spot } from './plan';

/** She is about while the player is this near her neighbourhood (m); she goes when farther and unseen. */
const ACTIVE_R = 260;
const DROP_R = 340;
/** Shops of her rounds: within this of her neighbourhood's centre (m). */
const ROUND_R = 170;
/** Her walking pace (m/s). */
const PACE = 0.95;
/** Seconds between pulls (random within). */
const PULL: [number, number] = [6, 14];
/** She shakes off when this many pieces stick (random within, per round). */
const FULL: [number, number] = [9, 15];
/** Seconds a bicycle rides on her back at most. */
const BIKE_STAY = 65;
/** Real seconds pieces lie on the pavement (at least; then once out of view). */
const LIE = 40;
/** Lines for the player within this (m). */
const TALK_R = 20;
const THREAD: ThreadInfo = { id: 'person:magnetic-grandma', tab: 'people', title: 'The magnetic grandma', color: '#b9a3ff', glyph: '🧲' };
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _n = new THREE.Vector3(), _z = new THREE.Vector3(0, 0, 1);

interface Piece {
  kind: JunkKind;
  obj: THREE.Object3D;
  spot: Spot;
  /** The passer-by it came from (she hands it back), else null. */
  owner: PedAgent | null;
  /** Seconds stuck. */
  t: number;
}
interface Flight {
  kind: JunkKind;
  obj: THREE.Object3D;
  from: THREE.Vector3;
  spin: THREE.Quaternion;
  spot: Spot;
  owner: PedAgent | null;
  t: number;
  dur: number;
}
interface Loose { obj: THREE.Object3D; vel: THREE.Vector3; spin: THREE.Vector3; rest: boolean; t: number; floor: number; flat: THREE.Quaternion }

type Phase = 'walk' | 'browse' | 'shake' | 'give' | 'home';

interface Her {
  a: PedAgent;
  act: Actor;
  cit: Citizen;
  name: string;
  rng: Rng;
  phase: Phase;
  t: number;
  /** Shop doors of her rounds, and the ones she went to last. */
  door: { x: number; z: number; nx: number; nz: number } | null;
  last: number[];
  pullT: number;
  full: number;
  talkT: number;
  playerT: number;
  said: Set<GrandmaTopic>;
  lastBike: number;
  watchers: PedAgent[];
  /** The piece she is handing back. */
  giving: Piece | null;
  /** Seconds to browse at the current shop; till the next look round for watchers. */
  m?: number;
  m2?: number;
}

export class MagneticGrandma {
  readonly home: GrandmaHome | null;
  readonly group = new THREE.Group();
  her: Her | null = null;
  private pieces: Piece[] = [];
  private flights: Flight[] = [];
  private loose: Loose[] = [];
  private bound: Character | null = null;
  private syncT = 0;
  private time = 0;
  /** The day she ran off (she stays home the rest of it). */
  private goneDay = -1;
  private moment = 0;
  /** Told the hero about her this session (the sandbox records no thread). */
  private met = false;
  private devDone = false;
  private tmp: PedAgent[] = [];
  /** Off: she doesn't come out (dev, tests). */
  enabled = true;
  /** Dev: out whatever the hour. */
  anyHour = false;
  stats = { spawned: 0, pulls: 0, bikes: 0, shakes: 0, givenBack: 0, panics: 0 };

  constructor(private g: Game) {
    this.home = grandmaHome(g.macro, g.settings.seed);
    this.group.name = 'magnetic-grandma';
    g.renderer.scene.add(this.group);
    g.stimuli.on((s) => this.onStimulus(s));
  }

  update(dt: number): void {
    if (!this.devDone) this.installDev();
    this.time += dt;
    this.syncT -= dt;
    if (this.syncT <= 0) { this.syncT = 1; this.sync(); }
    const h = this.her;
    if (h) this.step(h, dt);
    this.fly(dt);
    this.fall(dt);
  }

  private focus(): { x: number; z: number } {
    const p = this.g.freeCam ? this.g.renderer.camera.position : this.g.player.pos;
    return { x: p.x, z: p.z };
  }

  private rngNext(): Rng {
    return new Rng(deriveSeed(this.g.settings.seed, 'grandma-moment', this.moment++));
  }

  // ================================================================== out and about

  private sync(): void {
    const g = this.g, home = this.home, f = this.focus();
    const out = this.anyHour || grandmaOut(g.sky.hour);
    const h = this.her;
    if (h) {
      const d = Math.hypot(h.a.x - f.x, h.a.z - f.z);
      if (d > DROP_R && !g.crime.visible(h.a.x, h.a.y + 1, h.a.z)) { this.vanish(); return; }
      if (!out && h.phase !== 'home' && h.phase !== 'shake') this.goHome(h);
      return;
    }
    if (!home || !this.enabled || !out || dayOf(g.sky.hoursAbs) === this.goneDay || g.camRig.underground) return;
    if (Math.hypot(home.x - f.x, home.z - f.z) > ACTIVE_R) return;
    // She comes out of one of the shops of her rounds (the one nearest the player).
    const doors = this.doors();
    if (!doors.length) return;
    let best = doors[0], bd = Infinity;
    for (const d of doors) { const dd = Math.hypot(d.x - f.x, d.z - f.z); if (dd < bd) { bd = dd; best = d; } }
    this.spawn(best.x + best.nx * 1.2, best.z + best.nz * 1.2, Math.atan2(best.nx, best.nz));
  }

  /** Shop doors near her neighbourhood (loaded blocks only; any door if there is no shop). */
  private doors(): { x: number; z: number; nx: number; nz: number }[] {
    const home = this.home;
    if (!home) return [];
    const shops: { x: number; z: number; nx: number; nz: number }[] = [], other: typeof shops = [];
    for (const r of this.g.world.buildingsIn(home.x - ROUND_R, home.z - ROUND_R, home.x + ROUND_R, home.z + ROUND_R)) {
      if (!r.alive) continue;
      const d = doorOf(r.desc);
      if (Math.hypot(d.x - home.x, d.z - home.z) > ROUND_R) continue;
      if (!this.g.world.standable(d.x + d.nx * 1.2, d.z + d.nz * 1.2)) continue;
      (r.desc.shopfront || r.desc.eatery ? shops : other).push(d);
    }
    return shops.length >= 2 ? shops : [...shops, ...other];
  }

  /** The citizen she is: an old woman, the same one in every game of this city. */
  private citizen(): Citizen | null {
    const pop = this.g.population;
    let fallback: Citizen | null = null;
    for (let k = 0; k < 80; k++) {
      const c = pop.synthetic(hash32(deriveSeed(this.g.settings.seed, 'grandma-cit', k)) || 1);
      if (c.role === Role.Child) continue;
      fallback ??= c;
      if (c.role === Role.Senior && c.gender < 0.5) return c;
    }
    return fallback;
  }

  private spawn(x: number, z: number, heading: number, walk = true): Her | null {
    const g = this.g, cit = this.citizen();
    if (!cit) return null;
    const a = g.peds.spawnAt(cit, x, z, heading);
    if (!a) return null;
    const rng = new Rng(deriveSeed(cit.seed, 'grandma'));
    const s = () => rng.nextU32();
    const pastel: [number, number, number][] = [[0.62, 0.48, 0.66], [0.55, 0.62, 0.8], [0.78, 0.55, 0.5], [0.5, 0.66, 0.55]];
    const vis = (seed: number, c: [number, number, number], c2 = c, m = 'plain') => ({ shape: 'cloth', seed, primary: c, secondary: c2, accent: c2, material: m, glow: 0, glowColor: [0, 0, 0] as [number, number, number], wear: 0.15, style: '' });
    const name = grandmaName(nameOf(cit).first);
    const act = attach(a, makeActor('bystander', GRANDMA_OWNER, {
      title: `${name} · ${grandmaTitle}`, hp: 40, maxHp: 40, held: 'bag',
      outfit: {
        chest: { defId: 'dress', visual: vis(s(), rng.pick(pastel), [0.85, 0.82, 0.74], 'checks') },
        back: { defId: 'coat', visual: vis(s(), [0.42, 0.3, 0.36], [0.3, 0.22, 0.26]) },
        feet: { defId: 'shoes', visual: vis(s(), [0.16, 0.11, 0.08]) },
        head: { defId: 'beanie', visual: vis(s(), [0.72, 0.4, 0.45]) },
      },
    }));
    a.pref = PACE;
    const h: Her = {
      a, act, cit, name, rng, phase: 'walk', t: 0, door: null, last: [], pullT: 3, full: rng.int(FULL[0], FULL[1]),
      talkT: 4, playerT: 0, said: new Set(), lastBike: -1e9, watchers: [], giving: null,
    };
    this.her = h;
    this.stats.spawned++;
    if (walk) this.nextShop(h);
    return h;
  }

  /** On to another shop of her rounds. */
  private nextShop(h: Her): void {
    const doors = this.doors();
    h.phase = 'walk';
    h.t = 0;
    if (!doors.length) { h.door = null; return; }
    const a = h.a;
    const pool = doors.map((d, i) => ({ d, i, k: hash32(Math.round(d.x) * 73856093 ^ Math.round(d.z) * 19349663) })).filter((e) => !h.last.includes(e.k) && Math.hypot(e.d.x - a.x, e.d.z - a.z) > 12);
    const near = pool.filter((e) => Math.hypot(e.d.x - a.x, e.d.z - a.z) < 90);
    const pick = (near.length ? near : pool.length ? pool : doors.map((d, i) => ({ d, i, k: i })))[h.rng.int(0, Math.max(0, (near.length || pool.length || doors.length) - 1))];
    h.door = pick.d;
    h.last.push(pick.k);
    if (h.last.length > 3) h.last.shift();
    const tx = pick.d.x + pick.d.nx * 1.2, tz = pick.d.z + pick.d.nz * 1.2;
    const r = this.g.peds.buildRoute(a.x, a.z, tx, tz);
    h.act.route = r;
    h.act.wp = 1;
    h.act.stuckT = 0;
  }

  private goHome(h: Her): void {
    h.phase = 'home';
    h.t = 0;
    this.say(h, 'home', 6);
    // Home: a door near her neighbourhood's centre (not a shop).
    const home = this.home;
    if (!home) return;
    let best: { x: number; z: number } | null = null, bd = Infinity;
    for (const r of this.g.world.buildingsIn(home.x - 60, home.z - 60, home.x + 60, home.z + 60)) {
      if (!r.alive || r.desc.shopfront) continue;
      const d = doorOf(r.desc), dd = Math.hypot(d.x - home.x, d.z - home.z);
      if (dd < bd) { bd = dd; best = d; }
    }
    if (!best) return;
    h.act.route = this.g.peds.buildRoute(h.a.x, h.a.z, best.x, best.z);
    h.act.wp = 1;
  }

  // ================================================================== per frame

  private step(h: Her, dt: number): void {
    const g = this.g, a = h.a, act = h.act;
    h.t += dt;
    if (!a.alive) { this.drop(); return; }
    if (a.actor !== act) { this.letGo(); return; }
    this.bind(h);
    for (const p of this.pieces) p.t += dt;
    if (a.ragdoll || (statusOf(a)?.frozen ?? 0) > 0) return;
    if (act.hitByPlayer || a.state === PState.Down || act.state === 'down' || act.state === 'ko' || act.staggerT > 0) {
      this.say(h, 'hit', 4);
      this.panic(g.player.pos.x, g.player.pos.z);
      return;
    }
    const P = g.player.pos, dp = Math.hypot(P.x - a.x, P.z - a.z);
    h.playerT -= dt;
    this.meet(h, dp);
    switch (h.phase) {
      case 'walk': {
        act.mood = 'happy';
        if (act.route && followRoute(a, act, PACE)) {
          if (act.stuckT > 5) { act.route = null; }
          break;
        }
        act.route = null;
        stand(act);
        h.phase = 'browse';
        h.t = 0;
        h.m = 12 + h.rng.float() * 14;
        if (h.door) { a.heading = Math.atan2(h.door.nx, h.door.nz); act.face = { x: h.door.x, y: a.y + 1.5, z: h.door.z }; }
        if (h.rng.chance(0.5)) this.say(h, 'shop', 6);
        break;
      }
      case 'browse':
        act.mood = 'happy';
        if (h.t > (h.m ?? 15)) this.nextShop(h);
        break;
      case 'shake': this.shaking(h); break;
      case 'give': this.giving(h); break;
      case 'home':
        act.mood = 'neutral';
        if (!act.route || !followRoute(a, act, PACE)) { if (!g.crime.visible(a.x, a.y + 1, a.z) || h.t > 60) this.vanish(); else stand(act); }
        break;
    }
    if (h.phase === 'walk' || h.phase === 'browse') {
      // Too much on her: a shake. A bicycle doesn't stay long either.
      const bike = this.pieces.find((p) => p.kind === 'bicycle');
      if (this.pieces.length >= h.full || (bike && bike.t > BIKE_STAY)) this.startShake(h);
      else {
        const back = this.pieces.find((p) => p.owner && p.t > 4 && p.owner.alive && !p.owner.actor && Math.hypot(p.owner.x - a.x, p.owner.z - a.z) < 9);
        if (back) this.startGive(h, back);
        else this.pullTick(h, dt);
      }
      this.talk(h, dt, dp);
      this.watch(h, dt);
    }
  }

  /** First meeting: she goes into the tracker's People tab, her neighbourhood on the map. */
  private meet(h: Her, dp: number): void {
    const g = this.g, home = this.home;
    if (!home || this.met || dp > 14 || g.freeCam) return;
    if (g.story.know.threads.has(THREAD.id)) { this.met = true; return; }
    if (!g.crime.visible(h.a.x, h.a.y + 1.5, h.a.z)) return;
    this.met = true;
    g.story.tell({ ...THREAD, title: `${h.name}, the magnetic grandma` },
      `<b>${h.name}</b>, the magnetic grandma: metal flies to her and sticks. She does her shopping round here every day, ${grandmaHoursText()}.`,
      { x: home.x, z: home.z, kind: 'info' });
  }

  // ------------------------------------------------------------------ pulling things in

  private pullTick(h: Her, dt: number): void {
    h.pullT -= dt;
    if (h.pullT > 0 || this.flights.length >= 3) return;
    h.pullT = PULL[0] + h.rng.float() * (PULL[1] - PULL[0]);
    const rig = this.rig(h);
    if (!rig) return;
    const a = h.a, g = this.g;
    if (!g.crime.visible(a.x, a.y + 1, a.z)) return;
    const r = this.rngNext();
    // Where from: a passer-by's pocket, a café table, the shop she is at, the street; a bicycle now and then.
    let kind: JunkKind, from: THREE.Vector3, owner: PedAgent | null = null;
    const bikeOk = !this.pieces.some((p) => p.kind === 'bicycle') && this.time - h.lastBike > 150 && this.pieces.length < h.full - 3;
    const ped = g.peds.nearest(a.x, a.z, 7, (o) => o !== a && isBystander(o) && !o.actor);
    const table = this.cafeTable(a.x, a.z, 10);
    const pick = (src: 'table' | 'shop' | 'pocket' | 'street') => r.weighted(SMALL_JUNK.filter((k) => JUNK[k].from.includes(src)), (k) => JUNK[k].weight);
    if (bikeOk && r.chance(0.16)) {
      kind = 'bicycle';
      const side = r.sign(), ang = a.heading + side * (Math.PI / 2 + r.range(-0.4, 0.4));
      const x = a.x - Math.sin(ang) * 5, z = a.z - Math.cos(ang) * 5;
      from = new THREE.Vector3(x, g.floorAt(x, a.y, z) + 0.45, z);
      h.lastBike = this.time;
    } else if (ped && r.chance(0.35)) {
      kind = pick('pocket'); owner = ped;
      from = new THREE.Vector3(ped.x, ped.y + 0.95, ped.z);
    } else if (table && r.chance(0.7)) {
      kind = pick('table');
      from = new THREE.Vector3(table.x, g.floorAt(table.x, a.y, table.z) + 0.78, table.z);
    } else if (h.phase === 'browse' && h.door) {
      kind = pick('shop');
      from = new THREE.Vector3(h.door.x - h.door.nx * 0.5, a.y + r.range(0.6, 1.4), h.door.z - h.door.nz * 0.5);
    } else {
      kind = pick('street');
      const ang = r.range(-Math.PI, Math.PI), d = r.range(3, 6);
      const x = a.x - Math.sin(ang) * d, z = a.z - Math.cos(ang) * d;
      from = new THREE.Vector3(x, g.floorAt(x, a.y, z) + 0.05, z);
    }
    const fit = rig.char!.body.fit as FitLike;
    const spot = freeSpot(fit, r, this.pieces.map((p) => p.spot).concat(this.flights.map((f) => f.spot)), kind === 'bicycle' ? 'back' : undefined);
    if (!spot) { h.full = this.pieces.length; return; }
    // The bicycle flat across her back, a little askew (its tyres just behind the coat).
    if (kind === 'bicycle') { spot.socket = 'chest'; spot.pos = [0, -0.14, -fit.chestDepth * 0.1 - 0.08]; spot.normal = [0, 0, -1]; spot.roll = r.range(-0.35, 0.35); }
    const obj = junkMesh(kind, r.int(0, 7));
    obj.position.copy(from);
    obj.rotation.set(r.range(-1, 1), r.range(-3, 3), r.range(-1, 1));
    this.group.add(obj);
    const d = from.distanceTo(_v.set(a.x, a.y + 1.1, a.z));
    this.flights.push({ kind, obj, from, spin: new THREE.Quaternion().setFromEuler(new THREE.Euler(r.range(-6, 6), r.range(-6, 6), r.range(-6, 6))), spot, owner, t: 0, dur: (kind === 'bicycle' ? 1.1 : 0.35) + d * 0.07 });
    this.stats.pulls++;
    if (owner) { owner.state = PState.Gawk; owner.stateT = 0; owner.lookX = a.x; owner.lookY = a.y + 1.2; owner.lookZ = a.z; }
    if (kind === 'bicycle') this.stats.bikes++;
  }

  /** A café table near (x, z) from the loaded blocks' plans, or null. */
  private cafeTable(x: number, z: number, r: number): { x: number; z: number } | null {
    let best: { x: number; z: number } | null = null, bd = r;
    for (const cs of this.g.streamer.cells.values()) {
      const P = cs.plan;
      if (!P || !P.eateries.length) continue;
      const [x0, z0, x1, z1] = P.bounds;
      if (x < x0 - r || x > x1 + r || z < z0 - r || z > z1 + r) continue;
      const pr = P.props;
      for (let i = 0; i < pr.length; i += 6) {
        if (pr[i] !== PropType.CafeTable) continue;
        const d = Math.hypot(pr[i + 1] - x, pr[i + 2] - z);
        if (d < bd) { bd = d; best = { x: pr[i + 1], z: pr[i + 2] }; }
      }
    }
    return best;
  }

  /** Where a spot is in the world right now (its socket on her rig), and how a piece there is turned. */
  private spotWorld(spot: Spot, pos: THREE.Vector3, quat: THREE.Quaternion): boolean {
    const s = this.socket(spot);
    if (!s) return false;
    s.updateWorldMatrix(true, false);
    pos.set(spot.pos[0], spot.pos[1], spot.pos[2]).applyMatrix4(s.matrixWorld);
    s.getWorldQuaternion(quat);
    quat.multiply(spotQuat(spot, _q2));
    return true;
  }

  private socket(spot: Spot): THREE.Object3D | null {
    return this.bound?.sockets.get(spot.socket) ?? null;
  }

  private fly(dt: number): void {
    const h = this.her;
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i];
      f.t += dt;
      const ok = h && this.spotWorld(f.spot, _v, _q);
      if (!ok) { this.toLoose(f.obj, new THREE.Vector3(0, 0, 0)); this.flights.splice(i, 1); continue; }
      const u = Math.min(1, f.t / f.dur);
      // Faster and faster as it nears her (a magnet's pull), with a little hop.
      const e = u * u * (1.6 - 0.6 * u);
      f.obj.position.lerpVectors(f.from, _v, e);
      f.obj.position.y += Math.sin(u * Math.PI) * Math.min(0.6, f.from.distanceTo(_v) * 0.08);
      // Tumbling, then turning to lie flat against her.
      _q2.identity().slerp(f.spin, (1 - u) * 0.15);
      f.obj.quaternion.multiply(_q2).slerp(_q, Math.min(1, e * e + dt * 2));
      if (u < 1) continue;
      this.flights.splice(i, 1);
      this.stick(h!, f);
    }
  }

  /** It arrives: on her socket for good (until a shake), a clink, a word. */
  private stick(h: Her, f: Flight): void {
    const s = this.socket(f.spot);
    if (!s) { this.toLoose(f.obj, new THREE.Vector3()); return; }
    s.add(f.obj);
    f.obj.position.set(f.spot.pos[0], f.spot.pos[1], f.spot.pos[2]);
    spotQuat(f.spot, f.obj.quaternion);
    const piece: Piece = { kind: f.kind, obj: f.obj, spot: f.spot, owner: f.owner, t: 0 };
    this.pieces.push(piece);
    const g = this.g, a = h.a;
    g.audio.play('magnet_clink', a.x, a.y + 1.1, a.z, f.kind === 'bicycle' ? 0.9 : 0.5, (f.kind === 'bicycle' ? 0.6 : 0.85) + h.rng.float() * 0.35, 3, g.renderer.camera.position);
    if (f.kind === 'bicycle') { play(h.act, 'gesture_shrug', 1.6); this.say(h, 'bike', 5); }
    else if (h.rng.chance(0.55)) { this.say(h, 'stick', 6, JUNK[f.kind].word); if (h.rng.chance(0.4)) play(h.act, 'gesture_shrug', 1.3); }
    // Somebody nearby remarks on it.
    if (h.rng.chance(0.3)) {
      const w = g.peds.nearest(a.x, a.z, 12, (o) => o !== a && isBystander(o) && !o.actor && o !== f.owner);
      if (w) g.barks.say(w, WATCHER_LINES[h.rng.int(0, WATCHER_LINES.length - 1)], 8);
    }
  }

  // ------------------------------------------------------------------ handing back, shaking off

  private startGive(h: Her, p: Piece): void {
    h.phase = 'give';
    h.t = 0;
    h.giving = p;
    stand(h.act);
    const o = p.owner!;
    h.act.face = { x: o.x, y: o.y + 1.5, z: o.z };
    h.a.heading = Math.atan2(-(o.x - h.a.x), -(o.z - h.a.z));
    play(h.act, 'offer', 1.8);
    this.say(h, 'giveBack', 5);
    // The owner turns to her (and will walk on with it).
    o.state = PState.Gawk; o.stateT = 0; o.lookX = h.a.x; o.lookY = h.a.y + 1.3; o.lookZ = h.a.z;
    // Into her hand.
    const grip = this.bound?.sockets.get('grip.R');
    if (grip) { grip.add(p.obj); p.obj.position.set(0, 0.03, 0); p.obj.quaternion.identity(); }
    this.pieces.splice(this.pieces.indexOf(p), 1);
  }

  private giving(h: Her): void {
    const p = h.giving;
    if (h.t < 1.3 || !p) return;
    p.obj.removeFromParent();
    h.giving = null;
    this.stats.givenBack++;
    const o = p.owner;
    if (o?.alive && !o.actor) { o.helped = true; o.state = PState.Walk; o.stateT = 0; }
    h.phase = 'walk';
    h.t = 0;
  }

  private startShake(h: Her): void {
    h.phase = 'shake';
    h.t = 0;
    stand(h.act);
    this.say(h, 'full', 5);
  }

  private shaking(h: Her): void {
    const act = h.act;
    act.mood = 'happy';
    if (h.t > 0.9 && h.t < 3) hold(act, 'shake_off', 0.4);
    if (h.t > 1.8 && this.pieces.length) {
      this.dropAll(1);
      this.say(h, 'shake', 5);
      this.stats.shakes++;
      this.gawkers(h, 14, 5);
    }
    if (h.t > 3.2) {
      h.full = h.rng.int(FULL[0], FULL[1]);
      h.pullT = 10;
      this.nextShop(h);
    }
  }

  /** Everything off her onto the pavement (outward, `force` 0..1). */
  private dropAll(force: number): void {
    const g = this.g, a = this.her?.a;
    for (const p of this.pieces) {
      p.obj.getWorldPosition(_v);
      p.obj.getWorldQuaternion(_q);
      this.group.add(p.obj);
      p.obj.position.copy(_v);
      p.obj.quaternion.copy(_q);
      _n.set(0, 0, 1).applyQuaternion(_q);
      const r = this.rngNext();
      this.toLoose(p.obj, new THREE.Vector3(_n.x * (0.8 + r.float()) * force, 0.6 + r.float() * 1.2 * force, _n.z * (0.8 + r.float()) * force));
    }
    if (this.pieces.length && a) g.audio.play('junk_clatter', a.x, a.y + 0.3, a.z, Math.min(1, 0.4 + this.pieces.length * 0.05), 0.95, 4, g.renderer.camera.position);
    this.pieces = [];
    const giv = this.her?.giving;
    if (giv) { giv.obj.removeFromParent(); if (this.her) this.her.giving = null; }
  }

  private toLoose(obj: THREE.Object3D, vel: THREE.Vector3): void {
    if (obj.parent !== this.group) {
      obj.getWorldPosition(_v); obj.getWorldQuaternion(_q);
      this.group.add(obj); obj.position.copy(_v); obj.quaternion.copy(_q);
    }
    const r = this.rngNext();
    // It comes to rest lying flat (its touching side down, a turn of its own).
    const flat = new THREE.Quaternion().setFromUnitVectors(_z, new THREE.Vector3(0, -1, 0)).premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.range(-3, 3)));
    if (obj.name === 'junk:bicycle') flat.setFromEuler(new THREE.Euler(-Math.PI / 2, r.range(-3, 3), 0, 'YXZ'));
    const floor = this.g.floorAt(obj.position.x, obj.position.y - 0.5, obj.position.z);
    this.loose.push({ obj, vel, spin: new THREE.Vector3(r.range(-8, 8), r.range(-8, 8), r.range(-8, 8)), rest: false, t: 0, floor, flat });
  }

  private fall(dt: number): void {
    for (let i = this.loose.length - 1; i >= 0; i--) {
      const L = this.loose[i], o = L.obj;
      L.t += dt;
      if (!L.rest) {
        L.vel.y -= 9.8 * dt;
        o.position.addScaledVector(L.vel, dt);
        o.rotateX(L.spin.x * dt); o.rotateY(L.spin.y * dt); o.rotateZ(L.spin.z * dt);
        const lie = o.name === 'junk:bicycle' ? 0.05 : 0.012;
        if (o.position.y <= L.floor + lie) {
          o.position.y = L.floor + lie;
          if (Math.abs(L.vel.y) > 1.5) { L.vel.y *= -0.3; L.vel.x *= 0.5; L.vel.z *= 0.5; L.spin.multiplyScalar(0.4); }
          else { L.rest = true; L.t = 0; }
        }
      } else if (L.t < 0.5) {
        o.quaternion.slerp(L.flat, Math.min(1, dt * 10));
        if (o.name === 'junk:bicycle') o.position.y = L.floor + 0.05;
      }
      if (L.rest && L.t > LIE && (L.t > LIE * 3 || !this.g.crime.visible(o.position.x, o.position.y + 0.2, o.position.z))) {
        o.removeFromParent();
        this.loose.splice(i, 1);
      }
    }
    if (this.loose.length > 60) { const L = this.loose.shift(); L?.obj.removeFromParent(); }
  }

  // ------------------------------------------------------------------ the rig

  private rig(h: Her): HumanoidRig | null {
    return this.g.crowd.rigOf(h.a);
  }

  /** Keep what sticks on her current rig (a new rig is built when she comes back into range). */
  private bind(h: Her): void {
    const ch = this.rig(h)?.char ?? null;
    if (!ch || ch === this.bound) return;
    this.bound = ch;
    for (const p of this.pieces) {
      const s = ch.sockets.get(p.spot.socket);
      if (!s) continue;
      s.add(p.obj);
      p.obj.position.set(p.spot.pos[0], p.spot.pos[1], p.spot.pos[2]);
      spotQuat(p.spot, p.obj.quaternion);
    }
  }

  // ------------------------------------------------------------------ people about her

  private gawkers(h: Her, r: number, n: number): void {
    const a = h.a;
    for (const w of this.g.peds.neighbours(a.x, a.z, r, this.tmp)) {
      if (n <= 0) break;
      if (w === a || w.actor || w.inside || w.onRoad || w.state !== PState.Walk || w.fear > 0.2 || !canGawk(w) || h.rng.float() > 0.5) continue;
      w.state = h.rng.chance(0.45) ? PState.Film : PState.Gawk; w.stateT = 0;
      w.lookX = a.x; w.lookY = a.y + 1.2; w.lookZ = a.z;
      h.watchers.push(w);
      n--;
    }
  }

  /** A few passers-by stop for a look or a photo (she is a famous sight). */
  private watch(h: Her, dt: number): void {
    h.m2 = (h.m2 ?? 2) - dt;
    if (h.m2 > 0) return;
    h.m2 = 2.5;
    h.watchers = h.watchers.filter((w) => w.alive && !w.actor && (w.state === PState.Gawk || w.state === PState.Film));
    if (h.watchers.length < 3 && (this.pieces.length > 2 || this.flights.length)) this.gawkers(h, 10, 1);
  }

  private playerTopic(h: Her, dp: number): GrandmaTopic | null {
    const g = this.g, P = g.player;
    if (g.freeCam) return null;
    const rep = g.crime?.rep.value ?? 0, wanted = g.crime?.justice.wanted ?? 0;
    if (P.flying && dp < 30 && !h.said.has('fly')) return 'fly';
    if (P.height > 2.4 && dp < P.height * 8 && !h.said.has('giant')) return 'giant';
    if (P.height < 0.6 && dp < 8 && !h.said.has('tiny')) return 'tiny';
    if (dp > TALK_R) return null;
    if (wanted > 0 && !h.said.has('wanted')) return 'wanted';
    if (rep >= 40 && !h.said.has('hero') && dp < 12) return 'hero';
    if (rep <= -40 && !h.said.has('villain') && dp < 12) return 'villain';
    if (dp < 7 && !h.said.has('greet')) return 'greet';
    return null;
  }

  private talk(h: Her, dt: number, dp: number): void {
    h.talkT -= dt;
    if (h.talkT > 0) return;
    const top = h.playerT <= 0 ? this.playerTopic(h, dp) : null;
    if (!top && dp > TALK_R) { h.talkT = 1; return; }
    if (top) {
      if (!this.say(h, top, 6)) { h.talkT = 0.7; return; }
      h.said.add(top);
      h.playerT = 15;
      if (top === 'greet' || top === 'hero' || top === 'giant') { h.act.face = { x: this.g.player.pos.x, y: this.g.player.pos.y + this.g.player.height * 0.85, z: this.g.player.pos.z }; play(h.act, 'gesture_wave', 1.6); }
    } else this.say(h, 'own', 10);
    h.talkT = 14 + h.rng.float() * 12;
  }

  private say(h: Her, topic: GrandmaTopic, pause: number, thing?: string): boolean {
    const line = grandmaLine(topic, () => h.rng.float(), thing, h.name);
    return !!line && this.g.barks.say(h.a, line, pause);
  }

  // ================================================================== endings

  private onStimulus(s: Stimulus): void {
    const h = this.her;
    if (!h) return;
    const d = Math.hypot(h.a.x - s.x, h.a.z - s.z);
    if (d > s.radius) return;
    const prox = 1 - d / s.radius;
    switch (s.kind) {
      case 'blast': case 'collapse': case 'sonic': case 'roar': case 'threat': case 'gunfire': this.panic(s.x, s.z); break;
      case 'power': if (prox > 0.25) this.panic(s.x, s.z); break;
      case 'crash': if (d < 25) this.panic(s.x, s.z); break;
      case 'stomp': if ((s.size ?? 0) > 4 && prox > 0.3) this.panic(s.x, s.z); break;
      case 'siren': if (s.evac) this.panic(s.x, s.z, false); break;
      case 'impact': case 'glass': if (d < 12) play(h.act, 'flinch', 0.6); break;
      default: break;
    }
  }

  /** Her day is over: everything drops, she runs (or goes with everyone) like anyone else. */
  private panic(fx: number, fz: number, flee = true): void {
    const h = this.her;
    if (!h) return;
    this.say(h, 'panic', 4);
    this.stats.panics++;
    this.dropAll(0.5);
    this.goneDay = dayOf(this.g.sky.hoursAbs);
    const o = h.a;
    o.actor = undefined;
    if (o.state !== PState.Down) {
      if (flee) { o.state = PState.Flee; o.fear = Math.max(o.fear, 1.1); o.fearX = fx; o.fearZ = fz; }
      else { o.state = PState.Walk; o.fear = 0; }
      o.stateT = 0;
    }
    this.clear();
  }

  /** Someone else has her now (a ragdoll owner): what sticks falls off, and she is not ours. */
  private letGo(): void {
    this.dropAll(0.3);
    this.goneDay = dayOf(this.g.sky.hoursAbs);
    this.clear();
  }

  /** Gone unseen (far away, or home through the door): the person and what stuck to her. */
  private vanish(): void {
    const h = this.her;
    if (h && h.a.actor === h.act) h.a.alive = false;
    this.drop();
  }

  private drop(): void {
    for (const p of this.pieces) p.obj.removeFromParent();
    for (const f of this.flights) f.obj.removeFromParent();
    this.her?.giving?.obj.removeFromParent();
    this.pieces = [];
    this.flights = [];
    this.clear();
  }

  private clear(): void {
    for (const f of this.flights) this.toLoose(f.obj, new THREE.Vector3());
    this.flights = [];
    this.her = null;
    this.bound = null;
  }

  // ================================================================== dev

  /** Her, right now, `dist` m ahead of the player (dev.grandma.spawn). */
  spawnNear(dist = 7): string {
    const g = this.g, p = g.player.pos, fy = g.camRig.forwardYaw;
    if (this.her) this.vanish();
    let x = p.x - Math.sin(fy) * dist, z = p.z - Math.cos(fy) * dist;
    for (let k = 0; k < 8 && !g.world.standable(x, z); k++) { const a = fy + (k + 1) * 0.7; x = p.x - Math.sin(a) * dist; z = p.z - Math.cos(a) * dist; }
    const h = this.spawn(x, z, Math.atan2(-(p.x - x), -(p.z - z)), false);
    if (!h) return 'no room';
    h.phase = 'browse';
    h.m = 1e9;
    h.door = null;
    return `${h.name} at ${x.toFixed(0)}, ${z.toFixed(0)}`;
  }

  private installDev(): void {
    const dev = (window as unknown as { dev?: Record<string, unknown> }).dev;
    if (!dev) return;
    this.devDone = true;
    dev.grandma = {
      sys: this,
      /** dev.grandma.spawn(7): her, 7 m ahead, standing (pulling things in). */
      spawn: (dist = 7) => this.spawnNear(dist),
      /** dev.grandma.walk(): back to her rounds of the shops. */
      walk: () => { if (this.her) this.nextShop(this.her); return this.her ? 'walking' : 'not out'; },
      /** dev.grandma.pull(n): n things fly to her now. */
      pull: (n = 1) => { const h = this.her; if (!h) return 'not out'; for (let k = 0; k < n; k++) { h.pullT = 0; this.pullTick(h, 0); } return `${this.flights.length} flying, ${this.pieces.length} stuck`; },
      bike: () => { const h = this.her; if (!h) return 'not out'; h.lastBike = -1e9; for (let k = 0; k < 40 && !this.flights.some((f) => f.kind === 'bicycle'); k++) { h.pullT = 0; this.pullTick(h, 0); } return this.flights.some((f) => f.kind === 'bicycle') ? 'a bicycle is coming' : 'no bicycle'; },
      shake: () => { const h = this.her; if (!h) return 'not out'; this.startShake(h); return 'shaking'; },
      /** dev.grandma.hold(n): she shakes off only at n pieces (shots). */
      hold: (n = 99) => { if (this.her) this.her.full = n; return n; },
      /** dev.grandma.go(): the player to her neighbourhood. */
      go: () => { const H = this.home; if (!H) return 'no home'; const P = this.g.player; P.pos.set(H.x, this.g.world.groundHeight(H.x, H.z) + 1, H.z); P.vel?.set?.(0, 0, 0); return `to ${H.district} cell ${H.cell} at ${H.x.toFixed(0)}, ${H.z.toFixed(0)}`; },
      anyHour: (v = true) => (this.anyHour = v),
      on: (v = true) => (this.enabled = v),
      state: () => ({ home: this.home, out: !!this.her, phase: this.her?.phase, name: this.her?.name, stuck: this.pieces.map((p) => `${p.kind}@${p.spot.socket}`), flying: this.flights.length, loose: this.loose.length, rig: !!(this.her && this.rig(this.her)), ...this.stats }),
    };
  }
}

/** How a piece at a spot is turned in socket space: its +Z along the spot's outward normal. */
function spotQuat(spot: Spot, out: THREE.Quaternion): THREE.Quaternion {
  _n.set(spot.normal[0], spot.normal[1], spot.normal[2]).normalize();
  out.setFromUnitVectors(_z, _n);
  return out.multiply(_q3.setFromAxisAngle(_z, spot.roll));
}
