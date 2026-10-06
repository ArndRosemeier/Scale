// @ts-nocheck -- three's TSL typings infer swizzles and vector widths poorly; checked by rendering (docs/WEBGPU_PLAN.md).
/**
 * TSL counterparts of the humanoid GLSL helpers: `GLSL_NOISE` (humanoid/client/glsl.ts: hashing,
 * value noise, fbm, Voronoi) and `GLSL_FACE` (humanoid/client/faceRegions.ts: beard, scalp and
 * eyebrow coverage in face coordinates). Same names (`h_...`), same maths.
 */
import {
  Fn, float, vec2, vec3, fract, dot, floor, mix, sub, mul, add, abs, max, min, sqrt, length, clamp, sin, smoothstep, step, If, Loop, select,
  dFdx, dFdy, cross, normalize, sign,
} from 'three/tsl';

export const h_hash13 = Fn(([p0]) => {
  const p = fract(p0.mul(0.1031)).toVar();
  p.addAssign(dot(p, p.zyx.add(31.32)));
  return fract(p.x.add(p.y).mul(p.z));
}, { p: 'vec3', return: 'float' });

export const h_hash33 = Fn(([p0]) => {
  const p = fract(p0.mul(vec3(0.1031, 0.1030, 0.0973))).toVar();
  p.addAssign(dot(p, p.yxz.add(33.33)));
  return fract(p.xxy.add(p.yxx).mul(p.zyx));
}, { p: 'vec3', return: 'vec3' });

export const h_hash12 = Fn(([p]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
}, { p: 'vec2', return: 'float' });

export const h_hash22 = Fn(([p]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.1030, 0.0973))).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.xx.add(p3.yz).mul(p3.zy));
}, { p: 'vec2', return: 'vec2' });

export const h_noise3 = Fn(([p]) => {
  const i = floor(p).toVar(), f = fract(p).toVar();
  const u = f.mul(f).mul(sub(3.0, mul(2.0, f))).toVar();
  const a = h_hash13(i), b = h_hash13(i.add(vec3(1, 0, 0))), c = h_hash13(i.add(vec3(0, 1, 0))), d = h_hash13(i.add(vec3(1, 1, 0)));
  const e = h_hash13(i.add(vec3(0, 0, 1))), f1 = h_hash13(i.add(vec3(1, 0, 1))), g = h_hash13(i.add(vec3(0, 1, 1))), h = h_hash13(i.add(vec3(1, 1, 1)));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, f1, u.x), mix(g, h, u.x), u.y), u.z);
}, { p: 'vec3', return: 'float' });

export const h_noise2 = Fn(([p]) => {
  const i = floor(p).toVar(), f = fract(p).toVar();
  const u = f.mul(f).mul(sub(3.0, mul(2.0, f))).toVar();
  return mix(mix(h_hash12(i), h_hash12(i.add(vec2(1, 0))), u.x), mix(h_hash12(i.add(vec2(0, 1))), h_hash12(i.add(vec2(1, 1))), u.x), u.y);
}, { p: 'vec2', return: 'float' });

export const h_fbm3 = Fn(([p0]) => {
  const p = vec3(p0).toVar();
  const s = float(0.0).toVar(), a = float(0.5).toVar();
  Loop(4, () => { s.addAssign(a.mul(h_noise3(p))); p.assign(p.mul(2.03).add(17.1)); a.mulAssign(0.5); });
  return s;
}, { p: 'vec3', return: 'float' });

export const h_fbm2 = Fn(([p0]) => {
  const p = vec2(p0).toVar();
  const s = float(0.0).toVar(), a = float(0.5).toVar();
  Loop(4, () => { s.addAssign(a.mul(h_noise2(p))); p.assign(p.mul(2.03).add(17.1)); a.mulAssign(0.5); });
  return s;
}, { p: 'vec2', return: 'float' });

/** Voronoi: x = F1 distance, y = F2 distance, z = cell id hash. */
export const h_voronoi3 = Fn(([p]) => {
  const i = floor(p).toVar(), f = fract(p).toVar();
  const d1 = float(8.0).toVar(), d2 = float(8.0).toVar(), id = float(0.0).toVar();
  Loop({ start: -1, end: 2, name: 'vz' }, { start: -1, end: 2, name: 'vy' }, { start: -1, end: 2, name: 'vx' }, ({ vx, vy, vz }) => {
    const g = vec3(float(vx), float(vy), float(vz)).toVar();
    const o = h_hash33(i.add(g));
    const r = g.add(o).sub(f);
    const d = dot(r, r).toVar();
    If(d.lessThan(d1), () => { d2.assign(d1); d1.assign(d); id.assign(h_hash13(i.add(g).add(7.7))); })
      .ElseIf(d.lessThan(d2), () => { d2.assign(d); });
  });
  return vec3(sqrt(d1), sqrt(d2), id);
}, { p: 'vec3', return: 'vec3' });

export const h_voronoi2 = Fn(([p]) => {
  const i = floor(p).toVar(), f = fract(p).toVar();
  const d1 = float(8.0).toVar(), d2 = float(8.0).toVar(), id = float(0.0).toVar();
  Loop({ start: -1, end: 2, name: 'vy' }, { start: -1, end: 2, name: 'vx' }, ({ vx, vy }) => {
    const g = vec2(float(vx), float(vy)).toVar();
    const o = h_hash22(i.add(g));
    const r = g.add(o).sub(f);
    const d = dot(r, r).toVar();
    If(d.lessThan(d1), () => { d2.assign(d1); d1.assign(d); id.assign(h_hash12(i.add(g).add(7.7))); })
      .ElseIf(d.lessThan(d2), () => { d2.assign(d); });
  });
  return vec3(sqrt(d1), sqrt(d2), id);
}, { p: 'vec2', return: 'vec3' });

// ------------------------------------------------------------------ GLSL_FACE

export const h_beardCoverage = Fn(([style, f]) => {
  const ax = abs(f.x).toVar();
  const cheek = add(-0.82, mul(0.62, smoothstep(0.35, 1.25, ax)));
  const upper = sub(1.0, smoothstep(cheek.sub(0.06), cheek.add(0.06), f.y));
  const side = smoothstep(-1.45, -1.05, f.z).toVar();
  const neck = smoothstep(-2.25, -1.95, f.y.add(mul(0.25, ax))).mul(sub(1.0, smoothstep(1.3, 1.6, ax)));
  const front = upper.mul(side).mul(neck).toVar();
  const mouthGap = smoothstep(0.38, 0.5, length(vec2(f.x.div(1.1), f.y.add(1.18).div(0.36)))).toVar();
  const mustache = sub(1.0, smoothstep(0.5, 0.62, ax)).mul(smoothstep(-1.12, -1.02, f.y)).mul(sub(1.0, smoothstep(-0.86, -0.78, f.y))).toVar();
  const chin = sub(1.0, smoothstep(0.42, 0.56, ax)).mul(sub(1.0, smoothstep(-1.36, -1.28, f.y))).mul(smoothstep(-2.1, -1.95, f.y));
  return select(style.lessThan(0.0), 0.0,
    select(style.lessThan(0.5), max(front.mul(mouthGap), mustache),
      select(style.lessThan(1.5), max(chin, mustache).mul(side),
        select(style.lessThan(2.5), mustache,
          select(style.lessThan(3.5), front.mul(smoothstep(0.5, 0.75, ax)).mul(mouthGap),
            front.mul(smoothstep(-1.75, -1.6, f.y.negate().sub(mul(0.18, ax)))).mul(mouthGap))))));
}, { style: 'float', f: 'vec3', return: 'float' });

export const h_scalpCoverage = Fn(([f, recede]) => {
  const ax = abs(f.x).toVar();
  const hairline = add(1.05, mul(0.18, ax.mul(ax))).add(recede.mul(add(0.45, mul(0.4, smoothstep(0.2, 0.8, ax))))).toVar();
  const front = smoothstep(hairline.sub(0.08), hairline.add(0.08), f.y);
  const sides = smoothstep(-0.55, -0.85, f.z).mul(smoothstep(-0.05, 0.25, f.y.add(mul(0.35, smoothstep(-1.2, -2.0, f.z)))));
  const nape = smoothstep(-1.05, -1.35, f.z).mul(smoothstep(-2.2, -1.8, f.y));
  return min(1.0, max(front, max(sides, nape))).mul(step(-2.6, f.y));
}, { f: 'vec3', recede: 'float', return: 'float' });

/** Eyebrow: x = coverage, y = along-brow coordinate (0 inner..1 outer). br = (thickness, arch, unibrow, density). */
export const h_brow = Fn(([f, br]) => {
  const ax = abs(f.x).toVar();
  const u = ax.sub(0.17).div(0.86).toVar();
  const uc = clamp(u, 0.0, 1.0).toVar();
  const cy = add(0.43, br.y.mul(0.1).mul(sin(uc.mul(2.7)))).sub(mul(0.09, uc.mul(uc)));
  const th = br.x.mul(mix(0.085, 0.03, uc));
  const d = abs(f.y.sub(cy)).div(max(th, 1e-3));
  const m = sub(1.0, smoothstep(0.55, 1.05, d)).mul(smoothstep(-0.12, 0.04, u)).mul(sub(1.0, smoothstep(0.88, 1.05, u))).toVar();
  m.assign(max(m, br.z.mul(sub(1.0, smoothstep(0.12, 0.2, ax))).mul(sub(1.0, smoothstep(0.5, 1.0, abs(f.y.sub(0.42)).div(0.07))))));
  m.mulAssign(smoothstep(-0.55, -0.3, f.z));
  return vec2(m, u);
}, { f: 'vec3', br: 'vec4', return: 'vec2' });

// ------------------------------------------------------------------ shared by the humanoid materials

/**
 * Derivative bump mapping (h_bumpNormal in skinMaterial.ts, the inline blocks of the garment and
 * horn shaders): perturb the view normal `n` by the screen-space gradient of the height `h`.
 */
export const h_bumpNormal = Fn(([surfPos, n, h, faceDir]) => {
  const sx = dFdx(surfPos).toVar(), sy = dFdy(surfPos).toVar();
  const r1 = cross(sy, n).toVar(), r2 = cross(n, sx).toVar();
  const det = dot(sx, r1).mul(faceDir).toVar();
  const grad = sign(det).mul(dFdx(h).mul(r1).add(dFdy(h).mul(r2)));
  return normalize(abs(det).mul(n).sub(grad));
}, { surfPos: 'vec3', n: 'vec3', h: 'float', faceDir: 'float', return: 'vec3' });
