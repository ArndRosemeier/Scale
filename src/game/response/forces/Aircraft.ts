/**
 * The army's aircraft (THREATS_PLAN §2 level 4): attack helicopters and strike jets, instanced with
 * the shared vehicle material (one draw call per part: helicopter body, main rotor, tail rotor,
 * jet), no physics while they fly.
 *
 *  - Helicopters follow their ForceUnit (BattleModel: circling, rocket runs) with the drone layer's
 *    kind of flight (future/Drones): arrival steering with capped acceleration, a climb over
 *    buildings in the way, the body tilting into its acceleration, the yaw turning into the flight
 *    direction (facing the monster while hovering), rotors spinning, a rotor loop. Swatted by the
 *    monster (`airTargets`: Strider.airTargets) one becomes a Rapier body that spins down and
 *    crashes: an explosion, a burning wreck (it stays until the incident is over).
 *  - Jets fly straight runs (a shallow dive over the target, a climb out) on a timer: no physics;
 *    bombs are released ahead of the target (the director's callback), a flyby roar with a crack.
 */
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Game } from '../../Game';
import { createInstancedVehicleGeometry } from '../../../props/vehicles';
import { heliBody, heliRotor, heliTailRotor, jetBody, HELI_ROTOR, HELI_TAIL } from '../../../props/military';
import type { AirTarget } from '../../threats/Strider';
import { ARMY, type ForceUnit } from './BattleModel';

const OLIVE: [number, number, number] = [0.24, 0.27, 0.2];
const GREY: [number, number, number] = [0.42, 0.45, 0.48];

interface HeliVis {
  u: ForceUnit;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  yaw: number;
  q: THREE.Quaternion;
  up: THREE.Vector3;
  rotor: number; tail: number; spin: number;
  loop: ReturnType<Game['audio']['loop']>;
  body: RAPIER.RigidBody | null;
  crashT: number;
  landed: boolean;
}

interface JetRun { ax: number; az: number; dx: number; dz: number; tx: number; tz: number; ground: number; t: number; released: boolean; sound: boolean; side: number; release: (x: number, y: number, z: number, vx: number, vy: number, vz: number) => void }

const JET_V = 220, JET_PRE = 2600, JET_POST = 2600, JET_ALT = 115;

export class Aircraft {
  private helis = new Map<number, HeliVis>();
  private jets: JetRun[] = [];
  private mBody: THREE.InstancedMesh;
  private mRotor: THREE.InstancedMesh;
  private mTail: THREE.InstancedMesh;
  private mJet: THREE.InstancedMesh;
  private _m = new THREE.Matrix4();
  private _m2 = new THREE.Matrix4();
  stats = { helis: 0, jets: 0, crashed: 0, runs: 0 };
  /** A helicopter was brought down (the director books the loss). */
  onCrash: ((u: ForceUnit) => void) | null = null;
  /** A wreck hit the ground (the director: explosion, fire, a destruction impact). */
  onLanded: ((x: number, y: number, z: number) => void) | null = null;

  constructor(private g: Game) {
    const mk = (geo: THREE.BufferGeometry, cap: number, paint: [number, number, number]) => {
      const ig = createInstancedVehicleGeometry(geo, cap);
      const m = new THREE.InstancedMesh(ig, g.vehicles.material, cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = true;
      const p = ig.getAttribute('iPaint') as THREE.InstancedBufferAttribute;
      for (let i = 0; i < cap; i++) p.setXYZ(i, paint[0], paint[1], paint[2]);
      g.renderer.scene.add(m);
      return m;
    };
    this.mBody = mk(heliBody(), ARMY.maxHelis, OLIVE);
    this.mRotor = mk(heliRotor(), ARMY.maxHelis, OLIVE);
    this.mTail = mk(heliTailRotor(), ARMY.maxHelis, OLIVE);
    this.mJet = mk(jetBody(), ARMY.maxJets, GREY);
  }

  /** Helicopters near a point (the monster's swat): `swat` brings one down. */
  airTargets(x: number, y: number, z: number, r: number): AirTarget[] {
    const out: AirTarget[] = [];
    // (It lunges for a helicopter: a longer reach than for a drone.)
    const R = r * 1.7;
    for (const h of this.helis.values()) {
      if (h.body || h.u.task === 'dead') continue;
      if (Math.hypot(h.x - x, h.y - y, h.z - z) > R) continue;
      out.push({ x: h.x, y: h.y, z: h.z, swat: (jx, jy, jz) => this.crash(h, jx, jy, jz) });
    }
    return out;
  }

  /** Where a helicopter is now (rockets launch from it), or null. */
  heliPos(u: ForceUnit): { x: number; y: number; z: number; yaw: number } | null {
    const h = this.helis.get(u.id);
    return h && !h.body ? { x: h.x, y: h.y, z: h.z, yaw: h.yaw } : null;
  }

  /**
   * A jet run over (tx, tz) from the direction `ang`: bombs released ahead of the target (`release`
   * gets the jet's position and velocity). Two jets fly it, the second offset and a little later.
   */
  jetRun(tx: number, tz: number, ang: number, release: JetRun['release']): void {
    const dx = Math.cos(ang), dz = Math.sin(ang);
    const ground = this.g.terrain.height(tx, tz);
    for (const side of [0, 1]) {
      if (this.jets.length >= ARMY.maxJets) break;
      const ox = -dz * side * 140, oz = dx * side * 140;
      this.jets.push({ ax: tx + ox - dx * JET_PRE, az: tz + oz - dz * JET_PRE, dx, dz, tx: tx + ox, tz: tz + oz, ground, t: -side * 1.6, released: false, sound: false, side, release: side === 0 ? release : () => {} });
    }
    this.stats.runs++;
  }

  get jetsActive(): number { return this.jets.length; }

  private crash(h: HeliVis, jx: number, jy: number, jz: number): void {
    if (h.body) return;
    const P = this.g.physics, R = P.R;
    h.u.task = 'dead';
    h.u.hp = 0;
    this.stats.crashed++;
    h.body = P.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(h.x, h.y, h.z).setRotation({ x: h.q.x, y: h.q.y, z: h.q.z, w: h.q.w })
      .setLinvel(h.vx + jx / 600, h.vy + jy / 600, h.vz + jz / 600).setAngvel({ x: (Math.random() - 0.5) * 1.5, y: 3.5 + Math.random() * 2, z: (Math.random() - 0.5) * 1.5 })
      .setLinearDamping(0.05).setAngularDamping(0.15));
    P.world.createCollider(R.ColliderDesc.cuboid(1.1, 1.3, 4.6).setMass(5500).setFriction(0.8).setRestitution(0.1), h.body);
    P.ensureGround(h.x, h.z, 60);
    h.crashT = 0;
    h.loop?.stop(); h.loop = null;
    const cam = this.g.renderer.camera.position;
    this.g.audio.play('army_explosion', h.x, h.y, h.z, 0.8, 1.2, 40, cam);
    this.g.audio.play('metal_bend', h.x, h.y, h.z, 0.9, 0.7, 30, cam);
    this.onCrash?.(h.u);
  }

  /** Every frame: fly the helicopters after their units, the jets along their runs, draw them. */
  update(dt: number, units: ForceUnit[], look: { x: number; y: number; z: number } | null): void {
    const g = this.g, cam = g.renderer.camera.position;
    // Helicopters: a visual state per unit.
    for (const u of units) {
      if (u.kind !== 'heli' || this.helis.has(u.id) || u.task === 'dead') continue;
      const y = g.terrain.height(u.x, u.z) + ARMY.heliAlt + 40;
      this.helis.set(u.id, { u, x: u.x, y, z: u.z, vx: 0, vy: 0, vz: 0, yaw: 0, q: new THREE.Quaternion(), up: new THREE.Vector3(0, 1, 0), rotor: Math.random() * 6, tail: 0, spin: 1, loop: null, body: null, crashT: 0, landed: false });
    }
    let nb = 0;
    for (const [id, h] of this.helis) {
      if (h.body) this.stepWreck(h, dt);
      else if (h.u.task === 'dead') { this.crash(h, 0, -2000, 0); continue; }
      else if (!units.includes(h.u)) { h.loop?.stop(); this.helis.delete(id); continue; }
      else this.fly(h, dt, look);
      // Rotor sound (loads on first use).
      if (!h.body) {
        if (!h.loop) h.loop = g.audio.loop('army_rotor', 28);
        const d = Math.hypot(h.x - cam.x, h.z - cam.z);
        h.loop?.set(h.x, h.y, h.z, d > 1600 ? 0 : 0.95, 1 + Math.hypot(h.vx, h.vz) * 0.002);
      }
      if (nb >= ARMY.maxHelis || Math.hypot(h.x - cam.x, h.z - cam.z) > 2500) continue;
      this._m.compose(_p.set(h.x, h.y, h.z), h.q, _one);
      this.mBody.setMatrixAt(nb, this._m);
      _q.setFromAxisAngle(_Y, h.rotor);
      this._m2.compose(_p.set(HELI_ROTOR[0], HELI_ROTOR[1], HELI_ROTOR[2]), _q, _one).premultiply(this._m);
      this.mRotor.setMatrixAt(nb, this._m2);
      _q.setFromAxisAngle(_X, h.tail);
      this._m2.compose(_p.set(HELI_TAIL[0], HELI_TAIL[1], HELI_TAIL[2]), _q, _one).premultiply(this._m);
      this.mTail.setMatrixAt(nb, this._m2);
      const dmg = h.body ? 0.85 : 0;
      for (const m of [this.mBody, this.mRotor, this.mTail]) (m.geometry.getAttribute('iState') as THREE.InstancedBufferAttribute).setXYZW(nb, h.body ? 0 : 1, 0, 0, dmg);
      nb++;
    }
    for (const m of [this.mBody, this.mRotor, this.mTail]) { m.count = nb; if (nb) { m.instanceMatrix.needsUpdate = true; m.geometry.getAttribute('iState').needsUpdate = true; } }
    this.stats.helis = nb;
    // Jets.
    let nj = 0;
    for (let i = this.jets.length - 1; i >= 0; i--) {
      const J = this.jets[i];
      J.t += dt;
      if (J.t < 0) continue;
      const s = J.t * JET_V;
      if (s > JET_PRE + JET_POST) { this.jets.splice(i, 1); continue; }
      const x = J.ax + J.dx * s, z = J.az + J.dz * s;
      // A shallow dive to the target, a climb out after it.
      const toT = s - JET_PRE;
      const alt = JET_ALT + (toT < 0 ? Math.min(220, -toT * 0.12) : Math.min(500, toT * 0.25));
      const y = J.ground + alt;
      const pitch = toT < 0 ? -0.12 : 0.24;
      if (!J.sound && toT > -JET_V * 3.2) { J.sound = true; g.audio.play('army_jet', J.tx, J.ground + JET_ALT, J.tz, 1, 0.95 + J.side * 0.08, 260); }
      // Bombs away ahead of the target (they glide the rest of the way).
      if (!J.released && toT > -JET_V * 1.7) { J.released = true; J.release(x, y - 1, z, J.dx * JET_V, -8, J.dz * JET_V); }
      if (nj < ARMY.maxJets) {
        _e.set(pitch, Math.atan2(-J.dx, -J.dz), 0, 'YXZ');
        _q.setFromEuler(_e);
        this._m.compose(_p.set(x, y, z), _q, _one);
        this.mJet.setMatrixAt(nj++, this._m);
        // Afterburner glow.
        g.elements.fx.glow(x + J.dx * 8, y, z + J.dz * 8, 0, 0, 0, 0.04, 0.9, 0.5, _burn, _burn, 0.9, 1, 0);
      }
    }
    this.mJet.count = nj;
    if (nj) this.mJet.instanceMatrix.needsUpdate = true;
    this.stats.jets = nj;
  }

  /** Arrival steering towards the unit's place (drone-style), tilt into the acceleration, yaw into the flight. */
  private fly(h: HeliVis, dt: number, look: { x: number; y: number; z: number } | null): void {
    const g = this.g, u = h.u;
    const low = u.run === 1 || u.run === 2;
    let ground = g.terrain.height(u.x, u.z);
    const b = g.world.buildingAt(h.x + h.vx * 2, h.z + h.vz * 2);
    if (b) ground = Math.max(ground, b.top - 20);
    const ty = ground + (low ? 48 : ARMY.heliAlt);
    const ex = u.x - h.x, ey = ty - h.y, ez = u.z - h.z;
    const dist = Math.hypot(ex, ez);
    const want = Math.min(55, Math.sqrt(2 * 9 * Math.max(0, dist - 2)));
    const k = dist > 1e-3 ? want / dist : 0;
    let ax = (ex * k - h.vx) * 1.4, az = (ez * k - h.vz) * 1.4;
    const ay = (Math.max(-6, Math.min(8, ey * 0.8)) - h.vy) * 1.5;
    const ah = Math.hypot(ax, az);
    if (ah > 11) { ax *= 11 / ah; az *= 11 / ah; }
    h.vx += ax * dt; h.vy += ay * dt; h.vz += az * dt;
    h.x += h.vx * dt; h.y += h.vy * dt; h.z += h.vz * dt;
    // Attitude: tilt into the acceleration (and the drag), turn into the flight (face the monster when slow).
    const tX = (ax + h.vx * 0.08) / 9.81, tZ = (az + h.vz * 0.08) / 9.81;
    const tl = Math.hypot(tX, tZ), sc = tl > 0.4 ? 0.4 / tl : 1;
    _v.set(tX * sc, 1, tZ * sc).normalize();
    h.up.lerp(_v, Math.min(1, dt * 3)).normalize();
    const hs = Math.hypot(h.vx, h.vz);
    let hd = h.yaw;
    if ((hs < 12 || low) && look) hd = Math.atan2(-(look.x - h.x), -(look.z - h.z));
    else if (hs > 3) hd = Math.atan2(-h.vx, -h.vz);
    let dy = hd - h.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    h.yaw += dy * Math.min(1, dt * 1.4);
    _q.setFromAxisAngle(_Y, h.yaw);
    _q2.setFromUnitVectors(_Y, h.up);
    h.q.copy(_q2).multiply(_q);
    h.rotor += dt * 32;
    h.tail += dt * 60;
  }

  /** Spinning down: the body falls (Rapier), the rotor winds down; on the ground it burns. */
  private stepWreck(h: HeliVis, dt: number): void {
    const b = h.body!;
    h.crashT += dt;
    const t = b.translation(), r = b.rotation(), v = b.linvel();
    h.x = t.x; h.y = t.y; h.z = t.z;
    h.q.set(r.x, r.y, r.z, r.w);
    h.spin = Math.max(0, h.spin - dt * 0.15);
    h.rotor += dt * 20 * h.spin;
    h.tail += dt * 30 * h.spin;
    if (!h.landed) {
      // Smoke and fire trailing behind it on the way down.
      const fx = this.g.elements.fx;
      fx.soft(h.x, h.y + 1, h.z, 0, 1, 0, 3, 1.5, 5, _smoke, _smokeL, 0.6, 0.5, -0.4);
      if (Math.random() < 0.6) fx.glow(h.x, h.y + 0.5, h.z, 0, 1, 0, 0.4, 1, 2, _fire, _fireEnd, 0.9, 1, -1);
      if ((h.crashT > 1 && Math.hypot(v.x, v.y, v.z) < 3) || h.crashT > 14) {
        h.landed = true;
        this.onLanded?.(h.x, h.y, h.z);
      }
    } else if (h.crashT > 40 && b.isSleeping()) {
      // At rest: the body goes (the wreck stays where it lies, drawn from its last pose).
      this.g.physics.world.removeRigidBody(b);
      h.body = { translation: () => t, rotation: () => r, linvel: () => ({ x: 0, y: 0, z: 0 }), isSleeping: () => true } as unknown as RAPIER.RigidBody;
    }
  }

  /** The incident is over: wrecks are cleared away, rotor sounds stop. */
  clear(): void {
    for (const h of this.helis.values()) {
      h.loop?.stop();
      const b = h.body as unknown as { handle?: number } | null;
      if (b && b.handle !== undefined) try { this.g.physics.world.removeRigidBody(h.body!); } catch { /* gone */ }
    }
    this.helis.clear();
    this.jets.length = 0;
  }
}

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _Y = new THREE.Vector3(0, 1, 0);
const _X = new THREE.Vector3(1, 0, 0);
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _burn = new THREE.Color(3, 1.4, 0.5);
const _fire = new THREE.Color(3, 1.4, 0.4), _fireEnd = new THREE.Color(0.6, 0.12, 0.02);
const _smoke = new THREE.Color(0.12, 0.11, 0.1), _smokeL = new THREE.Color(0.35, 0.34, 0.33);
