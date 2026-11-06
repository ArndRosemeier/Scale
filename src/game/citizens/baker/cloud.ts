/**
 * The baker's own little rain cloud: a puffy grey cloud a metre and a half over his head with a
 * thin shower falling from it onto him (and nobody else), darker and flickering with tiny
 * lightning when he is cross. It grows in when he turns sad and shrinks away when he cheers up.
 *
 * Shader budget: only MeshStandardMaterial (the program the street props already use; no new
 * defines: smooth shading, no vertex colours, no maps), the drops a CPU-updated strip of thin quads.
 */
import * as THREE from 'three';
import { clamp, lerp } from '../../../core/math';

const DROPS = 70;
/** Puffs of the cloud: [x, y, z, radius] in cloud units (1 = ~0.8 m). */
const PUFFS: [number, number, number, number][] = [
  [0, 0, 0, 0.62], [0.55, -0.08, 0.1, 0.48], [-0.58, -0.06, -0.05, 0.5], [0.22, 0.28, -0.12, 0.45],
  [-0.25, 0.22, 0.15, 0.42], [0.05, -0.12, 0.45, 0.42], [-0.1, -0.1, -0.42, 0.44], [0.85, -0.18, -0.2, 0.32], [-0.88, -0.16, 0.2, 0.3],
];

export class RainCloud {
  readonly object = new THREE.Group();
  private puffMat = new THREE.MeshStandardMaterial({ color: 0x8a9099, roughness: 1, metalness: 0 });
  private dropMat = new THREE.MeshStandardMaterial({ color: 0xa9c4e4, emissive: 0x2a3a50, roughness: 0.3, transparent: true, opacity: 0.55, depthWrite: false });
  private cloud = new THREE.Group();
  private drops: THREE.Mesh;
  private pos: Float32Array;
  /** Per drop: x, z offset, fall phase, speed. */
  private seeds = new Float32Array(DROPS * 4);
  private size = 0;
  private flash = 0;
  private t = 0;
  private placed = false;

  constructor() {
    const geo = new THREE.SphereGeometry(1, 12, 9);
    for (const [x, y, z, r] of PUFFS) {
      const m = new THREE.Mesh(geo, this.puffMat);
      m.position.set(x * 0.8, y * 0.8, z * 0.8);
      m.scale.setScalar(r * 0.8);
      m.castShadow = false;
      this.cloud.add(m);
    }
    this.object.add(this.cloud);
    // Drops: one thin vertical quad each (two triangles), facing the camera roughly by being crossed.
    this.pos = new Float32Array(DROPS * 4 * 3);
    const idx: number[] = [];
    const nor = new Float32Array(DROPS * 4 * 3);
    let s = 0x9e3779b9;
    const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
    for (let i = 0; i < DROPS; i++) {
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 0.75;
      this.seeds.set([Math.cos(a) * r, Math.sin(a) * r, rnd(), 0.85 + rnd() * 0.3], i * 4);
      const v = i * 4;
      idx.push(v, v + 1, v + 2, v + 2, v + 1, v + 3);
      for (let k = 0; k < 4; k++) nor.set([0, 0, 1], (v + k) * 3);
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    dg.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    dg.setIndex(idx);
    dg.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -1.5, 0), 3);
    this.drops = new THREE.Mesh(dg, this.dropMat);
    this.drops.frustumCulled = false;
    this.drops.renderOrder = 2;
    this.object.add(this.drops);
    this.object.visible = false;
  }

  /** How big the cloud is now (0 gone … 1 full). */
  get amount(): number { return this.size; }

  /**
   * Follow him: `x, y, z` his feet, `h` his height, `want` 0..1 how much cloud there should be,
   * `rain` 0..1 how hard it pours, `anger` 0..1, `yaw` the camera's yaw (the drops face it).
   */
  update(dt: number, x: number, y: number, z: number, h: number, want: number, rain: number, anger: number, yaw: number): void {
    this.t += dt;
    this.size = want > this.size ? Math.min(want, this.size + 0.6 * dt) : Math.max(want, this.size - 0.45 * dt);
    if (this.size <= 0.01) { this.object.visible = false; this.placed = false; return; }
    const o = this.object;
    o.visible = true;
    const top = y + h * 1.05 + 1.25;
    // Bobs and drifts a little behind him.
    const k = this.placed ? clamp(dt * 2.5, 0, 1) : 1;
    this.placed = true;
    o.position.set(lerp(o.position.x, x, k), top + Math.sin(this.t * 0.9) * 0.08, lerp(o.position.z, z, k));
    const sc = this.size * (h / 1.8);
    this.cloud.scale.setScalar(Math.max(0.01, sc));
    this.cloud.rotation.y += dt * 0.08;
    // Darker when he is cross; a tiny lightning flicker now and then.
    if (anger > 0.2 && this.flash <= 0 && Math.random() < dt * anger * 0.7) this.flash = 0.18;
    this.flash = Math.max(0, this.flash - dt);
    const g = lerp(0.58, 0.28, clamp(anger * 1.5, 0, 1)) * lerp(1, 0.85, rain);
    this.puffMat.color.setRGB(g, g * 1.03, g * 1.1);
    this.puffMat.emissive.setRGB(this.flash > 0 ? 0.9 : 0, this.flash > 0 ? 0.9 : 0, this.flash > 0 ? 1 : 0);
    // The shower: drops from the cloud's belly down to his feet (local frame: y 0 = cloud centre).
    const fall = top - 0.35 * sc - y, len = 0.16 + rain * 0.12, w = 0.012;
    const n = Math.round(DROPS * clamp(0.25 + rain, 0, 1) * this.size);
    const cx = Math.cos(yaw), sz = -Math.sin(yaw);
    for (let i = 0; i < DROPS; i++) {
      const b = i * 12;
      if (i >= n) { this.pos.fill(0, b, b + 12); continue; }
      const sx = this.seeds[i * 4] * sc, szz = this.seeds[i * 4 + 1] * sc, ph = this.seeds[i * 4 + 2], sp = this.seeds[i * 4 + 3];
      const f = (ph + this.t * sp * 4.5 / Math.max(1, fall)) % 1;
      const yTop = -0.35 * sc - f * fall, yBot = yTop - len;
      const px = sx + (x - o.position.x), pz = szz + (z - o.position.z);
      this.pos[b] = px - cx * w; this.pos[b + 1] = yTop; this.pos[b + 2] = pz - sz * w;
      this.pos[b + 3] = px + cx * w; this.pos[b + 4] = yTop; this.pos[b + 5] = pz + sz * w;
      this.pos[b + 6] = px - cx * w; this.pos[b + 7] = yBot; this.pos[b + 8] = pz - sz * w;
      this.pos[b + 9] = px + cx * w; this.pos[b + 10] = yBot; this.pos[b + 11] = pz + sz * w;
    }
    (this.drops.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.object.removeFromParent();
    (this.cloud.children[0] as THREE.Mesh | undefined)?.geometry.dispose();
    this.drops.geometry.dispose();
    this.puffMat.dispose();
    this.dropMat.dispose();
  }
}
