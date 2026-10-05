/**
 * The hospital's rescue drones: three white quadcopters with red crosses and a cyan glow underneath,
 * their tractor beams, the stasis field round the body they carry, and the landing pad that lights
 * up on the hospital roof. Meshes only; Defeat moves them.
 */
import * as THREE from 'three';

const WHITE = new THREE.MeshStandardMaterial({ color: 0xf2f5f8, roughness: 0.28, metalness: 0.15, emissive: 0x2a3036, emissiveIntensity: 0.6 });
const DARK = new THREE.MeshStandardMaterial({ color: 0x23282e, roughness: 0.45, metalness: 0.6 });
const RED = new THREE.MeshStandardMaterial({ color: 0xff2a2a, emissive: 0xff1a1a, emissiveIntensity: 2.2, roughness: 0.5 });
const CYAN = new THREE.MeshStandardMaterial({ color: 0x7ff6ff, emissive: 0x38e8ff, emissiveIntensity: 3, roughness: 0.4 });
const BLUR = new THREE.MeshBasicMaterial({ color: 0xcfe9f5, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
const BEAM = new THREE.MeshBasicMaterial({ color: 0x46e6ff, transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
const FIELD = new THREE.MeshBasicMaterial({ color: 0x5ff0ff, transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
const PAD = new THREE.MeshBasicMaterial({ color: 0x46e6ff, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
const PAD_RED = new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });

/** One drone: body, arms, rotors, crosses, under-glow. */
export class MedDrone {
  readonly object = new THREE.Group();
  readonly beam: THREE.Mesh;
  private rotors: THREE.Object3D[] = [];
  private lights: THREE.Mesh[] = [];
  private t = Math.random() * 10;

  constructor() {
    const o = this.object;
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 12), WHITE);
    body.scale.set(0.95, 0.42, 1.25);
    o.add(body);
    const belly = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 0.08, 20), CYAN);
    belly.position.y = -0.2;
    o.add(belly);
    // Red crosses on top and on both flanks.
    const cross = (y: number, rx: number, ry: number, x: number) => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.02), RED), new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.34, 0.02), RED));
      g.position.set(x, y, 0);
      g.rotation.set(rx, ry, 0);
      o.add(g);
    };
    cross(0.215, -Math.PI / 2, 0, 0);
    cross(0.02, 0, Math.PI / 2, 0.47);
    cross(0.02, 0, -Math.PI / 2, -0.47);
    // Arms, motor pods, rotor rings and blur discs.
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.06, 1.0), DARK);
      arm.position.set(sx * 0.42, 0.05, sz * 0.42);
      arm.rotation.y = Math.atan2(sx, sz);
      o.add(arm);
      const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.14, 10), DARK);
      pod.position.set(sx * 0.78, 0.08, sz * 0.78);
      o.add(pod);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.025, 6, 28), WHITE);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(sx * 0.78, 0.14, sz * 0.78);
      o.add(ring);
      const rotor = new THREE.Group();
      rotor.position.set(sx * 0.78, 0.16, sz * 0.78);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.31, 20), BLUR);
      disc.rotation.x = -Math.PI / 2;
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.012, 0.05), DARK);
      rotor.add(disc, blade);
      o.add(rotor);
      this.rotors.push(rotor);
      const nav = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 4), sz > 0 ? RED : CYAN);
      nav.position.set(sx * 1.1, 0.12, sz * 1.1);
      o.add(nav);
      this.lights.push(nav);
    }
    // The tractor beam (down from the belly to the body; scaled to its length).
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.32, 1, 14, 1, true), BEAM);
    this.beam.visible = false;
  }

  update(dt: number): void {
    this.t += dt;
    for (let i = 0; i < this.rotors.length; i++) this.rotors[i].rotation.y += dt * (60 + i * 3) * (i % 2 ? 1 : -1);
    const blink = Math.sin(this.t * 7) > 0.6;
    for (const l of this.lights) l.visible = blink;
  }

  /** The beam from the drone's belly down to (x, y, z) (null: off). */
  aim(to: THREE.Vector3 | null, k = 1): void {
    const b = this.beam;
    b.visible = !!to && k > 0.02;
    if (!to || !b.visible) return;
    const p = this.object.position;
    const top = _a.set(p.x, p.y - 0.22, p.z);
    const len = Math.max(0.1, top.distanceTo(to));
    b.position.copy(top).add(to).multiplyScalar(0.5);
    b.scale.set(1, len, 1);
    b.quaternion.setFromUnitVectors(_up, _d.copy(top).sub(to).normalize());
    (b.material as THREE.MeshBasicMaterial).opacity = 0.32 * k;
  }
}

const _a = new THREE.Vector3(), _d = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);

/** The drones, the stasis field and the roof pad, all in one group. */
export class MedFleet {
  readonly group = new THREE.Group();
  readonly drones: MedDrone[] = [];
  /** The glowing capsule round the carried body. */
  readonly field: THREE.Mesh;
  /** The landing pad on the hospital roof. */
  readonly pad = new THREE.Group();
  private padRing: THREE.Mesh;
  private t = 0;

  constructor(n = 3) {
    for (let i = 0; i < n; i++) {
      const d = new MedDrone();
      this.drones.push(d);
      this.group.add(d.object, d.beam);
    }
    this.field = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 1.5, 6, 16), FIELD);
    this.field.rotation.order = 'YXZ';
    this.field.visible = false;
    this.group.add(this.field);
    this.padRing = new THREE.Mesh(new THREE.RingGeometry(4.2, 4.7, 48), PAD);
    this.padRing.rotation.x = -Math.PI / 2;
    const inner = new THREE.Mesh(new THREE.RingGeometry(2.9, 3.1, 48), PAD);
    inner.rotation.x = -Math.PI / 2;
    const c1 = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.1), PAD_RED), c2 = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 3.4), PAD_RED);
    c1.rotation.x = c2.rotation.x = -Math.PI / 2;
    this.pad.add(this.padRing, inner, c1, c2);
    this.pad.visible = false;
    this.group.add(this.pad);
    this.group.visible = false;
  }

  update(dt: number): void {
    this.t += dt;
    for (const d of this.drones) d.update(dt);
    if (this.field.visible) (this.field.material as THREE.MeshBasicMaterial).opacity = 0.14 + 0.06 * Math.sin(this.t * 5);
    if (this.pad.visible) {
      const s = 1 + 0.06 * Math.sin(this.t * 3);
      this.padRing.scale.set(s, s, 1);
      PAD.opacity = 0.6 + 0.3 * Math.sin(this.t * 3);
    }
  }

  /** Something to render once at start-up (shaders compiled before it is needed). */
  static warmupObject(): THREE.Object3D {
    const f = new MedFleet(1);
    f.group.visible = true;
    f.field.visible = true;
    f.pad.visible = true;
    f.drones[0].beam.visible = true;
    return f.group;
  }
}
