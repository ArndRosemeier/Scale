// @ts-nocheck -- three's TSL typings infer swizzles and vector widths poorly; checked by rendering (docs/WEBGPU_PLAN.md).
/**
 * Creature-like materials as node materials: the Brood's instanced bugs
 * (game/threats/brood/broodMesh.ts), the birds (fauna/birdMesh.ts), the skinned creature hide
 * (game/threats/rig/CreatureMesh.ts), the debris fragments (destruction/Debris.ts) and the hero
 * statue's bronze (game/fame/HeroStatue.ts).
 */
import * as THREE from 'three/webgpu';
import {
  Fn, float, int, ivec2, vec2, vec3, vec4, mix, normalize, max, min, abs, sign, floor, sin, cos, length, distance, dot, clamp, smoothstep,
  sub, add, mul, select, If, attribute, varying, texture, positionGeometry, positionLocal, normalGeometry, normalView, cameraPosition,
  modelWorldMatrix, referenceBuffer, OnObjectUpdate, materialRoughness, materialEmissive, diffuseColor,
} from 'three/tsl';
import type { MaterialArrays } from '../TextureLibrary';
import { h21, shared } from './common';
import { instanceMatrixNode, col, mulDiffuse } from './fx';

/**
 * Vertex `transformed` (GLSL begin_vertex replacement): the object-space position before
 * instancing and the model matrix. (positionNode would come after the instance matrix.)
 */
function beginVertex(mat: THREE.NodeMaterial, node: () => unknown): void {
  const base = mat.setupPosition;
  mat.setupPosition = function (builder) {
    positionLocal.assign(node());
    return base.call(this, builder);
  };
}

// ---------------------------------------------------------------- the Brood

export function createBroodNodeMaterial(): THREE.MeshLambertNodeMaterial {
  const mat = new THREE.MeshLambertNodeMaterial({ color: 0xffffff, side: THREE.DoubleSide, flatShading: true });
  mat.name = 'brood';
  const aPart = attribute('aPart', 'float'), aLeg = attribute('aLeg', 'vec4'), aSeg = attribute('aSeg', 'float');
  const iAnim = attribute('iAnim', 'vec4'), iCol = attribute('iCol', 'vec4');
  const position = positionGeometry;
  beginVertex(mat, Fn(() => {
    const transformed = vec3(position).toVar();
    If(aPart.greaterThan(0.5).and(aPart.lessThan(1.5)), () => {
      // Legs: swing about the hip (vertical axis), the foot lifting on the forward stroke; curled in when dead.
      const hip = aLeg.xyz;
      const rel0 = position.sub(hip).toVar();
      const ph = iAnim.x.add(aLeg.w).toVar();
      const sw = iAnim.y.mul(sin(ph)).mul(0.5).toVar();
      const c = cos(sw), s = sin(sw);
      const rel = vec3(c.mul(rel0.x).sub(s.mul(rel0.z)), rel0.y.add(max(0.0, cos(ph)).mul(iAnim.y).mul(0.14).mul(aSeg)), s.mul(rel0.x).add(c.mul(rel0.z))).toVar();
      // Curled (dead, on its back): folded in and bent towards the belly, so they stick up once it is rolled over.
      const curled = vec3(rel.x.mul(sub(0.55, aSeg.mul(0.25))), sub(-0.04, aSeg.mul(0.2)), rel.z.mul(0.5).add(aSeg.mul(0.05)));
      transformed.assign(hip.add(mix(rel, curled, iAnim.z)));
    });
    return transformed;
  }));
  const vBroodCol = varying(select(aPart.greaterThan(1.5), vec3(0.2, 0.06, 0.02), mix(iCol.rgb, vec3(0.62, 0.78, 0.9), iCol.w.mul(0.8))), 'vBroodCol');
  const vBroodGlow = varying(select(aPart.greaterThan(1.5), iAnim.w, 0.0), 'vBroodGlow');
  mulDiffuse(mat, () => vBroodCol);
  mat.emissiveNode = vec3(2.6, 0.75, 0.12).mul(vBroodGlow);
  return mat;
}

// ---------------------------------------------------------------- birds

export function createBirdNodeMaterial(u: { uBirdPx: { value: number } }): THREE.MeshLambertNodeMaterial {
  const mat = new THREE.MeshLambertNodeMaterial({ color: 0xffffff, side: THREE.DoubleSide, flatShading: true });
  mat.name = 'birds';
  const uBirdPx = shared(u.uBirdPx);
  const aPart = attribute('aPart', 'float'), iAnim = attribute('iAnim', 'vec4');
  const iColA = attribute('iColA', 'vec4'), iColB = attribute('iColB', 'vec4'), iSpan = attribute('iSpan', 'vec2');
  const position = positionGeometry;
  const IM = instanceMatrixNode();
  beginVertex(mat, Fn(() => {
    const transformed = vec3(position).toVar();
    const span = abs(position.x).toVar();
    If(aPart.greaterThan(0.5).and(aPart.lessThan(1.5)), () => {
      // Wing flap: rotate about the body axis at the shoulder; the outer segment lags.
      const side = sign(position.x);
      const th = iAnim.y.mul(sin(iAnim.x)).add(iAnim.w).toVar();
      const th2 = th.add(iAnim.y.mul(0.55).mul(sin(iAnim.x.sub(0.8)))).sub(iAnim.w.mul(0.6)).toVar();
      const si = min(span, 0.45).sub(0.06), so = max(span.sub(0.45), 0.0);
      const xy = vec2(0.06, 0.0).add(vec2(cos(th), sin(th)).mul(si).add(vec2(cos(th2), sin(th2)).mul(so)).mul(iSpan.x)).toVar();
      const open = vec3(side.mul(xy.x), position.y.add(xy.y), position.z);
      // Folded: a plate along the back and flank, tips over the tail.
      const folded = vec3(side.mul(sub(0.13, mul(0.07, span))), sub(0.11, mul(0.05, span)), position.z.mul(0.7).add(0.02).sub(span.mul(0.36)));
      transformed.assign(mix(open, folded, iAnim.z));
    });
    // Distance LOD: keep at least ~uBirdPx pixels of body length on screen.
    const bC = modelWorldMatrix.mul(vec4(col(IM, 3).xyz, 1.0)).xyz;
    const bL = max(length(col(IM, 2).xyz), 1e-3);
    return transformed.mul(max(1.0, distance(cameraPosition, bC).mul(uBirdPx).div(bL)));
  }));
  // Colour by part; dark wing tips.
  const span = abs(position.x);
  const beak = mix(vec3(0.05, 0.045, 0.04), vec3(0.85, 0.6, 0.08), iSpan.y);
  const vBirdCol = varying(select(aPart.lessThan(0.5), iColA.rgb, select(aPart.lessThan(1.5), mix(iColB.rgb, vec3(0.03), smoothstep(0.6, 0.95, span).mul(iColB.w)),
    select(aPart.lessThan(2.5), beak, iColB.rgb))), 'vBirdCol');
  mulDiffuse(mat, () => vBirdCol);
  return mat;
}

// ---------------------------------------------------------------- skinned creatures

/** Bone 0's first column of the skinned mesh being drawn (read as three's skinning reads its bones). */
const bone0 = Fn((builder) => {
  const sk = builder.object?.skeleton;
  if (!sk) return vec4(0.0);
  if (sk.bones.length * 64 <= builder.getUniformBufferLimit()) return referenceBuffer('skeleton.boneMatrices', 'vec4', sk.bones.length * 4).element(0);
  if (sk.boneTexture === null) sk.computeBoneTexture();
  const bt = texture(sk.boneTexture);
  OnObjectUpdate(({ object }) => {
    const s = object.skeleton;
    if (s.boneTexture === null) s.computeBoneTexture();
    bt.value = s.boneTexture;
  });
  return bt.load(ivec2(0, 0));
});

export function createCreatureNodeMaterial(params: Record<string, unknown>): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial(params);
  const glow = attribute('glow', 'vec4');
  const gp = bone0();
  // Bone 0 holds this creature's glow levels: ridge, throat, eyes, wet.
  const ridge = gp.x, throat = gp.y, eyes = gp.z;
  // The ridge lights up as a wave from the tail to the head.
  const gl = clamp(ridge.mul(1.6).sub(sub(1.0, glow.y).mul(0.6)), 0.0, 1.0);
  const vGlow = varying(vec3(0.6, 1.4, 3.2).mul(4.0).mul(gl).mul(gl).mul(glow.x).add(vec3(0.9, 1.8, 3.6).mul(throat).mul(glow.z)).add(vec3(3.2, 1.6, 0.3).mul(eyes).mul(glow.w)), 'vGlow');
  const vWet = varying(gp.w, 'vWet');
  m.roughnessNode = mix(materialRoughness, materialRoughness.mul(0.45), vWet);
  m.emissiveNode = materialEmissive.add(vGlow);
  return m;
}

// ---------------------------------------------------------------- debris

export function createDebrisNodeMaterial(arrays: MaterialArrays): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  const vLayer = attribute('iLayer', 'float');
  const IM = instanceMatrixNode();
  const vObj = varying(positionGeometry.mul(vec3(length(col(IM, 0).xyz), length(col(IM, 1).xyz), length(col(IM, 2).xyz))), 'vObj');
  const vObjN = normalGeometry;
  mulDiffuse(mat, () => Fn(() => {
    const layer = int(vLayer.add(0.5)).toVar();
    const w0 = abs(normalize(vObjN)).toVar();
    const w = w0.div(w0.x.add(w0.y).add(w0.z)).toVar();
    const T = (p) => texture(arrays.albedo, p).depth(layer);
    const a = T(vObj.yz.mul(0.5)).mul(w.x).add(T(vObj.xz.mul(0.5)).mul(w.y)).add(T(vObj.xy.mul(0.5)).mul(w.z)).toVar();
    // Broken faces: mix in fresh concrete/brick core colour on faces pointing "inward" of the original wall.
    const core = smoothstep(0.3, 0.7, h21(floor(vObj.xy.mul(3.0))));
    return mix(a.rgb, a.rgb.mul(0.8).add(vec3(0.06)), core.mul(0.3));
  })());
  return mat;
}

// ---------------------------------------------------------------- statue bronze

/**
 * Bronze on one of the statue rig's materials: its own shading kept underneath (darker in the
 * creases its colour marks), a green patina facing up, polished metal. Node materials of the
 * standard kind get the shader change; anything else gets the plain bronze colour.
 */
export function bronzeNodeMaterial(m: THREE.Material, bronze: THREE.Color): void {
  const n = m as THREE.MeshStandardNodeMaterial;
  if (n.isNodeMaterial && 'metalnessNode' in n) {
    const base = n.setupVariants;
    const B = vec3(bronze.r, bronze.g, bronze.b);
    n.setupVariants = function (builder) {
      // (Bronze: darker in the creases the material's own colour marks, a green patina facing up.)
      const lum = clamp(dot(diffuseColor.rgb, vec3(0.3, 0.55, 0.15)).mul(1.6), 0.55, 1.15);
      const bronzeC = B.mul(lum);
      const up = clamp(normalView.y, 0.0, 1.0);
      diffuseColor.assign(vec4(mix(bronzeC, vec3(0.16, 0.3, 0.24), up.mul(up).mul(0.35)), diffuseColor.a));
      return base.call(this, builder);
    };
    n.metalnessNode = float(0.82);
    n.roughnessNode = float(0.38);
    n.emissiveNode = vec3(0.0);
    n.needsUpdate = true;
    return;
  }
  const s = m as THREE.MeshStandardMaterial;
  if (s.color) s.color.copy(bronze);
  if ('metalness' in s) { s.metalness = 0.82; s.roughness = 0.38; s.emissive?.setRGB(0, 0, 0); s.needsUpdate = true; }
}
