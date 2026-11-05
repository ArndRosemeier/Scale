/**
 * The gargoyle's skinned body on screen: the skin (`gargoyleSkin.ts`) as one THREE.SkinnedMesh in
 * the creatures' ONE shared material (`threats/rig/CreatureMesh`), so it compiles no program of its
 * own (the same vertex inputs as the Roc's). Bone matrices are the rig's frames × the inverse bind
 * translations; bone 0 carries the glows (the eyes). Never ray-cast.
 */
import * as THREE from 'three';
import { skinIndexAttribute } from '../../../render/skinIndex';
import { buildGargoyleSkin } from './gargoyleSkin';
import { GargoyleRig, GARGOYLE_BONES, GARGOYLE_BIND } from './gargoyleRig';

const _f = new THREE.Matrix4();
const BIND_INV = GARGOYLE_BIND.map((B) => new THREE.Matrix4().makeTranslation(-B[0], -B[1], -B[2]));

export class GargoyleMesh {
  readonly mesh: THREE.SkinnedMesh;
  private skeleton: THREE.Skeleton;
  readonly stats: { vertices: number; triangles: number; parts: number };

  constructor(material: THREE.Material) {
    const sk = buildGargoyleSkin();
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
    const bones: THREE.Bone[] = [];
    for (let b = 0; b < GARGOYLE_BONES.count; b++) bones.push(new THREE.Bone());
    this.skeleton = new THREE.Skeleton(bones);
    this.skeleton.computeBoneTexture();
    const sk2 = this.skeleton;
    sk2.update = () => { if (sk2.boneTexture) sk2.boneTexture.needsUpdate = true; };
    const mesh = new THREE.SkinnedMesh(geo, material);
    mesh.bind(this.skeleton, new THREE.Matrix4());
    mesh.name = 'gargoyle';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    mesh.raycast = () => {};
    this.mesh = mesh;
  }

  /** Pose it (its rig placed this frame). */
  draw(rig: GargoyleRig): void {
    const W = rig.world, M = this.skeleton.boneMatrices!;
    for (let b = 1; b < GARGOYLE_BONES.count; b++) _f.fromArray(W, b * 16).multiply(BIND_INV[b]).toArray(M, b * 16);
    M.fill(0, 0, 16);
    // (ridge unused, throat unused, eyes, wet.)
    M[2] = rig.eyes;
    const bs = rig.bounds();
    this.mesh.boundingSphere!.center.set(bs.x, bs.y, bs.z);
    this.mesh.boundingSphere!.radius = bs.r;
    this.mesh.visible = true;
  }

  /** During the start-up warm-up: shrunk to a speck. */
  warm(x: number, y: number, z: number): void {
    const M = this.skeleton.boneMatrices!;
    _f.makeScale(1e-3, 1e-3, 1e-3).setPosition(x, y, z);
    for (let b = 1; b < GARGOYLE_BONES.count; b++) _f.toArray(M, b * 16);
    M.fill(0, 0, 16);
    this.mesh.boundingSphere!.center.set(x, y, z);
    this.mesh.boundingSphere!.radius = 1;
    this.mesh.visible = true;
  }

  hide(): void { this.mesh.visible = false; }
}
