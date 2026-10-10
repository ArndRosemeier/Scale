/**
 * The giant mech's skinned body on screen: the mech skin (`mechSkin.ts`) as a small THREE.SkinnedMesh pool
 * (a live mech, a wreck lying in the street) in the creatures' ONE shared material (`CreatureMesh`),
 * so it compiles no program of its own. Bone matrices are the rig's frames × the inverse bind
 * translations; bone 0 carries the glows (the vents' heat on the `ridge` channel, the visor on `eyes`). Culled
 * against a sphere round the capsules; never ray-cast. A speck is drawn during the start-up warm-up.
 */
import * as THREE from 'three';
import { skinIndexAttribute } from '../../../render/skinIndex';
import { buildMechSkin } from './mechSkin';
import { MechRig, MECH_BONES, MECH_BIND } from './mechRig';

interface Slot { mesh: THREE.SkinnedMesh; skeleton: THREE.Skeleton }

const _f = new THREE.Matrix4();
/** Inverse bind (translations only). */
const BIND_INV = MECH_BIND.map((B) => new THREE.Matrix4().makeTranslation(-B[0], -B[1], -B[2]));

export class MechMesh {
  readonly group = new THREE.Group();
  private slots: Slot[] = [];
  private used = 0;
  readonly stats: { vertices: number; triangles: number; parts: number };

  constructor(material: THREE.Material, count = 2) {
    this.group.name = 'mech';
    const sk = buildMechSkin();
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
    for (let i = 0; i < count; i++) {
      const bones: THREE.Bone[] = [];
      for (let b = 0; b < MECH_BONES.count; b++) bones.push(new THREE.Bone());
      const skeleton = new THREE.Skeleton(bones);
      skeleton.computeBoneTexture();
      skeleton.update = () => { if (skeleton.boneTexture) skeleton.boneTexture.needsUpdate = true; };
      const mesh = new THREE.SkinnedMesh(geo, material);
      mesh.bind(skeleton, new THREE.Matrix4());
      mesh.name = `mech:${i}`;
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

  /** Pose a roc (its rig placed this frame); 0 when no body is free. */
  draw(rig: MechRig): number {
    if (this.used >= this.slots.length) return 0;
    const slot = this.slots[this.used++];
    const W = rig.world, M = slot.skeleton.boneMatrices!;
    for (let b = 1; b < MECH_BONES.count; b++) {
      _f.fromArray(W, b * 16).multiply(BIND_INV[b]).toArray(M, b * 16);
    }
    M.fill(0, 0, 16);
    // (ridge: the vents' heat, throat unused, eyes: the visor, wet.)
    M[0] = rig.heat; M[1] = 0; M[2] = rig.visor; M[3] = 0;
    slot.mesh.visible = true;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const c of rig.caps) {
      x0 = Math.min(x0, c.ax - c.r, c.bx - c.r); y0 = Math.min(y0, c.ay - c.r, c.by - c.r); z0 = Math.min(z0, c.az - c.r, c.bz - c.r);
      x1 = Math.max(x1, c.ax + c.r, c.bx + c.r); y1 = Math.max(y1, c.ay + c.r, c.by + c.r); z1 = Math.max(z1, c.az + c.r, c.bz + c.r);
    }
    const bs = slot.mesh.boundingSphere!;
    bs.center.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    bs.radius = Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 + 4 * rig.scale;
    return 1;
  }

  /** During the start-up warm-up: one body shrunk to a speck. */
  warm(x: number, y: number, z: number): void {
    if (this.used >= this.slots.length) return;
    const slot = this.slots[this.used++];
    const M = slot.skeleton.boneMatrices!;
    _f.makeScale(1e-3, 1e-3, 1e-3).setPosition(x, y, z);
    for (let b = 1; b < MECH_BONES.count; b++) _f.toArray(M, b * 16);
    M.fill(0, 0, 16);
    slot.mesh.visible = true;
    slot.mesh.boundingSphere!.center.set(x, y, z);
    slot.mesh.boundingSphere!.radius = 1;
  }

  end(): void { for (let i = 0; i < this.slots.length; i++) this.slots[i].mesh.visible = i < this.used; }
}
