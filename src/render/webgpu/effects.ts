// @ts-nocheck -- three's TSL typings infer swizzles and vector widths poorly; checked by rendering (docs/WEBGPU_PLAN.md).
/**
 * Effect shaders as node materials: dust and smoke puffs (destruction/Dust.ts), the elemental
 * powers' beams, particles and decals (game/powers/ElementFx.ts), the long-range smoke columns
 * (game/aftermath/SmokeColumns.ts) and the origin scene's glows, discs, trails, shard and
 * particles (game/intro/StarFx.ts).
 *
 * ShaderMaterials become plain node materials with `vertexNode` (clip position, varyings assigned
 * in it, like the GLSL `main`) and `fragmentNode`; the callers' `{ value }` uniform objects are
 * followed with `shared()`.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, float, int, vec2, vec3, vec4, mix, normalize, max, min, abs, fract, floor, exp, pow, sin, cos, atan, length, distance, dot, cross,
  clamp, smoothstep, step, sub, add, mul, select, If, Discard, attribute, uniform, varyingProperty, positionGeometry, positionView, uv,
  modelViewMatrix, cameraProjectionMatrix, cameraViewMatrix, cameraPosition, normalViewGeometry, screenSize, instancedDynamicBufferAttribute,
} from 'three/tsl';
import { vnoise, shared } from './common';
import { instanceMatrixNode, col, shaderLike } from './fx';

type U = { value: unknown };

/** vec4 with xy moved by d (GLSL `mv.xy += d`). */
const addXY = (v, d) => vec4(v.xy.add(d), v.z, v.w);

// ---------------------------------------------------------------- scene fog (ShaderMaterial fog chunks)

let fogU: { col: unknown; p: unknown } | null = null;
/** The scene fog: colour and (kind 0 none / 1 linear / 2 exp2, near, far, density), like fog_fragment. */
function sceneFog() {
  if (!fogU) {
    const c = new THREE.Color(), p = new THREE.Vector4();
    fogU = {
      col: uniform(c).onRenderUpdate((frame) => { const f = frame.scene?.fog; if (f) c.copy(f.color); return c; }),
      p: uniform(p).onRenderUpdate((frame) => {
        const f = frame.scene?.fog;
        if (!f) p.set(0, 0, 0, 0);
        else if (f.isFogExp2) p.set(2, 0, 0, f.density);
        else p.set(1, f.near, f.far, 0);
        return p;
      }),
    };
  }
  return fogU;
}
const applyFog = (c, depth) => {
  const F = sceneFog();
  const f = select(F.p.x.lessThan(0.5), 0.0, select(F.p.x.lessThan(1.5), smoothstep(F.p.y, F.p.z, depth), sub(1.0, exp(F.p.w.mul(F.p.w).mul(depth).mul(depth).negate()))));
  return mix(c, F.col, f);
};

// ---------------------------------------------------------------- dust (destruction/Dust.ts)

export function createDustNodeMaterial(uTime: U): THREE.NodeMaterial {
  const T = shared(uTime);
  const a0 = attribute('a0', 'vec4'), a1 = attribute('a1', 'vec4'), a2 = attribute('a2', 'vec4'), a3 = attribute('a3', 'vec4');
  const vAlpha = varyingProperty('float', 'vAlpha'), vCol = varyingProperty('vec3', 'vCol'), vSeed = varyingProperty('float', 'vSeed');
  const position = positionGeometry;
  const vertex = Fn(() => {
    const age = T.sub(a0.w).toVar();
    const life = a1.w;
    const hide = life.lessThanEqual(0.0).or(age.lessThan(0.0)).or(age.greaterThan(life));
    const t = clamp(age.div(max(life, 1e-6)), 0.0, 1.0).toVar();
    // Velocity decays with drag; buoyant smoke rises.
    const drag = 1.6;
    const disp = a1.xyz.mul(sub(1.0, exp(age.mul(-drag)))).div(drag).add(vec3(0.0, a3.w.mul(age).mul(age).mul(0.3), 0.0));
    const p = a0.xyz.add(disp);
    const size = mix(a2.x, a2.y, sub(1.0, pow(sub(1.0, t), 2.5)));
    const mv = modelViewMatrix.mul(vec4(p, 1.0)).toVar();
    const r = a2.z.add(age.mul(0.2)).toVar();
    const c0 = position.xy;
    const c = vec2(c0.x.mul(cos(r)).sub(c0.y.mul(sin(r))), c0.x.mul(sin(r)).add(c0.y.mul(cos(r))));
    vAlpha.assign(a2.w.mul(smoothstep(0.0, 0.08, t)).mul(sub(1.0, smoothstep(0.55, 1.0, t))));
    vCol.assign(a3.rgb);
    vSeed.assign(a0.w.mul(13.7).add(a0.x));
    return select(hide, vec4(0.0), cameraProjectionMatrix.mul(addXY(mv, c.mul(size))));
  })();
  const fragment = Fn(() => {
    const vUv = uv();
    const q = vUv.sub(0.5);
    const d = length(q).mul(2.0).toVar();
    const puff = vnoise(q.mul(4.0).add(vSeed)).mul(0.6).add(vnoise(q.mul(9.0).sub(vSeed)).mul(0.4)).toVar();
    const a = smoothstep(1.0, 0.2, d.add(puff.sub(0.5).mul(0.6))).mul(vAlpha).toVar();
    If(a.lessThan(0.003), () => { Discard(); });
    const c = vCol.mul(add(0.75, mul(0.35, puff))).mul(sub(1.0, mul(0.25, d)));
    return vec4(c, a);
  })();
  return shaderLike({ vertex, fragment, transparent: true, depthWrite: false });
}

// ---------------------------------------------------------------- powers: beams (game/powers/ElementFx.ts)

const bh = Fn(([x]) => fract(sin(x.mul(91.17)).mul(43758.5)), { x: 'float', return: 'float' });
const n1 = Fn(([x]) => {
  const i = floor(x), f = fract(x);
  return mix(bh(i), bh(i.add(1.0)), f.mul(f).mul(sub(3.0, mul(2.0, f))));
}, { x: 'float', return: 'float' });

export function createBeamNodeMaterial(uTime: U): THREE.NodeMaterial {
  const T = shared(uTime);
  const iA = attribute('iA', 'vec4'), iB = attribute('iB', 'vec4'), iC = attribute('iC', 'vec4');
  const vQ = varyingProperty('vec2', 'vQ'), vCol = varyingProperty('vec3', 'vCol'), vI = varyingProperty('float', 'vI');
  const vStyle = varyingProperty('float', 'vStyle'), vLen = varyingProperty('float', 'vLen');
  const position = positionGeometry;
  const vertex = Fn(() => {
    const a = iA.xyz, b = iB.xyz;
    const axis = b.sub(a).toVar();
    const len = max(length(axis), 1e-4).toVar();
    const ad = axis.div(len).toVar();
    const p = mix(a, b, position.x).toVar();
    // At least ~3 px wide however far away (a beam must read at 100 m too).
    const w = max(iA.w, distance(cameraPosition, p).mul(0.0022)).toVar();
    p.addAssign(ad.mul(position.x.mul(2.0).sub(1.0)).mul(w).mul(0.5));
    const view = cameraPosition.sub(p);
    const side = cross(ad, view).toVar();
    const sl = length(side);
    side.assign(select(sl.greaterThan(1e-5), side.div(sl), vec3(0.0, 1.0, 0.0)));
    p.addAssign(side.mul(position.y).mul(w));
    vQ.assign(vec2(position.x.mul(len.add(w)), position.y));
    vCol.assign(iC.rgb); vI.assign(iB.w); vStyle.assign(iC.w); vLen.assign(len.add(w));
    return cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(p, 1.0));
  })();
  const fragment = Fn(() => {
    const v = abs(vQ.y).toVar();
    const u = vQ.x.toVar();
    // Soft rounded ends.
    const endA = smoothstep(0.0, 0.15, min(u, vLen.sub(u)).div(max(0.05, vLen)));
    const core = exp(v.mul(v).mul(-36.0)).toVar();
    const glow = exp(v.mul(v).mul(-3.5)).mul(sub(1.0, v)).toVar();
    const k = float(1.0).toVar();
    const c = vec3(0.0).toVar();
    const st = int(vStyle.add(0.5)).toVar();
    If(st.equal(1), () => {                 // lightning: thin, flickering
      k.assign(add(0.65, mul(0.35, n1(T.mul(50.0).add(u.mul(2.0))))));
      core.assign(exp(v.mul(v).mul(-60.0)));
      c.assign(vCol.mul(glow).mul(0.9).add(vec3(1.0).mul(core).mul(2.2)));
    }).ElseIf(st.equal(2), () => {          // shrink ray: travelling rings
      const rings = add(0.55, mul(0.45, sin(u.mul(7.0).sub(T.mul(26.0)))));
      c.assign(vCol.mul(glow).mul(add(0.5, rings)).add(vec3(1.0).mul(core).mul(0.9)));
    }).ElseIf(st.equal(3), () => {          // water jet: churning streaks
      const s = n1(u.mul(3.0).sub(T.mul(30.0)).add(floor(vQ.y.mul(3.0)).mul(7.0)));
      c.assign(vCol.mul(glow.mul(0.45).add(core.mul(0.35))).mul(add(0.6, mul(0.6, s))));
    }).ElseIf(st.equal(4), () => {          // ring / wave front
      c.assign(vCol.mul(glow).mul(1.2).add(vec3(1.0).mul(core).mul(0.6)));
    }).ElseIf(st.equal(5), () => {          // fire tongue
      const s = n1(u.mul(2.5).sub(T.mul(14.0)));
      c.assign(vCol.mul(glow).mul(add(0.6, mul(0.8, s))));
    }).Else(() => {                         // laser
      k.assign(add(0.92, mul(0.08, sin(T.mul(90.0).add(u.mul(0.5))))));
      c.assign(vCol.mul(glow).mul(1.1).add(vec3(1.0, 0.95, 0.9).mul(core).mul(2.6)));
    });
    return vec4(c.mul(vI).mul(k).mul(endA), 1.0);
  })();
  return shaderLike({ vertex, fragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
}

// ---------------------------------------------------------------- powers: particles

export function createPowerParticleNodeMaterial(additive: boolean): THREE.NodeMaterial {
  const iP = attribute('iP', 'vec4'), iC = attribute('iC', 'vec4');
  const vUv = varyingProperty('vec2', 'vUv'), vC = varyingProperty('vec4', 'vC');
  const position = positionGeometry;
  const vertex = Fn(() => {
    const mv = cameraViewMatrix.mul(vec4(iP.xyz, 1.0)).toVar();
    vUv.assign(position.xy.mul(2.0));
    // Fade out right at the camera (an ember or a puff of smoke next to the lens would fill the view
    // as a big flat disc): gone within 0.3 m, full from about two sprite sizes away.
    const near = clamp(mv.z.negate().sub(0.3).div(add(1.2, iP.w.mul(1.5))), 0.0, 1.0);
    vC.assign(vec4(iC.rgb, iC.a.mul(near).mul(near)));
    return cameraProjectionMatrix.mul(addXY(mv, position.xy.mul(iP.w)));
  })();
  const fragment = Fn(() => {
    const d = dot(vUv, vUv).toVar();
    If(d.greaterThan(1.0), () => { Discard(); });
    const a = sub(1.0, d).mul(sub(1.0, d));
    return additive ? vec4(vC.rgb.mul(a).mul(vC.a).mul(add(1.0, mul(1.5, exp(d.mul(-8.0))))), 1.0) : vec4(vC.rgb, a.mul(vC.a));
  })();
  return shaderLike({ vertex, fragment, transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending });
}

// ---------------------------------------------------------------- powers: decals

const dfbm = (p) => vnoise(p).mul(0.55).add(vnoise(p.mul(2.1).add(3.1)).mul(0.3)).add(vnoise(p.mul(4.3).sub(1.7)).mul(0.15));

export function createDecalNodeMaterial(uTime: U, uNight: U): THREE.NodeMaterial {
  const T = shared(uTime), N = shared(uNight);
  const vD = attribute('iD', 'vec4');
  const IM = instanceMatrixNode();
  // (The vertex position is the default one: projection · view · model · instanceMatrix · position.)
  const vScale = varyingProperty('vec2', 'vScale');
  const scaleV = Fn(() => {
    vScale.assign(vec2(length(col(IM, 0).xyz), length(col(IM, 1).xyz)));
    return cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(IM.mul(vec4(positionGeometry, 1.0)).xyz, 1.0));
  })();
  const fragment = Fn(() => {
    const vUv = uv();
    const kind = int(vD.x.add(0.5)).toVar();
    const age = T.sub(vD.y).toVar(), life = vD.z, seed = vD.w;
    If(age.lessThan(0.0).or(age.greaterThan(life)), () => { Discard(); });
    const fade = smoothstep(0.0, 0.08, age).mul(sub(1.0, smoothstep(life.mul(0.75), life, age))).toVar();
    const q = vUv.sub(0.5).toVar();
    const w = q.mul(vScale).toVar();                   // metres
    const lightK = sub(1.0, mul(0.7, N)).toVar();
    const c = vec3(0.0).toVar(), a = float(0.0).toVar();
    If(kind.equal(3), () => {                       // fissure: a jagged dark line along u
      const along = w.x;
      const off = dfbm(vec2(along.mul(0.35), seed)).sub(0.5).mul(vScale.y).mul(0.55).toVar();
      const d = abs(w.y.sub(off)).toVar();
      const width = vScale.y.mul(add(0.06, mul(0.08, vnoise(vec2(along.mul(1.3), seed.add(4.0)))))).mul(sub(1.0, smoothstep(0.38, 0.5, abs(q.x)))).toVar();
      const side = float(0.0).toVar();
      const br = dfbm(vec2(along.mul(0.9).add(11.0), seed)).toVar();
      If(br.greaterThan(0.62), () => { side.assign(smoothstep(0.03, 0.0, abs(abs(w.y.sub(off)).sub(br.sub(0.62).mul(vScale.y).mul(0.9))).sub(0.0))); });
      a.assign(max(smoothstep(width, width.mul(0.4), d), side.mul(0.7)));
      const rim = smoothstep(width.mul(2.6), width, d).mul(0.35);
      c.assign(mix(vec3(0.32, 0.29, 0.26), vec3(0.015), a).mul(lightK));
      a.assign(max(a, rim).mul(fade));
    }).Else(() => {
      const r = length(q).mul(2.0).toVar();
      const edge = dfbm(q.mul(5.0).add(seed)).mul(0.35).toVar();
      const body = sub(1.0, smoothstep(sub(0.62, edge.mul(0.6)), sub(1.0, edge.mul(0.6)), r)).toVar();
      If(kind.equal(0), () => {                     // scorch: soot, darkest in the middle
        c.assign(vec3(0.025, 0.02, 0.018).mul(add(0.7, mul(0.6, dfbm(w.mul(3.0))))));
        a.assign(body.mul(add(0.55, mul(0.4, sub(1.0, r)))).mul(fade));
        // embers at first
        const hot = exp(age.mul(-1.5)).mul(sub(1.0, r));
        c.addAssign(vec3(1.2, 0.35, 0.05).mul(hot).mul(step(0.55, dfbm(w.mul(6.0).add(seed)))));
      }).ElseIf(kind.equal(1).or(kind.equal(4)), () => { // ice: pale, with bright cracks
        const cr = abs(dfbm(w.mul(1.6).add(seed)).sub(0.5));
        const lines = smoothstep(0.03, 0.0, cr);
        c.assign(mix(vec3(0.72, 0.86, 0.96), vec3(1.0), lines.mul(0.8)).mul(add(0.85, mul(0.25, dfbm(w.mul(4.0))))).mul(lightK).add(vec3(0.04, 0.07, 0.1).mul(N)));
        a.assign(body.mul(select(kind.equal(4), 0.5, 0.82)).mul(fade));
      }).Else(() => {                               // puddle: dark, glossy
        c.assign(vec3(0.05, 0.065, 0.08).mul(lightK).add(vec3(0.25, 0.3, 0.35).mul(pow(dfbm(w.mul(0.7).add(seed.mul(0.3))), 3.0)).mul(lightK)));
        a.assign(body.mul(0.62).mul(fade));
      });
    });
    If(a.lessThan(0.004), () => { Discard(); });
    return vec4(c, a);
  })();
  return shaderLike({ vertex: scaleV, fragment, transparent: true, depthWrite: false, side: THREE.DoubleSide });
}

// ---------------------------------------------------------------- smoke columns (game/aftermath/SmokeColumns.ts)

const sh1 = (x) => fract(sin(x.mul(91.7)).mul(43758.5453));
const xz = (v) => vec3(v.x, 0.0, v.y);

export function createSmokeColumnNodeMaterial(uniforms: { uTime: U; uWind: U; uNight: U; uDay: U }, rise: number): THREE.NodeMaterial {
  const uTime = shared(uniforms.uTime), uWind = shared(uniforms.uWind), uNight = shared(uniforms.uNight), uDay = shared(uniforms.uDay);
  const iA = attribute('iA', 'vec4'), iB = attribute('iB', 'vec4'), iC = attribute('iC', 'vec4');
  const vUv = varyingProperty('vec2', 'vUv'), vC = varyingProperty('vec4', 'vC'), vGlow = varyingProperty('float', 'vGlow');
  const vSeed = varyingProperty('float', 'vSeed'), vFogDepth = varyingProperty('float', 'vFogDepth');
  const position = positionGeometry;
  const vertex = Fn(() => {
    // iA: base x, y, z, puff key (column seed + k / n) · iB: height, width, density, fire
    // iC: mode (0 column, 1 mushroom), growth, puff index share k / n, unused
    const key = iA.w, k = iC.z, H = iB.x, W = iB.y;
    const p = iA.xyz.toVar();
    const size = float(0).toVar(), a = float(0).toVar(), dark = float(0).toVar();
    vGlow.assign(0.0);
    If(iC.x.lessThan(0.5), () => {
      // A column: puffs rise, swell and drift downwind (more the higher), fading at the top.
      const ph = fract(uTime.mul(rise).div(max(20.0, H)).add(key)).toVar();
      const sway = sin(uTime.mul(0.21).add(key.mul(37.0))).mul(0.12);
      p.addAssign(vec3(0.0, ph.mul(H), 0.0));
      p.addAssign(xz(uWind.xz.add(vec2(sway, sway.negate())).mul(ph).mul(ph).mul(H).mul(0.45).mul(uWind.y)));
      p.addAssign(xz(vec2(sh1(key.mul(13.0)), sh1(key.mul(29.0))).sub(0.5).mul(W).mul(0.5).mul(add(0.4, ph))));
      size.assign(W.mul(add(0.6, mul(2.4, ph))));
      a.assign(iB.z.mul(smoothstep(0.0, 0.05, ph)).mul(sub(1.0, smoothstep(0.6, 1.0, ph))));
      dark.assign(mix(0.09, 0.34, ph));
      vGlow.assign(iB.w.mul(sub(1.0, smoothstep(0.0, 0.12, ph))));
    }).Else(() => {
      // The mushroom cloud: a stem rising into a rolling cap that spreads as it grows.
      const gr = iC.y, top = H.mul(add(0.25, mul(0.75, gr))).toVar();
      const roll = uTime.mul(0.05).add(key.mul(6.283)).toVar();
      If(k.lessThan(0.32), () => {
        const t = k.div(0.32).toVar();
        p.addAssign(vec3(0.0, t.mul(top).mul(0.92), 0.0));
        p.addAssign(xz(vec2(cos(roll.mul(3.0)), sin(roll.mul(3.0))).mul(W).mul(0.05)));
        size.assign(W.mul(add(0.22, mul(0.16, t))).mul(add(0.6, mul(0.4, gr))));
        dark.assign(mix(0.16, 0.3, t));
      }).Else(() => {
        const t = k.sub(0.32).div(0.68).toVar();
        const ang = t.mul(6.283 * 3.0).add(roll), rad = W.mul(add(0.25, mul(0.5, fract(t.mul(3.0))))).mul(add(0.5, mul(0.5, gr)));
        p.addAssign(vec3(0.0, top.add(W.mul(0.22).mul(sin(t.mul(18.0).add(roll)))).sub(W.mul(0.1).mul(fract(t.mul(3.0)))), 0.0));
        p.addAssign(xz(vec2(cos(ang), sin(ang)).mul(rad)));
        size.assign(W.mul(add(0.32, mul(0.14, sh1(key.mul(7.0))))).mul(add(0.55, mul(0.45, gr))));
        dark.assign(mix(0.3, 0.45, sh1(key.mul(3.0))));
      });
      p.addAssign(xz(uWind.xz.mul(gr).mul(gr).mul(H).mul(0.12).mul(uWind.y)));
      a.assign(iB.z);
      vGlow.assign(iB.w);
    });
    const mv = cameraViewMatrix.mul(vec4(p, 1.0)).toVar();
    // Fade puffs at the camera (standing inside a column is not a grey wall).
    const dc = length(mv.xyz);
    a.mulAssign(smoothstep(size.mul(0.35), size.mul(1.4), dc));
    mv.assign(addXY(mv, position.xy.mul(size)));
    vUv.assign(position.xy.mul(2.0));
    // Lit by the day: grey by daylight, dark at night (a burning base lights it from below).
    const lit = mix(0.12, 1.0, uDay).mul(sub(1.0, mul(0.6, uNight)));
    vC.assign(vec4(vec3(dark).mul(lit), a));
    vSeed.assign(key);
    vFogDepth.assign(mv.z.negate());
    return cameraProjectionMatrix.mul(mv);
  })();
  const fragment = Fn(() => {
    const d = dot(vUv, vUv).toVar();
    If(d.greaterThan(1.0), () => { Discard(); });
    const n = vnoise(vUv.mul(2.3).add(vSeed.mul(17.0))).mul(0.6).add(vnoise(vUv.mul(5.1).sub(vSeed.mul(9.0))).mul(0.4)).toVar();
    const a = pow(sub(1.0, d), 1.5).mul(add(0.6, mul(0.8, n))).mul(vC.a).toVar();
    If(a.lessThan(0.004), () => { Discard(); });
    // Shade: the top of a puff a little lighter than its underside.
    const c = vC.rgb.mul(add(0.82, mul(0.3, vUv.y)).add(mul(0.15, n))).toVar();
    c.addAssign(vec3(2.2, 0.9, 0.25).mul(vGlow).mul(sub(1.0, d)).mul(add(0.6, mul(0.4, n))));
    return vec4(applyFog(c, vFogDepth), min(1.0, a));
  })();
  return shaderLike({ vertex, fragment, transparent: true, depthWrite: false });
}

// ---------------------------------------------------------------- origin scene (game/intro/StarFx.ts)

type StarKind = 'glow' | 'disc' | 'trail' | 'shard';

/** StarFx's glow / disc / trail / shard materials; `additive` as its `additive()` helper. */
export function createStarFxNodeMaterial(kind: StarKind, u: Record<string, U>, additive: boolean): THREE.NodeMaterial {
  const S = (name: string) => shared(u[name]);
  const opts = additive ? { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } : {};
  if (kind === 'glow') {
    const vertex = Fn(() => {
      const mv = modelViewMatrix.mul(vec4(0.0, 0.0, 0.0, 1.0)).toVar();
      const s = max(S('uSize'), mv.z.negate().mul(S('uMinAng')));
      return cameraProjectionMatrix.mul(addXY(mv, positionGeometry.xy.mul(s)));
    })();
    const fragment = Fn(() => {
      const vUv = uv().mul(2.0).sub(1.0);
      const r = length(vUv).toVar();
      If(r.greaterThan(1.0), () => { Discard(); });
      const halo = pow(sub(1.0, r), 2.4);
      const core = exp(r.mul(r).mul(S('uCore')).negate());
      return vec4(S('uColor').mul(halo.mul(0.55).add(core.mul(1.6))).mul(S('uI')), 1.0);
    })();
    return shaderLike({ vertex, fragment, ...opts });
  }
  if (kind === 'disc') {
    const fragment = Fn(() => {
      const vUv = uv().mul(2.0).sub(1.0).toVar();
      const r = length(vUv).toVar();
      If(r.greaterThan(1.0), () => { Discard(); });
      const out = vec4(0.0).toVar();
      If(S('uDark').greaterThan(0.5), () => {
        // Scorch: dark, ragged edge.
        const a = atan(vUv.y, vUv.x).toVar();
        const edge = add(0.78, mul(0.12, sin(a.mul(7.0)))).add(mul(0.06, sin(a.mul(13.0).add(1.3)))).toVar();
        const k = sub(1.0, smoothstep(edge.sub(0.25), edge, r));
        out.assign(vec4(vec3(0.025, 0.02, 0.03), k.mul(0.85).mul(S('uI'))));
      }).Else(() => {
        const ring = add(0.5, mul(0.5, sin(r.mul(18.0).sub(S('uT').mul(3.0)))));
        const g = pow(sub(1.0, r), 2.0).mul(add(0.75, mul(0.25, ring)));
        out.assign(vec4(S('uColor').mul(g).mul(S('uI')), 1.0));
      });
      return out;
    })();
    return shaderLike({ fragment, ...opts });
  }
  if (kind === 'trail') {
    const vT = attribute('aT', 'float'), vSide = attribute('aSide', 'float');
    const across = sub(1.0, vSide.mul(vSide));
    const a = pow(sub(1.0, vT), 1.6).mul(across);
    const c = mix(S('uHead'), S('uTail'), smoothstep(0.0, 0.5, vT));
    return shaderLike({ fragment: vec4(c.mul(a).mul(S('uI')), 1.0), ...opts });
  }
  // The shard: facets, a fresnel rim, a pulse.
  const fragment = Fn(() => {
    const N = normalize(normalViewGeometry), V = normalize(positionView.negate());
    const vH = positionGeometry.y;
    const fres = pow(sub(1.0, abs(dot(N, V))), 2.0);
    const facet = add(0.5, mul(0.5, dot(N, normalize(vec3(0.4, 0.8, 0.3)))));
    const vein = add(0.5, mul(0.5, sin(vH.mul(14.0).sub(S('uT').mul(4.0)))));
    const deep = vec3(0.18, 0.08, 0.55), mid = vec3(0.25, 0.75, 1.2), hot = vec3(1.6, 1.5, 1.9);
    const c = mix(deep, mid, facet.mul(0.8).add(vein.mul(0.2))).add(hot.mul(fres));
    return vec4(c.mul(S('uI')), 1.0);
  })();
  return shaderLike({ fragment, ...opts });
}

/**
 * StarFx particles. WebGPU draws plain points 1 px wide, so this is an instanced quad mesh (one
 * quad per point, sized in pixels like gl_PointSize) reading the Points' position / colour /
 * size attributes as per-instance data.
 */
export function createStarParticlesNode(P: THREE.BufferAttribute, C: THREE.BufferAttribute, S: THREE.BufferAttribute, uScale: U): THREE.Mesh {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.instanceCount = P.count;
  const iPos = instancedDynamicBufferAttribute(P, 'vec3'), iCol = instancedDynamicBufferAttribute(C, 'vec3'), iSize = instancedDynamicBufferAttribute(S, 'float');
  const Sc = shared(uScale);
  const vColor = varyingProperty('vec3', 'vColor'), vPC = varyingProperty('vec2', 'vPC');
  const vertex = Fn(() => {
    vColor.assign(iCol);
    vPC.assign(positionGeometry.xy);
    const mv = modelViewMatrix.mul(vec4(iPos, 1.0)).toVar();
    const ps = select(iSize.lessThanEqual(0.0), 0.0, clamp(iSize.mul(Sc).div(max(0.05, mv.z.negate())), 1.5, 64.0));
    const clip = cameraProjectionMatrix.mul(mv).toVar();
    // gl_PointSize: a square ps pixels across.
    return addXY(clip, positionGeometry.xy.mul(ps).div(screenSize).mul(clip.w));
  })();
  const fragment = Fn(() => {
    const d = length(vPC).toVar();
    If(d.greaterThan(1.0), () => { Discard(); });
    const a = pow(sub(1.0, d), 2.0);
    return vec4(vColor.mul(a), 1.0);
  })();
  const m = shaderLike({ vertex, fragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  return mesh;
}

