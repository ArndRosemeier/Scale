/**
 * Flight effects: speed streaks around the flyer, vapour trail at high speed,
 * downwash dust when skimming the ground, and a vapour cone + shock ring when
 * passing the speed of sound.
 */
import * as THREE from 'three';
import type { Player } from './Player';
import type { Dust } from '../destruction/Dust';

const N = 220;

export class FlightFX {
  readonly group = new THREE.Group();
  private streaks: THREE.InstancedMesh;
  private pos = new Float32Array(N * 3);
  private life = new Float32Array(N);
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private t = 0;
  private trailT = 0;
  private washT = 0;
  private cone: THREE.Mesh;
  private ring: THREE.Mesh;
  private coneT = 10;
  private prevSpeed = 0;
  private mat: THREE.MeshBasicMaterial;

  constructor(private dust: Dust) {
    const g = new THREE.PlaneGeometry(0.02, 1);
    this.mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    this.streaks = new THREE.InstancedMesh(g, this.mat, N);
    this.streaks.frustumCulled = false;
    this.group.add(this.streaks);
    const coneGeo = new THREE.ConeGeometry(1, 2.2, 32, 1, true);
    coneGeo.rotateX(Math.PI / 2);
    this.cone = new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.06, 8, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
    this.group.add(this.cone, this.ring);
    for (let i = 0; i < N; i++) this.life[i] = 0;
  }

  update(dt: number, p: Player, cam: THREE.Camera, groundY: number): void {
    this.t += dt;
    const k = p.k, sk = Math.sqrt(k);
    const v = p.vel.length();
    const rel = v / sk; // speed in "body lengths" terms
    // Streaks in fast flight and at super speed on foot.
    const on = p.flying || p.speeding ? Math.min(1, Math.max(0, (rel - 18) / 60)) : 0;
    this.mat.opacity = on * 0.35;
    const R = 6 * p.height + 4;
    const dir = rel > 1 ? p.vel.clone().normalize() : new THREE.Vector3(0, 0, -1);
    // Streaks: respawn ahead, fly past the camera.
    for (let i = 0; i < N; i++) {
      this.life[i] -= dt;
      const o = i * 3;
      if (this.life[i] <= 0 || on <= 0) {
        const a = Math.random() * Math.PI * 2, r = R * (0.3 + Math.random() * 0.7);
        const side = new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
        // basis around dir
        const up = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
        const x = new THREE.Vector3().crossVectors(dir, up).normalize();
        const y = new THREE.Vector3().crossVectors(x, dir);
        const off = x.multiplyScalar(side.x * r).add(y.multiplyScalar(side.y * r)).addScaledVector(dir, R * (0.5 + Math.random()));
        this.pos[o] = cam.position.x + off.x; this.pos[o + 1] = cam.position.y + off.y; this.pos[o + 2] = cam.position.z + off.z;
        this.life[i] = 0.25 + Math.random() * 0.4;
      }
      // Streaks are static in the world; we move past them.
      const len = Math.min(R * 0.6, v * 0.06) + 0.1;
      this.q.setFromUnitVectors(_y, dir);
      this.m.compose(new THREE.Vector3(this.pos[o], this.pos[o + 1], this.pos[o + 2]), this.q, new THREE.Vector3(Math.max(1, p.height * 0.6), len, 1));
      this.streaks.setMatrixAt(i, this.m);
    }
    this.streaks.instanceMatrix.needsUpdate = true;
    // Vapour trail at high speed.
    this.trailT -= dt;
    if (p.flying && rel > 70 && this.trailT <= 0) {
      this.trailT = 0.04;
      const c = p.pos.clone().addScaledVector(dir, -p.height * 0.6);
      c.y += p.height * 0.5;
      this.dust.burst(c.x, c.y, c.z, 1, p.height * 0.1, 0.5, p.height * 0.25, 2.2, new THREE.Color(0.95, 0.96, 1), 0, 0.22);
    }
    // Downwash: skimming the ground kicks up dust.
    this.washT -= dt;
    const alt = p.pos.y - groundY;
    if (p.flying && alt < p.height * 3 && rel > 12 && this.washT <= 0) {
      this.washT = 0.05;
      this.dust.burst(p.pos.x, groundY + 0.2, p.pos.z, 2, p.height * 0.5, rel * 0.08 * sk, p.height * 0.3 + 0.4, 2.5, new THREE.Color(0.6, 0.57, 0.52), 0.05, 0.35);
    }
    // Sound barrier.
    if (p.flying && v > 343 && this.prevSpeed <= 343) this.coneT = 0;
    this.prevSpeed = v;
    this.coneT += dt;
    const cm = this.cone.material as THREE.MeshBasicMaterial, rm = this.ring.material as THREE.MeshBasicMaterial;
    if (this.coneT < 1.2) {
      const f = this.coneT / 1.2;
      this.cone.position.copy(p.pos).addScaledVector(dir, p.height * 0.2);
      this.cone.position.y += p.height * 0.5;
      this.cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().negate());
      this.cone.scale.setScalar(p.height * (0.8 + f * 2));
      cm.opacity = 0.35 * (1 - f);
      this.ring.position.copy(this.cone.position);
      this.ring.quaternion.copy(this.cone.quaternion);
      this.ring.scale.setScalar(p.height * (1 + f * 25));
      rm.opacity = 0.5 * (1 - f);
    } else { cm.opacity = 0; rm.opacity = 0; }
  }
}

const _y = new THREE.Vector3(0, 1, 0);
