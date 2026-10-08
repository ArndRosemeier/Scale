/**
 * What the army's fire looks and sounds like (THREATS_PLAN §2 levels 3–4), all on pools that exist
 * already — no new programs, no new real lights:
 *
 *  - tracers: short glowing streaks flying from the muzzle (beam ribbons of the powers' Beams pool,
 *    ≤ ARMY.maxTracers at once), muzzle flashes and smoke puffs (its particles);
 *  - projectiles: tank shells, rockets with smoke trails, bombs, artillery shells — each resolves
 *    where it lands (a hit on the monster, else the street or a facade);
 *  - explosions: a fireball, smoke, chips and dust, a `gunfire` stimulus; people within the blast
 *    are knocked down and hurt (an area effect hits bystanders: injured on the casualty ledger,
 *    cause 'military'; never dead); destruction impacts from the army's fire draw on a token
 *    bucket (≤ ARMY.impactsPerS a second);
 *  - searchlights at night: emissive beam ribbons from the vehicles, sweeping over the monster;
 *  - sandbag walls (instanced, the shared vehicle material: one draw call);
 *  - the artillery's flashes on the horizon, the boom arriving later (sound at 343 m/s).
 */
import * as THREE from 'three';
import type { Game } from '../../Game';
import { BeamStyle, DecalKind } from '../../powers/ElementFx';
import { createInstancedVehicleGeometry } from '../../../props/vehicles';
import { sandbagWall } from '../../../props/military';
import { ARMY } from './BattleModel';
import { PState, type PedAgent } from '../../../sim/Pedestrians';

const FIRE_HOT = new THREE.Color(3.2, 1.6, 0.45), FIRE_END = new THREE.Color(0.6, 0.12, 0.02);
const SMOKE = new THREE.Color(0.16, 0.15, 0.14), SMOKE_L = new THREE.Color(0.42, 0.41, 0.4);
const FLASH = new THREE.Color(4, 2.6, 1.1), FLASH_END = new THREE.Color(1.2, 0.4, 0.05);
const DUST = new THREE.Color(0.55, 0.52, 0.47);
const SPARK = new THREE.Color(4, 2.4, 0.8);
const SAND: [number, number, number] = [0.62, 0.55, 0.4];

interface Tracer { ax: number; ay: number; az: number; dx: number; dy: number; dz: number; len: number; s: number; L: number; v: number; w: number; r: number; g: number; b: number }

export type ProjectileKind = 'shell' | 'rocket' | 'bomb' | 'arty';
interface Projectile {
  kind: ProjectileKind;
  ax: number; ay: number; az: number; bx: number; by: number; bz: number;
  t: number; T: number;
  /** Height of the arc over the straight line (bombs, artillery). */
  arc: number;
  land: () => void;
  trailT: number;
}

const SANDBAG_CAP = 48;

export class ArmyFx {
  private tracers: Tracer[] = [];
  private shots: Projectile[] = [];
  private tokens: number = ARMY.impactsPerS;
  private bags: THREE.InstancedMesh;
  private nBags = 0;
  private bagsDirty = false;
  private fires: { x: number; y: number; z: number; t: number }[] = [];
  private _m = new THREE.Matrix4();
  private _q = new THREE.Quaternion();
  stats = { tracers: 0, peakTracers: 0, projectiles: 0, impacts: 0, impactsSkipped: 0, explosions: 0, knocked: 0 };

  constructor(private g: Game) {
    const geo = createInstancedVehicleGeometry(sandbagWall(), SANDBAG_CAP);
    this.bags = new THREE.InstancedMesh(geo, g.vehicles.material, SANDBAG_CAP);
    this.bags.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bags.count = 0;
    this.bags.frustumCulled = false;
    this.bags.castShadow = this.bags.receiveShadow = true;
    const paint = geo.getAttribute('iPaint') as THREE.InstancedBufferAttribute;
    for (let i = 0; i < SANDBAG_CAP; i++) paint.setXYZ(i, SAND[0], SAND[1], SAND[2]);
    g.renderer.scene.add(this.bags);
  }

  /** A tracer streak from a to b (speed m/s, streak length m, colour). */
  tracer(ax: number, ay: number, az: number, bx: number, by: number, bz: number, v = 650, len = 7, w = 0.11, r = 3.2, gg = 1.3, b = 0.35, delay = 0): void {
    if (this.tracers.length >= ARMY.maxTracers) return;
    const dx = bx - ax, dy = by - ay, dz = bz - az, L = Math.hypot(dx, dy, dz) || 1;
    this.tracers.push({ ax, ay, az, dx: dx / L, dy: dy / L, dz: dz / L, len, s: -delay * v, L, v, w, r, g: gg, b });
  }

  /** A muzzle flash with a puff of smoke (size: rifle 0.4, autocannon 0.8, tank 2.5). */
  flash(x: number, y: number, z: number, dx: number, dy: number, dz: number, size: number): void {
    const fx = this.g.elements.fx;
    fx.glow(x, y, z, dx * 2, dy * 2, dz * 2, 0.06 + size * 0.02, size * 0.7, size * 1.1, FLASH, FLASH_END, 1, 4, 0);
    if (size > 0.6) for (let i = 0; i < Math.ceil(size * 2); i++) fx.soft(x + dx * size, y + dy * size, z + dz * size, dx * size * 3 + (Math.random() - 0.5) * 2, 0.6 + Math.random(), dz * size * 3 + (Math.random() - 0.5) * 2, 1.2 + size * 0.6, size * 0.6, size * 2.2, SMOKE_L, SMOKE, 0.45, 1.6, -0.4);
  }

  /** A projectile flying from a to b over T seconds (arc: m over the straight line); `land` when it arrives. */
  projectile(kind: ProjectileKind, ax: number, ay: number, az: number, bx: number, by: number, bz: number, T: number, land: () => void, arc = 0, delay = 0): void {
    this.shots.push({ kind, ax, ay, az, bx, by, bz, t: -delay, T: Math.max(0.05, T), arc, land, trailT: 0 });
    this.stats.projectiles++;
  }

  /** An explosion (size: a rocket 1, a shell 1.6, a bomb 3): fireball, smoke, chips, dust, sound, a stimulus. */
  explosion(x: number, y: number, z: number, size: number, onBody = false): void {
    const g = this.g, fx = g.elements.fx, cam = g.renderer.camera.position;
    this.stats.explosions++;
    const near = Math.hypot(cam.x - x, cam.z - z) < 900;
    if (near) {
      for (let i = 0; i < 6 + size * 4; i++) fx.glow(x, y, z, (Math.random() - 0.5) * 14 * size, Math.random() * 10 * size, (Math.random() - 0.5) * 14 * size, 0.35 + Math.random() * 0.3, size * 1.2, size * 3.2, FIRE_HOT, FIRE_END, 0.9, 2.4, -3);
      for (let i = 0; i < 3 + size * 3; i++) fx.soft(x + (Math.random() - 0.5) * size * 2, y + Math.random() * size, z + (Math.random() - 0.5) * size * 2, (Math.random() - 0.5) * 4, 2 + Math.random() * 3 * size, (Math.random() - 0.5) * 4, 3 + size * 1.5, size * 1.5, size * 5, SMOKE, SMOKE_L, 0.55, 0.6, -0.6);
      g.debris.chipBurst(x, y, z, Math.round(6 + size * 6), 6 + size * 4, 0, 1, 0, onBody ? SPARK : DUST, 0.05, 1.6);
      if (!onBody) g.dust.burst(x, y, z, Math.round(8 * size), size * 2.5, size * 3, size * 2.2, 4, DUST, 0.4, 0.5);
    }
    g.audio.play(size >= 2.5 ? 'army_bomb' : 'army_explosion', x, y, z, Math.min(1, 0.55 + size * 0.15), 1.1 - size * 0.07, 18 + size * 14, cam);
    g.stimuli.emit('gunfire', x, y, z, 5 + size, 120 + size * 60, { cause: 'military' });
    const d = Math.hypot(g.player.pos.x - x, g.player.pos.z - z);
    if (d < 250) g.camRig.addShake(Math.min(0.35, size * 12 / Math.max(25, d)));
    // Stray splash only: the army never aims at the player (a near miss stings a little).
    const r = 3 + size * 2.5;
    if (d < r && Math.abs(g.player.pos.y - y) < r) g.crime.health.damage(6 * size * (1 - d / r), 'military', x, z);
    // People in the blast (an area effect hits bystanders): knocked down, injured.
    for (const a of g.peds.neighbours(x, z, r, this.nb)) {
      // (The army's own soldiers aside: their shells fall on the target, not on their own line.)
      if (!a.alive || a.inside || a.state === PState.Down || a.actor?.role === 'soldier' || Math.abs(a.y + 0.9 - y) > r) continue;
      const da = Math.hypot(a.x - x, a.z - z);
      if (da > r) continue;
      g.reactions.knockDown(a, x, z, 3 + 8 * (1 - da / r), 'military');
      g.consequences.record('army', 'person', 'knockdown', a.x, a.z, a, 'military');
      this.stats.knocked++;
    }
  }
  private nb: PedAgent[] = [];

  /** A destruction impact from the army's fire, within the budget (−1: none left this moment). */
  impact(x: number, y: number, z: number, r: number, J: number, dx: number, dy: number, dz: number, kind: 'wall' | 'stomp' = 'wall'): number {
    if (this.tokens < 1) { this.stats.impactsSkipped++; return -1; }
    this.tokens -= 1;
    this.stats.impacts++;
    const n = this.g.destruction.as('military', () => this.g.destruction.impact(x, y, z, r, J, dx, dy, dz, kind));
    if (n) this.g.consequences.record('army', 'building', 'facade', x, z, undefined, 'military');
    return n;
  }

  /** A burning wreck (helicopter): flames and smoke for a while. */
  burn(x: number, y: number, z: number, t = 50): void {
    this.fires.push({ x, y, z, t });
    if (this.fires.length > 6) this.fires.shift();
  }

  /** A searchlight beam this frame (a shaft of light, no real light). */
  searchlight(ax: number, ay: number, az: number, bx: number, by: number, bz: number, k: number): void {
    const fx = this.g.elements.fx, c = this.g.renderer.camera.position;
    // A shaft passing close by the camera would fill the view: fade it there.
    const ux = bx - ax, uy = by - ay, uz = bz - az, L2 = ux * ux + uy * uy + uz * uz || 1;
    const t = Math.max(0, Math.min(1, ((c.x - ax) * ux + (c.y - ay) * uy + (c.z - az) * uz) / L2));
    const dc = Math.hypot(ax + ux * t - c.x, ay + uy * t - c.y, az + uz * t - c.z);
    k *= Math.min(1, Math.max(0, (dc - 6) / 40));
    if (k <= 0.01) return;
    fx.seg(ax, ay, az, bx, by, bz, 2.0, 0.55 * k, 0.55 * k, 0.5 * k, 0.2, BeamStyle.Ring);
    fx.seg(ax, ay, az, ax + (bx - ax) * 0.3, ay + (by - ay) * 0.3, az + (bz - az) * 0.3, 0.9, 0.8 * k, 0.8 * k, 0.7 * k, 0.35, BeamStyle.Ring);
    if (Math.random() < 0.3) fx.glow(ax, ay, az, 0, 0, 0, 0.2, 0.9, 1.1, FLASH_END, FLASH_END, 0.25 * k, 1, 0);
  }

  /** A sandbag emplacement: a wall facing (fx, fz) and two short side walls. */
  emplacement(x: number, z: number, fx: number, fz: number): void {
    const yaw = Math.atan2(fx, fz);
    const y = this.g.world.groundHeight(x, z);
    const put = (ox: number, oz: number, yy: number) => {
      if (this.nBags >= SANDBAG_CAP) return;
      // Local (ox along the wall, oz towards the front) to world.
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const wx = x + ox * c + oz * s, wz = z - ox * s + oz * c;
      this._q.setFromAxisAngle(_Y, yaw + yy);
      this._m.compose(_p.set(wx, this.g.world.groundHeight(wx, wz) || y, wz), this._q, _one);
      this.bags.setMatrixAt(this.nBags++, this._m);
    };
    put(0, 1.4, 0);
    put(-2.0, 0.2, Math.PI / 2 - 0.35);
    put(2.0, 0.2, -Math.PI / 2 + 0.35);
    this.bagsDirty = true;
  }

  /** Clear the sandbags (the incident is over and the units have gone). */
  clearEmplacements(): void { this.nBags = 0; this.bagsDirty = true; }

  /** The artillery firing far beyond the city edge: a flash low on the horizon, the boom later. */
  horizonFlash(bx: number, bz: number): void {
    const g = this.g, cam = g.renderer.camera.position;
    const dx = bx - cam.x, dz = bz - cam.z, d = Math.hypot(dx, dz) || 1;
    // Drawn at a fixed distance in that direction (the battery itself is beyond the fog).
    const k = Math.min(1, 1300 / d), x = cam.x + dx * k, z = cam.z + dz * k, y = g.terrain.height(x, z) + 25;
    const fx = g.elements.fx;
    for (let i = 0; i < 3; i++) fx.glow(x, y + i * 6, z, 0, 4, 0, 0.35, 30, 70, FLASH, FLASH_END, 0.8, 1, 0);
    const delay = Math.min(12, d / 343);
    setTimeout(() => g.audio.play('army_artillery', cam.x + dx / d * 300, cam.y + 30, cam.z + dz / d * 300, 0.9, 0.9 + Math.random() * 0.15, 150), delay * 1000);
  }

  update(dt: number): void {
    const g = this.g, fx = g.elements.fx;
    this.tokens = Math.min(ARMY.impactsPerS, this.tokens + dt * ARMY.impactsPerS);
    // Tracers: the streak flies along its line.
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.s += t.v * dt;
      if (t.s - t.len > t.L) { this.tracers[i] = this.tracers[this.tracers.length - 1]; this.tracers.pop(); continue; }
      if (t.s <= 0) continue;
      const h = Math.min(t.s, t.L), tl = Math.max(0, t.s - t.len);
      fx.seg(t.ax + t.dx * tl, t.ay + t.dy * tl, t.az + t.dz * tl, t.ax + t.dx * h, t.ay + t.dy * h, t.az + t.dz * h, t.w, t.r, t.g, t.b, 1.6, BeamStyle.Laser);
    }
    this.stats.tracers = this.tracers.length;
    this.stats.peakTracers = Math.max(this.stats.peakTracers, this.tracers.length);
    // Projectiles.
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const p = this.shots[i];
      p.t += dt;
      if (p.t < 0) continue;
      const k = Math.min(1, p.t / p.T);
      const x = p.ax + (p.bx - p.ax) * k, z = p.az + (p.bz - p.az) * k, y = p.ay + (p.by - p.ay) * k + p.arc * 4 * k * (1 - k);
      if (p.kind === 'rocket') {
        // A bright motor and a smoke trail.
        fx.glow(x, y, z, 0, 0, 0, 0.05, 0.5, 0.8, FLASH, FLASH_END, 1, 1, 0);
        p.trailT -= dt;
        if (p.trailT <= 0) { p.trailT = 0.03; fx.soft(x, y, z, (Math.random() - 0.5), 0.4, (Math.random() - 0.5), 1.6, 0.5, 2.2, SMOKE_L, SMOKE, 0.5, 1.2, -0.2); }
      } else if (p.kind === 'shell') {
        const kb = Math.max(0, k - 0.05);
        const x0 = p.ax + (p.bx - p.ax) * kb, y0 = p.ay + (p.by - p.ay) * kb, z0 = p.az + (p.bz - p.az) * kb;
        fx.seg(x0, y0, z0, x, y, z, 0.18, 3.5, 2.2, 1.0, 1.8, BeamStyle.Laser);
      } else if (p.kind === 'bomb' && k > 0.05) {
        fx.glow(x, y, z, 0, 0, 0, 0.04, 0.25, 0.25, SMOKE, SMOKE, 0.8, 1, 0);
      }
      if (k >= 1) { this.shots[i] = this.shots[this.shots.length - 1]; this.shots.pop(); p.land(); }
    }
    // Burning wrecks.
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      f.t -= dt;
      if (f.t <= 0) { this.fires.splice(i, 1); continue; }
      if (Math.random() < 0.5) fx.glow(f.x + (Math.random() - 0.5) * 2, f.y + 0.5, f.z + (Math.random() - 0.5) * 2, 0, 3 + Math.random() * 2, 0, 0.7, 1.2, 2.6, FIRE_HOT, FIRE_END, 0.8, 1, -2);
      if (Math.random() < 0.25) fx.soft(f.x, f.y + 2, f.z, (Math.random() - 0.5) * 1.5, 3 + Math.random() * 2, (Math.random() - 0.5) * 1.5, 6, 2, 7, SMOKE, SMOKE_L, 0.5, 0.4, -0.7);
    }
    if (this.bagsDirty) {
      this.bagsDirty = false;
      this.bags.count = this.nBags;
      this.bags.instanceMatrix.needsUpdate = true;
    }
  }

  /** Craters and scorch where a shell or bomb hit the ground. */
  scorch(x: number, y: number, z: number, size: number): void {
    this.g.elements.fx.decal(DecalKind.Scorch, x, y + 0.05, z, 0, 1, 0, size * 3, size * 3, Math.random() * 6, 120);
  }
}

const _Y = new THREE.Vector3(0, 1, 0);
const _p = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
