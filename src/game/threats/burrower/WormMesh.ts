/**
 * The Burrower's skinned body on screen: the worm skin (`wormSkin.ts`) as THREE.SkinnedMesh pool
 * (a live worm and one lying dead), in the creatures' ONE shared material (`CreatureMesh`: dark
 * hide, the scale texture, emissive from the glow mask), so it compiles no program of its own. Bone
 * matrices are written straight from the rig (frames × the inverse bind frames); bone 0 carries the
 * glows as the material reads them: the flank pits on the `ridge` channel (blue-white, a wave from
 * the tail to the head), the gullet on the `eyes` channel (amber). Culled against a sphere round the
 * body's capsules; never ray-cast. A speck is drawn during the start-up warm-up.
 */
import * as THREE from 'three';
import { skinIndexAttribute } from '../../../render/skinIndex';
import { buildWormSkin } from './wormSkin';
import { WormRig, WORM_BONES } from './wormRig';

interface Slot { mesh: THREE.SkinnedMesh; skeleton: THREE.Skeleton }

const _f = new THREE.Matrix4();

export class WormMesh {
  readonly group = new THREE.Group();
  private slots: Slot[] = [];
  private bindInv: THREE.Matrix4[] = [];
  private frames = new Float32Array(WORM_BONES.count * 16);
  private used = 0;
  readonly stats: { vertices: number; triangles: number; parts: number };

  /** `tint`: the hide's vertex colours scaled per channel (the Leviathan's sea-green; same program). */
  constructor(material: THREE.Material, count = 2, tint?: [number, number, number], name = 'burrower') {
    this.group.name = name;
    const sk = buildWormSkin();
    if (tint) for (let i = 0; i < sk.color.length; i++) sk.color[i] *= tint[i % 3];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(sk.position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(sk.normal, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(sk.uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(sk.color, 3));
    geo.setAttribute('glow', new THREE.BufferAttribute(sk.glow, 4));
    geo.setAttribute('skinIndex', skinIndexAttribute(sk.skinIndex));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sk.skinWeight, 4));
    geo.setIndex(new THREE.BufferAttribute(sk.index, 1));
    geo.computeBoundingSphere();
    this.stats = { vertices: sk.position.length / 3, triangles: sk.index.length / 3, parts: sk.parts.length };
    const bind = WormRig.bindFrames();
    for (let b = 0; b < WORM_BONES.count; b++) this.bindInv.push(b === 0 ? new THREE.Matrix4() : new THREE.Matrix4().fromArray(bind, b * 16).invert());
    for (let i = 0; i < count; i++) {
      const bones: THREE.Bone[] = [];
      for (let b = 0; b < WORM_BONES.count; b++) bones.push(new THREE.Bone());
      const skeleton = new THREE.Skeleton(bones);
      skeleton.computeBoneTexture();
      skeleton.update = () => { if (skeleton.boneTexture) skeleton.boneTexture.needsUpdate = true; };
      const mesh = new THREE.SkinnedMesh(geo, material);
      mesh.bind(skeleton, new THREE.Matrix4());
      mesh.name = `${name}:${i}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
      mesh.raycast = () => {};
      this.group.add(mesh);
      this.slots.push({ mesh, skeleton });
    }
  }

  begin(): void { this.used = 0; }

  /** Pose a worm (its rig placed this frame); 0 when no body is free. */
  draw(rig: WormRig, wet = 0): number {
    if (this.used >= this.slots.length) return 0;
    const slot = this.slots[this.used++];
    const F = this.frames, M = slot.skeleton.boneMatrices!;
    rig.frames(F);
    for (let b = 1; b < WORM_BONES.count; b++) {
      _f.fromArray(F, b * 16).multiply(this.bindInv[b]);
      _f.toArray(M, b * 16);
    }
    M.fill(0, 0, 16);
    // (ridge = the flank pits, throat unused, eyes = the gullet, wet.)
    M[0] = rig.pits; M[1] = 0; M[2] = rig.maw; M[3] = wet;
    slot.mesh.visible = true;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const c of rig.caps) {
      x0 = Math.min(x0, c.ax - c.r, c.bx - c.r); y0 = Math.min(y0, c.ay - c.r, c.by - c.r); z0 = Math.min(z0, c.az - c.r, c.bz - c.r);
      x1 = Math.max(x1, c.ax + c.r, c.bx + c.r); y1 = Math.max(y1, c.ay + c.r, c.by + c.r); z1 = Math.max(z1, c.az + c.r, c.bz + c.r);
    }
    const bs = slot.mesh.boundingSphere!;
    bs.center.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    bs.radius = Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 + 8 * rig.scale;
    return 1;
  }

  /** During the start-up warm-up: one body shrunk to a speck (the skinned program with this bone count). */
  warm(x: number, y: number, z: number): void {
    if (this.used >= this.slots.length) return;
    const slot = this.slots[this.used++];
    const M = slot.skeleton.boneMatrices!;
    _f.makeScale(1e-3, 1e-3, 1e-3).setPosition(x, y, z);
    for (let b = 1; b < WORM_BONES.count; b++) _f.toArray(M, b * 16);
    M.fill(0, 0, 16);
    slot.mesh.visible = true;
    slot.mesh.boundingSphere!.center.set(x, y, z);
    slot.mesh.boundingSphere!.radius = 1;
  }

  end(): void { for (let i = 0; i < this.slots.length; i++) this.slots[i].mesh.visible = i < this.used; }
}
