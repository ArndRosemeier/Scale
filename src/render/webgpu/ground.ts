// @ts-nocheck -- three's TSL typings infer swizzles and vector widths poorly; checked by rendering (docs/WEBGPU_PLAN.md).
/**
 * Ground materials (render/materials/ground.ts) as node materials: urban surfaces, natural
 * terrain with the countryside land use, and water.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, float, int, uint, bool, vec2, vec3, vec4, mix, normalize, min, max, abs, fract, floor, fwidth, length, smoothstep, sub, add, mul,
  dot, sin, clamp, pow, select, If, Loop, Break, attribute, texture, uniformArray, uniform, positionWorld, positionView, cameraPosition,
  normalView, normalWorldGeometry, Discard, diffuseColor, cameraViewMatrix, struct,
} from 'three/tsl';
import type { MaterialArrays } from '../TextureLibrary';
import { terrainHoles } from '../materials/ground';
import type { ParcelParams } from '../../world/landuse';
import { WARP_K1, WARP_K2 } from '../../world/landuse';
import { fbm2, vnoise, perturbNormalUV, GN, shared } from './common';

/** Sets the diffuse colour without colorNode (the shadow pass would evaluate colorNode). */
export function setDiffuse(mat: THREE.NodeMaterial, node: () => unknown): void {
  const base = mat.setupDiffuseColor;
  mat.setupDiffuseColor = function (builder) {
    base.call(this, builder);
    diffuseColor.assign(vec4(node(), diffuseColor.a));
  };
}

/** The scene's fog colour (stands in for the sky in the wet sheen). */
let fogCol: ReturnType<typeof uniform> | null = null;
function fogColor() {
  if (!fogCol) {
    const c = new THREE.Color();
    fogCol = uniform(c).onRenderUpdate((frame) => { const f = frame.scene?.fog; if (f) c.copy(f.color); return c; });
  }
  return fogCol;
}

const GroundSurf = struct({ alb: 'vec3', rough: 'float', pud: 'float', tuv: 'vec2', tn: 'vec2' }, 'GroundSurf');
const TerrainSurf = struct({ albedo: 'vec3', rough: 'float', tn: 'vec2', tuv: 'vec2' }, 'TerrainSurf');

function tiles(arrays: MaterialArrays) {
  return uniformArray(arrays.tileMeters.slice(0, 16).concat(new Array(Math.max(0, 16 - arrays.tileMeters.length)).fill(2)), 'float');
}

let holes: { A: unknown; B: unknown; N: unknown; under: unknown } | null = null;
function holeNodes() {
  if (!holes) holes = {
    A: uniformArray(terrainHoles.uHoleA.value, 'vec4'),
    B: uniformArray(terrainHoles.uHoleB.value, 'vec4'),
    N: shared(terrainHoles.uHoleN),
    under: shared(terrainHoles.uUnder),
  };
  return holes;
}

/** Discards inside open manholes and metro entrances. */
const cutHoles = (hp) => {
  const H = holeNodes();
  Loop(16, ({ i }) => {
    If(i.greaterThanEqual(int(H.N)), () => { Break(); });
    const a = H.A.element(i), b = H.B.element(i);
    const hd = hp.sub(a.xy);
    const hu = dot(hd, a.zw), hv = hd.x.negate().mul(a.w).add(hd.y.mul(a.z));
    const inside = select(b.y.lessThan(0.0), dot(hd, hd).lessThan(b.x.mul(b.x)), abs(hu).lessThan(b.y).and(abs(hv).lessThan(b.x)));
    If(inside, () => { Discard(); });
  });
};

export function createGroundNodeMaterial(arrays: MaterialArrays): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const uTile = tiles(arrays);
  const { uWet } = GN;
  const vMUv = attribute('uv', 'vec2');
  const vLayer = attribute('aLayer', 'float');

  const S = Fn(() => {
    cutHoles(positionWorld.xz);
    const layer = int(vLayer.add(0.5)).toVar();
    const tuv = vMUv.div(uTile.element(layer)).toVar();
    const ar = texture(arrays.albedo, tuv).depth(layer).toVar();
    const nh = texture(arrays.normal, tuv).depth(layer).toVar();
    const macroV = fbm2(vMUv.mul(0.035));
    const alb = ar.rgb.mul(mix(0.86, 1.1, macroV)).toVar();
    If(layer.equal(3), () => { alb.mulAssign(mix(vec3(0.92, 0.95, 0.85), vec3(1.05, 1.0, 1.02), fbm2(vMUv.mul(0.11)))); });
    alb.mulAssign(mix(1.0, nh.a, 0.85));
    const rough = ar.a.toVar();
    const pud = float(0).toVar();
    If(uWet.greaterThan(0.001), () => {
      // Wet: darker and glossier (hard surfaces more than grass, gravel and dirt); puddles in the
      // hollows of the paving and in large shallow dips once it is properly wet.
      const hard = layer.notEqual(3).and(layer.notEqual(6)).and(layer.notEqual(11));
      const dip = fbm2(vMUv.mul(0.21).add(7.3)).add(sub(1.0, nh.a).mul(0.35));
      pud.assign(select(hard, smoothstep(0.7, 0.76, dip.add(uWet.mul(0.2)).sub(0.14)).mul(smoothstep(0.45, 0.9, uWet)), 0.0));
      alb.mulAssign(mix(1.0, select(hard, 0.62, 0.78), uWet).mul(sub(1.0, mul(0.35, pud))));
      rough.assign(mix(rough, select(hard, rough.mul(0.38), rough.mul(0.8)), uWet));
      rough.assign(mix(rough, 0.06, pud));
    });
    return GroundSurf(alb, rough, pud, tuv, nh.xy.mul(2.0).sub(1.0));
  });
  const v = S().toVar('groundS');
  setDiffuse(mat, () => v.get('alb'));
  mat.roughnessNode = v.get('rough');
  mat.metalnessNode = float(0.0);
  mat.normalNode = perturbNormalUV(positionView, normalView, v.get('tuv'), v.get('tn'), sub(1.0, mul(0.9, v.get('pud'))));
  // Wet sheen: puddles (and a wet street, less) mirror the grey sky at grazing angles.
  mat.emissiveNode = Fn(() => {
    // (vars, so normalView is evaluated here and not first inside a branch)
    const nv = clamp(dot(normalView, normalize(positionView.negate())), 0.0, 1.0).toVar();
    const fres = pow(sub(1.0, nv), 4.0).toVar();
    return select(uWet.greaterThan(0.001), fogColor().mul(v.get('pud').mul(add(0.02, mul(0.3, fres))).add(uWet.mul(0.08).mul(fres))), vec3(0.0));
  })();
  return mat;
}

const srgb = (r: number, g: number, b: number) => vec3(...[r, g, b].map((c) => Math.pow(c, 2.2)));

/** The parcel layout (world/landuse PARCEL GLSL) with the seed's constants baked in. */
function parcelFns(P: ParcelParams) {
  const lb32 = Fn(([x0]) => {
    const x = uint(x0).toVar();
    x.bitXorAssign(x.shiftRight(16)); x.mulAssign(uint(0x7feb352d));
    x.bitXorAssign(x.shiftRight(15)); x.mulAssign(uint(0x846ca68b));
    x.bitXorAssign(x.shiftRight(16));
    return x;
  }, { x: 'uint', return: 'uint' });
  const hash2u = (seed, a, b) => lb32(uint(seed).bitXor(lb32(uint(a).mul(uint(0x27d4eb2d)).bitXor(lb32(uint(b).mul(uint(0x165667b1)))))));
  const u2f = (h) => float(h.shiftRight(8)).div(16777216.0);
  const PS = P.seed >>> 0;
  const SEED2 = (PS ^ 0x9e37) >>> 0;
  /** x = distance to its edge (m), y = id hash as float, z = row coordinate (m), w = rows along v (1) or u (0); and the crop. */
  const parcelAt = Fn(([p]) => {
    const q = p.add(vec2(sin(p.y.mul(WARP_K1).add(P.ph1)), sin(p.x.mul(WARP_K2).add(P.ph2))).mul(P.warp));
    const u = q.x.mul(P.cos).add(q.y.mul(P.sin)), v = q.x.negate().mul(P.sin).add(q.y.mul(P.cos));
    const vv = v.div(P.sv);
    const j = int(floor(vv)), fv = vv.sub(floor(vv));
    const off = u2f(hash2u(PS, int(7), j)).mul(P.su);
    const uu = u.add(off).div(P.su);
    const i = int(floor(uu)), fu = uu.sub(floor(uu));
    const h = hash2u(PS, i, j);
    const k = float(uint(1).add(h.mod(uint(3))));
    const fsk = fu.mul(k), si = floor(fsk), fs = fsk.sub(si);
    const id = hash2u(SEED2, i.mul(4).add(int(si)), j);
    const ci = int(id.mod(uint(16)));
    const crop = select(ci.lessThan(3), 0.0, select(ci.equal(3), 1.0, select(ci.lessThan(7), 2.0, select(ci.lessThan(9), 3.0,
      select(ci.lessThan(11), 4.0, select(ci.lessThan(14), 5.0, select(ci.equal(14), 6.0, 7.0)))))));
    const w = float(P.su).div(k);
    const border = min(min(fs, sub(1.0, fs)).mul(w), min(fv, sub(1.0, fv)).mul(P.sv));
    const alongV = w.lessThan(P.sv);
    return vec4(border, u2f(id), select(alongV, u, v), crop);
  }, { p: 'vec2', return: 'vec4' });
  return parcelAt;
}

const cropColor = (crop) => select(crop.lessThan(0.5), srgb(0.66, 0.56, 0.3), select(crop.lessThan(1.5), srgb(0.72, 0.66, 0.42), select(crop.lessThan(2.5), srgb(0.37, 0.49, 0.18),
  select(crop.lessThan(3.5), srgb(0.25, 0.37, 0.13), select(crop.lessThan(4.5), srgb(0.38, 0.29, 0.2), select(crop.lessThan(5.5), srgb(0.4, 0.5, 0.22),
    select(crop.lessThan(6.5), srgb(0.8, 0.74, 0.2), srgb(0.64, 0.58, 0.4))))))));
const cropCover = (crop) => select(crop.lessThan(0.5), 0.9, select(crop.lessThan(1.5), 0.88, select(crop.lessThan(2.5), 0.7, select(crop.lessThan(3.5), 0.6,
  select(crop.lessThan(4.5), 0.5, select(crop.lessThan(5.5), 1.0, select(crop.lessThan(6.5), 0.85, 0.8)))))));
const rowPeriod = (crop) => select(crop.lessThan(1.5), 0.17, select(crop.lessThan(2.5), 0.22, select(crop.lessThan(3.5), 0.75,
  select(crop.lessThan(4.5), 0.6, select(crop.lessThan(6.5), 0.35, 0.2)))));

export function createTerrainNodeMaterial(arrays: MaterialArrays, P: ParcelParams | null): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  const uTile = tiles(arrays);
  const { uWet } = GN;
  const H = holeNodes();
  const vMUv = attribute('uv', 'vec2');
  const parcelAt = P ? parcelFns(P) : null;
  const alb = (uv, l) => texture(arrays.albedo, uv).depth(l);
  const nrm = (uv, l) => texture(arrays.normal, uv).depth(l);

  const S = Fn(() => {
    // (vars: first evaluated here, not inside a branch)
    const wN = normalWorldGeometry.toVar();
    const wPos = positionWorld.toVar();
    // Skirts (vertical, the only faces with a level normal) are not drawn from below the ground.
    If(H.under.greaterThan(0.5).and(wN.y.lessThan(0.02)), () => { Discard(); });
    cutHoles(wPos.xz);
    const slope = sub(1.0, clamp(wN.y, 0.0, 1.0));
    const n = fbm2(vMUv.mul(0.02)).toVar();
    const tg = vMUv.div(uTile.element(3)).toVar(), td = vMUv.div(uTile.element(11)), tr = vMUv.div(uTile.element(12)), ts = vMUv.div(uTile.element(6));
    const g = alb(tg, 3).toVar(), d = alb(td, 11).toVar(), r = alb(tr, 12), sa = alb(ts, 6);
    const gn = nrm(tg, 3).toVar(), dn = nrm(td, 11).toVar(), rn = nrm(tr, 12), sn = nrm(ts, 6);
    const wDirt = smoothstep(0.12, 0.3, slope.add(n.sub(0.5).mul(0.25)));
    const wRock = smoothstep(0.38, 0.6, slope).toVar();
    const wSand = sub(1.0, smoothstep(0.6, 2.2, wPos.y));
    const a = mix(g, d, wDirt).toVar(); const nn = mix(gn, dn, wDirt).toVar();
    a.assign(mix(a, r, wRock)); nn.assign(mix(nn, rn, wRock));
    if (parcelAt) {
      const vLand = attribute('aLand', 'vec4');
      const rural = vLand.x.add(vLand.y).add(vLand.z).toVar();
      If(rural.greaterThanEqual(0.003), () => {
        const camD = length(wPos.sub(cameraPosition));
        const foot = length(fwidth(wPos.xz));
        const lumW = vec3(0.3, 0.59, 0.11);
        const gAvg = dot(texture(arrays.albedo, vec2(0.5)).depth(3).level(10).rgb, lumW);
        const dAvg = dot(texture(arrays.albedo, vec2(0.5)).depth(11).level(10).rgb, lumW);
        const far = smoothstep(25.0, 160.0, camD);
        const gDet = mix(clamp(dot(g.rgb, lumW).div(max(1e-4, gAvg)), 0.55, 1.5), 1.0, far);
        const dDet = mix(clamp(dot(d.rgb, lumW).div(max(1e-4, dAvg)), 0.55, 1.5), 1.0, far);
        const big = fbm2(wPos.xz.mul(0.0021).add(3.7)).toVar();
        // Meadow: the grass, lusher or drier in large patches; banks lush; a pasture green from afar.
        const meadow = mix(g.rgb.mul(mix(vec3(1.08, 1.02, 0.72), vec3(0.86, 1.08, 0.82), big)), srgb(0.4, 0.5, 0.22).mul(mix(0.88, 1.08, big)), smoothstep(40.0, 320.0, camD).mul(0.85)).toVar();
        const bank = meadow.mul(vec3(0.9, 1.04, 0.86));
        // Forest: litter and moss up close, canopy colour from afar.
        const moss = smoothstep(0.35, 0.65, fbm2(wPos.xz.mul(0.09).add(11.0)).add(n.sub(0.5).mul(0.4)));
        const floorC = mix(d.rgb.mul(vec3(0.6, 0.5, 0.38)), g.rgb.mul(vec3(0.62, 0.78, 0.42)), moss);
        const canopy = srgb(0.2, 0.29, 0.12).mul(mix(0.75, 1.2, fbm2(wPos.xz.mul(0.013)))).mul(mix(0.9, 1.08, big));
        const forest = mix(floorC, canopy, smoothstep(120.0, 700.0, camD));
        // Fields: the parcel patchwork, crop rows (fading out before they alias), tramlines, grass margins.
        const pc = parcelAt(wPos.xz).toVar();
        const crop = pc.w;
        const pasture = crop.greaterThan(4.5).and(crop.lessThan(5.5)), ploughed = crop.greaterThan(3.5).and(crop.lessThan(4.5));
        const cc = select(pasture, meadow.mul(mix(0.92, 1.1, pc.y)), cropColor(crop).mul(mix(0.86, 1.12, pc.y)).mul(mix(0.93, 1.05, big)));
        const soil = srgb(0.34, 0.27, 0.19).mul(dDet);
        const rowM = pc.z.div(rowPeriod(crop));
        const rows = sub(1.0, smoothstep(0.2, 0.55, fwidth(rowM)));
        const stripe = add(0.5, mul(0.5, sin(rowM.mul(6.2831853))));
        const cover = cropCover(crop);
        const soilShare = mix(sub(1.0, cover), mix(sub(1.0, cover), smoothstep(cover.sub(0.15), cover.add(0.15), stripe), 0.75), rows).toVar();
        const field = select(ploughed, cc.mul(dDet).mul(mix(1.0, add(0.78, mul(0.4, stripe)), rows)), mix(cc.mul(gDet), soil, soilShare)).toVar();
        If(pasture.not().and(ploughed.not()), () => {
          const tm = abs(fract(pc.z.div(18.0)).sub(0.5)).mul(18.0);
          const fwT = fwidth(pc.z);
          field.assign(mix(field, soil.mul(1.05), sub(1.0, smoothstep(0.35, add(0.35, fwT.mul(1.5)), tm)).mul(sub(1.0, smoothstep(0.3, 1.2, fwT))).mul(0.8)));
        });
        const fwB = fwidth(pc.x);
        field.assign(mix(field, meadow.mul(0.95), sub(1.0, smoothstep(1.1, add(1.1, fwB.mul(1.5)), pc.x)).mul(sub(1.0, smoothstep(2.0, 8.0, fwB)))));
        // Too far to resolve the parcels: their average colour.
        field.assign(mix(field, srgb(0.5, 0.52, 0.27).mul(mix(0.85, 1.1, big)), smoothstep(25.0, 70.0, foot)));
        const c = vLand.x.mul(forest).add(vLand.y.mul(field)).add(vLand.z.mul(meadow)).div(rural).toVar();
        c.assign(mix(c, bank, clamp(vLand.w.div(rural), 0.0, 1.0)));
        const wl = rural.mul(sub(1.0, wRock.mul(0.6)));
        a.assign(vec4(mix(a.rgb, c, wl), mix(a.a, 0.92, wl)));
        const soilN = vLand.y.mul(select(ploughed, 1.0, soilShare)).add(vLand.x.mul(0.4)).div(rural);
        nn.assign(mix(nn, mix(gn, dn, soilN), wl.mul(0.85)));
      });
    }
    a.assign(mix(a, sa.mul(vec4(1.15, 1.08, 0.9, 1.0)), wSand)); nn.assign(mix(nn, sn, wSand));
    const albedo = a.rgb.mul(mix(0.85, 1.1, n)).mul(mix(1.0, nn.a, 0.8)).mul(sub(1.0, mul(0.25, uWet)));
    return TerrainSurf(albedo, a.a.mul(sub(1.0, mul(0.25, uWet))), nn.xy.mul(2.0).sub(1.0), tg);
  });
  const v = S().toVar('terrainS');
  setDiffuse(mat, () => v.get('albedo'));
  mat.roughnessNode = v.get('rough');
  mat.metalnessNode = float(0.0);
  mat.normalNode = perturbNormalUV(positionView, normalView, v.get('tuv'), v.get('tn'), float(1.0));
  return mat;
}

/** Animated water: procedural normal waves, fresnel reflection of the environment, depth tint. */
export function createWaterNodeMaterial(murky = false): THREE.MeshPhysicalNodeMaterial {
  const mat = new THREE.MeshPhysicalNodeMaterial({
    color: 0x1d3b44, roughness: 0.06, metalness: 0.0, clearcoat: 0.0, envMapIntensity: 1.0,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const { uTime } = GN;
  const waveGrad = Fn(([p, t]) => {
    const g = vec2(0.0).toVar();
    const a = float(0.5).toVar();
    const dir = vec2(1.0, 0.3).toVar();
    const sc = float(0.35).toVar();
    Loop(5, ({ i }) => {
      const q = p.mul(sc).add(dir.mul(t).mul(add(0.6, mul(0.25, float(i)))));
      const e = 0.07;
      const h0 = vnoise(q), hx = vnoise(q.add(vec2(e, 0.0))), hz = vnoise(q.add(vec2(0.0, e)));
      g.addAssign(vec2(hx.sub(h0), hz.sub(h0)).div(e).mul(a));
      a.mulAssign(0.55);
      sc.mulAssign(1.9);
      dir.assign(vec2(dir.y, dir.x.negate()).mul(1.1));
    });
    return g;
  }, { p: 'vec2', t: 'float', return: 'vec2' });
  mat.normalNode = Fn(() => {
    const wg = waveGrad(positionWorld.xz, uTime).mul(0.16);
    const nW = normalize(vec3(wg.x.negate(), 1.0, wg.y.negate()));
    return normalize(cameraViewMatrix.mul(vec4(nW, 0.0)).xyz);
  })();
  const wp = positionWorld.xz;
  setDiffuse(mat, () => murky
    ? mix(vec3(0.045, 0.04, 0.025), vec3(0.08, 0.07, 0.04), fbm2(wp.mul(0.3).add(vec2(uTime.mul(0.4), 0.0))))
    : mix(vec3(0.05, 0.13, 0.14), vec3(0.11, 0.2, 0.2), fbm2(wp.mul(0.01))));
  return mat;
}
