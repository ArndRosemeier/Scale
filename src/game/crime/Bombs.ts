/**
 * Villains' bombs (the mad bomber, crime/Bomber): a round black bomb with a lit fuse, lobbed in an
 * arc, lying in the street hissing and sparking for a moment, then going off.
 *
 * The blast is the fireball's look (powers/blastFx) on the world's own reactions: people near it
 * are thrown down and hurt (and the nearest catch fire), cars close by are wrecked and the ones
 * farther off scorched and set burning, props topple, windows and light walls break (a
 * destruction impact booked as fire, never to the player), the player takes damage through
 * PlayerHealth (size, invulnerability), and bystanders run (a `gunfire` stimulus: a scare, no
 * knock-downs booked to the player). Bombs that land on a fuse can be outrun: the fuse is the tell.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Game } from '../Game';
import type { PedAgent } from '../../sim/Pedestrians';
import { PState } from '../../sim/Pedestrians';
import { VState, dentCar } from '../../sim/Traffic';
import { fireBurst } from '../powers/blastFx';
import type { HurtKind } from '../PlayerHealth';

export const BOMB = {
  /** Blast radius (m): people thrown, the player hurt. */
  radius: 4.8,
  /** Cars nearer than this are wrecked; out to the radius they are scorched and set burning. */
  wreckR: 2.6,
  /** On the facades (N·s): blows out windows and light walls next to it. */
  blast: 22000,
  /** Fling speed (m/s) for a person at the centre. */
  person: 9,
  /** Damage to the player at the centre (before size), out to `playerR` m (a dash sideways on the fuse gets clear). */
  player: 26,
  playerR: 3.6,
  /** Throwing speed along the ground (m/s) and the limits of the flight time (s). */
  speed: 13,
  flight: [0.45, 1.6],
  /** Bombs in the air or on the ground at once. */
  cap: 12,
};

interface Bomb {
  ax: number; ay: number; az: number; bx: number; by: number; bz: number;
  t: number; T: number; arc: number;
  /** Seconds of fuse left once it has landed. */
  fuse: number;
  landed: boolean;
  x: number; y: number; z: number;
  spin: number;
}

const SPARK = new THREE.Color(4, 2.6, 1.0), SPARK_END = new THREE.Color(1.4, 0.35, 0.05);

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _e = new THREE.Euler();

export class Bombs {
  private live: Bomb[] = [];
  private mesh: THREE.InstancedMesh;
  private nb: PedAgent[] = [];
  /** The player is hurt through here (CrimeSystem: PlayerHealth and its sound). */
  hurtPlayer: ((dmg: number, kind: HurtKind, fromX: number, fromZ: number, fromY: number) => void) | null = null;
  stats = { thrown: 0, exploded: 0, knocked: 0, wrecked: 0, atPlayer: 0 };

  constructor(private g: Game) {
    const body = new THREE.SphereGeometry(0.13, 12, 9);
    // The fuse cap: a short stub on top.
    const cap = new THREE.CylinderGeometry(0.035, 0.04, 0.07, 8).translate(0, 0.14, 0);
    const geo = mergeGeometries([body, cap]) ?? body;
    const mat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.45, metalness: 0.35 });
    this.mesh = new THREE.InstancedMesh(geo, mat, BOMB.cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    g.renderer.scene.add(this.mesh);
  }

  get count(): number { return this.live.length; }

  /** Lob a bomb from a person's hand to the ground at (tx, tz); false when too many are out already. */
  throw(by: PedAgent, tx: number, tz: number, fuse: number): boolean {
    if (this.live.length >= BOMB.cap) return false;
    const fx = tx - by.x, fz = tz - by.z, fl = Math.hypot(fx, fz) || 1;
    const ax = by.x + (fx / fl) * 0.4, az = by.z + (fz / fl) * 0.4, ay = by.y + 1.75;
    const bz = tz, bx = tx, byy = this.g.floorAt(tx, by.y, tz) + 0.13;
    const T = Math.min(BOMB.flight[1], Math.max(BOMB.flight[0], fl / BOMB.speed));
    this.live.push({ ax, ay, az, bx, by: byy, bz, t: 0, T, arc: 1 + fl * 0.22, fuse, landed: false, x: ax, y: ay, z: az, spin: Math.random() * 6 });
    this.stats.thrown++;
    return true;
  }

  update(dt: number): void {
    if (!this.live.length) { if (this.mesh.count) { this.mesh.count = 0; } return; }
    const fx = this.g.elements.fx;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const b = this.live[i];
      if (!b.landed) {
        b.t += dt;
        const u = Math.min(1, b.t / b.T);
        b.x = b.ax + (b.bx - b.ax) * u;
        b.z = b.az + (b.bz - b.az) * u;
        b.y = b.ay + (b.by - b.ay) * u + b.arc * 4 * u * (1 - u);
        b.spin += dt * 9;
        if (u >= 1) { b.landed = true; this.g.audio.play('spray_hiss', b.x, b.y, b.z, 0.45, 1.6, 5, this.g.renderer.camera.position); }
      } else {
        b.fuse -= dt;
        if (b.fuse <= 0) { this.live.splice(i, 1); this.explode(b.x, b.y, b.z); continue; }
      }
      // The lit fuse: sparks spitting from the top (the tell).
      const n = Math.random() < 0.6 ? 2 : 1;
      for (let k = 0; k < n; k++) fx.glow(b.x, b.y + 0.2, b.z, (Math.random() - 0.5) * 2.4, 1 + Math.random() * 2, (Math.random() - 0.5) * 2.4, 0.18 + Math.random() * 0.15, 0.09, 0.02, SPARK, SPARK_END, 1, 1, -6);
    }
    for (let i = 0; i < this.live.length; i++) {
      const b = this.live[i];
      _q.setFromEuler(_e.set(b.landed ? 0.3 : b.spin, b.spin * 0.7, 0));
      this.mesh.setMatrixAt(i, _m.compose(_p.set(b.x, b.y, b.z), _q, _s));
    }
    this.mesh.count = this.live.length;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** A bomb goes off at (x, y, z) (the centre of the bomb lying on the ground). */
  explode(x: number, y: number, z: number): void {
    const g = this.g, R = BOMB.radius, cam = g.renderer.camera.position;
    this.stats.exploded++;
    const ground = g.floorAt(x, y - 0.13, z);
    if (Math.hypot(cam.x - x, cam.z - z) < 700) fireBurst(g.elements.fx, g.debris, g.dust, x, y + 0.5, z, 1.25, ground, 0.6);
    g.audio.play('army_explosion', x, y, z, 0.95, 1.05 + Math.random() * 0.1, 30, cam);
    g.destruction.as('fire', () => g.destruction.impact(x, y + 0.6, z, 2.4, BOMB.blast, 0, 0.2, 0, 'blast'));
    g.props.hit(x, y + 0.5, z, R * 0.8, 0, 900, 0);
    // People: thrown and hurt (Combat books the injury through the knock-down), the nearest set alight.
    for (const a of g.peds.neighbours(x, z, R, this.nb)) {
      if (!a.alive || a.inside || Math.abs(a.y - y) > R) continue;
      const d = Math.hypot(a.x - x, a.z - z), f = 1 - d / R;
      if (f <= 0) continue;
      if (a.state !== PState.Down) { g.reactions.knockDown(a, x, z, 2.5 + BOMB.person * f, 'other'); a.vy = 2 + 3 * f; this.stats.knocked++; }
      if (f > 0.55) g.elements.ignite({ kind: 'person', obj: a }, 2 + 2 * f);
    }
    // Cars: wrecked close by, scorched and burning farther off.
    for (const list of [g.traffic.vehicles, g.parkedCars]) for (const v of list) {
      const d = Math.max(0, Math.hypot(v.x - x, v.z - z) - v.length * 0.4);
      if (d > R) continue;
      const f = 1 - d / R;
      v.fear = 2;
      g.elements.ignite({ kind: 'car', obj: v }, 4 + 6 * f);
      if (d < BOMB.wreckR && v.state !== VState.Wreck && v.state !== VState.Crushed) {
        const hx = v.x - x, hz = v.z - z, hl = Math.hypot(hx, hz) || 1;
        g.traffic.wreckIt(v);
        g.vehicles.makeWreck(v, x, y + 0.3, z, (hx / hl) * 6000 * f, 5000 * f, (hz / hl) * 6000 * f);
        this.stats.wrecked++;
      } else { v.speed *= 0.3; dentCar(v, 0.3 * f); }
    }
    // The player.
    const P = g.player, pd = Math.hypot(P.pos.x - x, P.pos.z - z);
    const PR = BOMB.playerR + P.height * 0.1;
    if (pd < PR && P.pos.y < y + R && P.pos.y + P.height > y - 1) {
      this.stats.atPlayer++;
      this.hurtPlayer?.(BOMB.player * (1 - pd / PR) + 4, 'bomb', x, z, y);
    }
    g.stimuli.emit('gunfire', x, y, z, 6, 150);
    const dp = Math.hypot(P.pos.x - x, P.pos.z - z);
    if (dp < 200) g.camRig.addShake(Math.min(0.6, 14 / Math.max(12, dp)));
  }
}
