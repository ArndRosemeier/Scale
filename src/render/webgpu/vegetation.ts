// @ts-nocheck -- three's TSL typings infer swizzles and vector widths poorly; checked by rendering (docs/WEBGPU_PLAN.md).
/**
 * Vegetation materials (props/vegetation.ts) and the countryside canopy clumps
 * (stream/Countryside.ts) as node materials: bark, alpha-tested leaf cards (autumn tints,
 * translucency, crown occlusion), far canopy hulls (noise-dissolved edges), all swaying in the
 * wind; clumps darkened towards the base of the crown.
 *
 * Kept line by line close to the GLSL so the two can be compared.
 *
 * Wind: vegWind works in the instance's own space and needs the instance matrix (origin, rotation
 * and scale). The node material applies instancing before `positionNode`, so `positionNode` here
 * recomputes the position from the geometry: wind in instance space, then the instance matrix
 * (read through its own nodes, see instanceCols). `positionNode` is also what the shadow pass
 * uses, so shadows sway like the WebGL depth materials.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, float, int, vec2, vec3, vec4, mix, normalize, max, abs, fract, floor, length, smoothstep, sub, add, mul, dot, sin, clamp, pow,
  log2, cross, inverseSqrt, select, If, Discard, attribute, texture, uniformArray, uv, buffer, instanceIndex, instancedBufferAttribute,
  instancedDynamicBufferAttribute, OnBeforeFrameUpdate, modelWorldMatrix, positionGeometry, normalGeometry, positionView,
  positionViewDirection, normalView, normalViewGeometry, diffuseColor, varying, dFdx, dFdy,
} from 'three/tsl';
import { shared } from './common';

/** The shared `{ value }` uniforms of props/vegetation (`vegetationUniforms`). */
export interface VegUniforms { uTime: { value: number }; uWind: { value: number }; uSeason: { value: number } }

// ---------------------------------------------------------------------------------------------
// Instance matrix
// ---------------------------------------------------------------------------------------------

interface Cols { c0: unknown; c1: unknown; c2: unknown; c3: unknown }
const _cols = new WeakMap<THREE.InstancedBufferAttribute, Cols>();
const _ibufs = new WeakMap<THREE.InstancedBufferAttribute, THREE.InstancedInterleavedBuffer>();

/**
 * The columns of the instance matrix of the object being built (null when not instanced), read
 * the same way as three's instancing (accessors/Instance.js): a uniform buffer when it fits, else
 * instanced vertex attributes (our own interleaved copy, kept in step with the matrix's version).
 * Call inside a Fn (it registers the per-frame sync).
 */
function instanceCols(builder): Cols | null {
  const object = builder.object;
  if (!object || object.isInstancedMesh !== true || !object.instanceMatrix || object.instanceMatrix.isInstancedBufferAttribute !== true) return null;
  const im = object.instanceMatrix as THREE.InstancedBufferAttribute;
  const count = Math.max(im.count, 1);
  const inUniforms = count * 16 * 4 <= builder.getUniformBufferLimit();
  let cols = _cols.get(im);
  if (!cols) {
    if (inUniforms) {
      const m = buffer(im.array, 'mat4', count).element(instanceIndex);
      cols = { c0: m.element(int(0)), c1: m.element(int(1)), c2: m.element(int(2)), c3: m.element(int(3)) };
    } else {
      const ib = new THREE.InstancedInterleavedBuffer(im.array, 16, 1);
      _ibufs.set(im, ib);
      const fn = im.usage === THREE.DynamicDrawUsage ? instancedDynamicBufferAttribute : instancedBufferAttribute;
      cols = { c0: fn(ib, 'vec4', 16, 0), c1: fn(ib, 'vec4', 16, 4), c2: fn(ib, 'vec4', 16, 8), c3: fn(ib, 'vec4', 16, 12) };
    }
    _cols.set(im, cols);
  }
  const ib = _ibufs.get(im);
  if (ib) {
    OnBeforeFrameUpdate(() => {
      if (ib.version !== im.version) {
        ib.clearUpdateRanges();
        ib.updateRanges.push(...im.updateRanges);
        ib.version = im.version;
      }
    });
  }
  return cols;
}

// ---------------------------------------------------------------------------------------------
// Wind (WIND_PARS)
// ---------------------------------------------------------------------------------------------

const DIR_W = new THREE.Vector3(1.0, 0.0, 0.42).normalize();

/** vegWind(p, n, w, flutter, seed) in the instance's space (I: instance matrix columns or null). */
function vegWind(U: VegUniforms, I: Cols | null, p, n, w, flutter: number, seed) {
  const uTime = shared(U.uTime), uWind = shared(U.uWind);
  const org = I ? I.c3.xyz : vec3(0.0);
  const wo = modelWorldMatrix.mul(vec4(org, 1.0)).xyz;
  const ph = dot(wo.xz, vec2(0.137, 0.213)).toVar();
  const dirW = vec3(DIR_W.x, DIR_W.y, DIR_W.z);
  let dir;
  if (I) {
    const sc = max(1e-3, length(I.c0.xyz));
    // transpose(rot) * dirW / sc
    dir = vec3(dot(I.c0.xyz, dirW), dot(I.c1.xyz, dirW), dot(I.c2.xyz, dirW)).div(sc);
  } else dir = dirW;
  const t = uTime;
  const gust = add(0.55, mul(0.45, sin(t.mul(0.37).add(ph.mul(0.5)))).mul(sin(t.mul(0.23).add(ph.mul(0.9)).add(1.3))));
  const s = uWind.mul(add(0.35, gust)).toVar();
  const w2 = w.mul(w).toVar();
  const sway = add(0.55, mul(0.45, sin(t.mul(1.05).add(ph))));
  const off = dir.mul(s.mul(w2).mul(0.42).mul(sway)).toVar();
  const bp = ph.mul(3.0).add(dot(p, vec3(0.45, 0.31, 0.38))).toVar();
  const osc = vec3(sin(t.mul(2.1).add(bp)), mul(0.35, sin(t.mul(2.7).add(bp.mul(1.3)))), sin(t.mul(1.8).add(bp.mul(0.8)).add(1.7)));
  off.addAssign(osc.mul(s.mul(w2).mul(w).mul(0.13)));
  if (flutter !== 0) off.addAssign(n.mul(sin(t.mul(9.0).add(seed.mul(40.0)).add(bp.mul(2.0))).mul(flutter).mul(s).mul(w).mul(0.05)));
  // off.y -= dot(off.xz, off.xz) * 0.12
  const o = vec3(off.x, off.y.sub(dot(off.xz, off.xz).mul(0.12)), off.z);
  return p.add(o);
}

/** positionNode: the swaying vertex (transformed = vegWind(...)) followed by the instance matrix. */
function windPosition(U: VegUniforms, flutter: number, seed: () => unknown) {
  return Fn((builder) => {
    const I = instanceCols(builder);
    const p = vegWind(U, I, positionGeometry, normalGeometry, attribute('aWind', 'float'), flutter, flutter !== 0 ? seed() : float(0.0)).toVar();
    if (!I) return p;
    return I.c0.xyz.mul(p.x).add(I.c1.xyz.mul(p.y)).add(I.c2.xyz.mul(p.z)).add(I.c3.xyz);
  })();
}

/** Like setDiffuse (webgpu/ground.ts) but with a free body run after the default diffuse colour. */
function afterDiffuse(mat: THREE.NodeMaterial, body: (builder) => void): void {
  const base = mat.setupDiffuseColor;
  mat.setupDiffuseColor = function (builder) {
    base.call(this, builder);
    body(builder);
  };
}

/** Physical lighting with the crown occlusion / translucency tweaks of the GLSL patches. */
class VegLightingModel extends THREE.PhysicalLightingModel {
  constructor(private occ, private trans, private leaf: boolean) { super(); }

  direct(data, builder) {
    super.direct(data, builder);
    if (!this.leaf) return;
    const { lightDirection, lightColor, reflectedLight } = data;
    // Light through the leaves: seen against the light, and wrapped around the crown.
    const bk = pow(clamp(dot(positionViewDirection, lightDirection.negate()), 0.0, 1.0), 6.0);
    const wr = clamp(sub(0.5, mul(0.5, dot(normalView, lightDirection))), 0.0, 1.0);
    reflectedLight.directDiffuse.addAssign(lightColor.mul(diffuseColor.rgb).mul(bk.mul(0.8).add(wr.mul(0.18))).mul(this.trans).mul(sub(1.0, this.occ.mul(0.6))));
  }

  indirect(builder) {
    super.indirect(builder);
    const { reflectedLight } = builder.context;
    if (this.leaf) {
      reflectedLight.indirectDiffuse.mulAssign(sub(1.0, this.occ.mul(0.45)));
      reflectedLight.indirectSpecular.mulAssign(sub(1.0, this.occ.mul(0.8)).mul(0.3));
      // (all direct lights are accumulated before the indirect term)
      reflectedLight.directSpecular.mulAssign(0.45);
    } else {
      reflectedLight.indirectDiffuse.mulAssign(sub(1.0, this.occ.mul(0.5)));
      reflectedLight.indirectSpecular.mulAssign(sub(1.0, this.occ.mul(0.7)));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Bark
// ---------------------------------------------------------------------------------------------

/** normalize(tbn * mapN) with three's getTangentFrame (screen derivatives, no tangents). */
const tangentFrameNormal = Fn(([eyePos, N, st, mapN]) => {
  const q0 = dFdx(eyePos), q1 = dFdy(eyePos);
  const st0 = dFdx(st), st1 = dFdy(st);
  const q1perp = cross(q1, N), q0perp = cross(N, q0);
  const T = q1perp.mul(st0.x).add(q0perp.mul(st1.x));
  const B = q1perp.mul(st0.y).add(q0perp.mul(st1.y));
  const det = max(dot(T, T), dot(B, B));
  const sc = select(det.equal(0.0), 0.0, inverseSqrt(det));
  return normalize(T.mul(sc.mul(mapN.x)).add(B.mul(sc.mul(mapN.y))).add(N.mul(mapN.z)));
}, { eyePos: 'vec3', N: 'vec3', st: 'vec2', mapN: 'vec3', return: 'vec3' });

export function createBarkNodeMaterial(map: THREE.Texture, normalMap: THREE.Texture, strips: number, U: VegUniforms): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
  mat.positionNode = windPosition(U, 0.0, null);
  const vMapUv = uv();
  const vOcc = attribute('aOcc', 'float');
  const S = float(strips);
  const normalScale = vec2(1.1, 1.1);

  // uv.x = strip * 16 + u: the strip's column of the bark atlas, with gradients of the unwrapped uv.
  const bStrip = floor(vMapUv.x.div(16.0));
  const bUv = vec2(vMapUv.x.sub(bStrip.mul(16.0)), vMapUv.y);
  const bAt = vec2(bStrip.add(0.012).add(fract(bUv.x).mul(0.976)).div(S), bUv.y);
  const bGx = dFdx(bUv).mul(vec2(float(0.976).div(S), 1.0));
  const bGy = dFdy(bUv).mul(vec2(float(0.976).div(S), 1.0));

  afterDiffuse(mat, () => {
    const c = texture(map, bAt).grad(bGx, bGy);
    diffuseColor.assign(vec4(diffuseColor.rgb.mul(c.rgb).mul(sub(1.0, vOcc.mul(0.6))), diffuseColor.a.mul(c.a)));
  });
  mat.normalNode = Fn(() => {
    const m = texture(normalMap, bAt).grad(bGx, bGy).xyz.mul(2.0).sub(1.0);
    const mapN = vec3(m.xy.mul(normalScale), m.z);
    return tangentFrameNormal(positionView, normalViewGeometry, vMapUv, mapN);
  })();
  mat.setupLightingModel = () => new VegLightingModel(vOcc, float(0.0), false);
  return mat;
}

// ---------------------------------------------------------------------------------------------
// Leaves
// ---------------------------------------------------------------------------------------------

/**
 * Leaf cards. `autumn`: 16 atlas cells' autumn colours (linear rgb, a = turns), `trans`: the
 * translucency. The atlas goes in through colorNode (not `map`) so the shadow pass uses the
 * mip-boosted alpha like the WebGL depth material; the edge-on fade is the opacity (main pass only).
 */
export function createLeafNodeMaterial(atlas: THREE.Texture, autumn: THREE.Vector4[], trans: number, U: VegUniforms): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.78, metalness: 0, alphaToCoverage: false,
  });
  mat.shadowSide = THREE.DoubleSide;
  const vTint = attribute('aLeafTint', 'float');
  const vOcc = attribute('aOcc', 'float');
  mat.positionNode = windPosition(U, 1.0, () => vTint);
  const uSeason = shared(U.uSeason);
  const uAutumn = uniformArray(autumn, 'vec4');
  const vMapUv = uv();

  mat.colorNode = Fn(() => {
    const c = texture(atlas, vMapUv).toVar();
    // LEAF_ALPHA_BOOST: keep thin leaves from vanishing in the smaller mips.
    const dxA = dFdx(vMapUv.mul(1024.0)), dyA = dFdy(vMapUv.mul(1024.0));
    const lodA = max(0.0, mul(0.5, log2(max(dot(dxA, dxA), dot(dyA, dyA)))));
    return vec4(c.rgb, clamp(c.a.mul(add(1.0, lodA.mul(0.32))), 0.0, 1.0));
  })();
  // fade cards seen edge-on (they would read as streaks)
  mat.opacityNode = Fn(() => {
    const fN = normalize(cross(dFdx(positionView), dFdy(positionView)));
    const edgeOn = abs(dot(fN, normalize(positionView)));
    return smoothstep(0.04, 0.32, edgeOn).mul(0.55).add(0.45);
  })();
  afterDiffuse(mat, () => {
    const cellI = floor(clamp(vMapUv, 0.0, 0.9999).mul(4.0));
    const ci = int(cellI.y).mul(4).add(int(cellI.x));
    const aut = uAutumn.element(ci).toVar();
    const c = diffuseColor.rgb.toVar();
    const tv = vTint.sub(0.5).toVar();
    c.mulAssign(add(1.0, tv.mul(0.4)));
    c.assign(mix(c, c.mul(vec3(1.12, 1.06, 0.7)), max(tv, 0.0).mul(0.5)));
    const lum = dot(c, vec3(0.3, 0.59, 0.11));
    const turn = clamp(uSeason.mul(1.6).sub(vTint.mul(0.6)), 0.0, 1.0).mul(aut.a);
    c.assign(mix(c, aut.rgb.mul(lum.mul(3.2).add(0.015)), turn));
    c.mulAssign(sub(1.0, vOcc.mul(0.62)));
    diffuseColor.assign(vec4(c, diffuseColor.a));
  });
  // Crown (spherical) normals on both faces: not flipped on the back side.
  mat.normalNode = normalViewGeometry;
  mat.setupLightingModel = () => new VegLightingModel(vOcc, float(trans), true);
  return mat;
}

// ---------------------------------------------------------------------------------------------
// Far hulls
// ---------------------------------------------------------------------------------------------

const vhash = Fn(([p0]) => {
  const p = fract(p0.mul(0.3183099).add(0.1)).mul(17.0).toVar();
  return fract(p.x.mul(p.y).mul(p.z).mul(p.x.add(p.y).add(p.z)));
}, { p: 'vec3', return: 'float' });

const vnoise3 = Fn(([x]) => {
  const i = floor(x).toVar();
  const f0 = fract(x);
  const f = f0.mul(f0).mul(sub(3.0, mul(2.0, f0))).toVar();
  return mix(
    mix(mix(vhash(i), vhash(i.add(vec3(1, 0, 0))), f.x), mix(vhash(i.add(vec3(0, 1, 0))), vhash(i.add(vec3(1, 1, 0))), f.x), f.y),
    mix(mix(vhash(i.add(vec3(0, 0, 1))), vhash(i.add(vec3(1, 0, 1))), f.x), mix(vhash(i.add(vec3(0, 1, 1))), vhash(i.add(vec3(1, 1, 1))), f.x), f.y),
    f.z,
  );
}, { x: 'vec3', return: 'float' });

export function createFarTreeNodeMaterial(U: VegUniforms): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  mat.positionNode = windPosition(U, 0.0, null);
  const uSeason = shared(U.uSeason);
  const vAutumn = attribute('aAutumn', 'vec3');
  const vKind = uv();

  afterDiffuse(mat, (builder) => {
    // vObjPos = position (+ instance origin * 0.37)
    const I = instanceCols(builder);
    const vObjPos = varying(I ? positionGeometry.add(I.c3.xyz.mul(0.37)) : positionGeometry, 'vObjPos');
    const nV = normalViewGeometry.toVar();
    const nz = vnoise3(vObjPos.mul(2.2)).mul(0.6).add(vnoise3(vObjPos.mul(5.1)).mul(0.4)).toVar();
    If(vKind.x.greaterThan(0.75), () => {
      const edge = sub(1.0, abs(dot(nV, normalize(positionView.negate()))));
      If(edge.mul(edge).mul(1.25).greaterThan(nz.add(0.12)), () => { Discard(); });
    });
    If(vKind.x.greaterThan(0.25), () => {
      const c = diffuseColor.rgb.mul(add(0.78, nz.mul(0.45))).toVar();
      c.assign(mix(c, vAutumn.mul(add(0.78, nz.mul(0.45))), clamp(uSeason.mul(1.4).sub(nz.mul(0.4)), 0.0, 1.0).mul(vKind.y)));
      diffuseColor.assign(vec4(c, diffuseColor.a));
    });
  });
  return mat;
}

// ---------------------------------------------------------------------------------------------
// Countryside canopy clumps
// ---------------------------------------------------------------------------------------------

/** Clump material: instance colour, darker towards the base of the crown. */
export function createClumpNodeMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  const vClumpY = positionGeometry.y;
  afterDiffuse(mat, () => {
    diffuseColor.assign(vec4(diffuseColor.rgb.mul(mix(0.5, 1.1, smoothstep(0.2, 1.0, vClumpY))), diffuseColor.a));
  });
  return mat;
}
