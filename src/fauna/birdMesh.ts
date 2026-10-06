/**
 * The bird model and material: one tiny low-poly mesh (a body of two rings, a tail fan and
 * two-segment wings, 26 triangles) drawn instanced for every bird in one draw call.
 *
 * Per instance:
 *  - instanceMatrix: position, heading / pitch / bank, size (uniform scale = body length),
 *  - iAnim (phase, amplitude, fold, bias): the wing flap is done in the vertex shader -
 *    wings rotate about the body axis at the shoulder and the outer segment lags behind
 *    the inner one; fold 1 tucks the wings against the body (sitting birds),
 *  - iColA (body rgb), iColB (wing rgb, wing-tip darkness), iSpan (wingspan factor,
 *    beak 0 dark … 1 yellow).
 *
 * Distance LOD in the shader: a bird never gets smaller than ~2 px on screen, so a far
 * flock still reads as flapping V shapes instead of vanishing (uBirdPx).
 */
import * as THREE from 'three';
import { WEBGPU, gpuKit } from '../render/gpuMode';

/** Vertex part ids (aPart). */
const BODY = 0, WING = 1, BEAK = 2, TAIL = 3;

export function createBirdGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const part: number[] = [];
  const tri = (a: number[], b: number[], c: number[], pa: number, pb = pa, pc = pa) => {
    pos.push(...a, ...b, ...c);
    part.push(pa, pb, pc);
  };
  const quad = (a: number[], b: number[], c: number[], d: number[], p: number) => { tri(a, b, c, p); tri(a, c, d, p); };
  // Body (nose at +Z): beak tip, head ring (raised), neck ring, chest ring, belly ring, tail point.
  const N = [0, 0.16, 0.5];
  const R = [
    [[0, 0.25, 0.36], [0.06, 0.17, 0.36], [0, 0.1, 0.36], [-0.06, 0.17, 0.36]],
    [[0, 0.2, 0.22], [0.085, 0.09, 0.22], [0, -0.03, 0.22], [-0.085, 0.09, 0.22]],
    [[0, 0.16, 0.04], [0.14, 0.03, 0.04], [0, -0.15, 0.04], [-0.14, 0.03, 0.04]],
    [[0, 0.1, -0.14], [0.1, 0.02, -0.14], [0, -0.08, -0.14], [-0.1, 0.02, -0.14]],
  ];
  const T = [0, 0.04, -0.3];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    tri(N, R[0][j], R[0][i], BEAK, BODY, BODY);
    for (let r = 0; r < 3; r++) {
      tri(R[r][i], R[r][j], R[r + 1][j], BODY);
      tri(R[r][i], R[r + 1][j], R[r + 1][i], BODY);
    }
    tri(R[3][i], R[3][j], T, BODY);
  }
  // Tail fan.
  quad([-0.04, 0.05, -0.24], [0.04, 0.05, -0.24], [0.11, 0.03, -0.52], [-0.11, 0.03, -0.52], TAIL);
  // Wings: inner (shoulder → elbow) and outer (elbow → swept-back tip) segments.
  for (const s of [1, -1]) {
    const y = 0.08;
    const r0 = [0.06 * s, y, 0.14], r1 = [0.06 * s, y, -0.1];
    const e0 = [0.45 * s, y, 0.12], e1 = [0.45 * s, y, -0.15];
    const t0 = [1.0 * s, y, -0.06], t1 = [0.92 * s, y, -0.22];
    quad(r0, e0, e1, r1, WING);
    quad(e0, t0, t1, e1, WING);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  // Flat shading takes normals from screen derivatives (they follow the flapping wings);
  // the attribute is only there for the standard vertex code.
  g.computeVertexNormals();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

export interface BirdUniforms {
  /** Minimum on-screen size: world metres per pixel per metre of distance × pixels. */
  uBirdPx: { value: number };
}

export function createBirdMaterial(u: BirdUniforms): THREE.MeshLambertMaterial {
  if (WEBGPU) return gpuKit().createBirdNodeMaterial(u) as unknown as THREE.MeshLambertMaterial;
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide, flatShading: true });
  mat.name = 'birds';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uBirdPx = u.uBirdPx;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aPart;
attribute vec4 iAnim;
attribute vec4 iColA;
attribute vec4 iColB;
attribute vec2 iSpan;
uniform float uBirdPx;
varying vec3 vBirdCol;`)
      .replace('#include <begin_vertex>', `
vec3 transformed = vec3(position);
{
  float span = abs(position.x);
  if (aPart > 0.5 && aPart < 1.5) {
    // Wing flap: rotate about the body axis at the shoulder; the outer segment lags.
    float side = sign(position.x);
    float th = iAnim.y * sin(iAnim.x) + iAnim.w;
    float th2 = th + iAnim.y * 0.55 * sin(iAnim.x - 0.8) - iAnim.w * 0.6;
    float si = min(span, 0.45) - 0.06, so = max(span - 0.45, 0.0);
    vec2 xy = vec2(0.06, 0.0) + (vec2(cos(th), sin(th)) * si + vec2(cos(th2), sin(th2)) * so) * iSpan.x;
    vec3 open = vec3(side * xy.x, position.y + xy.y, position.z);
    // Folded: a plate along the back and flank, tips over the tail.
    vec3 folded = vec3(side * (0.13 - 0.07 * span), 0.11 - 0.05 * span, position.z * 0.7 + 0.02 - span * 0.36);
    transformed = mix(open, folded, iAnim.z);
  }
  // Colour by part; dark wing tips.
  vec3 beak = mix(vec3(0.05, 0.045, 0.04), vec3(0.85, 0.6, 0.08), iSpan.y);
  vBirdCol = aPart < 0.5 ? iColA.rgb : aPart < 1.5 ? mix(iColB.rgb, vec3(0.03), smoothstep(0.6, 0.95, span) * iColB.w) : aPart < 2.5 ? beak : iColB.rgb;
  // Distance LOD: keep at least ~uBirdPx pixels of body length on screen.
  vec3 bC = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
  float bL = max(length(instanceMatrix[2].xyz), 1e-3);
  transformed *= max(1.0, distance(cameraPosition, bC) * uBirdPx / bL);
}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBirdCol;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vBirdCol;');
  };
  mat.customProgramCacheKey = () => 'fauna-birds-v2';
  return mat;
}
