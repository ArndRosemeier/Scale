// @ts-nocheck -- three's TSL typings infer swizzles and vector widths poorly; checked by rendering (docs/WEBGPU_PLAN.md).
/**
 * TSL counterparts of `render/materials/glsl.ts` and the shared uniforms (`materials/globals`).
 */
import * as THREE from 'three/webgpu';
import {
  Fn, float, int, ivec2, vec2, vec3, fract, sin, dot, floor, mix, mul, sub, dFdx, dFdy, cross, max, inverseSqrt, select, sqrt,
  normalize, uniform, attribute, textureLoad, textureSize, varying, Loop, texture,
} from 'three/tsl';
import { G } from '../materials/globals';

export const h11 = Fn(([n]) => fract(sin(n.mul(12.9898).add(4.1414)).mul(43758.5453)), { n: 'float', return: 'float' });
export const h21 = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)), { p: 'vec2', return: 'float' });
export const h31 = Fn(([p]) => fract(sin(dot(p, vec3(127.1, 311.7, 74.7))).mul(43758.5453)), { p: 'vec3', return: 'float' });

export const vnoise = Fn(([p]) => {
  const i = floor(p), f = fract(p);
  const u = f.mul(f).mul(sub(3.0, mul(2.0, f)));
  return mix(mix(h21(i), h21(i.add(vec2(1, 0))), u.x), mix(h21(i.add(vec2(0, 1))), h21(i.add(vec2(1, 1))), u.x), u.y);
}, { p: 'vec2', return: 'float' });

export const fbm2 = Fn(([p0]) => {
  const p = vec2(p0).toVar();
  const s = float(0.0).toVar(), a = float(0.5).toVar();
  Loop(4, () => {
    s.addAssign(a.mul(vnoise(p)));
    p.mulAssign(2.03);
    a.mulAssign(0.5);
  });
  return s;
}, { p: 'vec2', return: 'float' });

/** Tangent-space normal (xy, strength) to view space from screen derivatives (no tangents needed). */
export const perturbNormalUV = Fn(([eyePos, N, uv, tn, strength]) => {
  const q0 = dFdx(eyePos), q1 = dFdy(eyePos);
  const st0 = dFdx(uv), st1 = dFdy(uv);
  const q1perp = cross(q1, N), q0perp = cross(N, q0);
  const T = q1perp.mul(st0.x).add(q0perp.mul(st1.x));
  const B = q1perp.mul(st0.y).add(q0perp.mul(st1.y));
  const det = max(dot(T, T), dot(B, B));
  const sc = select(det.equal(0.0), 0.0, inverseSqrt(det));
  const t = tn.mul(strength);
  const mapN = vec3(t, sqrt(max(0.0, sub(1.0, dot(t, t)))));
  return normalize(T.mul(mapN.x.mul(sc)).add(B.mul(mapN.y.mul(sc))).add(N.mul(mapN.z)));
}, { eyePos: 'vec3', N: 'vec3', uv: 'vec2', tn: 'vec2', strength: 'float', return: 'vec3' });

/**
 * A uniform node that follows one of the game's shared `{ value }` objects (the GLSL materials
 * read the same objects). One node per object, so every material shares it.
 */
const follow = new Map<object, ReturnType<typeof uniform>>();
export function shared(u: { value: unknown }): ReturnType<typeof uniform> {
  let n = follow.get(u);
  if (!n) {
    const v = u.value;
    if (typeof v === 'number') n = uniform(v).onRenderUpdate(() => u.value as number);
    else n = uniform(v as THREE.Vector3); // (objects are held by reference)
    follow.set(u, n);
  }
  return n;
}

/** The global city uniforms as nodes. */
export const GN = {
  get uTime() { return shared(G.uTime); },
  get uNight() { return shared(G.uNight); },
  get uDayLight() { return shared(G.uDayLight); },
  get uLitFrac() { return shared(G.uLitFrac); },
  get uShopLit() { return shared(G.uShopLit); },
  get uEatLit() { return shared(G.uEatLit); },
  get uSunDir() { return shared(G.uSunDir); },
  get uLampOn() { return shared(G.uLampOn); },
  get uWet() { return shared(G.uWet); },
};

/**
 * Destroyed elements (GLSL_ELEM_VERTEX_*): the element's state from the state texture.
 * Returns `{ alive, open }` nodes for the vertex stage (`alive` < 0.5: collapse the vertex) and
 * `open` as a varying for the fragment stage.
 */
export function elemState(elemTex: THREE.Texture, elemW: number) {
  const tex = texture(elemTex);
  const W = int(elemW);
  const e = int(attribute('aElem', 'float').add(0.5));
  const c = ivec2(e.mod(W), e.div(W));
  const size = textureSize(tex, 0);
  const es = select(c.y.greaterThanEqual(size.y), vec2(1.0), textureLoad(elemTex, c).rg);
  return { alive: es.x, open: varying(sub(1.0, es.y), 'vOpen') };
}
