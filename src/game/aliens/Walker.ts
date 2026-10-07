/**
 * A Warden walker (ALIENS_PLAN §2): a tall, thin robot (about 4.3 m) set down on a square by a
 * disc's beam. It stands there for the best part of an hour, its narrow head turning slowly (now
 * and then towards whoever comes close), takes a few slow steps, and is lifted away again. It never
 * reacts to being bumped, shouted at or photographed; people give it a wide berth.
 *
 * A small rig of primitives (two at most in the city): pivots for the hips, knees, shoulders,
 * elbows and the neck, animated by hand.
 */
import * as THREE from 'three';
import { clamp, lerp } from '../../core/math';
import { Rng } from '../../core/rng';

export type WalkerPhase = 'wait' | 'descend' | 'stand' | 'step' | 'ascend' | 'gone';

/** Height of the head's top above the feet (m). */
export const WALKER_H = 4.35;
/** Where the beam starts lowering it from (m above the ground). */
export const DROP_H = 34;

let mats: { shell: THREE.MeshStandardMaterial; joint: THREE.MeshStandardMaterial; visor: THREE.MeshBasicMaterial } | null = null;
function materials() {
  return mats ??= {
    shell: new THREE.MeshStandardMaterial({ color: 0xe9e7e1, roughness: 0.32, metalness: 0.08 }),
    joint: new THREE.MeshStandardMaterial({ color: 0x2c2f35, roughness: 0.45, metalness: 0.7 }),
    visor: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.55, 1.6, 2.2), toneMapped: false }),
  };
}

/** A limb segment hanging down from its pivot: a tapered cylinder of length L. */
function seg(L: number, r0: number, r1: number, mat: THREE.Material): THREE.Mesh {
  const g = new THREE.CylinderGeometry(r0, r1, L, 10);
  g.translate(0, -L / 2, 0);
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  return m;
}

function ball(r: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), mat);
  m.castShadow = true;
  return m;
}

interface Leg { hip: THREE.Group; knee: THREE.Group }
interface Arm { sh: THREE.Group; el: THREE.Group }

export class Walker {
  readonly root = new THREE.Group();
  phase: WalkerPhase = 'wait';
  x: number; y: number; z: number;
  /** Height above its ground while hanging in the beam, and how high the beam takes it before it is gone. */
  lift = DROP_H;
  ceiling = DROP_H;
  yaw: number;
  /** Game-time end of its visit (hours). */
  readonly until: number;
  private body = new THREE.Group();
  private head = new THREE.Group();
  private legs: Leg[] = [];
  private arms: Arm[] = [];
  private headYaw = 0;
  private headWant = 0;
  private lookT = 3;
  private stepT = 30;
  private walkPh = 0;
  private walkTo: { x: number; z: number } | null = null;
  private rng: Rng;
  /** Where it was set down: it keeps within a few metres. */
  readonly homeX: number;
  readonly homeZ: number;

  constructor(x: number, y: number, z: number, seed: number, until: number) {
    this.x = this.homeX = x; this.y = y; this.z = this.homeZ = z;
    this.until = until;
    this.rng = new Rng(seed);
    this.yaw = this.rng.range(0, Math.PI * 2);
    const M = materials();
    const hipY = 3.12;
    // Legs.
    for (const s of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(s * 0.19, hipY, 0);
      hip.rotation.z = s * 0.035;
      hip.add(seg(1.5, 0.09, 0.062, M.shell));
      const knee = new THREE.Group();
      knee.position.set(0, -1.5, 0);
      knee.add(ball(0.095, M.joint), seg(1.52, 0.062, 0.045, M.shell));
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.06, 0.44), M.joint);
      foot.position.set(0, -1.55, 0.09);
      foot.castShadow = true;
      knee.add(foot);
      hip.add(knee);
      this.body.add(hip);
      this.legs.push({ hip, knee });
    }
    // Pelvis, torso, shoulders.
    const pelvis = new THREE.Mesh(new THREE.SphereGeometry(0.27, 12, 8), M.joint);
    pelvis.scale.set(1, 0.55, 0.7);
    pelvis.position.y = hipY + 0.04;
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.17, 0.82, 12), M.shell);
    torso.scale.z = 0.62;
    torso.position.y = hipY + 0.47;
    const shoulders = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.74, 4, 8), M.shell);
    shoulders.rotation.z = Math.PI / 2;
    shoulders.position.y = hipY + 0.84;
    for (const m of [pelvis, torso, shoulders]) { m.castShadow = true; this.body.add(m); }
    // Arms: long, hanging to the knees.
    for (const s of [-1, 1]) {
      const sh = new THREE.Group();
      sh.position.set(s * 0.46, hipY + 0.84, 0);
      sh.add(ball(0.085, M.joint), seg(1.18, 0.052, 0.04, M.shell));
      const el = new THREE.Group();
      el.position.y = -1.18;
      el.add(ball(0.05, M.joint), seg(1.1, 0.036, 0.028, M.shell));
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.28, 0.1), M.joint);
      hand.position.y = -1.24;
      hand.castShadow = true;
      el.add(hand);
      sh.add(el);
      sh.rotation.z = s * 0.1;
      this.body.add(sh);
      this.arms.push({ sh, el });
    }
    // Neck and the narrow head with its visor slit.
    const neck = seg(0.2, 0.03, 0.035, M.joint);
    neck.position.y = hipY + 1.1;
    this.body.add(neck);
    this.head.position.y = hipY + 1.08;
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 10), M.shell);
    skull.scale.set(1.4, 0.6, 0.85);
    skull.position.y = 0.06;
    skull.castShadow = true;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.03, 0.02), M.visor);
    visor.position.set(0, 0.07, 0.165);
    this.head.add(skull, visor);
    this.body.add(this.head);
    this.root.add(this.body);
    this.place();
  }

  /** Standing on the square (not hanging in the beam, not gone). */
  get grounded(): boolean { return this.phase === 'stand' || this.phase === 'step'; }

  /** `px, pz`: the hero, whom it may turn its head to. */
  update(dt: number, px: number, py: number, pz: number): void {
    switch (this.phase) {
      case 'wait': case 'gone':
        this.root.visible = false;
        return;
      case 'descend':
        this.lift = Math.max(0, this.lift - dt * lerp(1.2, 3.2, clamp(this.lift / 12, 0, 1)));
        if (this.lift <= 0) { this.phase = 'stand'; this.stepT = this.rng.range(20, 50); }
        this.hang(dt);
        break;
      case 'ascend':
        this.lift += dt * lerp(1.5, 4, clamp(this.lift / 10, 0, 1));
        if (this.lift > this.ceiling) this.phase = 'gone';
        this.hang(dt);
        break;
      case 'stand':
        this.relax(dt);
        this.stepT -= dt;
        if (this.stepT <= 0) {
          // A few slow steps somewhere near where it was set down.
          const a = this.rng.range(0, Math.PI * 2), r = this.rng.range(1.5, 5);
          this.walkTo = { x: this.homeX + Math.cos(a) * r, z: this.homeZ + Math.sin(a) * r };
          this.phase = 'step';
        }
        break;
      case 'step': {
        const t = this.walkTo!;
        const dx = t.x - this.x, dz = t.z - this.z, L = Math.hypot(dx, dz);
        const want = Math.atan2(dx, dz);
        let d = want - this.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        this.yaw += clamp(d, -dt * 0.8, dt * 0.8);
        if (Math.abs(d) < 0.3) {
          const v = 0.7;
          this.x += (dx / Math.max(L, 1e-3)) * Math.min(L, v * dt);
          this.z += (dz / Math.max(L, 1e-3)) * Math.min(L, v * dt);
          this.walkPh += dt * (Math.PI * 2) / 1.9;
        }
        this.gait();
        if (L < 0.08) { this.phase = 'stand'; this.stepT = this.rng.range(25, 70); }
        break;
      }
    }
    this.lookAround(dt, px, py, pz);
    this.place();
  }

  /** Legs straight, arms a little out: hanging in the beam. */
  private hang(dt: number): void {
    for (const l of this.legs) { l.hip.rotation.x *= 1 - Math.min(1, dt * 3); l.knee.rotation.x *= 1 - Math.min(1, dt * 3); }
    this.arms.forEach((a, i) => { a.sh.rotation.z = lerp(a.sh.rotation.z, (i ? 1 : -1) * 0.22, Math.min(1, dt * 2)); a.el.rotation.x = 0; });
    this.yaw += dt * 0.15;
  }

  /** Settle into the still stance. */
  private relax(dt: number): void {
    const k = Math.min(1, dt * 3);
    for (const l of this.legs) { l.hip.rotation.x *= 1 - k; l.knee.rotation.x *= 1 - k; }
    this.arms.forEach((a, i) => { a.sh.rotation.x *= 1 - k; a.sh.rotation.z = lerp(a.sh.rotation.z, (i ? 1 : -1) * 0.1, k); a.el.rotation.x *= 1 - k; });
    this.walkPh = 0;
  }

  /** A slow, deliberate stride. */
  private gait(): void {
    const s = Math.sin(this.walkPh);
    this.legs.forEach((l, i) => {
      const ph = i ? s : -s;
      l.hip.rotation.x = ph * 0.32;
      l.knee.rotation.x = Math.max(0, -Math.cos(this.walkPh + (i ? Math.PI : 0))) * 0.55;
    });
    this.arms.forEach((a, i) => { a.sh.rotation.x = (i ? -s : s) * 0.14; a.el.rotation.x = -0.08; });
  }

  /** The head turns slowly from one direction to the next, and to the hero when they are close. */
  private lookAround(dt: number, px: number, py: number, pz: number): void {
    this.lookT -= dt;
    const d = Math.hypot(px - this.x, pz - this.z);
    if (this.grounded && d < 16 && d > 0.5) {
      this.headWant = clamp(wrap(Math.atan2(px - this.x, pz - this.z) - this.yaw), -1.3, 1.3);
      this.head.rotation.x = clamp(-Math.atan2(py + 1.5 - (this.y + WALKER_H - 0.2), d) * 0.6, -0.3, 0.5);
    } else {
      if (this.lookT <= 0) { this.lookT = this.rng.range(3, 9); this.headWant = this.rng.range(-1.2, 1.2); }
      this.head.rotation.x *= 1 - Math.min(1, dt);
    }
    this.headYaw += clamp(this.headWant - this.headYaw, -dt * 0.5, dt * 0.5);
    this.head.rotation.y = this.headYaw;
  }

  private place(): void {
    this.root.visible = true;
    this.root.position.set(this.x, this.y + this.lift, this.z);
    this.root.rotation.y = this.yaw;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
  }
}

function wrap(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
