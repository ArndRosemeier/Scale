/**
 * A renderable humanoid: skeleton (own bones per instance for independent
 * animation), skinned body with three LODs, eyes, lashes, teeth & tongue,
 * hair/beard/horn/tusk/tail parts, sockets for equipment, and the per-
 * character materials.
 *
 * Geometry is shared between characters with identical appearances
 * (`CharacterGeometry`, ref-counted by the BodyService); every character owns
 * its bones and materials (expression weights, sky visibility).
 *
 * Rest pose bones carry no rotation (translation-only frames aligned with
 * the model axes: +Y up, character faces −Z, character's left is −X), which
 * makes procedural animation and IK straightforward.
 */
import * as THREE from 'three';
import type { HumanoidAppearance } from '../types';
import type { CharacterBuild } from '../characterBuild';
import type { PartGeo } from '../parts';
import type { HumanStatic } from './staticData';
import type { SkyVisPatch } from '../../render/skyOcclusion';
import { createSkinMaterial, applySkinLook, type SkinMaterialHandle } from './skinMaterial';
import {
  createEyeMaterial, eyeGeometry, createHairMaterial, applyHairColor, createHornMaterial, simpleMaterial, createLashMaterial,
  type PatchedMaterial, type EyeUniforms, type HairUniforms, type HornUniforms,
} from './partMaterials';
import { shellIndex, createShellMaterial, scalpShellFor, beardShellFor } from './hairShells';

/** Shell triangle subsets per (style) spec — identical for every body. */
const shellIndexCache = new Map<string, Uint16Array>();

// ------------------------------------------------------------------ shared geometry

function partGeometry(p: PartGeo): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(p.normal, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(p.uv, 2));
  g.setAttribute('hairTangent', new THREE.BufferAttribute(p.tangent, 3));
  g.setAttribute('hairAux', new THREE.BufferAttribute(p.aux, 2));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(p.skinIndex, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(p.skinWeight, 4));
  if (p.material === 'tail') {
    // The tail uses the skin shader: neutral masks, face coords far from the face.
    const n = p.position.length / 3;
    g.setAttribute('aMaskA', new THREE.Uint8BufferAttribute(new Uint8Array(n * 4), 4, true));
    g.setAttribute('aMaskB', new THREE.Uint8BufferAttribute(new Uint8Array(n * 4), 4, true));
    g.setAttribute('aFace', new THREE.BufferAttribute(new Float32Array(n * 3).fill(-20), 3));
    g.setAttribute('aExpr', new THREE.BufferAttribute(new Float32Array(n).fill(-1), 1));
  }
  g.setIndex(new THREE.BufferAttribute(p.index, 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * Free a geometry's own GL buffers but not those of attributes it shares (three's dispose()
 * deletes the buffer of every attribute in the geometry: a shared one would be gone for every
 * other geometry using it too — draws from a stale vertex array, "no buffer is bound to enabled
 * attribute").
 */
export function disposeOwn(g: THREE.BufferGeometry, shared: (a: THREE.BufferAttribute) => boolean): void {
  for (const name of Object.keys(g.attributes)) if (shared(g.attributes[name] as THREE.BufferAttribute)) g.deleteAttribute(name);
  if (g.index && shared(g.index)) g.setIndex(null);
  g.dispose();
}

/** Geometry for one built appearance, shared by all characters using it. */
export class CharacterGeometry {
  /** Body geometries for LOD 0..2 (same vertex attributes, different index). */
  readonly body: THREE.BufferGeometry[];
  readonly lashes: THREE.BufferGeometry;
  readonly teeth: THREE.BufferGeometry;
  readonly tongue: THREE.BufferGeometry;
  readonly parts: { geo: THREE.BufferGeometry; part: PartGeo }[][];
  readonly position: THREE.BufferAttribute;
  readonly normal: THREE.BufferAttribute;
  refs = 0;

  constructor(readonly st: HumanStatic, readonly build: CharacterBuild) {
    this.position = new THREE.BufferAttribute(build.renderPos, 3);
    this.normal = new THREE.BufferAttribute(build.renderNormal, 3);
    const mk = (index: THREE.BufferAttribute, uv = st.uv) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', this.position);
      g.setAttribute('normal', this.normal);
      g.setAttribute('uv', uv);
      g.setAttribute('skinIndex', st.skinIndex);
      g.setAttribute('skinWeight', st.skinWeight);
      g.setAttribute('aMaskA', st.maskA);
      g.setAttribute('aMaskB', st.maskB);
      g.setAttribute('aFace', st.face);
      g.setAttribute('aExpr', st.expr);
      g.setIndex(index);
      return g;
    };
    this.body = st.bodyIndex.map((ix) => mk(ix));
    const h = build.body.height;
    const sphere = new THREE.Sphere(new THREE.Vector3(0, h * 0.5, 0), h * 0.75 + 0.3);
    for (const g of this.body) g.boundingSphere = sphere;
    this.lashes = mk(st.lashIndex, st.lashUv);
    this.teeth = mk(st.teethIndex);
    this.tongue = mk(st.tongueIndex);
    for (const g of [this.lashes, this.teeth, this.tongue]) g.boundingSphere = sphere;
    this.parts = build.parts.map((pr) => pr.parts.map((part) => ({ part, geo: partGeometry(part) })));
    for (const lod of this.parts) for (const p of lod) p.geo.boundingSphere = sphere;
  }

  dispose() {
    // The static attributes and indices belong to HumanStatic (every character uses them): keep them.
    const st = this.st;
    const shared = new Set<THREE.BufferAttribute>([st.uv, st.skinIndex, st.skinWeight, st.maskA, st.maskB, st.face, st.expr, st.lashUv, ...st.bodyIndex, st.tongueIndex, st.teethIndex, st.lashIndex]);
    for (const g of [...this.body, this.lashes, this.teeth, this.tongue]) disposeOwn(g, (a) => shared.has(a));
    for (const lod of this.parts) for (const p of lod) p.geo.dispose();
  }
}

// ------------------------------------------------------------------ character

const _m = new THREE.Matrix4();

export interface CharacterOptions {
  /** Enable facial expressions (near LOD). */
  expressions?: boolean;
  castShadow?: boolean;
}

export class Character {
  readonly object = new THREE.Group();
  /** Inner group: animation root offsets (lean, hit recoil) are applied here. */
  readonly model = new THREE.Group();
  readonly bones: THREE.Bone[] = [];
  readonly boneIndex = new Map<string, number>();
  readonly skeleton: THREE.Skeleton;
  readonly sockets = new Map<string, THREE.Object3D>();
  readonly eyes: THREE.Object3D[] = [];
  /** Rest-pose bone heads (model space, final scale). */
  readonly rest: THREE.Vector3[] = [];
  readonly exprW: Float32Array;
  readonly lods: THREE.Group[] = [new THREE.Group(), new THREE.Group(), new THREE.Group()];
  readonly bodyMeshes: THREE.SkinnedMesh[] = [];
  readonly skin: SkinMaterialHandle;
  readonly skinLow: SkinMaterialHandle;
  readonly eyeMat: PatchedMaterial<EyeUniforms>;
  private hairMats: PatchedMaterial<HairUniforms>[] = [];
  private hornMat: PatchedMaterial<HornUniforms> | null = null;
  private skyPatches: SkyVisPatch[] = [];
  private ownMaterials: THREE.Material[] = [];
  private ownGeometries: THREE.BufferGeometry[] = [];
  lod = 0;
  /** Painted scalp shading (shaved styles) — restored after helmets come off. */
  readonly shavedScalp: number;
  hairMeshes: THREE.Object3D[] = [];
  beardMeshes: THREE.Object3D[] = [];

  constructor(readonly geo: CharacterGeometry, readonly app: HumanoidAppearance, opts: CharacterOptions = {}) {
    const st = geo.st, build = geo.build, as = st.assets;
    geo.refs++;
    this.object.name = 'humanoid';
    this.object.add(this.model);

    // ---- skeleton (translation-only rest frames)
    const defs = as.manifest.bones;
    const heads = build.body.heads;
    const allBones = [...defs.map((d, i) => ({ name: d.name, parent: d.parent, head: [heads[i * 3], heads[i * 3 + 1], heads[i * 3 + 2]] as [number, number, number] })), ...build.parts[0].extraBones];
    allBones.forEach((d, i) => {
      const b = new THREE.Bone();
      b.name = d.name;
      const p = d.parent;
      const ph = p >= 0 ? allBones[p].head : [0, 0, 0];
      b.position.set(d.head[0] - ph[0], d.head[1] - ph[1], d.head[2] - ph[2]);
      (p >= 0 ? this.bones[p] : this.model).add(b);
      this.bones.push(b);
      this.boneIndex.set(d.name, i);
      this.rest.push(new THREE.Vector3(...d.head));
    });
    this.model.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(this.bones);

    // ---- materials
    const exprUnits = st.exprNames.length;
    this.skin = createSkinMaterial({ expr: opts.expressions !== false, exprTex: st.exprTex, exprUnits, lod: 0 });
    this.skinLow = createSkinMaterial({ expr: false, exprTex: null, exprUnits, lod: 1 });
    this.exprW = this.skin.uniforms.uExprW.value;
    this.shavedScalp = build.parts[0].shavedScalp;
    for (const s of [this.skin, this.skinLow]) {
      applySkinLook(s.uniforms, app, { shavedScalp: this.shavedScalp, hairCovered: false });
      s.uniforms.uFaceScale.value = build.body.faceScale;
      this.skyPatches.push(s.sky);
      this.ownMaterials.push(s.material);
    }
    this.eyeMat = createEyeMaterial();
    const eu = this.eyeMat.uniforms;
    eu.uIris.value.setRGB(app.eyeColor[0], app.eyeColor[1], app.eyeColor[2], THREE.SRGBColorSpace);
    eu.uPupil.value.set({ round: 0, slit: 1, goat: 2, none: 3 }[app.pupil] ?? 0, 0.5, app.eyeGlow, ((app.seed >>> 3) % 997) / 997);
    if (app.race === 'umbral' && app.pupil === 'none') eu.uScleraTint.value.setRGB(0.55, 0.55, 0.62);
    this.reg(this.eyeMat);
    const lash = createLashMaterial();
    lash.material instanceof THREE.MeshStandardMaterial && lash.material.color.setRGB(app.hairColor[0] * 0.3, app.hairColor[1] * 0.3, app.hairColor[2] * 0.3, THREE.SRGBColorSpace);
    this.reg(lash);
    const teeth = simpleMaterial(new THREE.Color().setRGB(0.86, 0.82, 0.72, THREE.SRGBColorSpace), { roughness: 0.28, clearcoat: 0.4 });
    const tongue = simpleMaterial(new THREE.Color().setRGB(0.6, 0.28, 0.28, THREE.SRGBColorSpace), { roughness: 0.38, sheen: 0.3 });
    this.reg(teeth);
    this.reg(tongue);

    // ---- meshes per LOD
    const castShadow = opts.castShadow !== false;
    const skinned = (g: THREE.BufferGeometry, m: THREE.Material, lod: number, shadow = castShadow) => {
      const mesh = new THREE.SkinnedMesh(g, m);
      mesh.bind(this.skeleton, _m.identity());
      mesh.boundingSphere = g.boundingSphere!.clone();
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      this.lods[lod].add(mesh);
      return mesh;
    };
    for (let l = 0; l < 3; l++) this.bodyMeshes.push(skinned(geo.body[l], l === 0 ? this.skin.material : this.skinLow.material, l));
    skinned(geo.lashes, lash.material, 0, false);
    skinned(geo.teeth, teeth.material, 0, false);
    skinned(geo.tongue, tongue.material, 0, false);

    for (let l = 0; l < 2; l++) {
      for (const { geo: pg, part } of geo.parts[l]) {
        let mat: THREE.Material;
        if (part.material === 'hair' || part.material === 'leaf') {
          const hm = createHairMaterial(part.material === 'leaf');
          applyHairColor(hm.uniforms, app.hairColor, part.material === 'leaf', app.race === 'sylvan' ? app.skinAccent : undefined);
          this.hairMats.push(hm);
          this.reg(hm);
          mat = hm.material;
        } else if (part.material === 'horn' || part.material === 'tusk') {
          if (part.material === 'tusk') {
            // Ivory, smooth.
            const tm = createHornMaterial();
            tm.uniforms.uTipC.value.setRGB(0.9, 0.86, 0.74, THREE.SRGBColorSpace);
            tm.uniforms.uBase.value.setRGB(0.7, 0.62, 0.48, THREE.SRGBColorSpace);
            tm.uniforms.uRidge.value = 0.2;
            this.reg(tm);
            mat = tm.material;
          } else {
            if (!this.hornMat) {
              this.hornMat = createHornMaterial();
              const hc = app.horns.color;
              this.hornMat.uniforms.uTipC.value.setRGB(hc[0], hc[1], hc[2], THREE.SRGBColorSpace);
              this.hornMat.uniforms.uBase.value.setRGB(hc[0] * 0.55, hc[1] * 0.5, hc[2] * 0.45, THREE.SRGBColorSpace);
              this.reg(this.hornMat);
            }
            mat = this.hornMat.material;
          }
        } else if (part.material === 'tail') {
          mat = l === 0 ? this.skin.material : this.skinLow.material;
        } else {
          const fm = simpleMaterial(new THREE.Color().setRGB(app.skinAccent[0], app.skinAccent[1], app.skinAccent[2], THREE.SRGBColorSpace), { roughness: 0.5, side: THREE.DoubleSide, sheen: 0.3 });
          this.reg(fm);
          mat = fm.material;
        }
        const mesh = skinned(pg, mat, l, part.material !== 'tusk');
        mesh.name = part.name;
        if (part.name === 'hair' || part.name === 'crest') this.hairMeshes.push(mesh);
        if (part.name === 'beard') this.beardMeshes.push(mesh);
        // The tail and horns also show at the far LOD.
        if (l === 1 && (part.name === 'tail' || part.name === 'horns')) {
          const far = skinned(pg, part.name === 'tail' ? this.skinLow.material : mat, 2);
          far.name = part.name;
        }
      }
    }
    // ---- fur shells: dense short hair / beard base layer (near LOD; 3 layers at mid LOD)
    const recede = app.gender > 0.5 ? Math.max(0, app.age - 0.6) * 1.6 : 0;
    const hairLin = new THREE.Color().setRGB(app.hairColor[0], app.hairColor[1], app.hairColor[2], THREE.SRGBColorSpace);
    for (const spec of [scalpShellFor(app.hairStyle, recede), beardShellFor(app.beardStyle)]) {
      if (!spec) continue;
      const key = JSON.stringify(spec);
      let idx = shellIndexCache.get(key);
      if (!idx) { idx = shellIndex(st, spec); shellIndexCache.set(key, idx); }
      if (!idx.length) continue;
      const g = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(geo.body[0].attributes)) g.setAttribute(name, attr);
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.boundingSphere = geo.body[0].boundingSphere;
      this.ownGeometries.push(g);
      for (const lod of [0, 1]) {
        const layers = lod === 0 ? spec.layers : Math.min(3, spec.layers);
        for (let k = 0; k < layers; k++) {
          const sh = createShellMaterial({ ...spec, layers }, k, hairLin);
          this.skyPatches.push(sh.sky);
          this.ownMaterials.push(sh.material);
          const m = skinned(g, sh.material, lod, false);
          m.renderOrder = 2 + k;
          (spec.kind === 'scalp' ? this.hairMeshes : this.beardMeshes).push(m);
        }
      }
    }
    for (const g of this.lods) this.model.add(g);
    this.setLod(0);

    // ---- eyes (children of the head bone, rotated for gaze)
    const headI = this.boneIndex.get('head')!;
    const headBone = this.bones[headI];
    const e = build.body.eyes;
    for (let k = 0; k < 2; k++) {
      const pivot = new THREE.Object3D();
      pivot.position.set(e[k * 4] - this.rest[headI].x, e[k * 4 + 1] - this.rest[headI].y, e[k * 4 + 2] - this.rest[headI].z);
      const ball = new THREE.Mesh(eyeGeometry(), this.eyeMat.material);
      ball.scale.setScalar(e[k * 4 + 3] * 0.98);
      ball.castShadow = false;
      ball.receiveShadow = true;
      pivot.add(ball);
      headBone.add(pivot);
      this.eyes.push(pivot);
    }

    // ---- sockets
    for (const [name, s] of Object.entries(build.body.sockets)) {
      const o = new THREE.Object3D();
      o.name = `socket:${name}`;
      const b = s.bone;
      o.position.set(s.pos[0] - this.rest[b].x, s.pos[1] - this.rest[b].y, s.pos[2] - this.rest[b].z);
      const B = s.basis;
      const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(B[0], B[1], B[2]), new THREE.Vector3(B[3], B[4], B[5]), new THREE.Vector3(B[6], B[7], B[8]));
      if (m.determinant() < 0) {
        // Reflection (see items' socket convention): rotation × scale(-1,1,1).
        m.makeBasis(new THREE.Vector3(-B[0], -B[1], -B[2]), new THREE.Vector3(B[3], B[4], B[5]), new THREE.Vector3(B[6], B[7], B[8]));
        o.scale.x = -1;
      }
      o.quaternion.setFromRotationMatrix(m);
      this.bones[b].add(o);
      this.sockets.set(name, o);
    }
  }

  private reg(p: PatchedMaterial<unknown>) {
    this.skyPatches.push(p.sky);
    this.ownMaterials.push(p.material);
  }

  bone(name: string): THREE.Bone {
    return this.bones[this.boneIndex.get(name)!];
  }

  /** Apply colour-only appearance changes (skin, eyes, hair) without rebuilding geometry. */
  recolor(app: HumanoidAppearance) {
    for (const s of [this.skin, this.skinLow]) applySkinLook(s.uniforms, app, { shavedScalp: this.shavedScalp, hairCovered: false });
    const eu = this.eyeMat.uniforms;
    eu.uIris.value.setRGB(app.eyeColor[0], app.eyeColor[1], app.eyeColor[2], THREE.SRGBColorSpace);
    eu.uPupil.value.x = { round: 0, slit: 1, goat: 2, none: 3 }[app.pupil] ?? 0;
    eu.uPupil.value.z = app.eyeGlow;
    for (const h of this.hairMats) applyHairColor(h.uniforms, app.hairColor, h.uniforms.uSpec.value.w > 0.5, app.race === 'sylvan' ? app.skinAccent : undefined);
  }

  setLod(l: number) {
    this.lod = l;
    this.lods.forEach((g, i) => (g.visible = i === l));
    for (const e of this.eyes) e.visible = l === 0;
  }

  setSkyVis(v: number) {
    for (const p of this.skyPatches) if (p.uniform) p.uniform.value = v;
  }

  /** Show/hide scalp hair & beard (helmets, hoods). */
  setHairHidden(hair: boolean, beard: boolean) {
    for (const m of this.hairMeshes) m.visible = !hair;
    for (const m of this.beardMeshes) m.visible = !beard;
    for (const s of [this.skin, this.skinLow]) s.uniforms.uLook.value.w = hair ? 0 : this.shavedScalp;
  }

  /** Register an extra sky patch (equipment materials) so setSkyVis reaches it. */
  addSkyPatch(p: SkyVisPatch) {
    this.skyPatches.push(p);
  }
  removeSkyPatch(p: SkyVisPatch) {
    const i = this.skyPatches.indexOf(p);
    if (i >= 0) this.skyPatches.splice(i, 1);
  }

  dispose() {
    for (const m of this.ownMaterials) m.dispose();
    for (const g of this.ownGeometries) g.dispose();
    this.skeleton.dispose();
    this.geo.refs--;
    this.object.removeFromParent();
  }
}
