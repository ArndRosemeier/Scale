/**
 * Instanced vehicle rendering (bodies + wheels per model variant) for moving
 * traffic, parked cars and wrecks. Wrecks are Rapier rigid bodies.
 */
import * as THREE from 'three';
import { vehicleModel, createInstancedVehicleGeometry, createVehicleMaterial, vehicleUniforms, paintColor, type VehicleModel, type VehicleKind } from '../props/vehicles';
import { VState, type Vehicle } from './Traffic';
import type { Physics } from '../physics/Physics';
import type RAPIER from '@dimforge/rapier3d-compat';
import { G } from '../render/materials/globals';
import { statusOf } from '../shared/status';

const CAP = 160;
const MOVE_RANGE = 420;
const PARK_RANGE = 170;

interface Bucket {
  model: VehicleModel;
  body: THREE.InstancedMesh;
  wheels: THREE.InstancedMesh;
  paint: THREE.InstancedBufferAttribute;
  state: THREE.InstancedBufferAttribute;
  wPaint: THREE.InstancedBufferAttribute;
  wState: THREE.InstancedBufferAttribute;
  n: number;
  nw: number;
}

export interface VehicleExtra {
  spin: number;
  steer: number;
  q?: THREE.Quaternion;
  body?: RAPIER.RigidBody;
}

export class VehicleRenderer {
  readonly group = new THREE.Group();
  private buckets = new Map<string, Bucket>();
  private mat: THREE.Material;
  private extras = new WeakMap<Vehicle, VehicleExtra>();
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private frustum = new THREE.Frustum();
  private sphere = new THREE.Sphere();
  private wrecks: Vehicle[] = [];
  stats = { drawn: 0 };

  constructor(private physics: Physics) {
    this.mat = createVehicleMaterial(true);
  }

  private bucket(kind: VehicleKind, variant: number): Bucket {
    const key = `${kind}:${variant}`;
    let b = this.buckets.get(key);
    if (b) return b;
    const model = vehicleModel(kind, variant);
    const bg = createInstancedVehicleGeometry(model.body, CAP);
    const wg = createInstancedVehicleGeometry(model.wheel, CAP * model.wheels.length);
    const body = new THREE.InstancedMesh(bg, this.mat, CAP);
    const wheels = new THREE.InstancedMesh(wg, this.mat, CAP * model.wheels.length);
    for (const m of [body, wheels]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
    }
    b = {
      model, body, wheels, n: 0, nw: 0,
      paint: bg.getAttribute('iPaint') as THREE.InstancedBufferAttribute,
      state: bg.getAttribute('iState') as THREE.InstancedBufferAttribute,
      wPaint: wg.getAttribute('iPaint') as THREE.InstancedBufferAttribute,
      wState: wg.getAttribute('iState') as THREE.InstancedBufferAttribute,
    };
    this.buckets.set(key, b);
    return b;
  }

  extra(v: Vehicle): VehicleExtra {
    let e = this.extras.get(v);
    if (!e) { e = { spin: 0, steer: 0 }; this.extras.set(v, e); }
    return e;
  }

  /** Turn a vehicle into a tumbling physical wreck with an impulse (N·s) at a point. */
  makeWreck(v: Vehicle, ix: number, iy: number, iz: number, jx: number, jy: number, jz: number): void {
    const R = this.physics.R;
    const ex = this.extra(v);
    if (ex.body) { ex.body.applyImpulseAtPoint({ x: jx, y: jy, z: jz }, { x: ix, y: iy, z: iz }, true); return; }
    const m = this.bucket(v.kind as VehicleKind, v.variant).model;
    const q = new THREE.Quaternion().setFromEuler(_eul.set(v.pitch ?? 0, v.yaw, v.roll ?? 0, 'YXZ'));
    const body = this.physics.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(v.x, v.y + m.height / 2, v.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinvel(-Math.sin(v.yaw) * v.speed, 0, -Math.cos(v.yaw) * v.speed).setAngularDamping(0.4));
    this.physics.world.createCollider(R.ColliderDesc.cuboid(m.width / 2, m.height / 2, m.length / 2).setMass(m.mass).setFriction(0.7).setRestitution(0.2), body);
    body.applyImpulseAtPoint({ x: jx, y: jy, z: jz }, { x: ix, y: iy, z: iz }, true);
    ex.body = body;
    ex.q = new THREE.Quaternion();
    this.physics.ensureGround(v.x, v.z, 40);
    this.wrecks.push(v);
  }

  update(dt: number, moving: Vehicle[], parked: Vehicle[], cam: THREE.PerspectiveCamera): void {
    vehicleUniforms.uTime.value += dt;
    vehicleUniforms.uNight.value = G.uNight.value;
    for (const b of this.buckets.values()) { b.n = 0; b.nw = 0; }
    this.frustum.setFromProjectionMatrix(this.m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    // Sync wrecks from physics.
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const v = this.wrecks[i];
      const ex = this.extra(v);
      if (!ex.body) continue;
      const t = ex.body.translation(), r = ex.body.rotation();
      const m = this.bucket(v.kind as VehicleKind, v.variant).model;
      ex.q!.set(r.x, r.y, r.z, r.w);
      const off = new THREE.Vector3(0, -m.height / 2, 0).applyQuaternion(ex.q!);
      v.x = t.x + off.x; v.y = t.y + off.y; v.z = t.z + off.z;
      if (ex.body.isSleeping() || !v.alive) {
        if (!v.alive || v.stateT > 30) { this.physics.world.removeRigidBody(ex.body); ex.body = undefined; this.wrecks.splice(i, 1); }
      }
    }
    const cp = cam.position;
    const lamps = G.uNight.value > 0.3 ? 1 : 0;
    const draw = (v: Vehicle, range: number) => {
      const d = Math.hypot(v.x - cp.x, v.z - cp.z);
      if (d > range) return;
      this.sphere.center.set(v.x, v.y + 1, v.z);
      this.sphere.radius = v.length * 0.6;
      if (!this.frustum.intersectsSphere(this.sphere)) return;
      const b = this.bucket(v.kind as VehicleKind, v.variant);
      if (b.n >= CAP) return;
      const k = b.n++;
      const ex = this.extra(v);
      ex.spin += (v.speed * dt) / b.model.wheelRadius;
      if (v.paint[0] + v.paint[1] + v.paint[2] === 0) v.paint = paintColor(v.kind as VehicleKind, v.id);
      const crushed = v.state === VState.Crushed;
      // A wreck keeps the attitude it came to rest in; cars sit on the road surface.
      if (ex.q) this.q.copy(ex.q);
      else this.q.setFromEuler(_eul.set(v.pitch ?? 0, v.yaw, v.roll ?? 0, 'YXZ'));
      this.p.set(v.x, v.y, v.z);
      // Shrink ray: a tiny car (it keeps driving).
      const sc = statusOf(v)?.scale ?? 1;
      this.s.set((crushed ? 1.08 : 1) * sc, (crushed ? 0.38 : 1) * sc, (crushed ? 1.04 : 1) * sc);
      this.m4.compose(this.p, this.q, this.s);
      b.body.setMatrixAt(k, this.m4);
      b.paint.setXYZ(k, v.paint[0], v.paint[1], v.paint[2]);
      const head = v.state === VState.Abandoned || crushed ? 0 : Math.max(lamps, v.kind === 'police' ? 0.3 : 0);
      const ind = v.state === VState.Abandoned ? 2 : v.kind === 'police' && (v.fear > 0.3 || v.siren) ? 3 : v.task?.hold ? 2 : v.indicator;
      b.state.setXYZW(k, head, v.brake, ind, v.damage);
      // Wheels.
      const steerTarget = v.turn ? Math.max(-0.5, Math.min(0.5, (v.indicator || 0) * -0.35)) : 0;
      ex.steer += (steerTarget - ex.steer) * Math.min(1, dt * 5);
      b.model.wheels.forEach((w, wi) => {
        const j = b.nw++;
        const left = w[0] < 0;
        const front = w[2] < 0;
        _eul.set(-ex.spin, front ? ex.steer : 0, 0, 'YXZ');
        this.q2.setFromEuler(_eul);
        _lp.set(w[0], w[1] * (crushed ? 0.6 : 1), w[2]);
        _ls.set(left ? -1 : 1, 1, 1);
        _local.compose(_lp, this.q2, _ls);
        _world.compose(this.p, this.q, crushed || sc !== 1 ? this.s : _one).multiply(_local);
        b.wheels.setMatrixAt(j, _world);
        b.wPaint.setXYZ(j, 0.2, 0.2, 0.2);
        b.wState.setXYZW(j, 0, 0, 0, v.damage);
      });
    };
    for (const v of moving) draw(v, MOVE_RANGE);
    for (const v of parked) draw(v, PARK_RANGE);
    let total = 0;
    for (const b of this.buckets.values()) {
      b.body.count = b.n;
      b.wheels.count = b.nw;
      total += b.n;
      if (b.n) {
        b.body.instanceMatrix.needsUpdate = true;
        b.wheels.instanceMatrix.needsUpdate = true;
        b.paint.needsUpdate = b.state.needsUpdate = b.wPaint.needsUpdate = b.wState.needsUpdate = true;
      }
    }
    this.stats.drawn = total;
  }
}

const _one = new THREE.Vector3(1, 1, 1);
const _eul = new THREE.Euler();
const _lp = new THREE.Vector3();
const _ls = new THREE.Vector3();
const _local = new THREE.Matrix4();
const _world = new THREE.Matrix4();
