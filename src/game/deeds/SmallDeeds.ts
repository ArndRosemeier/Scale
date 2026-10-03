/**
 * Cheeky small deeds (PLAYGROUND_PLAN §0 decision 11): light, funny, seeded situations near the
 * player, each worth a little karma, told only by staging and sound.
 *
 *   cat     a cat up a street tree meows; its owner stands below, pointing up and fretting.
 *           Get up there (climb the trunk with E, a super jump, flight), grab it, bring it down
 *           and hand it over (E).
 *   dog     a dog trailing its leash runs zig-zag down the sidewalk, barking, its owner running
 *           after it shouting. Catch it (get close) and it follows you back to its owner.
 *   wallet  a passer-by drops their wallet and walks on; a while later they stop, pat their
 *           pockets and look back. Pick it up (E) and give it back (E).
 *
 * One at a time, every few minutes (seeded per day / hour slot); none in the middle of a crime.
 */
import * as THREE from 'three';
import { deriveSeed, hashToFloat, Rng } from '../../core/rng';
import type { PedAgent, Pedestrians } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';
import type { Player } from '../../player/Player';
import type { StreetProp } from '../../props/PropRenderer';
import type { MapMarker } from '../../ui/map/GameMap';
import { makeActor, attach, release, setState, play, goTo, stand, lookAt, followRoute } from '../../sim/actors/Actor';
import { makeCat, makeDog, makeItem, makeGlint, type Critter } from './critters';

export type SmallDeedKind = 'cat' | 'dog' | 'wallet';

export interface SmallDeedHost {
  seed: number;
  time(): number;
  hoursAbs(): number;
  player: Player;
  peds: Pedestrians;
  scene: THREE.Object3D;
  trees(x: number, z: number, r: number): StreetProp[];
  route(ax: number, az: number, bx: number, bz: number): Float32Array | null;
  /** A citizen standing at a point with an actor attached (role owner). */
  spawn(seed: number, x: number, z: number, heading: number): PedAgent | null;
  ground(x: number, z: number): number;
  inBuilding(x: number, z: number): boolean;
  visible(x: number, y: number, z: number): boolean;
  sound(id: string, x: number, y: number, z: number, gain: number, pitch?: number): void;
  reward(karma: number, rep: number, reason: string): void;
  markers(list: MapMarker[]): void;
  /** A crime is running near the player (no deed then). */
  busy(): boolean;
}

export const SMALL_DEEDS = {
  /** Seconds between deeds (average) and the roll tick. */
  every: 170, tick: 5,
  karma: { cat: 9, dog: 8, wallet: 6 } as Record<SmallDeedKind, number>,
  rep: { cat: 1.5, dog: 1.5, wallet: 1 } as Record<SmallDeedKind, number>,
  ringMin: 35, ringMax: 120, timeout: 240, notice: 70,
};

interface Deed {
  kind: SmallDeedKind;
  rng: Rng;
  t: number;
  phase: 'waiting' | 'carried' | 'following' | 'done';
  owner: PedAgent | null;
  x: number; y: number; z: number;
  critter: Critter | null;
  item: THREE.Group | null;
  glint: THREE.Sprite | null;
  tree?: StreetProp;
  /** Dog: heading and speed; wander target. */
  heading: number; speed: number; turnT: number;
  callT: number;
  /** Wallet: the owner noticed it is gone. */
  missed: boolean;
}

export class SmallDeeds {
  current: Deed | null = null;
  private acc = 0;
  private slot = 0;
  private hourKey = -1;
  private climbT = 0;
  private markKey = '';
  /** Off in tests / when crimes are off. */
  enabled = true;
  stats = { spawned: 0, done: 0 };

  constructor(private h: SmallDeedHost) {}

  // ------------------------------------------------------------------ spawning

  update(dt: number): void {
    const d = this.current;
    if (d) { this.step(d, dt); this.markers(); return; }
    if (!this.enabled) return;
    this.acc += dt;
    if (this.acc < SMALL_DEEDS.tick) return;
    this.acc = 0;
    const abs = this.h.hoursAbs();
    if (Math.floor(abs) !== this.hourKey) { this.hourKey = Math.floor(abs); this.slot = 0; }
    const day = Math.floor(abs / 24);
    const s = deriveSeed(this.h.seed, 'smalldeed', day, Math.floor(abs % 24), this.slot++);
    if (hashToFloat(s) > SMALL_DEEDS.tick / SMALL_DEEDS.every || this.h.busy()) return;
    const kinds: SmallDeedKind[] = ['cat', 'dog', 'wallet'];
    const night = abs % 24 < 6 || abs % 24 > 21;
    const k = kinds[Math.floor(hashToFloat(s * 7 + 3) * 3)];
    if (night && k !== 'wallet') return;
    this.start(k, s);
  }

  /** Start a deed now (dev: window.dev.deed). */
  start(kind: SmallDeedKind, seed = (Math.random() * 2 ** 32) >>> 0): boolean {
    if (this.current) this.end(false);
    const rng = new Rng(seed);
    const d: Deed = { kind, rng, t: 0, phase: 'waiting', owner: null, x: 0, y: 0, z: 0, critter: null, item: null, glint: null, heading: 0, speed: 0, turnT: 0, callT: 1, missed: false };
    const ok = kind === 'cat' ? this.setupCat(d) : kind === 'dog' ? this.setupDog(d) : this.setupWallet(d);
    if (!ok) { this.cleanup(d); return false; }
    this.current = d;
    this.stats.spawned++;
    return true;
  }

  private ringPoint(rng: Rng): { x: number; z: number } {
    const p = this.h.player.pos;
    const a = rng.float() * Math.PI * 2, r = SMALL_DEEDS.ringMin + rng.float() * (SMALL_DEEDS.ringMax - SMALL_DEEDS.ringMin);
    return { x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r };
  }

  private setupCat(d: Deed): boolean {
    const p = this.h.player.pos;
    const trees = this.h.trees(p.x, p.z, SMALL_DEEDS.ringMax).filter((t) => t.height > 4.5 && t.height < 16 && !t.broken && Math.hypot(t.x - p.x, t.z - p.z) > 20);
    if (!trees.length) return false;
    const t = trees[d.rng.int(0, trees.length - 1)];
    d.tree = t;
    const a = d.rng.float() * Math.PI * 2, rr = Math.max(0.5, t.radius * 0.35);
    d.x = t.x + Math.cos(a) * rr; d.z = t.z + Math.sin(a) * rr; d.y = t.y + Math.max(3.4, Math.min(t.height * 0.42, 5.2));
    d.critter = makeCat(d.rng.int(0, 999));
    d.critter.object.position.set(d.x, d.y, d.z);
    d.critter.object.rotation.y = a + Math.PI;
    this.h.scene.add(d.critter.object);
    // The owner below, a couple of metres out, on the street side.
    const ox = t.x + Math.cos(a) * 2.4, oz = t.z + Math.sin(a) * 2.4;
    if (this.h.inBuilding(ox, oz)) return false;
    d.owner = this.h.spawn(d.rng.nextU32(), ox, oz, a + Math.PI);
    if (!d.owner) return false;
    Object.assign(d.owner.actor!, { mood: 'afraid', held: null });
    return true;
  }

  private setupDog(d: Deed): boolean {
    let q = this.ringPoint(d.rng);
    for (let k = 0; k < 8 && this.h.inBuilding(q.x, q.z); k++) q = this.ringPoint(d.rng);
    const r = this.h.route(q.x, q.z, q.x + 1, q.z + 1);
    if (!r) return false;
    d.x = r[0]; d.z = r[1]; d.y = this.h.ground(d.x, d.z);
    d.critter = makeDog(d.rng.int(0, 999));
    this.h.scene.add(d.critter.object);
    d.heading = d.rng.float() * Math.PI * 2;
    d.speed = 3.2;
    // The owner a few metres behind, running after it.
    d.owner = this.h.spawn(d.rng.nextU32(), d.x + Math.sin(d.heading) * 6, d.z + Math.cos(d.heading) * 6, d.heading);
    if (!d.owner) return false;
    Object.assign(d.owner.actor!, { mood: 'afraid', held: null });
    return true;
  }

  private setupWallet(d: Deed): boolean {
    const p = this.h.player.pos;
    const cands = this.h.peds.neighbours(p.x, p.z, 80, []).filter((a) => a.alive && !a.actor && !a.inside && a.state === PState.Walk && !a.onRoad && a.cit.role !== 0 && Math.hypot(a.x - p.x, a.z - p.z) > 12 && a.wp < a.route.length / 3 - 4);
    if (!cands.length) return false;
    const o = cands[d.rng.int(0, cands.length - 1)];
    const act = attach(o, makeActor('owner', -1, { held: undefined }));
    // Keep walking their own route (the actor follows a copy of it).
    act.route = o.route; act.wp = o.wp;
    d.owner = o;
    d.x = o.x + Math.sin(o.heading) * 0.6; d.z = o.z + Math.cos(o.heading) * 0.6; d.y = o.y;
    d.item = makeItem('wallet');
    d.item.position.set(d.x, d.y, d.z);
    d.item.rotation.y = d.rng.float() * 6;
    d.glint = makeGlint();
    this.h.scene.add(d.item, d.glint);
    return true;
  }

  // ------------------------------------------------------------------ per frame

  private step(d: Deed, dt: number): void {
    d.t += dt;
    const P = this.h.player, p = P.pos, now = this.h.time();
    const o = d.owner;
    if (!o || !o.alive || d.t > SMALL_DEEDS.timeout || Math.hypot(d.x - p.x, d.z - p.z) > 260) { this.end(false); return; }
    const oa = o.actor;
    if (d.critter) d.critter.update(dt, d.kind === 'dog' && d.phase !== 'done' ? d.speed : 0, now);
    if (d.glint) {
      d.glint.visible = d.phase === 'waiting';
      d.glint.position.set(d.x, d.y + 0.18, d.z);
      const k = 0.5 + 0.5 * Math.sin(now * 3.1);
      d.glint.material.opacity = 0.25 + 0.75 * k * k;
      d.glint.scale.setScalar(0.22 + 0.16 * k);
    }
    if (d.phase === 'done') {
      // The happy ending plays out, then everyone goes on.
      if (d.critter && d.kind === 'cat') { d.critter.object.position.set(o.x - Math.sin(o.heading) * 0.25, o.y + 1.05, o.z - Math.cos(o.heading) * 0.25); d.critter.object.rotation.y = o.heading; }
      if (d.critter && d.kind === 'dog') this.dogFollow(d, o.x, o.z, dt, 1.0);
      if (d.t > 9) this.end(true);
      return;
    }
    if (d.kind === 'cat') this.stepCat(d, dt);
    else if (d.kind === 'dog') this.stepDog(d, dt);
    else this.stepWallet(d, dt);
    // Carried things sit in the player's arms.
    if (d.phase === 'carried') {
      const fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw), h = P.height;
      const obj = d.critter?.object ?? d.item;
      obj?.position.set(p.x + fx * 0.32 * h / 1.8, p.y + h * 0.55, p.z + fz * 0.32 * h / 1.8);
      if (obj) obj.rotation.y = P.yaw;
      d.x = p.x; d.z = p.z; d.y = p.y;
    }
    void oa;
  }

  private stepCat(d: Deed, dt: number): void {
    const o = d.owner!, oa = o.actor!, P = this.h.player, p = P.pos;
    d.callT -= dt;
    if (d.phase === 'waiting') {
      // The owner frets under the tree, pointing up; the cat meows.
      stand(oa);
      lookAt(oa, d.x, d.y, d.z);
      setState(oa, 'point');
      if (!oa.action) play(oa, d.rng.chance(0.6) ? 'gesture_point' : 'gesture_shrug', 2.4);
      if (d.callT <= 0) { d.callT = 3 + d.rng.float() * 3.5; this.h.sound('cat_meow', d.x, d.y, d.z, 0.7, 0.9 + d.rng.float() * 0.25); }
      // Climbing the trunk (E started it): up at a steady pace.
      if (this.climbT > 0) {
        this.climbT -= dt;
        const t = d.tree!;
        if (Math.hypot(p.x - t.x, p.z - t.z) < 2.2 && p.y < d.y - 0.9) { P.vel.y = 2.4; P.grounded = false; P.vel.x *= 0.5; P.vel.z *= 0.5; }
        else this.climbT = 0;
      }
      // Within reach (climbed, jumped, flew): grab it.
      if (Math.hypot(p.x - d.x, p.z - d.z) < 1.6 && Math.abs(p.y + P.height * 0.6 - d.y) < 1.4) {
        d.phase = 'carried';
        this.climbT = 0;
        this.h.sound('cat_meow', d.x, d.y, d.z, 0.9, 1.2);
      }
    } else if (d.phase === 'carried') {
      stand(oa);
      lookAt(oa, p.x, p.y + 1.2, p.z);
      oa.mood = 'surprised';
      if (d.callT <= 0) { d.callT = 6 + d.rng.float() * 4; this.h.sound('cat_meow', p.x, p.y + 1.2, p.z, 0.4, 1.1); }
    }
  }

  private stepDog(d: Deed, dt: number): void {
    const o = d.owner!, oa = o.actor!, p = this.h.player.pos;
    d.callT -= dt;
    if (d.phase === 'waiting') {
      // Runs about, away from whoever comes close, barking; the owner runs after it calling.
      d.turnT -= dt;
      const dp = Math.hypot(d.x - p.x, d.z - p.z);
      let sp = 3.0;
      if (dp < 6) { d.heading = Math.atan2(d.x - p.x, d.z - p.z) + (d.rng.float() - 0.5) * 1.2; sp = 4.4; d.turnT = 0.8; }
      else if (d.turnT <= 0) { d.turnT = 1.5 + d.rng.float() * 2.5; d.heading += (d.rng.float() - 0.5) * 2.2; }
      d.speed += (sp - d.speed) * Math.min(1, dt * 3);
      this.dogMove(d, dt);
      if (d.callT <= 0) { d.callT = 2 + d.rng.float() * 3; this.h.sound('dog_bark', d.x, d.y + 0.5, d.z, 0.75, 0.9 + d.rng.float() * 0.2); }
      const od = Math.hypot(o.x - d.x, o.z - d.z);
      if (od > 3) goTo(oa, d.x, d.z, od > 12 ? 4.2 : 2.6); else stand(oa);
      setState(oa, 'run');
      oa.face = { x: d.x, y: d.y + 0.4, z: d.z };
      oa.memo.call = (oa.memo.call ?? 2) - dt;
      if (oa.memo.call < 0) { oa.memo.call = 3.5 + d.rng.float() * 2; this.h.sound('shout_hey', o.x, o.y + 1.6, o.z, 0.55, 0.9 + d.rng.float() * 0.2); play(oa, 'gesture_point', 1.4); }
      if (dp < 1.2) { d.phase = 'following'; this.h.sound('dog_bark', d.x, d.y + 0.5, d.z, 0.5, 1.15); }
    } else if (d.phase === 'following') {
      // Caught: trots at the player's heel; the owner waits, waving.
      this.dogFollow(d, p.x, p.z, dt, 1.1);
      stand(oa);
      lookAt(oa, p.x, p.y + 1.2, p.z);
      oa.mood = 'surprised';
      if (Math.hypot(o.x - d.x, o.z - d.z) < 3.2) this.finish(d, 'Brought the dog back');
    }
  }

  private dogMove(d: Deed, dt: number): void {
    const nx = d.x + Math.sin(d.heading) * d.speed * dt, nz = d.z + Math.cos(d.heading) * d.speed * dt;
    if (this.h.inBuilding(nx, nz)) { d.heading += Math.PI * (0.5 + d.rng.float() * 0.5); return; }
    d.x = nx; d.z = nz;
    d.y += (this.h.ground(d.x, d.z) - d.y) * Math.min(1, dt * 10);
    const obj = d.critter!.object;
    obj.position.set(d.x, d.y, d.z);
    obj.rotation.y = d.heading + Math.PI;
  }

  private dogFollow(d: Deed, tx: number, tz: number, dt: number, keep: number): void {
    const dx = tx - d.x, dz = tz - d.z, dd = Math.hypot(dx, dz);
    const sp = dd > keep ? Math.min(4.6, (dd - keep) * 2.2) : 0;
    d.speed += (sp - d.speed) * Math.min(1, dt * 4);
    if (dd > 0.2) d.heading = Math.atan2(dx, dz);
    if (d.speed > 0.05) this.dogMove(d, dt);
  }

  private stepWallet(d: Deed, dt: number): void {
    const o = d.owner!, oa = o.actor!, p = this.h.player.pos;
    if (!d.missed) {
      // Walks on, unaware.
      if (!followRoute(o, oa, o.pref)) { stand(oa); }
      if (d.t > 22) { d.missed = true; play(oa, 'gesture_shrug', 2.2); }
    } else if (d.phase !== 'done') {
      // Pats the pockets, looks back, wanders back to where it might have fallen.
      oa.mood = 'surprised';
      const dw = Math.hypot(o.x - d.x, o.z - d.z);
      if (d.phase === 'waiting' && dw > 3) goTo(oa, d.x, d.z, 0.9); else stand(oa);
      lookAt(oa, d.phase === 'carried' ? p.x : d.x, d.phase === 'carried' ? p.y + 1.2 : d.y, d.phase === 'carried' ? p.z : d.z);
      oa.memo.pat = (oa.memo.pat ?? 3) - dt;
      if (oa.memo.pat < 0) { oa.memo.pat = 4 + d.rng.float() * 3; play(oa, 'gesture_shrug', 2); }
    }
  }

  // ------------------------------------------------------------------ the player

  /** Hint text for E, or null. */
  hint(): string | null {
    const d = this.current;
    if (!d || d.phase === 'done') return null;
    const p = this.h.player.pos;
    if (d.kind === 'cat' && d.phase === 'waiting' && d.tree && Math.hypot(p.x - d.tree.x, p.z - d.tree.z) < 2.2 && p.y < d.y - 1 && this.climbT <= 0) return 'Press <b>E</b> to climb the tree';
    if (d.kind === 'wallet' && d.phase === 'waiting' && Math.hypot(p.x - d.x, p.z - d.z) < 1.6) return 'Press <b>E</b> to pick up the wallet';
    if (d.phase === 'carried' && d.owner && Math.hypot(p.x - d.owner.x, p.z - d.owner.z) < 2.6) return d.kind === 'cat' ? 'Press <b>E</b> to hand the cat back' : 'Press <b>E</b> to give the wallet back';
    return null;
  }

  /** E: climb, pick up, hand back. True when used. */
  use(): boolean {
    const d = this.current;
    if (!d || d.phase === 'done') return false;
    const P = this.h.player, p = P.pos;
    if (d.kind === 'cat' && d.phase === 'waiting' && d.tree && Math.hypot(p.x - d.tree.x, p.z - d.tree.z) < 2.2 && p.y < d.y - 1) {
      this.climbT = 4;
      P.action = { id: 'pickup', t0: P.animClock, dur: 0.5 };
      return true;
    }
    if (d.kind === 'wallet' && d.phase === 'waiting' && Math.hypot(p.x - d.x, p.z - d.z) < 1.6) {
      d.phase = 'carried';
      P.action = { id: 'pickup', t0: P.animClock, dur: 0.9 };
      return true;
    }
    if (d.phase === 'carried' && d.owner && Math.hypot(p.x - d.owner.x, p.z - d.owner.z) < 2.6) {
      P.action = { id: 'pickup', t0: P.animClock, dur: 0.8 };
      this.finish(d, d.kind === 'cat' ? 'Rescued a cat from a tree' : 'Returned a lost wallet');
      return true;
    }
    return false;
  }

  private finish(d: Deed, reason: string): void {
    d.phase = 'done';
    d.t = 0;
    const o = d.owner!, oa = o.actor!;
    stand(oa);
    oa.mood = 'happy';
    lookAt(oa, this.h.player.pos.x, this.h.player.pos.y + 1.5, this.h.player.pos.z);
    play(oa, d.kind === 'dog' ? 'pickup' : 'cheer', 2.4);
    if (d.kind === 'wallet') { oa.held = undefined; if (d.item) d.item.visible = false; }
    if (d.kind === 'cat') this.h.sound('cat_meow', o.x, o.y + 1.2, o.z, 0.6, 1.25);
    if (d.kind === 'dog') this.h.sound('dog_bark', d.x, d.y + 0.5, d.z, 0.6, 1.2);
    this.h.reward(SMALL_DEEDS.karma[d.kind], SMALL_DEEDS.rep[d.kind], reason);
    this.stats.done++;
  }

  private end(_ok: boolean): void {
    const d = this.current;
    if (!d) return;
    this.current = null;
    this.cleanup(d);
    this.markKey = '';
    this.h.markers([]);
  }

  private cleanup(d: Deed): void {
    if (d.critter) this.h.scene.remove(d.critter.object);
    if (d.item) this.h.scene.remove(d.item);
    if (d.glint) { this.h.scene.remove(d.glint); d.glint.material.map?.dispose(); d.glint.material.dispose(); }
    if (d.owner?.actor) { if (d.kind !== 'wallet' && !this.h.visible(d.owner.x, d.owner.y + 1, d.owner.z)) d.owner.alive = false; else release(d.owner); }
  }

  /** Noticed (close enough to hear it): a small amber dot on the minimap. */
  private markers(): void {
    const d = this.current;
    const p = this.h.player.pos;
    const list: MapMarker[] = [];
    if (d && d.phase !== 'done') {
      const tx = d.phase === 'carried' || d.phase === 'following' ? d.owner!.x : d.x, tz = d.phase === 'carried' || d.phase === 'following' ? d.owner!.z : d.z;
      if (Math.hypot(tx - p.x, tz - p.z) < SMALL_DEEDS.notice || d.phase !== 'waiting') list.push({ x: tx, z: tz, color: '#ffc04d', kind: 'dot', title: '' });
    }
    const key = list.map((m) => `${Math.round(m.x / 3)},${Math.round(m.z / 3)}`).join(';');
    if (key !== this.markKey) { this.markKey = key; this.h.markers(list); }
  }

  /** Warm-up object (shader precompile). */
  static warmup(): THREE.Object3D {
    const g = new THREE.Group();
    g.add(makeCat(0).object, makeDog(0).object, makeItem('wallet'), makeItem('bag'), makeItem('cash'));
    return g;
  }
}
