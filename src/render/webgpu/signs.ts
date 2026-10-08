// @ts-nocheck -- three's TSL typings infer swizzles and vector widths poorly; checked by rendering (docs/WEBGPU_PLAN.md).
/**
 * Near-future signage as node materials: the drones' navigation glows (future/NavGlows.ts), the
 * LED facade signs and the kiosk holograms (future/Signs.ts).
 */
import * as THREE from 'three/webgpu';
import {
  Fn, float, int, vec2, vec3, vec4, mix, normalize, max, min, abs, fract, floor, mod, sin, atan, length, distance, dot, clamp,
  smoothstep, step, sub, add, mul, select, If, attribute, varying, texture, positionGeometry, modelWorldMatrix,
  cameraProjectionMatrix, cameraViewMatrix, cameraWorldMatrix, fwidth, OnMaterialUpdate,
} from 'three/tsl';
import { shared } from './common';
import { setDiffuse } from './ground';
import { instanceMatrixNode, col, shaderLike } from './fx';

type U = { value: unknown };

/** The camera's right and up vectors in world space (rows 0 and 1 of the view matrix). */
const camR = () => cameraWorldMatrix.mul(vec4(1.0, 0.0, 0.0, 0.0)).xyz;
const camU = () => cameraWorldMatrix.mul(vec4(0.0, 1.0, 0.0, 0.0)).xyz;

/** A texture uniform following a `{ value }` object (the callers swap textures in). */
function followTex(u: { value: THREE.Texture | null }) {
  const t = texture(u.value ?? new THREE.Texture());
  return { t, sync: () => OnMaterialUpdate(() => { if (u.value && t.value !== u.value) t.value = u.value; }) };
}

// ---------------------------------------------------------------- nav glows

export function createNavGlowNodeMaterial(u: { uTime: U; uNight: U }): THREE.NodeMaterial {
  const uTime = shared(u.uTime), uNight = shared(u.uNight);
  const IM = instanceMatrixNode();
  const vG = attribute('sUv', 'vec2'), vGlow = attribute('iGlow', 'vec4'), vPh = attribute('iPhase', 'float');
  const vertex = Fn(() => {
    const cW = modelWorldMatrix.mul(col(IM, 3)).toVar();
    const s = length(col(IM, 0).xyz);
    const t = positionGeometry;
    return cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(cW.xyz.add(camR().mul(t.x).add(camU().mul(t.y)).mul(s)), 1.0));
  })();
  const fragment = Fn(() => {
    const q = vG.mul(2.0).sub(1.0);
    const r2 = dot(q, q).toVar();
    const a = glowA(r2);
    const c = vGlow.rgb.toVar();
    const k = float(1.0).toVar();
    const kind = int(vGlow.a.add(0.5)).toVar();
    If(kind.equal(1), () => {
      const ph = fract(uTime.mul(0.9).add(vPh)).toVar();
      k.assign(step(ph, 0.04).add(step(abs(ph.sub(0.13)), 0.02)));
    }).ElseIf(kind.equal(2), () => {
      const red = fract(uTime.mul(2.0).add(vPh)).lessThan(0.5);
      c.assign(select(red, vec3(1.0, 0.08, 0.05), vec3(0.1, 0.25, 1.0)));
      k.assign(step(0.5, fract(uTime.mul(8.0))));
    });
    // Steady lights mostly at dusk and night; strobes are seen in daylight too.
    const vis = select(kind.equal(0), uNight, mix(0.35, 1.0, uNight));
    return vec4(c.mul(a).mul(k).mul(vis).mul(2.2), 1.0);
  })();
  return shaderLike({ vertex, fragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
}
const glowA = (r2) => r2.mul(-7.0).exp().add(r2.mul(-40.0).exp().mul(0.6));

// ---------------------------------------------------------------- facade signs

const sh1 = Fn(([x]) => fract(sin(x.mul(127.1)).mul(43758.5453)), { x: 'float', return: 'float' });

// Seven-segment digits (the countdown) and the shapes of the pictograms (no text anywhere).
const segLine = Fn(([p, a, b, w]) => {
  const pa = p.sub(a), ba = b.sub(a);
  const h = clamp(dot(pa, ba).div(dot(ba, ba)), 0.0, 1.0);
  return sub(1.0, smoothstep(w.mul(0.6), w, length(pa.sub(ba.mul(h)))));
}, { p: 'vec2', a: 'vec2', b: 'vec2', w: 'float', return: 'float' });

const digit7 = Fn(([p, d]) => {
  const m = select(d.equal(0), int(63), select(d.equal(1), int(6), select(d.equal(2), int(91), select(d.equal(3), int(79), select(d.equal(4), int(102),
    select(d.equal(5), int(109), select(d.equal(6), int(125), select(d.equal(7), int(7), select(d.equal(8), int(127), int(111)))))))))).toVar();
  const TL = vec2(0.18, 0.88), TR = vec2(0.82, 0.88), ML = vec2(0.18, 0.5), MR = vec2(0.82, 0.5), BL = vec2(0.18, 0.12), BR = vec2(0.82, 0.12);
  const w = float(0.1), c = float(0.0).toVar();
  const seg = (bit: number, a, b) => { If(m.bitAnd(bit).notEqual(0), () => { c.assign(max(c, segLine(p, a, b, w))); }); };
  seg(1, TL, TR); seg(2, TR, MR); seg(4, MR, BR); seg(8, BL, BR); seg(16, ML, BL); seg(32, TL, ML); seg(64, ML, MR);
  return c;
}, { p: 'vec2', d: 'int', return: 'float' });

// A stylised hazard symbol: a black trefoil on a yellow disc (p centred, unit ≈ the disc's radius).
const trefoil = Fn(([p]) => {
  const r = length(p), a = atan(p.y, p.x);
  const blade = step(0.24, r).mul(step(r, 0.86)).mul(step(fract(a.mul(0.4774648).add(0.5)), 0.5));
  return max(blade, step(r, 0.17));
}, { p: 'vec2', return: 'float' });

function signFns(uTime, uFeed, uAtlas, uCardTex, uCards) {
  // The countdown: the symbol and MM:SS in red LED digits, hazard stripes round the edge.
  const countPict = Fn(([l, aspect, secs]) => {
    const P = vec2(l.x.mul(aspect), l.y).toVar();
    const edge = min(min(P.x, aspect.sub(P.x)), min(P.y, sub(1.0, P.y)));
    const c = vec3(0.015, 0.01, 0.01).toVar();
    If(edge.lessThan(0.07), () => { c.assign(mix(vec3(0.02), vec3(1.0, 0.75, 0.0), step(0.5, fract(P.x.add(P.y).mul(5.0))))); });
    const wide = aspect.greaterThan(1.6).toVar();
    const sc = select(wide, vec2(0.55, 0.5), vec2(aspect.mul(0.5), 0.67));
    const sr = select(wide, 0.34, min(0.22, aspect.mul(0.36)));
    const sp = P.sub(sc).div(sr).toVar();
    const blink = select(secs.lessThan(30.0), step(0.35, fract(uTime.mul(2.0))), 1.0);
    If(length(sp).lessThan(1.0), () => { c.assign(mix(vec3(1.0, 0.78, 0.0), vec3(0.02), trefoil(sp)).mul(mix(0.25, 1.0, blink))); });
    // MM:SS.
    const m = floor(secs.div(60.0)).toVar(), s = floor(mod(secs, 60.0)).toVar();
    const d0 = select(wide, vec2(1.05, 0.22), vec2(aspect.mul(0.08), 0.1));
    const dw = select(wide, aspect.sub(1.15).div(4.6), aspect.mul(0.84).div(4.6)).toVar(), dh = select(wide, 0.56, 0.3).toVar();
    dh.assign(min(dh, dw.mul(1.8))); dw.assign(min(dw, dh.div(1.3)));
    const q = P.sub(d0).div(vec2(dw, dh)).toVar();
    const lit = float(0.0).toVar();
    If(q.y.greaterThan(0.0).and(q.y.lessThan(1.0)).and(q.x.greaterThan(0.0)).and(q.x.lessThan(4.6)), () => {
      const cell = select(q.x.lessThan(2.0), floor(q.x), select(q.x.lessThan(2.6), -1.0, floor(q.x.sub(0.6)))).toVar();
      const f = vec2(select(q.x.lessThan(2.0), fract(q.x), fract(q.x.sub(0.6))), q.y).toVar();
      const dd = select(cell.equal(0.0), int(mod(floor(m.div(10.0)), 10.0)), select(cell.equal(1.0), int(mod(m, 10.0)),
        select(cell.equal(2.0), int(floor(s.div(10.0))), int(mod(s, 10.0)))));
      If(cell.greaterThanEqual(0.0), () => { lit.assign(digit7(f, dd)); })
        .Else(() => { lit.assign(step(length(vec2(q.x.sub(2.3).mul(0.6), q.y.sub(0.3))), 0.07).add(step(length(vec2(q.x.sub(2.3).mul(0.6), q.y.sub(0.7))), 0.07))); });
    });
    c.assign(mix(c, vec3(1.0, 0.18, 0.04).mul(1.6), clamp(lit, 0.0, 1.0)));
    return c;
  });
  // The live feed: the news drone's picture, scan lines, a blinking red dot, viewfinder corners.
  const feedPict = Fn(([l, aspect]) => {
    const k = vec2(min(1.0, aspect.div(1.7778)), min(1.0, float(1.7778).div(aspect)));
    const f = uFeed.t.sample(l.sub(0.5).mul(k).add(0.5)).rgb.toVar();
    f.assign(f.div(add(1.0, f)));
    f.assign(f.mul(f).mul(1.5).mul(add(0.92, mul(0.08, sin(l.y.mul(420.0).sub(uTime.mul(30.0)))))));
    const P = vec2(l.x.mul(aspect), l.y).toVar();
    const dotR = length(P.sub(vec2(0.12, 0.86)));
    f.assign(mix(f, vec3(1.0, 0.05, 0.03), step(dotR, 0.045).mul(step(0.4, fract(uTime.mul(0.9))))));
    const e = min(P, vec2(aspect, 1.0).sub(P)).toVar();
    const corner = step(min(e.x, e.y), 0.03).mul(step(max(e.x, e.y), 0.14)).mul(step(0.012, min(e.x, e.y)));
    return mix(f, vec3(0.9), corner);
  });
  // City news (pictograms): 1 the city lost — a mushroom cloud over a broken skyline; 2 all clear — a
  // check over the skyline; 3 the monster brought down — its body lying before the skyline.
  const newsPict = Fn(([l, aspect, kind]) => {
    const P = vec2(l.x.sub(0.5).mul(aspect), l.y).toVar();
    const bg = select(kind.lessThan(1.5), mix(vec3(0.25, 0.02, 0.0), vec3(0.06, 0.0, 0.0), l.y), select(kind.lessThan(2.5),
      mix(vec3(0.05, 0.35, 0.12), vec3(0.02, 0.15, 0.05), l.y), mix(vec3(0.05, 0.12, 0.3), vec3(0.02, 0.04, 0.12), l.y)));
    const fg = select(kind.lessThan(1.5), vec3(0.02), vec3(0.9, 0.95, 0.9));
    const bx = floor(P.x.mul(9.0)).toVar();
    const hgt = add(0.12, mul(0.22, sh1(bx.mul(3.7).add(1.0)))).toVar();
    If(kind.lessThan(1.5).and(abs(P.x).lessThan(0.3)), () => { hgt.mulAssign(add(0.25, mul(0.2, sh1(bx.mul(5.1))))); });
    const c = mix(bg, fg, step(l.y, hgt).mul(step(abs(P.x), aspect.mul(0.48)))).toVar();
    If(kind.lessThan(1.5), () => {
      const cap = step(length(P.sub(vec2(0.0, 0.7)).mul(vec2(1.0, 1.5))), 0.2);
      const stem = step(abs(P.x), add(0.05, mul(0.03, sub(0.62, l.y)))).mul(step(0.2, l.y)).mul(step(l.y, 0.62));
      c.assign(mix(c, mix(vec3(1.0, 0.45, 0.1), vec3(0.45, 0.4, 0.36), l.y), max(cap, stem).mul(add(0.85, mul(0.15, sin(uTime.mul(3.0)))))));
    }).ElseIf(kind.lessThan(2.5), () => {
      const ck = max(segLine(P, vec2(-0.16, 0.66), vec2(-0.05, 0.54), float(0.05)), segLine(P, vec2(-0.05, 0.54), vec2(0.2, 0.84), float(0.05)));
      c.assign(mix(c, vec3(1.0), ck));
    }).Else(() => {
      const body = step(length(P.sub(vec2(-0.05, 0.12)).mul(vec2(1.0, 3.2))), 0.32).add(step(length(P.sub(vec2(0.3, 0.13))), 0.07))
        .add(step(length(P.sub(vec2(-0.45, 0.08)).mul(vec2(1.0, 5.0))), 0.18));
      c.assign(mix(c, vec3(0.15, 0.17, 0.2), clamp(body, 0.0, 1.0)));
      const ck = max(segLine(P, vec2(0.18, 0.7), vec2(0.26, 0.62), float(0.035)), segLine(P, vec2(0.26, 0.62), vec2(0.42, 0.84), float(0.035)));
      c.assign(mix(c, vec3(0.3, 1.0, 0.4), ck));
    });
    return c;
  });
  // Red alert: a white warning triangle with a black "!" on a flashing red field (no text).
  const alertPict = Fn(([l, aspect]) => {
    const p = l.sub(0.5).mul(vec2(aspect, 1.0)).div(min(1.0, aspect)).toVar();
    const on = step(0.5, fract(uTime.mul(1.2)));
    const c = mix(vec3(0.35, 0.0, 0.0), vec3(1.0, 0.04, 0.02), on).toVar();
    const tri = step(-0.32, p.y).mul(step(p.y, 0.36)).mul(step(abs(p.x), sub(0.36, p.y).mul(0.62)));
    const inner = step(-0.25, p.y).mul(step(p.y, 0.25)).mul(step(abs(p.x), sub(0.25, p.y).mul(0.6))).toVar();
    const bang = step(abs(p.x), 0.033).mul(step(-0.06, p.y)).mul(step(p.y, 0.17)).add(step(length(p.sub(vec2(0.0, -0.15))), 0.042));
    c.assign(mix(c, vec3(1.0, 0.04, 0.02), tri));
    c.assign(mix(c, vec3(1.0, 0.95, 0.85), inner));
    c.assign(mix(c, vec3(0.02), inner.mul(min(1.0, bang))));
    return c;
  });
  const slide = (i, l) => {
    const colI = mod(i, 4.0), row = floor(i.div(4.0));
    const a = vec2(colI.mul(0.25), sub(1.0, add(1536.0, row.add(1.0).mul(256.0)).div(2048.0)));
    return uAtlas.t.sample(a.add(l.mul(vec2(0.25, 0.125)).mul(0.994)).add(vec2(0.25, 0.125).mul(0.003))).rgb;
  };
  // A slide show's slot: slots 2 and 6 show a city news card when there are some (two across, four down).
  const slideOr = (i, l, seed) => {
    const k = mod(floor(seed.mul(13.0)).add(i.mul(0.5)).add(floor(uTime.div(64.0))), max(uCards.x, 1.0));
    const colK = mod(k, 2.0), row = floor(k.div(2.0));
    const q = clamp(l, 0.004, 0.996);
    const card = uCardTex.t.sample(vec2(colK.add(q.x).mul(0.5), sub(1.0, row.add(1.0).sub(q.y).mul(0.25)))).rgb;
    return select(uCards.x.greaterThan(0.5).and(i.equal(2.0).or(i.equal(6.0))), card, slide(i, l));
  };
  return { countPict, feedPict, newsPict, alertPict, slideOr };
}

export function createSignNodeMaterial(u: Record<string, U>): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ color: 0xffffff });
  const uTime = shared(u.uTime), uNight = shared(u.uNight), uAlert = shared(u.uAlert), uCount = shared(u.uCount), uCountOn = shared(u.uCountOn);
  const uFeedAt = shared(u.uFeedAt), uNews = shared(u.uNews), uCards = shared(u.uCards);
  const uAtlas = followTex(u.uAtlas), uFeed = followTex(u.uFeed), uCardTex = followTex(u.uCardTex);
  const IM = instanceMatrixNode();
  const iSign = attribute('iSign', 'vec4');
  const vL = attribute('sUv', 'vec2'), vRect = attribute('iRect', 'vec4'), vSign = iSign;
  const wc = modelWorldMatrix.mul(col(IM, 3)).xyz;
  const vAlert = varying(uAlert.w.mul(step(distance(wc.xz, uAlert.xy), uAlert.z)), 'vAlert');
  const vCount = varying(uCountOn.mul(step(distance(wc.xz, uCount.xy), uCount.z)), 'vCount');
  // The big billboards (slide shows) carry the live feed near the player, and the news (most of them).
  const bill = step(2.5, iSign.x).mul(step(iSign.x, 3.5));
  const vFeed = varying(bill.mul(uFeedAt.w).mul(step(distance(wc.xz, uFeedAt.xy), uFeedAt.z)), 'vFeed');
  const vNews = varying(bill.mul(uNews.y).mul(step(iSign.y, 0.7)), 'vNews');
  const F = signFns(uTime, uFeed, uAtlas, uCardTex, uCards);

  const sign = Fn(() => {
    uAtlas.sync(); uFeed.sync(); uCardTex.sync();
    const mode = int(vSign.x.add(0.5)).toVar();
    const seed = vSign.y.toVar(), state = vSign.z.toVar();
    const l = vec2(vL).toVar();
    If(mode.equal(1), () => { l.assign(vec2(fract(l.x.add(uTime.mul(0.07)).add(seed)), l.y)); });
    const c = uAtlas.t.sample(mix(vRect.xy, vRect.zw, l)).rgb.toVar();
    If(mode.equal(2), () => { // a light sweep across every few seconds
      const p = fract(uTime.mul(0.12).add(seed)).mul(3.0).sub(1.0);
      c.mulAssign(add(1.0, mul(0.9, smoothstep(0.12, 0.0, abs(l.x.add(l.y.mul(0.25)).sub(p))))));
    }).ElseIf(mode.equal(3), () => { // slide show with a wipe
      const tt = uTime.div(8.0).add(seed.mul(8.0)).toVar();
      const i0 = mod(floor(tt), 8.0).toVar(), i1 = mod(i0.add(1.0), 8.0).toVar();
      const w = smoothstep(0.92, 1.0, fract(tt));
      c.assign(mix(F.slideOr(i0, l, seed), F.slideOr(i1, l, seed), step(l.x, w)));
      c.mulAssign(add(0.9, mul(0.1, sin(l.x.mul(6.0).sub(uTime.mul(0.7)).add(l.y.mul(3.0))))));
    }).ElseIf(mode.equal(4), () => { // letters light up top to bottom, then all blink
      const p = fract(uTime.mul(0.22).add(seed)).mul(1.4).toVar();
      c.mulAssign(select(p.lessThan(1.0), mix(0.25, 1.0, step(sub(1.0, l.y), p)), add(0.6, mul(0.4, step(0.5, fract(p.mul(20.0)))))));
    });
    // LED pixels and a faint refresh band.
    const cnt = vec2(vSign.w, vSign.w.mul(vRect.w.sub(vRect.y)).div(vRect.z.sub(vRect.x))).toVar();
    const px = abs(fract(vL.mul(cnt)).sub(0.5));
    const aa = clamp(sub(1.0, max(fwidth(vL.x.mul(cnt.x)), fwidth(vL.y.mul(cnt.y))).mul(1.5)), 0.0, 1.0); // no moiré far away
    c.mulAssign(sub(1.0, mul(0.18, aa).mul(sub(1.0, smoothstep(0.5, 0.3, max(px.x, px.y))))));
    c.mulAssign(add(0.97, mul(0.03, sin(vL.y.mul(40.0).sub(uTime.mul(9.0))))));
    If(state.lessThan(0.75), () => { // damaged: drop-outs, a torn colour band
      const n = sh1(floor(uTime.mul(14.0)).add(seed.mul(91.0))).toVar();
      c.mulAssign(select(n.lessThan(0.35), 0.05, select(n.lessThan(0.5), 0.5, 1.0)));
      If(abs(vL.y.sub(fract(uTime.mul(0.5).add(seed)))).lessThan(0.06), () => { c.assign(c.gbr.mul(1.4)); });
    });
    const asp = vRect.z.sub(vRect.x).div(max(1e-4, vRect.w.sub(vRect.y))).toVar();
    If(vNews.greaterThan(0.0).and(state.greaterThan(0.25)), () => { c.assign(mix(c, F.newsPict(vL, asp, uNews.x), vNews)); });
    If(vAlert.greaterThan(0.0).and(state.greaterThan(0.25)), () => { c.assign(mix(c, F.alertPict(vL, asp), vAlert)); });
    If(vFeed.greaterThan(0.0).and(state.greaterThan(0.25)), () => { c.assign(mix(c, F.feedPict(vL, asp), vFeed)); });
    If(vCount.greaterThan(0.0).and(state.greaterThan(0.25)), () => { c.assign(mix(c, F.countPict(vL, asp, uCount.w), vCount)); });
    return c.mul(mix(1.15, 2.7, uNight));
  });
  const S = sign().toVar('signC');
  setDiffuse(m, () => S);
  return m;
}

// ---------------------------------------------------------------- kiosk holograms

export function createHoloNodeMaterial(u: Record<string, U>): THREE.NodeMaterial {
  const uTime = shared(u.uTime), uNight = shared(u.uNight);
  const uAtlas = followTex(u.uAtlas);
  const IM = instanceMatrixNode();
  const iSign = attribute('iSign', 'vec4');
  const vL = attribute('sUv', 'vec2'), vRect = attribute('iRect', 'vec4'), vSign = iSign;
  const vertex = Fn(() => {
    // Cylindrical billboard: always turned to the camera, upright, with a slow hover.
    const cW = modelWorldMatrix.mul(col(IM, 3)).xyz.toVar();
    const R = camR();
    const rt = normalize(vec3(R.x, 0.0, R.z).add(1e-5));
    const sx = length(col(IM, 0).xyz), sy = length(col(IM, 1).xyz);
    cW.addAssign(vec3(0.0, mul(0.04, sin(uTime.mul(1.3).add(iSign.y.mul(20.0)))), 0.0));
    const t = positionGeometry;
    return cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(cW.add(rt.mul(t.x).mul(sx)).add(vec3(0.0, t.y.mul(sy), 0.0)), 1.0));
  })();
  const fragment = Fn(() => {
    uAtlas.sync();
    const l = vec2(vL).toVar();
    const g = step(0.985, fract(uTime.mul(0.13).add(vSign.y))); // rare glitch: a sideways jump
    l.assign(vec2(l.x.add(g.mul(0.04).mul(sin(l.y.mul(80.0)))), l.y));
    const c = uAtlas.t.sample(mix(vRect.xy, vRect.zw, clamp(l, 0.0, 1.0))).rgb.toVar();
    const lum = max(c.r, max(c.g, c.b));
    const scan = add(0.6, mul(0.4, smoothstep(0.3, 0.7, fract(l.y.mul(60.0).sub(uTime.mul(2.0))))));
    const band = add(1.0, mul(0.8, smoothstep(0.05, 0.0, abs(fract(uTime.mul(0.35).add(vSign.y)).sub(l.y)))));
    const fade = smoothstep(0.0, 0.18, l.y).mul(smoothstep(1.0, 0.9, l.y));
    const tint = vec3(0.35, 0.85, 1.0);
    const beam = sub(1.0, abs(l.x.mul(2.0).sub(1.0))).toVar();
    return vec4(tint.mul(lum.mul(scan).mul(band).add(mul(0.04, beam.mul(beam)).mul(sub(1.0, l.y)))).mul(fade).mul(mix(0.9, 1.8, uNight)), 1.0);
  })();
  return shaderLike({ vertex, fragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
}

