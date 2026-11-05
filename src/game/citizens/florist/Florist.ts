/**
 * The shrunk florist: a well-known citizen whom a crystal made 15 cm tall. Neither hero nor
 * villain: she keeps her flower shop (plan.ts picks it), with her own little door in the wall and a
 * flower stand on the pavement asking people to mind their step, and she rides her big pigeon,
 * Captain, between the shop and her roof gardens.
 *
 * Day (game hours, plan.ts `floristDay`): asleep inside at night; from 6:30 at her stand (tending
 * the buckets with a watering can, sitting on the rim of a terracotta pot, waving at people), every
 * few minutes off on Captain to a roof garden to water the planters and back with a bouquet;
 * in the evening no more flights; at 21:30 in through her little door. No flights in the rain.
 *
 * Underfoot: passers-by near her step round her, and the curious stop to look or film her (she is a
 * press magnet). A hero who walks onto her makes her hop aside with a squeak; a giant, a blast, a
 * roar or gunfire nearby sends her up and away on Captain to a roof garden until it is calm.
 *
 * She is her own rig (an Actors character scaled to FLORIST_H, humanoid/client/HumanoidRig), not a
 * pedestrian: the crowd, crimes and powers leave her be. Captain is a hand-posed bird on the flock's
 * mesh and material (fauna/Birds `solo`). Everything only within ACTIVE_R m of her shop.
 */
import * as THREE from 'three';
import type { Game } from '../../Game';
import type { Stimulus } from '../../Stimuli';
import { HumanoidRig } from '../../../humanoid/client/HumanoidRig';
import { randomAppearance } from '../../../humanoid/appearance';
import type { EquipmentVisuals, ItemVisual } from '../../../items/types';
import type { MoveState } from '../../../shared/types';
import { PState, canGawk, type PedAgent } from '../../../sim/Pedestrians';
import { planCell } from '../../../plan/cell';
import type { Obstacle } from '../../../world/Collision';
import type { SoloBird } from '../../../fauna/Birds';
import { Rng, deriveSeed } from '../../../core/rng';
import { FLORIST_H, PIGEON_LEN, floristCells, floristDay, floristHome, type FloristHome } from './plan';
import { flowerStand, littleDoor, roofGarden, type Stand } from './props';
import { ABOUT_HER, floristLine, type FloristTopic } from './lines';

/** Lived in within this distance of the shop (m); her rig is let go beyond DROP_R. */
const ACTIVE_R = 160;
const DROP_R = 230;
/** Her walking pace (m/s: quick little steps) and Captain's cruising speed (m/s). */
const WALK = 0.2, RUN = 0.42, FLY = 5.5;
/** Real seconds between delivery trips (random within) and spent in a garden. */
const TRIP: [number, number] = [110, 210];
const GARDEN_T: [number, number] = [28, 45];
/** Talks to the player within this (m). */
const TALK_R = 9;
/** Most people stopping to look at her at once. */
const WATCHERS = 3;

type Mode = 'inside' | 'stand' | 'ride' | 'garden' | 'hide';
type Doing = 'idle' | 'walk' | 'tend' | 'sit' | 'wave' | 'mount' | 'dodge' | 'door';

interface Spot { x: number; y: number; z: number }
interface Garden { b: number; x: number; z: number; ux: number; uz: number; y: number; obj: THREE.Group; tend: Spot[]; solid: Obstacle[] }

const cloth = (seed: number, primary: [number, number, number]): ItemVisual =>
  ({ shape: 'cloth', seed, primary, secondary: primary, accent: primary, material: 'plain', glow: 0, glowColor: [0, 0, 0], wear: 0.05, style: '' });

const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _v = new THREE.Vector3();

export class Florist {
  home: FloristHome | null = null;
  private tried = new Map<number, FloristHome | null>();
  private cands: number[];
  readonly group = new THREE.Group();
  private stand: Stand | null = null;
  private standObj: THREE.Group | null = null;
  private gardens: Garden[] = [];
  private solids: Obstacle[] = [];
  private rig: HumanoidRig | null = null;
  private bird: SoloBird | null = null;
  private rng: Rng;
  private time = 0;
  private syncT = 0;
  private active = false;
  /** Her feet, facing (Pedestrians convention: forward = (−sin, −cos)), velocity. */
  readonly at = { x: 0, y: 0, z: 0 };
  private yaw = 0;
  private vx = 0;
  private vz = 0;
  /** Bubble anchor (her feet). */
  private anchor = { x: 0, y: 0, z: 0, alive: true };
  mode: Mode = 'inside';
  doing: Doing = 'idle';
  private t = 0;
  private doT = 0;
  private goal: Spot | null = null;
  private speed = WALK;
  private action: { id: string; t0: number; dur: number } | null = null;
  private move: MoveState = 'idle';
  private seat = 0;
  private held: string | null = null;
  private heldNow: string | null | undefined = undefined;
  private tripT = 60;
  private garden: Garden | null = null;
  private tendK = 0;
  /** Captain: where he is, faces (yaw: atan2(dx, dz)), wings, carrying her. */
  private pg = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, phase: 0, amp: 0, fold: 1, ground: true, vy: 0 };
  private flight: { tx: number; ty: number; tz: number; alt: number; to: 'garden' | 'home'; landed: number } | null = null;
  private dodge: { x0: number; z0: number; x1: number; z1: number; t: number } | null = null;
  private stepped = 0;
  private steppedT = 0;
  private scaredT = 0;
  private talkT = 4;
  private playerT = 0;
  private said = new Set<FloristTopic>();
  private watchers: PedAgent[] = [];
  private watchT = 2;
  private nearT = 0;
  private tmp: PedAgent[] = [];
  private devDone = false;
  stats = { trips: 0, dodges: 0, scares: 0, lines: 0, watchers: 0, pushes: 0 };

  constructor(private g: Game) {
    this.rng = new Rng(deriveSeed(g.settings.seed, 'florist'));
    this.cands = floristCells(g.macro, g.settings.seed);
    g.renderer.scene.add(this.group);
    g.stimuli.on((s) => this.onStimulus(s));
    g.collision.obstacleProviders.push((x0, z0, x1, z1, out) => {
      for (const o of this.solids) if (o.x + 1 > x0 && o.x - 1 < x1 && o.z + 1 > z0 && o.z - 1 < z1) out(o);
    });
  }

  // ================================================================== where

  /**
   * Her shop: the first candidate cell with a shop that fits (plan.ts). Cells are taken from the
   * streamer once loaded; `force` plans the ones not loaded yet (dev, go to).
   */
  private resolve(force: boolean): FloristHome | null {
    if (this.home) return this.home;
    const g = this.g;
    for (const id of this.cands) {
      let h = this.tried.get(id);
      if (h === undefined) {
        const cs = g.streamer.cells.get(id);
        const plan = cs?.status === 'ready' && cs.plan ? cs.plan : force ? planCell(g.macro, g.macro.cells[id], g.terrain) : null;
        if (!plan) return null;
        h = floristHome(plan, g.settings.seed);
        this.tried.set(id, h);
      }
      if (h) { this.home = h; return h; }
    }
    return null;
  }

  private focus(): THREE.Vector3 {
    return this.g.freeCam ? this.g.renderer.camera.position : this.g.player.pos;
  }

  /** A point of the stand (local along, out) in the world. */
  private local(x: number, z: number): { x: number; z: number } {
    const H = this.home!;
    // The stand group's local +x in the world (its rotation keeps +z out of the wall); flowerStand flips its layout.
    const ax = H.nz, az = -H.nx;
    return { x: H.stand.x + ax * x + H.nx * z, z: H.stand.z + az * x + H.nz * z };
  }

  /** −1 when the stand runs the other way along the facade than the group's +x. */
  private flip(): number {
    const H = this.home!;
    return H.tx * H.nz + H.tz * -H.nx >= 0 ? 1 : -1;
  }

  private ground(x: number, z: number, y: number): number {
    return this.g.world.groundHeight(x, z, y + 0.4);
  }

  // ================================================================== update

  update(dt: number): void {
    if (dt <= 0) return;
    const g = this.g;
    if (!this.devDone) this.installDev();
    this.time += dt;
    this.syncT -= dt;
    if (this.syncT <= 0) { this.syncT = 1; this.sync(); }
    if (!this.active) return;
    this.t += dt;
    this.doT -= dt;
    this.tripT -= dt;
    this.scaredT -= dt;
    this.steppedT -= dt;
    this.playerT -= dt;
    this.live(dt);
    this.pigeon(dt);
    if (this.mode !== 'inside' && !g.camRig.underground) {
      this.underfoot(dt);
      this.crowd(dt);
      this.talk(dt);
    }
    this.draw(dt);
  }

  /** Once a second: find the shop, build or drop her things by distance, keep the gardens up to date. */
  private sync(): void {
    const g = this.g, f = this.focus();
    const H = this.home ?? (this.near(f) ? this.resolve(false) : null);
    if (!H) return;
    const d = Math.hypot(H.stand.x - f.x, H.stand.z - f.z);
    if (!this.active && d < ACTIVE_R && this.cellReady()) this.start();
    else if (this.active && d > DROP_R) this.stop();
    if (this.active) this.syncGardens();
    void g;
  }

  /** Near one of the candidate cells (worth looking for the shop). */
  private near(f: THREE.Vector3): boolean {
    const C = this.g.macro.cells;
    return this.cands.some((id) => C[id] && Math.hypot(C[id].centroid[0] - f.x, C[id].centroid[1] - f.z) < 700);
  }

  private cellReady(): boolean {
    const cs = this.g.streamer.cells.get(this.home!.cell);
    return cs?.status === 'ready';
  }

  /** Coming into range: her things go up, and she is where the hour says. */
  private start(): void {
    const g = this.g, H = this.home!;
    this.active = true;
    const st = flowerStand(H.shop, g.settings.seed & 255, this.flip());
    this.stand = st;
    const gy = this.ground(H.stand.x, H.stand.z, g.terrain.height(H.stand.x, H.stand.z) + 1);
    const yaw = Math.atan2(H.nx, H.nz);
    st.object.position.set(H.stand.x, gy, H.stand.z);
    st.object.rotation.y = yaw;
    const door = littleDoor(H.shop);
    door.position.set(H.little.x, this.ground(H.little.x, H.little.z, gy), H.little.z);
    door.rotation.y = yaw;
    this.standObj = new THREE.Group();
    this.standObj.add(st.object, door);
    this.group.add(this.standObj);
    this.solids = st.solid.map((s) => {
      const p = this.local(s.x, s.z);
      return { cyl: true, x: p.x, z: p.z, r: s.r, hx: 0, hz: 0, ux: 1, uz: 0, y0: gy - 0.2, y1: gy + s.h };
    });
    // Her rig: a woman in a flowery dress, scaled to FLORIST_H.
    const app = randomAppearance('human', deriveSeed(g.settings.seed, 'florist-look'), { gender: 0.08, age: 0.35 });
    this.rig = new HumanoidRig(app, { castShadow: true, priority: 4 });
    this.group.add(this.rig.object);
    this.bird = g.birds.solo(PIGEON_LEN, 0x6c717c, 0x8c929e);
    this.group.add(this.bird.mesh);
    // Where she is now.
    const day = floristDay(g.sky.hour);
    const perch = this.local(st.perch.x, st.perch.z);
    Object.assign(this.pg, { x: perch.x, y: gy, z: perch.z, yaw: Math.atan2(H.nx, H.nz), pitch: 0, roll: 0, fold: 1, amp: 0, ground: true });
    if (day === 'asleep') this.goInside(true);
    else this.toStand(true);
    this.tripT = 20 + this.rng.float() * 40;
  }

  private stop(): void {
    this.active = false;
    this.rig?.dispose();
    this.rig = null;
    this.bird?.dispose();
    this.bird = null;
    if (this.standObj) this.standObj.removeFromParent();
    this.standObj = null;
    this.stand = null;
    for (const G of this.gardens) G.obj.removeFromParent();
    this.gardens = [];
    this.solids = [];
    this.releaseWatchers();
    this.flight = null;
    this.mode = 'inside';
  }

  /** Her roof gardens: built once their building is loaded, dropped when it is gone (destroyed). */
  private syncGardens(): void {
    const g = this.g, H = this.home!;
    for (const fg of H.gardens) {
      const ref = g.world.buildingAt(fg.x, fg.z);
      const have = this.gardens.find((x) => x.b === fg.b);
      const ok = !!ref && ref.alive && ref.cell.id === H.cell;
      if (have && !ok) { have.obj.removeFromParent(); this.gardens.splice(this.gardens.indexOf(have), 1); this.rebuildSolids(); continue; }
      if (have || !ok) continue;
      const y = g.world.groundHeight(fg.x, fg.z);
      // Flat roof only (all three planters on the same level).
      if (Math.abs(g.world.groundHeight(fg.x + fg.ux * 1.6, fg.z + fg.uz * 1.6) - y) > 0.15 || Math.abs(g.world.groundHeight(fg.x - fg.ux * 1.6, fg.z - fg.uz * 1.6) - y) > 0.15) continue;
      const rg = roofGarden(fg.b);
      const yaw = Math.atan2(-fg.uz, fg.ux);
      rg.object.position.set(fg.x, y, fg.z);
      rg.object.rotation.y = yaw;
      this.group.add(rg.object);
      rg.object.updateMatrixWorld(true);
      const w = (x: number, z: number) => rg.object.localToWorld(_v.set(x, 0, z));
      const tend = rg.tend.map((s) => { const p = w(s.x, s.z); return { x: p.x, y, z: p.z }; });
      const solid: Obstacle[] = rg.solid.map((s) => { const p = w(s.x, s.z); const ux = Math.cos(yaw), uz = -Math.sin(yaw); return { cyl: false, x: p.x, z: p.z, r: 0, hx: s.hx, hz: s.hz, ux, uz, y0: y - 0.1, y1: y + s.h }; });
      this.gardens.push({ b: fg.b, x: fg.x, z: fg.z, ux: fg.ux, uz: fg.uz, y, obj: rg.object, tend, solid });
      this.rebuildSolids();
    }
  }

  private rebuildSolids(): void {
    if (!this.stand) return;
    const keep = this.solids.filter((o) => o.cyl);
    this.solids = [...keep, ...this.gardens.flatMap((G) => G.solid)];
  }

  // ================================================================== what she does

  private toStand(now = false): void {
    const H = this.home!, st = this.stand!;
    this.mode = 'stand';
    this.garden = null;
    if (now) {
      const p = this.local(st.tend[1].x, st.tend[1].z);
      this.at.x = p.x; this.at.z = p.z; this.at.y = this.ground(p.x, p.z, this.pg.y);
      this.yaw = Math.atan2(H.nx, H.nz);
    }
    this.next();
  }

  /** In through her little door (asleep, or hiding): out of sight. */
  private goInside(now = false): void {
    const H = this.home!;
    if (now) { this.mode = 'inside'; this.doing = 'idle'; this.goal = null; return; }
    this.mode = 'stand';
    this.doing = 'door';
    this.goal = { x: H.little.x + H.nx * 0.05, y: this.at.y, z: H.little.z + H.nz * 0.05 };
    this.speed = WALK;
    this.held = null;
  }

  /** The next thing to do at the stand (or in a garden). */
  private next(): void {
    const g = this.g, st = this.stand!, r = this.rng;
    this.action = null;
    this.seat = 0;
    const day = floristDay(g.sky.hour);
    const rain = (g.terraces?.rain ?? 0) > 0.25;
    if (this.mode === 'garden') {
      const G = this.garden!;
      // Hiding up here until it is calm.
      if (this.scaredT > 0) { this.doing = 'idle'; this.goal = null; this.doT = 4; this.held = null; return; }
      if (this.tendK < G.tend.length && this.t < GARDEN_T[1]) {
        const s = G.tend[this.tendK++];
        this.doing = 'tend';
        this.goal = { x: s.x, y: s.y, z: s.z };
        this.held = 'wateringcan';
        this.speed = WALK;
        return;
      }
      // A moment to admire them, then home.
      if (this.t < GARDEN_T[0]) { this.doing = 'idle'; this.goal = null; this.doT = GARDEN_T[0] - this.t; this.held = 'bouquet'; return; }
      this.mount('home');
      return;
    }
    if (this.mode !== 'stand') return;
    if (day === 'asleep') { this.goInside(); return; }
    if (day === 'open' && !rain && this.tripT <= 0 && this.gardens.length && this.scaredT <= 0) { this.mount('garden'); return; }
    const roll = r.float();
    if (roll < 0.45) {
      const s = st.tend[r.int(0, st.tend.length - 1)];
      const p = this.local(s.x, s.z);
      this.doing = 'tend';
      this.goal = { x: p.x, y: this.at.y, z: p.z };
      this.held = 'wateringcan';
    } else if (roll < 0.75 || day === 'evening') {
      const p = this.local(st.seat.x, st.seat.z + 0.07);
      this.doing = 'sit';
      this.goal = { x: p.x, y: this.at.y, z: p.z };
      this.held = day === 'evening' ? 'bouquet' : null;
    } else {
      this.doing = 'wave';
      this.goal = null;
      this.doT = 3.5;
      this.held = null;
      this.action = { id: 'gesture_wave', t0: this.time, dur: 2.4 };
    }
    this.speed = WALK;
  }

  /** Over to Captain and up, to a garden (or home). */
  private mount(to: 'garden' | 'home', hurry = false): void {
    const g = this.g;
    let target: Spot | null = null;
    if (to === 'garden') {
      const G = this.pickGarden(hurry);
      if (!G) { this.next(); return; }
      this.garden = G;
      // Land in front of the middle planter.
      const s = G.tend[1];
      target = { x: s.x + (s.x - G.x) * 0.6, y: G.y, z: s.z + (s.z - G.z) * 0.6 };
      this.tripT = TRIP[0] + this.rng.float() * (TRIP[1] - TRIP[0]);
      this.stats.trips++;
    } else {
      const st = this.stand!, p = this.local(st.perch.x, st.perch.z);
      target = { x: p.x, y: this.stand!.object.position.y, z: p.z };
    }
    // Cruise over whatever is in between.
    let top = Math.max(this.pg.y, target.y);
    const n = Math.ceil(Math.hypot(target.x - this.pg.x, target.z - this.pg.z) / 6);
    for (let k = 1; k < n; k++) {
      const u = k / n;
      top = Math.max(top, g.world.groundHeight(this.pg.x + (target.x - this.pg.x) * u, this.pg.z + (target.z - this.pg.z) * u));
    }
    this.flight = { tx: target.x, ty: target.y, tz: target.z, alt: top + 4, to, landed: 0 };
    this.doing = 'mount';
    this.goal = { x: this.pg.x, y: this.pg.y, z: this.pg.z };
    this.speed = hurry ? RUN : WALK * 1.3;
    this.held = to === 'home' ? 'bouquet' : null;
    if (!hurry) this.say('mount', 8);
  }

  private pickGarden(far: boolean): Garden | null {
    if (!this.gardens.length) return null;
    if (far) return this.gardens.reduce((a, b) => (Math.hypot(b.x - this.at.x, b.z - this.at.z) > Math.hypot(a.x - this.at.x, a.z - this.at.z) ? b : a));
    return this.gardens[this.rng.int(0, this.gardens.length - 1)];
  }

  /** Her body: walking to the goal, doing the thing there, riding Captain. */
  private live(dt: number): void {
    const g = this.g;
    this.move = 'idle';
    this.vx = 0; this.vz = 0;
    if (this.mode === 'inside') {
      // Out again in the morning (or once calm after hiding).
      if (floristDay(g.sky.hour) !== 'asleep' && this.scaredT <= 0) {
        const H = this.home!;
        this.at.x = H.little.x + H.nx * 0.08; this.at.z = H.little.z + H.nz * 0.08;
        this.at.y = this.ground(this.at.x, this.at.z, this.stand!.object.position.y);
        this.yaw = Math.atan2(H.nx, H.nz);
        this.mode = 'stand';
        this.next();
        this.say('morning', 10);
      }
      return;
    }
    if (this.mode === 'ride') { this.riding(dt); return; }
    if (this.dodge) { this.hop(dt); return; }
    // Scared at her stand: off on Captain (or, without a garden to go to, inside).
    if (this.goal && this.walkTo(this.goal, dt)) return;
    switch (this.doing) {
      case 'door':
        this.mode = 'inside';
        this.releaseWatchers();
        return;
      case 'mount':
        this.mode = 'ride';
        this.pg.ground = false;
        this.pg.vy = 1.6;
        this.g.audio.play('bird_flutter', this.pg.x, this.pg.y + 0.2, this.pg.z, 0.45, 1.05, 4, g.renderer.camera.position);
        return;
      case 'tend':
        if (!this.action) {
          // Face the bucket (or planter) and water it.
          this.faceAwayFromStreet();
          this.action = { id: 'harvest', t0: this.time, dur: 3.2 + this.rng.float() * 1.5 };
          this.doT = this.action.dur;
        }
        if (this.doT <= 0) this.next();
        return;
      case 'sit':
        if (!this.seat) {
          const st = this.stand!, H = this.home!;
          const p = this.local(st.seat.x, st.seat.z + 0.1);
          this.at.x = p.x; this.at.z = p.z;
          this.yaw = Math.atan2(-H.nx, -H.nz) + (this.rng.float() - 0.5) * 0.6;
          this.seat = st.seat.y;
          this.doT = 14 + this.rng.float() * 14;
        }
        this.move = 'sit';
        if (this.doT <= 0) { this.seat = 0; this.next(); }
        return;
      case 'wave':
        this.faceTowards(this.g.player.pos.x, this.g.player.pos.z);
        if (this.doT <= 0) this.next();
        return;
      default:
        if (this.mode === 'garden' && this.scaredT > 0) this.move = 'crouch';
        if (this.doT <= 0) this.next();
    }
  }

  /** One step towards a spot; true while still on the way. */
  private walkTo(s: Spot, dt: number): boolean {
    const dx = s.x - this.at.x, dz = s.z - this.at.z, d = Math.hypot(dx, dz);
    if (d < 0.03) { this.goal = null; return false; }
    const v = Math.min(this.speed, d / dt);
    this.vx = (dx / d) * v; this.vz = (dz / d) * v;
    this.at.x += this.vx * dt; this.at.z += this.vz * dt;
    this.at.y = this.mode === 'garden' ? s.y : this.ground(this.at.x, this.at.z, this.at.y);
    this.yaw = turn(this.yaw, Math.atan2(-dx, -dz), dt * 8);
    this.move = this.speed > 0.3 ? 'run' : 'walk';
    return true;
  }

  private faceTowards(x: number, z: number): void {
    this.yaw = Math.atan2(-(x - this.at.x), -(z - this.at.z));
  }

  /** Facing the wall (the buckets stand between her and the shop). */
  private faceAwayFromStreet(): void {
    if (this.mode === 'garden' && this.garden) { this.faceTowards(this.garden.x, this.garden.z); return; }
    const H = this.home!;
    this.yaw = Math.atan2(H.nx, H.nz);
  }

  /** Flying with Captain: up, across at cruise height, down onto the spot. */
  private riding(dt: number): void {
    const F = this.flight!, P = this.pg;
    const dx = F.tx - P.x, dz = F.tz - P.z, d = Math.hypot(dx, dz);
    if (F.landed > 0) {
      F.landed += dt;
      if (F.landed > 0.6) {
        // Off his back.
        this.flight = null;
        this.at.x = P.x + Math.cos(P.yaw) * 0.18; this.at.z = P.z - Math.sin(P.yaw) * 0.18; this.at.y = F.ty;
        this.yaw = P.yaw - Math.PI / 2;
        if (F.to === 'garden') { this.mode = 'garden'; this.t = 0; this.tendK = 0; this.say('garden', 10); this.next(); }
        else { this.toStand(); this.say('back', 10); }
      }
      return;
    }
    const hs = Math.min(FLY, Math.max(0.6, d * 1.2));
    const vx = d > 0.01 ? (dx / d) * hs : 0, vz = d > 0.01 ? (dz / d) * hs : 0;
    // Climb first (straight up off the pavement), then across, then down.
    const climb = P.y < F.alt - 0.5 && d > 4;
    const wantY = d > 4 ? F.alt : F.ty + Math.max(0, d - 0.3) * 0.8;
    const vy = THREE.MathUtils.clamp((wantY - P.y) * 1.5, -2.2, 2.8);
    const go = climb && P.y < F.alt - 2 && Math.hypot(P.x - (this.home?.stand.x ?? P.x), P.z - (this.home?.stand.z ?? P.z)) < 1 ? 0.15 : 1;
    P.x += vx * dt * go; P.z += vz * dt * go; P.y += vy * dt;
    P.vy = vy;
    if (d > 0.05) P.yaw = turnBird(P.yaw, Math.atan2(dx, dz), dt * 3);
    P.pitch = THREE.MathUtils.clamp(-vy * 0.12, -0.35, 0.35);
    P.amp = vy > 0.4 || d < 2 ? 1.0 : 0.35;
    P.fold = 0;
    if (d < 0.08 && Math.abs(P.y - F.ty) < 0.05) { P.y = F.ty; P.ground = true; P.fold = 1; P.amp = 0; P.pitch = 0; F.landed = 1e-3; this.g.audio.play('bird_flutter', P.x, P.y + 0.2, P.z, 0.35, 1.1, 4, this.g.renderer.camera.position); }
    // She sits on his back, sideways, her legs down his left flank.
    this.seatOnBird();
    this.move = 'sit';
  }

  private seatOnBird(): void {
    const P = this.pg, L = PIGEON_LEN, S = this.scale();
    _e.set(P.pitch, P.yaw, P.roll);
    _q.setFromEuler(_e);
    const back = _v.set(0, 0.2 * L, 0.0).applyQuaternion(_q);
    const cy = P.ground ? L * 0.18 : 0;
    this.seat = 0.47 * S;
    this.at.x = P.x + back.x; this.at.y = P.y + cy + back.y - this.seat; this.at.z = P.z + back.z;
    this.yaw = P.yaw - Math.PI / 2;
  }

  /** Hopping aside from a foot. */
  private hop(dt: number): void {
    const D = this.dodge!;
    D.t += dt / 0.45;
    const u = Math.min(1, D.t);
    this.at.x = D.x0 + (D.x1 - D.x0) * u; this.at.z = D.z0 + (D.z1 - D.z0) * u;
    const gy = this.ground(this.at.x, this.at.z, this.at.y);
    this.at.y = (this.mode === 'garden' ? this.garden!.y : gy) + Math.sin(u * Math.PI) * 0.12;
    this.move = 'jump';
    if (u >= 1) { this.dodge = null; this.at.y = this.mode === 'garden' ? this.garden!.y : gy; this.next(); }
  }

  /** Captain on the ground: pecking about near his perch while she is busy (or on her own roof). */
  private pigeon(dt: number): void {
    const P = this.pg;
    P.phase += (P.ground ? 0 : 7) * dt * Math.PI * 2;
    if (P.phase > 1e4) P.phase -= Math.PI * 2000;
    if (!P.ground || this.mode === 'ride' || this.doing === 'mount' && !this.goal) return;
    // A peck now and then (nose down).
    const k = this.time * 1.3 + 7;
    const peck = Math.max(0, Math.sin(k * 2.1)) ** 6;
    P.pitch = peck * 0.6;
    P.yaw += Math.sin(k * 0.37) * dt * 0.4;
  }

  // ================================================================== underfoot

  private scale(): number {
    return FLORIST_H / Math.max(0.5, this.rig?.height ?? 1.65);
  }

  /** The hero's feet, a giant, the crowd stepping round her. */
  private underfoot(_dt: number): void {
    const g = this.g, P = g.player;
    if (g.freeCam || this.mode === 'ride' || this.dodge) return;
    const dx = P.pos.x - this.at.x, dz = P.pos.z - this.at.z, d = Math.hypot(dx, dz);
    const hs = Math.hypot(P.vel.x, P.vel.z);
    // A giant (or a big hero) close by: away on Captain.
    if (P.height > 4 && d < Math.max(12, P.height * 4) && !P.flying) { this.scare(P.pos.x, P.pos.z, 'giant'); return; }
    if (P.flying || P.height < 0.6 || Math.abs(P.pos.y - this.at.y) > 0.5) return;
    if (d < P.radius + 0.14 && hs > 0.25) {
      // Hop aside, away from the foot (and not into the wall).
      const away = d > 0.01 ? { x: -dx / d, z: -dz / d } : { x: -P.vel.z / hs, z: P.vel.x / hs };
      let tx = this.at.x + away.x * 0.45, tz = this.at.z + away.z * 0.45;
      const H = this.home!;
      if (this.mode !== 'garden') {
        const out = (tx - H.stand.x) * H.nx + (tz - H.stand.z) * H.nz;
        if (out < 0.1) { tx += H.nx * (0.1 - out); tz += H.nz * (0.1 - out); }
      }
      this.dodge = { x0: this.at.x, z0: this.at.z, x1: tx, z1: tz, t: 0 };
      this.goal = null;
      this.action = null;
      this.seat = 0;
      this.stats.dodges++;
      this.stepped = this.steppedT > 0 ? this.stepped + 1 : 1;
      this.steppedT = 90;
      this.g.barks.sayAt(this.anchor, floristLine(this.stepped >= 3 ? 'stepped2' : 'stepped', () => this.rng.float(), H.name, H.shop) ?? 'Eek!', { head: 0.3, pause: 2, voice: true, tone: this.stepped >= 3 ? 'angry' : undefined });
    }
  }

  /** Off and away on Captain (a giant, a blast): to the farthest garden, until it is calm. */
  private scare(fx: number, fz: number, topic: FloristTopic = 'scared'): void {
    void fx; void fz;
    const first = this.scaredT <= 0;
    this.scaredT = 40;
    if (this.mode === 'ride' || this.mode === 'inside') return;
    if (this.mode === 'garden') { if (first) this.say(topic, 4); this.doing = 'idle'; this.goal = null; this.action = null; this.doT = 4; return; }
    if (this.doing === 'mount') { this.speed = RUN; return; }
    this.stats.scares++;
    this.seat = 0;
    this.dodge = null;
    this.say(topic, 4);
    if (this.gardens.length) this.mount('garden', true);
    else { this.goInside(); this.speed = RUN; }
  }

  private onStimulus(s: Stimulus): void {
    if (!this.active || this.mode === 'inside') return;
    const d = Math.hypot(this.at.x - s.x, this.at.z - s.z);
    if (d > s.radius) return;
    const prox = 1 - d / Math.max(1, s.radius);
    switch (s.kind) {
      case 'blast': case 'collapse': case 'sonic': case 'roar': case 'threat': case 'gunfire':
        this.scare(s.x, s.z);
        break;
      case 'power': if (prox > 0.3) this.scare(s.x, s.z); break;
      case 'crash': case 'impact': if (d < 18) this.scare(s.x, s.z); break;
      case 'stomp': if ((s.size ?? 0) > 4 && prox > 0.2) this.scare(s.x, s.z, 'giant'); break;
      default: break;
    }
  }

  /** Passers-by: step round her, and the curious stop to look (or film). */
  private crowd(dt: number): void {
    const g = this.g, a0 = this.at;
    this.nearT -= dt;
    if (this.nearT <= 0 && this.mode !== 'ride') {
      this.nearT = 0.2;
      for (const a of g.peds.neighbours(a0.x, a0.z, 1.2, this.tmp)) {
        if (!a.alive || a.inside || Math.abs(a.y - a0.y) > 0.6) continue;
        const dx = a.x - a0.x, dz = a.z - a0.z, d = Math.hypot(dx, dz);
        const R = 0.55;
        if (d < R && d > 1e-3) { a.x = a0.x + (dx / d) * R; a.z = a0.z + (dz / d) * R; this.stats.pushes++; }
      }
    }
    // Watchers.
    for (let i = this.watchers.length - 1; i >= 0; i--) {
      const w = this.watchers[i];
      if (w.alive && !w.actor && (w.state === PState.Gawk || w.state === PState.Film) && this.mode !== 'ride' && this.mode !== 'inside') { w.lookX = a0.x; w.lookY = a0.y + 0.1; w.lookZ = a0.z; continue; }
      this.watchers.splice(i, 1);
    }
    this.watchT -= dt;
    if (this.watchT > 0 || this.mode === 'ride' || this.watchers.length >= WATCHERS) return;
    this.watchT = 2;
    for (const w of g.peds.neighbours(a0.x, a0.z, 7, this.tmp)) {
      if (this.watchers.length >= WATCHERS) break;
      if (w.actor || w.inside || w.evac || w.onRoad || w.state !== PState.Walk || w.fear > 0.2 || !canGawk(w) || Math.abs(w.y - a0.y) > 1) continue;
      if (w.cit.curiosity < 0.25 || this.rng.float() > 0.4) continue;
      w.state = w.cit.curiosity > 0.65 ? PState.Film : PState.Gawk;
      w.stateT = 0;
      w.lookX = a0.x; w.lookY = a0.y + 0.1; w.lookZ = a0.z;
      this.watchers.push(w);
      this.stats.watchers++;
      if (this.rng.float() < 0.35) g.barks.say(w, ABOUT_HER[this.rng.int(0, ABOUT_HER.length - 1)], 30);
      else if (this.rng.float() < 0.3) this.say('fan', 12);
    }
  }

  private releaseWatchers(): void {
    for (const w of this.watchers) if (w.alive && !w.actor && (w.state === PState.Gawk || w.state === PState.Film)) { w.state = PState.Walk; w.stateT = 0; }
    this.watchers = [];
  }

  // ================================================================== talk

  private say(topic: FloristTopic, pause: number): boolean {
    const H = this.home!;
    const line = floristLine(topic, () => this.rng.float(), H.name, H.shop);
    if (!line) return false;
    const ok = this.g.barks.sayAt(this.anchor, line, { head: 0.3, pause });
    if (ok) this.stats.lines++;
    return ok;
  }

  private playerTopic(dp: number): FloristTopic | null {
    const g = this.g, P = g.player;
    if (g.freeCam) return null;
    const rep = g.crime?.rep.value ?? 0, wanted = g.crime?.justice.wanted ?? 0;
    if (P.flying && dp < 25 && !this.said.has('fly')) return 'fly';
    if (P.height < 0.6 && dp < 4) return 'tiny';
    if (dp > TALK_R) return null;
    if (wanted > 0 && !this.said.has('wanted')) return 'wanted';
    if (rep >= 40 && !this.said.has('hero') && dp < 6) return 'hero';
    if (rep <= -40 && !this.said.has('villain') && dp < 6) return 'villain';
    if (dp < 4 && !this.said.has('greet')) return 'greet';
    return null;
  }

  private talk(dt: number): void {
    this.talkT -= dt;
    if (this.talkT > 0 || this.mode === 'ride') return;
    const P = this.g.player.pos, dp = Math.hypot(P.x - this.at.x, P.z - this.at.z);
    const top = this.playerT <= 0 ? this.playerTopic(dp) : null;
    if (!top && dp > TALK_R * 1.5) { this.talkT = 1; return; }
    const rain = (this.g.terraces?.rain ?? 0) > 0.25;
    const day = floristDay(this.g.sky.hour);
    const ok = this.say(top ?? (rain && this.rng.float() < 0.4 ? 'rain' : day === 'evening' && this.rng.float() < 0.3 ? 'evening' : 'own'), top ? 6 : 14);
    if (!ok) { this.talkT = 0.8; return; }
    if (top) { this.said.add(top); this.playerT = top === 'tiny' ? 12 : 20; }
    this.talkT = 14 + this.rng.float() * 12;
  }

  // ================================================================== drawing

  private draw(dt: number): void {
    const g = this.g, R = this.rig, cam = g.renderer.camera.position;
    this.anchor.x = this.at.x; this.anchor.y = this.at.y; this.anchor.z = this.at.z;
    const P = this.pg;
    this.bird?.set(P.x, P.y + (P.ground ? PIGEON_LEN * 0.18 : 0), P.z, P.yaw, P.pitch, P.roll, P.phase, P.amp, P.fold, P.ground ? 0 : 0.15);
    if (!R) return;
    const show = this.mode !== 'inside';
    R.setVisible(show);
    if (!show) return;
    if (this.heldNow !== this.held) {
      this.heldNow = this.held;
      R.setEquipment(this.outfit(this.held));
    }
    const mood = this.stepped >= 3 && this.steppedT > 70 ? 'angry' : this.scaredT > 30 ? 'afraid' : 'happy';
    const look = this.lookAt();
    R.update({
      pos: [this.at.x, this.at.y, this.at.z], vel: [this.vx, 0, this.vz], yaw: this.yaw, scale: this.scale(),
      anim: { move: this.move, action: this.action ?? undefined, mood, lookAt: look, seat: this.seat || undefined, talking: false }, flags: 0,
    }, dt, this.time, cam);
  }

  /** She looks at the player when near, else at a watcher. */
  private lookAt(): [number, number, number] | undefined {
    const P = this.g.player.pos;
    if (Math.hypot(P.x - this.at.x, P.z - this.at.z) < 5) return [P.x, P.y + this.g.player.height * 0.9, P.z];
    const w = this.watchers[0];
    return w ? [w.x, w.y + 1.6, w.z] : undefined;
  }

  private outfit(held: string | null): EquipmentVisuals {
    const s = this.g.settings.seed;
    const dress = cloth(s + 1, [0.92, 0.5, 0.62]);
    return {
      chest: { defId: 'dress', visual: dress },
      feet: { defId: 'shoes', visual: cloth(s + 2, [0.28, 0.45, 0.25]) },
      mainhand: held ? { defId: held, visual: dress } : undefined,
    };
  }

  // ================================================================== dev

  /** Where to stand to see her (dev, go to): in front of her stand, looking at it. */
  go(): string {
    const H = this.resolve(true);
    if (!H) return 'no shop for the florist in this city';
    const g = this.g, x = H.stand.x + H.nx * 2.2, z = H.stand.z + H.nz * 2.2;
    const y = g.world.groundHeight(x, z);
    g.player.pos.set(x, y + 0.1, z);
    g.player.vel.set(0, 0, 0);
    g.camRig.zoom = 1.2;
    g.camRig.yaw = Math.atan2(x - H.stand.x, z - H.stand.z);
    g.camRig.snap?.();
    return `${H.shop} at ${x.toFixed(0)}, ${z.toFixed(0)}`;
  }

  status(): Record<string, unknown> {
    const H = this.home, p = this.g.player.pos;
    return {
      shop: H?.shop ?? null, at: H ? { x: Math.round(H.stand.x), z: Math.round(H.stand.z), d: Math.round(Math.hypot(H.stand.x - p.x, H.stand.z - p.z)) } : null,
      active: this.active, mode: this.mode, doing: this.doing, gardens: this.gardens.length + '/' + (H?.gardens.length ?? 0),
      her: { x: +this.at.x.toFixed(2), y: +this.at.y.toFixed(2), z: +this.at.z.toFixed(2) }, dressed: !!this.rig?.dressed, tripIn: Math.round(this.tripT), stats: { ...this.stats },
    };
  }

  private installDev(): void {
    const dev = (globalThis as unknown as { dev?: Record<string, unknown> }).dev;
    if (!dev) return;
    this.devDone = true;
    dev.florist = {
      florist: this,
      go: () => this.go(),
      status: () => this.status(),
      /** Off to a garden now. */
      trip: () => { if (this.mode !== 'stand') return `busy: ${this.mode}`; this.tripT = 0; this.goal = null; this.action = null; this.seat = 0; this.mount('garden'); return this.flight ? 'off she goes' : 'no garden loaded'; },
      scare: () => { this.scare(this.at.x, this.at.z); return this.mode; },
      sit: () => { if (this.mode !== 'stand') return this.mode; this.doing = 'sit'; const st = this.stand!; const q = this.local(st.seat.x, st.seat.z + 0.07); this.goal = { x: q.x, y: this.at.y, z: q.z }; return 'sitting down'; },
    };
  }
}

/** Turn a heading (Pedestrians convention) towards another by at most `k` rad. */
function turn(a: number, b: number, k: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + Math.max(-k, Math.min(k, d));
}

/** Turn a bird's yaw (atan2(dx, dz)) towards another by at most `k` rad. */
function turnBird(a: number, b: number, k: number): number {
  return turn(a, b, k);
}
