/**
 * The runaway teens' stolen saucer (ALIENS_PLAN §5), the mesh only: a small, scuffed Warden disc
 * (the hull of the grown-ups' discs, a quarter of their size, dented and patched), a glass dome
 * with two small Warden heads in it bobbing about, a ring of gaudy lights chasing round the rim,
 * three glowing hover pods underneath (each goes dark and smokes when knocked out), the beam it
 * lifts things with, and the stasis bubble a parent disc holds it in. RunawayTeens flies it; the
 * omens fly a copy past.
 */
import * as THREE from 'three';
import { hullGeometry } from './Discs';
import { TEEN_COLOURS, teenGlow } from './Glyphs';

/** Radius of the saucer (m). */
export const SAUCER_R = 4.2;
/** Where the pods sit (share of the radius, below the rim) and how big they are (m). */
export const POD_AT = 0.72, POD_Y = -0.55, POD_R = 0.62;
const LIGHTS = 14;

let shared: {
  hull: THREE.BufferGeometry; hullMat: THREE.MeshStandardMaterial; glass: THREE.MeshStandardMaterial; head: THREE.MeshStandardMaterial;
  visor: THREE.MeshBasicMaterial; podOn: THREE.MeshStandardMaterial; podOff: THREE.MeshStandardMaterial; light: THREE.MeshBasicMaterial;
  beam: THREE.MeshBasicMaterial; field: THREE.MeshBasicMaterial; tether: THREE.MeshBasicMaterial;
} | null = null;

function materials() {
  if (shared) return shared;
  // The hull, dented and patched: darker blotches and a few bright patch plates in the vertex colours.
  const hull = hullGeometry().clone();
  const p = hull.attributes.position, col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = Math.sin(x * 9.1 + z * 4.3) * Math.sin(z * 7.7 - y * 5.1) * Math.sin(x * 3.3 + 1.7);
    const a = Math.atan2(z, x);
    const patch = Math.sin(a * 3 + 0.5) > 0.82 && y > 0.02 ? 0.3 : 0;
    // Scorch streaks and dents: dark blotches that read from the street.
    const scorch = Math.max(0, Math.sin(a * 5 + 1.3) * Math.sin(x * 6.1 - z * 3.7) - 0.35) * 0.9;
    const k = Math.max(0.12, 0.66 + n * 0.4 + patch - scorch);
    col.set([k * 0.95, k * 0.9, k * 0.85], i * 3);
  }
  hull.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return shared = {
    hull,
    hullMat: new THREE.MeshStandardMaterial({ color: 0xb4b2ad, vertexColors: true, metalness: 0.4, roughness: 0.6 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.32, roughness: 0.05, metalness: 0.1, depthWrite: false }),
    head: new THREE.MeshStandardMaterial({ color: 0xe9e7e1, roughness: 0.32, metalness: 0.08 }),
    visor: new THREE.MeshBasicMaterial({ color: new THREE.Color(0, 1.4, 2), toneMapped: false }),
    podOn: new THREE.MeshStandardMaterial({ color: 0x223038, emissive: new THREE.Color(0.04, 0.8, 1.2), emissiveIntensity: 1.2, roughness: 0.4 }),
    podOff: new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.8, metalness: 0.3 }),
    light: new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
    beam: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 0.35, 1.1), transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
    tether: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 0.75, 1.1), transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
    field: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.35, 0.9, 1.2), transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
  };
}

const _c = new THREE.Color();

export class TeenSaucer {
  readonly root = new THREE.Group();
  /** The tilting, spinning body (the beam and field hang off the root, upright). */
  readonly body = new THREE.Group();
  readonly pods: THREE.Mesh[] = [];
  private lights: THREE.InstancedMesh;
  private heads: THREE.Group[] = [];
  private beam: THREE.Mesh;
  private field: THREE.Mesh;
  private tether: THREE.Mesh;
  private time = Math.random() * 10;
  private spin = 0;

  constructor() {
    const M = materials();
    const hull = new THREE.Mesh(M.hull, M.hullMat);
    hull.scale.setScalar(SAUCER_R);
    hull.castShadow = true;
    this.body.add(hull);
    // The dome with the two of them in it.
    const dome = new THREE.Mesh(new THREE.SphereGeometry(SAUCER_R * 0.34, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.glass);
    dome.position.y = SAUCER_R * 0.26;
    dome.renderOrder = 3;
    for (let i = 0; i < 2; i++) {
      const h = new THREE.Group();
      const skull = new THREE.Mesh(new THREE.SphereGeometry(0.42, 14, 10), M.head);
      skull.scale.set(1.3, 0.7, 0.9);
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 0.4, 8), M.head);
      neck.position.y = -0.3;
      h.add(skull, neck);
      // Two big glowing eyes: you can tell from the street that somebody is in there, looking at you.
      for (const ex of [-0.17, 0.17]) {
        const eye = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), M.visor);
        eye.scale.set(1, 0.75, 0.6);
        eye.position.set(ex, 0.04, 0.35);
        h.add(eye);
      }
      h.position.set(i ? 0.62 : -0.62, SAUCER_R * 0.26 + 0.42, 0.1);
      this.heads.push(h);
      this.body.add(h);
    }
    this.body.add(dome);
    // Gaudy lights chasing round the rim.
    this.lights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.22, 8, 6), M.light, LIGHTS);
    const m = new THREE.Matrix4();
    for (let i = 0; i < LIGHTS; i++) {
      const a = (i / LIGHTS) * Math.PI * 2;
      m.makeTranslation(Math.cos(a) * SAUCER_R * 0.99, SAUCER_R * 0.02, Math.sin(a) * SAUCER_R * 0.99);
      this.lights.setMatrixAt(i, m);
      this.lights.setColorAt(i, _c.setRGB(1, 1, 1));
    }
    this.body.add(this.lights);
    // The hover pods.
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.5;
      const pod = new THREE.Mesh(new THREE.SphereGeometry(POD_R, 12, 8), M.podOn);
      pod.scale.y = 0.7;
      pod.position.set(Math.cos(a) * SAUCER_R * POD_AT, POD_Y, Math.sin(a) * SAUCER_R * POD_AT);
      this.pods.push(pod);
      this.body.add(pod);
    }
    this.root.add(this.body);
    // The beam (apex at the saucer, pointing down, length 1) and the stasis bubble.
    const bg = new THREE.CylinderGeometry(0.6, 1, 1, 20, 1, true);
    bg.translate(0, -0.5, 0);
    this.beam = new THREE.Mesh(bg, M.beam);
    this.beam.visible = false;
    this.beam.renderOrder = 6;
    this.field = new THREE.Mesh(new THREE.SphereGeometry(SAUCER_R * 1.35, 24, 14), M.field);
    this.field.scale.y = 0.6;
    this.field.visible = false;
    // The parent's pull: a column of light from the bubble up to the parent disc (base at the saucer, length 1).
    const tg = new THREE.CylinderGeometry(1, 1, 1, 20, 1, true);
    tg.translate(0, 0.5, 0);
    this.tether = new THREE.Mesh(tg, M.tether);
    this.tether.visible = false;
    this.tether.renderOrder = 6;
    this.root.add(this.beam, this.field, this.tether);
    for (const o of [this.beam, this.field, this.lights, this.tether]) o.frustumCulled = false;
  }

  /** Where pod i is in the world now (after the body's tilt and spin). */
  podPos(i: number, out: THREE.Vector3): THREE.Vector3 {
    this.body.updateWorldMatrix(true, false);
    return out.copy(this.pods[i].position).applyMatrix4(this.body.matrixWorld);
  }

  podOut(i: number): void { this.pods[i].material = materials().podOff; }

  /**
   * Pose and animate: position, tilt into velocity (wobbling more with pods out), the lights
   * chasing (frantic when `panic`), the heads bobbing (looking at `look` when given).
   */
  update(dt: number, x: number, y: number, z: number, vx: number, vz: number, wobble: number, panic: boolean, look: THREE.Vector3 | null): void {
    this.time += dt;
    this.spin += dt * (0.9 + (panic ? 1.4 : 0));
    this.root.position.set(x, y, z);
    const w = wobble * 0.22;
    this.body.rotation.set(
      THREE.MathUtils.clamp(vz * 0.012, -0.32, 0.32) + Math.sin(this.time * 7.3) * w,
      this.spin,
      THREE.MathUtils.clamp(-vx * 0.012, -0.32, 0.32) + Math.cos(this.time * 6.1) * w, 'YXZ');
    const step = Math.floor(this.time * (panic ? 14 : 6));
    for (let i = 0; i < LIGHTS; i++) {
      const c = TEEN_COLOURS[(i + step) % TEEN_COLOURS.length];
      const on = (i + step) % 3 !== 0 ? 1 : 0.15;
      this.lights.setColorAt(i, _c.copy(c).multiplyScalar(on * teenGlow.gain * 1.3));
    }
    if (this.lights.instanceColor) this.lights.instanceColor.needsUpdate = true;
    materials().podOn.emissiveIntensity = 1.1 * teenGlow.gain;
    this.heads.forEach((h, i) => {
      h.position.y = SAUCER_R * 0.26 + 0.42 + Math.abs(Math.sin(this.time * (3 + i) + i)) * 0.12;
      if (look) {
        const wp = h.getWorldPosition(_v);
        h.rotation.y = Math.atan2(look.x - wp.x, look.z - wp.z) - this.spin;
      } else h.rotation.y = Math.sin(this.time * (0.9 + i * 0.4) + i * 2) * 1.2;
    });
  }

  /** The beam down to a point (null: off); `strength` 0..1. */
  setBeam(to: THREE.Vector3 | null, strength = 1): void {
    if (!to || strength <= 0.01) { this.beam.visible = false; return; }
    const from = this.root.position;
    const dx = to.x - from.x, dy = to.y - (from.y - 0.5), dz = to.z - from.z, L = Math.hypot(dx, dy, dz);
    if (L < 0.5) { this.beam.visible = false; return; }
    this.beam.visible = true;
    this.beam.position.set(0, -0.5, 0);
    this.beam.quaternion.setFromUnitVectors(_down, _v.set(dx / L, dy / L, dz / L));
    const rr = Math.max(1.4, L * 0.22);
    this.beam.scale.set(rr, L, rr);
    (this.beam.material as THREE.MeshBasicMaterial).opacity = 0.32 * strength * (0.85 + 0.15 * Math.sin(this.time * 20));
  }

  /** The parent's stasis bubble round it (0: none). */
  setField(k: number): void {
    this.field.visible = k > 0.01;
    this.field.scale.set(k, k * 0.6, k);
    (this.field.material as THREE.MeshBasicMaterial).opacity = 0.2 * Math.min(1, k) * (0.8 + 0.2 * Math.sin(this.time * 9));
  }

  /** The parent's light column from the saucer straight up to `topY` (null: off). */
  setTether(topY: number | null, strength = 1): void {
    const L = topY === null ? 0 : topY - this.root.position.y;
    if (L < 0.3 || strength <= 0.01) { this.tether.visible = false; return; }
    this.tether.visible = true;
    // In the saucer's own scale (it shrinks as it rises into the parent).
    const r = SAUCER_R * 0.9;
    this.tether.scale.set(r, L / (this.root.scale.y || 1), r);
    (this.tether.material as THREE.MeshBasicMaterial).opacity = 0.3 * strength * (0.8 + 0.2 * Math.sin(this.time * 6));
  }

  dispose(): void {
    this.root.removeFromParent();
  }
}

const _v = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
