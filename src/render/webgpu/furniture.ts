// @ts-nocheck -- three's TSL typings infer swizzles and vector widths poorly; checked by rendering (docs/WEBGPU_PLAN.md).
/**
 * The street furniture material (props/furniture.ts, createFurnitureMaterial) as a node material:
 * the per vertex material id (aMat) and sub-material (aSub) resolved in the shader — steel, paint,
 * timber, concrete, stone, screen-door glass, plastic / foliage, lenses (lamps, traffic and
 * pedestrian signals, near-future LEDs), water (with falling streaks and ripples), bronze, rubber,
 * signage from the sign atlas. Per instance iColor (sRGB) / iState when the geometry has them.
 *
 * Kept line by line close to the GLSL so the two can be compared.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, float, int, vec2, vec3, vec4, mix, normalize, max, abs, fract, floor, smoothstep, sub, add, mul, dot, step, sin, cos, pow, clamp, select,
  mod, atan, If, Discard, struct, attribute, varying, texture, positionGeometry, normalGeometry, normalView, cameraViewMatrix,
  screenCoordinate,
} from 'three/tsl';
import { shared } from './common';
import { setDiffuse } from './ground';
import { noise3 as fn, instanceMatrixOf } from './propsCommon';

const FurnSurf = struct({ base: 'vec3', rough: 'float', metal: 'float', emis: 'vec3' }, 'FurnitureSurf');

export function createFurnitureNodeMaterial(
  sign: THREE.Texture,
  U: { uTime: { value: number }; uNight: { value: number }; uLampOn: { value: number } },
): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  const uTime = shared(U.uTime), uNight = shared(U.uNight), uLampOn = shared(U.uLampOn);

  // Vertex.
  const aMat = attribute('aMat', 'float'), aSub = attribute('aSub', 'float');
  const vMat = aMat, vEmit = attribute('aEmit', 'float'), vSub = aSub;
  const vUvF = attribute('uv', 'vec2');
  const vONrm = varying(normalGeometry, 'vONrm');
  // A missing iState reads (0, 0, 0, 1) in WebGL: no instance state, lights on, signals by uTime.
  const vState = varying(Fn((_, builder) => {
    if (!builder.hasGeometryAttribute('iState')) return vec4(1.0, -1.0, 0.0, 0.0);
    const iState = attribute('iState', 'vec4');
    const hasInst = iState.x.equal(0.0).and(iState.y.equal(0.0)).and(iState.z.equal(0.0)).and(iState.w.equal(1.0)).not();
    return select(hasInst, iState, vec4(1.0, -1.0, 0.0, 0.0));
  })(), 'vState');
  const vPaint = varying(Fn((_, builder) => {
    const aColor = attribute('aColor', 'vec3');
    if (!builder.hasGeometryAttribute('iColor')) return aColor;
    const iColor = attribute('iColor', 'vec3');
    const tint = dot(iColor, iColor).greaterThan(0.0).and(aSub.lessThan(8.5))
      .and(aMat.greaterThan(0.5).and(aMat.lessThan(1.5)).or(aMat.greaterThan(5.5).and(aMat.lessThan(6.5))));
    return select(tint, pow(iColor, vec3(2.2)), aColor);
  })(), 'vPaint');
  // vOPos = position (+ instanceMatrix[3].xyz * 0.73 when instanced).
  const vOPos = varying(Fn((_, builder) => {
    const im = instanceMatrixOf(builder);
    return im ? positionGeometry.add(im.element(int(3)).xyz.mul(0.73)) : positionGeometry;
  })(), 'vOPos');

  const surface = Fn(() => {
    const mid = int(vMat.add(0.5)).toVar();
    const sub_ = int(vSub.add(0.5)).toVar();
    const base = vec3(0.5).toVar();
    const rough = float(0.6).toVar(), metal = float(0.0).toVar();
    const fEmis = vec3(0.0).toVar();
    const n1 = fn(vOPos.mul(7.0)).toVar(), n2 = fn(vOPos.mul(23.0)).toVar(), n0 = fn(vOPos.mul(1.7)).toVar();
    const lightOn = vState.x.mul(uLampOn).toVar();
    // ivec2(gl_FragCoord.xy) % 2
    const fc = mod(floor(screenCoordinate.xy), 2.0).toVar();
    If(mid.equal(0), () => { // galvanised / stainless steel
      base.assign(vec3(0.56, 0.57, 0.58).mul(add(0.9, mul(0.15, n1)).add(mul(0.06, n2))));
      rough.assign(add(0.32, mul(0.18, n1))); metal.assign(0.85);
    }).ElseIf(mid.equal(1), () => { // painted metal
      base.assign(vPaint.mul(add(0.94, mul(0.08, n2))));
      rough.assign(add(0.38, mul(0.15, n1)).add(mul(0.12, n0).mul(n2))); metal.assign(0.25);
      const scuff = smoothstep(0.78, 0.92, n1.mul(0.6).add(n2.mul(0.4))).mul(0.35).toVar();
      base.assign(mix(base, vec3(0.32, 0.31, 0.3), scuff)); rough.addAssign(scuff.mul(0.3));
    }).ElseIf(mid.equal(2), () => { // timber
      const along = select(abs(vONrm.x).lessThan(0.7), vOPos.x, vOPos.z);
      const grain = fn(vec3(along.mul(2.0), vOPos.y.mul(40.0), vOPos.z.mul(40.0).add(vOPos.x.mul(3.0)))).toVar();
      const rings = add(0.5, mul(0.5, sin(vOPos.y.add(vOPos.z).mul(140.0).add(grain.mul(6.0)))));
      base.assign(vPaint.mul(add(0.68, mul(0.28, grain)).add(mul(0.12, rings))).mul(add(0.85, mul(0.2, n0))));
      rough.assign(add(0.62, mul(0.15, grain)));
    }).ElseIf(mid.equal(3), () => { // concrete
      base.assign(vPaint.mul(add(0.82, mul(0.22, n1)).add(mul(0.1, n2))).mul(sub(1.0, mul(0.25, step(0.86, fn(vOPos.mul(60.0)))))));
      rough.assign(0.9);
    }).ElseIf(mid.equal(4), () => { // stone (granite / limestone)
      const speck = step(0.82, fn(vOPos.mul(90.0)));
      base.assign(vec3(0.25, 0.235, 0.215).mul(add(0.82, mul(0.25, n0)).add(mul(0.12, n1)).add(mul(0.06, n2))).mul(sub(1.0, speck.mul(0.3))));
      rough.assign(add(0.72, mul(0.1, n2)));
    }).ElseIf(mid.equal(5), () => { // glass (screen-door transparency)
      If(fc.x.equal(fc.y), () => { Discard(); });
      base.assign(vec3(0.04, 0.05, 0.055));
      rough.assign(0.04); metal.assign(0.6);
    }).ElseIf(mid.equal(6), () => { // plastic / foliage
      base.assign(vPaint);
      rough.assign(add(0.45, mul(0.1, n1)));
      If(sub_.equal(8), () => {
        const leaf = fn(vOPos.mul(38.0)).mul(0.6).add(fn(vOPos.mul(90.0)).mul(0.4));
        base.assign(vPaint.mul(add(0.55, mul(0.75, leaf))).mul(add(0.8, mul(0.3, n1))));
        rough.assign(0.85);
      });
    }).ElseIf(mid.equal(7), () => { // light lens
      If(sub_.greaterThanEqual(1).and(sub_.lessThanEqual(3)), () => {
        const phase = select(vState.y.lessThan(-0.5), mod(floor(uTime.div(4.0)), 3.0), vState.y);
        const want = select(sub_.equal(1), float(0.0), select(sub_.equal(2), float(1.0), float(2.0)));
        const lit = select(abs(phase.sub(want)).lessThan(0.5), float(1.0), float(0.0));
        base.assign(vPaint.mul(0.12));
        rough.assign(0.15);
        fEmis.assign(vPaint.mul(vPaint).mul(lit).mul(add(2.2, mul(3.0, uNight))));
      }).ElseIf(sub_.equal(4).or(sub_.equal(5)), () => {
        const phase = select(vState.y.lessThan(-0.5), mod(floor(uTime.div(4.0)), 3.0), vState.y);
        const walk = select(phase.lessThan(0.5), float(1.0), float(0.0));
        const lit = select(sub_.equal(5), walk, sub(1.0, walk));
        const mask = texture(sign, vUvF).r.toVar();
        base.assign(vec3(0.02).add(vPaint.mul(mask).mul(0.05)));
        rough.assign(0.2);
        fEmis.assign(vPaint.mul(mask).mul(lit).mul(add(3.0, mul(4.0, uNight))));
      }).ElseIf(sub_.greaterThanEqual(10).and(sub_.lessThanEqual(12)), () => { // near-future LEDs (always powered; iState.z phase, .w mode: 0 ok, 1 alert, 2 off, 3 hostile, 4 glitching)
        base.assign(vPaint.mul(0.25));
        rough.assign(0.2);
        const off = select(abs(vState.w.sub(2.0)).lessThan(0.5), float(0.0), float(1.0)).toVar();
        const hostile = vState.w.greaterThan(2.5).and(vState.w.lessThan(3.5)).toVar();
        // Glitching: irregular drop-outs, flicking between its colour and red.
        const gl = select(vState.w.greaterThan(3.5), fract(sin(floor(uTime.mul(11.0)).mul(91.7).add(vState.z.mul(311.0))).mul(43758.5)), float(0.0)).toVar();
        If(sub_.equal(10), () => { // status light: steady teal pulse, amber blink when waiting, angry red when hostile
          const alert = vState.w.greaterThan(0.5).and(vState.w.lessThan(1.5)).toVar();
          const c = select(alert, vec3(1.0, 0.5, 0.06), vec3(0.12, 0.8, 1.0)).toVar();
          const k = select(alert, step(0.45, fract(uTime.mul(1.6).add(vState.z))), add(0.75, mul(0.25, sin(uTime.mul(2.5).add(vState.z.mul(6.283)))))).toVar();
          If(hostile, () => { c.assign(vec3(1.0, 0.03, 0.02)); k.assign(add(0.8, mul(0.4, step(0.5, fract(uTime.mul(3.0).add(vState.z)))))); });
          If(vState.w.greaterThan(3.5), () => { c.assign(select(gl.greaterThan(0.55), vec3(1.0, 0.04, 0.02), c)); k.mulAssign(step(0.25, gl)); });
          base.assign(c.mul(0.3));
          fEmis.assign(c.mul(k).mul(off).mul(add(1.4, mul(2.6, uNight))));
        }).ElseIf(sub_.equal(11), () => { // anti-collision strobe (double flash); police: red / blue; hostile: fast red
          const ph = fract(uTime.mul(0.9).add(vState.z)).toVar();
          const k = step(ph, 0.04).add(step(abs(ph.sub(0.13)), 0.02)).toVar();
          const c = select(vState.y.greaterThan(2.5), select(fract(uTime.mul(2.0).add(vState.z)).lessThan(0.5), vec3(1.0, 0.05, 0.03), vec3(0.05, 0.2, 1.0)), vec3(1.0)).toVar();
          If(vState.y.greaterThan(2.5), () => { k.assign(step(0.5, fract(uTime.mul(8.0))).mul(0.8)); });
          If(hostile, () => { c.assign(vec3(1.0, 0.03, 0.02)); k.assign(step(0.5, fract(uTime.mul(5.0).add(vState.z)))); });
          fEmis.assign(c.mul(k).mul(off).mul(add(5.0, mul(9.0, uNight))));
        }).Else(() => { // steady navigation light (colour from the model); hostile: red
          fEmis.assign(select(hostile, vec3(1.0, 0.03, 0.02), vPaint).mul(off).mul(add(0.6, mul(3.4, uNight))).mul(select(vState.w.greaterThan(3.5), step(0.3, gl), float(1.0))));
        });
      }).ElseIf(sub_.equal(9), () => { // retro-reflective band
        base.assign(vPaint); rough.assign(0.25); metal.assign(0.0);
      }).Else(() => { // lamp: frosted diffuser
        base.assign(vec3(0.82, 0.82, 0.8));
        rough.assign(0.25);
        fEmis.assign(vPaint.mul(vec3(1.0, 0.86, 0.66)).mul(vEmit).mul(lightOn).mul(9.0));
      });
    }).ElseIf(mid.equal(8), () => { // water
      const t = uTime;
      If(sub_.equal(1), () => {
        const ang = atan(vOPos.z, vOPos.x).toVar();
        const streak = fn(vec3(ang.mul(12.0), vOPos.y.mul(6.0).add(t.mul(5.0)), 0.0)).toVar();
        const streak2 = fn(vec3(ang.mul(31.0), vOPos.y.mul(9.0).add(t.mul(7.0)), 3.0));
        streak.assign(streak.mul(0.6).add(streak2.mul(0.4)));
        If(streak.lessThan(0.42), () => { Discard(); });
        If(streak.lessThan(0.6).and(fc.x.equal(fc.y)), () => { Discard(); });
        base.assign(mix(vec3(0.05, 0.09, 0.1), vec3(0.55, 0.62, 0.64), smoothstep(0.5, 0.85, streak)));
        rough.assign(0.08); metal.assign(0.1);
      }).Else(() => {
        base.assign(vec3(0.025, 0.07, 0.075));
        rough.assign(0.03); metal.assign(0.15);
      });
    }).ElseIf(mid.equal(9), () => { // bronze with verdigris
      const pat = smoothstep(0.35, 0.8, n0.mul(0.5).add(fn(vOPos.mul(4.0)).mul(0.3)).add(n2.mul(0.1)).add(max(0.0, vONrm.y).mul(0.3))).toVar();
      base.assign(mix(vec3(0.16, 0.09, 0.045), vec3(0.13, 0.24, 0.19), pat));
      metal.assign(mix(0.85, 0.15, pat)); rough.assign(mix(0.38, 0.75, pat));
    }).ElseIf(mid.equal(10), () => { // rubber
      base.assign(vPaint.mul(add(0.85, mul(0.2, n2))));
      rough.assign(0.95);
    }).ElseIf(mid.equal(11), () => { // signage
      base.assign(texture(sign, vUvF).rgb);
      rough.assign(0.45); metal.assign(0.0);
      If(sub_.equal(7), () => { fEmis.assign(base.mul(vEmit).mul(uNight).mul(1.6).mul(max(lightOn, uNight.mul(vState.x)))); });
    });
    return FurnSurf(base, clamp(rough, 0.02, 1.0), metal, fEmis);
  });

  const S = surface().toVar('furnitureS');
  setDiffuse(m, () => S.get('base'));
  m.roughnessNode = S.get('rough');
  m.metalnessNode = S.get('metal');
  m.emissiveNode = S.get('emis');
  // Still water: ripples in the normal (view space).
  m.normalNode = Fn(() => {
    const nrm = normalView.toVar();
    If(int(vMat.add(0.5)).equal(8).and(vSub.lessThan(0.5)), () => {
      const t = uTime;
      const p = vOPos.xz.mul(3.0).toVar();
      const g = vec2(
        sin(p.x.mul(2.1).add(t.mul(1.7))).add(sin(p.y.mul(1.3).sub(t.mul(1.3)).add(p.x))),
        cos(p.y.mul(2.4).add(t.mul(1.9))).add(sin(p.x.mul(1.7).add(p.y.mul(0.8)).sub(t))),
      ).toVar();
      nrm.assign(normalize(nrm.add(cameraViewMatrix.mul(vec4(g.x.mul(0.06), 0.0, g.y.mul(0.06), 0.0)).xyz)));
    });
    return nrm;
  })();
  return m;
}
