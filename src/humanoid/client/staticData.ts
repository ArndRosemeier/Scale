/**
 * Shared, appearance-independent GPU data derived once from the human
 * assets: UVs, skin weights, index buffers (full + LODs), per-vertex skin
 * masks (lips, cheeks, eye sockets...), face coordinates for painted
 * features (brows, stubble, scalp, warpaint), body regions for garment
 * fitting, and the facial expression texture.
 *
 * Every character's BufferGeometry references these same attribute objects,
 * so they are uploaded to the GPU once no matter how many characters exist.
 */
import * as THREE from 'three';
import type { HumanAssets } from '../assets';
import { targetMask } from '../bodyBuild';
import type { BodyRegion } from '../../items/wearable';
import { smoothstep as smooth, v3cross, v3scale, type Vec3 } from '../../core/math';

export const BODY_REGIONS: BodyRegion[] = [
  'scalp', 'face', 'neck', 'chest', 'belly', 'back', 'pelvis', 'buttocks',
  'upperarm.L', 'upperarm.R', 'forearm.L', 'forearm.R', 'hand.L', 'hand.R',
  'thigh.L', 'thigh.R', 'shin.L', 'shin.R', 'foot.L', 'foot.R',
];

export interface HumanStatic {
  assets: HumanAssets;
  renderVerts: number;
  /** Render-vertex count of the body (prefix of the render vertices). */
  bodyVerts: number;
  uv: THREE.BufferAttribute;
  skinIndex: THREE.BufferAttribute;
  skinWeight: THREE.BufferAttribute;
  maskA: THREE.BufferAttribute;
  maskB: THREE.BufferAttribute;
  face: THREE.BufferAttribute;
  expr: THREE.BufferAttribute;
  lashUv: THREE.BufferAttribute;
  index: { body: Uint16Array; tongue: Uint16Array; teeth: Uint16Array; lashes: Uint16Array };
  /** Shared index attributes (full body, LOD1, LOD2). */
  bodyIndex: THREE.BufferAttribute[];
  tongueIndex: THREE.BufferAttribute;
  teethIndex: THREE.BufferAttribute;
  lashIndex: THREE.BufferAttribute;
  /** Body region (index into BODY_REGIONS) and position along the limb (0 proximal..1 distal), per render vertex. */
  region: Uint8Array;
  regionT: Float32Array;
  /** Expression units texture (width = face verts, height = units). */
  exprTex: THREE.DataTexture;
  exprNames: string[];
  /** Neutral-mesh inter-pupil distance (m), face coordinate unit. */
  ipd: number;
}

let staticCache: HumanStatic | null = null;

export function getHumanStatic(as: HumanAssets): HumanStatic {
  if (staticCache && staticCache.assets === as) return staticCache;
  const m = as.manifest;
  const RV = m.renderVerts;
  const src = as.renderSrc;
  const base = as.basePos;
  const bone = (n: string) => as.boneByName.get(n)!;
  const BODY = m.groups.tongue[0];

  // ---- skin attributes (render-expanded)
  const si = new Uint16Array(RV * 4), sw = new Uint8Array(RV * 4);
  for (let r = 0; r < RV; r++) for (let k = 0; k < 4; k++) {
    si[r * 4 + k] = as.skinIdx[src[r] * 4 + k];
    sw[r * 4 + k] = as.skinW[src[r] * 4 + k];
  }

  // ---- face frame from the neutral mesh
  const eyeC = (g: [number, number]) => {
    let x = 0, y = 0, z = 0;
    for (let v = g[0]; v < g[0] + g[1]; v++) { x += base[v * 3]; y += base[v * 3 + 1]; z += base[v * 3 + 2]; }
    return [x / g[1], y / g[1], z / g[1]];
  };
  const eL = eyeC(m.groups.eyeL), eR = eyeC(m.groups.eyeR);
  const c = [(eL[0] + eR[0]) / 2, (eL[1] + eR[1]) / 2, (eL[2] + eR[2]) / 2];
  const ipd = Math.hypot(eL[0] - eR[0], eL[1] - eR[1], eL[2] - eR[2]);

  // ---- masks from target magnitudes (morph space)
  const N = m.morphVerts;
  const mx = (...names: string[]) => {
    const out = new Float32Array(N);
    for (const n of names) { const t = targetMask(as, n); for (let i = 0; i < N; i++) out[i] = Math.max(out[i], t[i]); }
    return out;
  };
  const lips = mx('mouth-upperlip-volume-incr', 'mouth-lowerlip-volume-incr');
  const cheeks = mx('l-cheek-volume-incr', 'r-cheek-volume-incr');
  const socket = mx('l-eye-bag-incr', 'r-eye-bag-incr', 'l-eye-eyefold-down', 'r-eye-eyefold-down');
  const nose = mx('nose-scale-depth-incr', 'nose-point-width-incr');
  const ears = mx('l-ear-scale-incr', 'r-ear-scale-incr');
  const age = mx('head-age-incr');
  const laugh = mx('mouth-laugh-lines-out');

  // Nails: dorsal side of the last finger segments.
  const nails = new Float32Array(N);
  for (const s of ['L', 'R']) {
    for (let f = 1; f <= 5; f++) {
      const b = m.bones[bone(`finger${f}-3.${s}`)];
      const bi = bone(`finger${f}-3.${s}`);
      const h = [base[b.head * 3], base[b.head * 3 + 1], base[b.head * 3 + 2]];
      const t = [base[b.tail * 3], base[b.tail * 3 + 1], base[b.tail * 3 + 2]];
      const ax = [t[0] - h[0], t[1] - h[1], t[2] - h[2]];
      const al = Math.hypot(ax[0], ax[1], ax[2]) || 1;
      // Dorsal direction ≈ hand dorsal from the wrist frame.
      const w = m.bones[bone(`wrist.${s}`)];
      const wh = [base[w.head * 3], base[w.head * 3 + 1], base[w.head * 3 + 2]];
      const f3 = m.bones[bone(`finger3-1.${s}`)], i2 = m.bones[bone(`finger2-1.${s}`)], p5 = m.bones[bone(`finger5-1.${s}`)];
      const fd: Vec3 = [base[f3.head * 3] - wh[0], base[f3.head * 3 + 1] - wh[1], base[f3.head * 3 + 2] - wh[2]];
      const ac: Vec3 = [base[i2.head * 3] - base[p5.head * 3], base[i2.head * 3 + 1] - base[p5.head * 3 + 1], base[i2.head * 3 + 2] - base[p5.head * 3 + 2]];
      const sg = s === 'L' ? -1 : 1;
      const dz = v3scale(v3cross(fd, ac), sg);
      const dl = Math.hypot(dz[0], dz[1], dz[2]) || 1;
      for (let v = 0; v < BODY; v++) {
        let wgt = 0;
        for (let k = 0; k < 4; k++) if (as.skinIdx[v * 4 + k] === bi) wgt += as.skinW[v * 4 + k] / 255;
        if (wgt < 0.5) continue;
        const r = [base[v * 3] - h[0], base[v * 3 + 1] - h[1], base[v * 3 + 2] - h[2]];
        const tt = (r[0] * ax[0] + r[1] * ax[1] + r[2] * ax[2]) / (al * al);
        const nrm = (r[0] * dz[0] + r[1] * dz[1] + r[2] * dz[2]) / dl;
        if (tt > 0.35 && nrm > 0) nails[v] = Math.max(nails[v], smooth(0.35, 0.55, tt) * smooth(0.0, 0.004, nrm));
      }
    }
  }

  // Lid line: around each eye, the innermost skin seen from the front in every direction (the
  // lid rim where the lashes grow), strong on the upper lid, faint below. Kept in the nails channel: the
  // two never meet (the shader tells them apart by face height).
  const lid = new Float32Array(N);
  for (const g of [m.groups.eyeL, m.groups.eyeR]) {
    const ec = eyeC(g);
    const BINS = 32;
    const near: [number, number, number][] = []; // vertex, bin, distance from the eye's centre (front view)
    const binMin = new Float32Array(BINS).fill(Infinity);
    for (let v = 0; v < BODY; v++) {
      const x = base[v * 3], y = base[v * 3 + 1], z = base[v * 3 + 2];
      if (z > ec[2] || Math.hypot(x - ec[0], y - ec[1], z - ec[2]) > 0.03) continue;
      const best = Math.hypot(x - ec[0], y - ec[1]);
      const bin = Math.floor(((Math.atan2(y - ec[1], x - ec[0]) / Math.PI + 1) / 2) * BINS) % BINS;
      near.push([v, bin, best]);
      binMin[bin] = Math.min(binMin[bin], best);
    }
    for (const [v, bin, d] of near) {
      const w = 1 - smooth(0.001, 0.0035, d - binMin[bin]);
      lid[v] = Math.max(lid[v], w * (base[v * 3 + 1] > ec[1] - 0.002 ? 1 : 0.25));
    }
  }

  const maskA = new Uint8Array(RV * 4), maskB = new Uint8Array(RV * 4);
  const face = new Float32Array(RV * 3);
  const q = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  for (let r = 0; r < RV; r++) {
    const v = src[r];
    maskA[r * 4] = q(smooth(0.22, 0.55, lips[v]));
    maskA[r * 4 + 1] = q(smooth(0.1, 0.7, cheeks[v]));
    maskA[r * 4 + 2] = q(smooth(0.15, 0.7, socket[v]));
    maskA[r * 4 + 3] = q(smooth(0.2, 0.8, nose[v]));
    maskB[r * 4] = q(smooth(0.05, 0.5, ears[v]));
    maskB[r * 4 + 1] = q(smooth(0.1, 0.8, age[v]));
    maskB[r * 4 + 2] = q(smooth(0.15, 0.7, laugh[v]));
    maskB[r * 4 + 3] = q(Math.max(nails[v], lid[v]));
    // Face coordinates in inter-pupil units: x lateral (character's right = +), y up, z forward.
    face[r * 3] = (base[v * 3] - c[0]) / ipd;
    face[r * 3 + 1] = (base[v * 3 + 1] - c[1]) / ipd;
    face[r * 3 + 2] = (c[2] - base[v * 3 + 2]) / ipd;
  }

  // ---- expression units → texture
  const F = m.expressions.faceVerts, U = m.expressions.names.length;
  const texData = new Float32Array(F * U * 4);
  for (let u = 0; u < U; u++) for (let i = 0; i < F; i++) {
    const s = (u * F + i) * 3, d = (u * F + i) * 4;
    texData[d] = as.exprDelta[s] * m.expressions.scale;
    texData[d + 1] = as.exprDelta[s + 1] * m.expressions.scale;
    texData[d + 2] = as.exprDelta[s + 2] * m.expressions.scale;
  }
  const exprTex = new THREE.DataTexture(texData, F, U, THREE.RGBAFormat, THREE.FloatType);
  exprTex.minFilter = exprTex.magFilter = THREE.NearestFilter;
  exprTex.needsUpdate = true;
  const morphToFace = new Int32Array(N).fill(-1);
  for (let i = 0; i < F; i++) morphToFace[as.exprVerts[i]] = i;
  const expr = new Float32Array(RV);
  for (let r = 0; r < RV; r++) expr[r] = morphToFace[src[r]];

  // ---- eyelash card coordinates: u along the lid, v root→tip
  const lashUv = new Float32Array(RV * 2);
  {
    const [ls, lc] = m.groups.lashes;
    for (let r = 0; r < RV; r++) {
      const v = src[r];
      if (v < ls || v >= ls + lc) continue;
      // Distance to the nearest eyelid (body) vertex decides root vs tip.
      let best = Infinity;
      const x = base[v * 3], y = base[v * 3 + 1], z = base[v * 3 + 2];
      const side = x < c[0] ? -1 : 1;
      const ec = side < 0 ? (eL[0] < eR[0] ? eL : eR) : (eL[0] < eR[0] ? eR : eL);
      for (let b = 0; b < BODY; b++) {
        const dx = base[b * 3] - x, dy = base[b * 3 + 1] - y, dz = base[b * 3 + 2] - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) best = d;
      }
      const dist = Math.sqrt(best);
      lashUv[r * 2] = Math.atan2(y - ec[1], (x - ec[0]) * side) / Math.PI;
      lashUv[r * 2 + 1] = smooth(0.0005, 0.005, dist);
    }
  }

  // ---- body regions per render vertex
  const region = new Uint8Array(RV);
  const regionT = new Float32Array(RV);
  const H = (n: string) => { const b = m.bones[bone(n)]; return [base[b.head * 3], base[b.head * 3 + 1], base[b.head * 3 + 2]]; };
  const T = (n: string) => { const b = m.bones[bone(n)]; return [base[b.tail * 3], base[b.tail * 3 + 1], base[b.tail * 3 + 2]]; };
  const along = (p: number[], a: number[], b: number[]) => {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1;
    return Math.min(1, Math.max(0, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / l2));
  };
  const R = (n: BodyRegion) => BODY_REGIONS.indexOf(n);
  const boneRegion: (number | null)[] = m.bones.map(() => null);
  const spineZ = H('spine03')[2];
  const waistY = H('spine04')[1], neckY = H('neck01')[1], hipY = H('upperleg01.L')[1];
  for (let r = 0; r < RV; r++) {
    const v = src[r];
    const p = [base[v * 3], base[v * 3 + 1], base[v * 3 + 2]];
    // Dominant bone (largest weight).
    const rsi = as.regionSkinIdx, rsw = as.regionSkinW;
    let bb = rsi[v * 4], bw = rsw[v * 4];
    for (let k = 1; k < 4; k++) if (rsw[v * 4 + k] > bw) { bw = rsw[v * 4 + k]; bb = rsi[v * 4 + k]; }
    const name = m.bones[bb].name;
    const side = name.endsWith('.L') ? 'L' : name.endsWith('.R') ? 'R' : '';
    let reg: BodyRegion, t = 0;
    const fy = face[r * 3 + 1], fz = face[r * 3 + 2], fx = face[r * 3];
    if (name === 'head' || name === 'jaw') {
      const scalp = fy > 1.0 + 0.25 * fx * fx || (fz < -0.35 && fy > -0.2) || (fz < -1.0);
      reg = scalp ? 'scalp' : 'face';
      t = smooth(-2, 2.5, fy);
    } else if (/^neck/.test(name)) { reg = 'neck'; t = along(p, H('neck01'), H('head')); }
    else if (/^(spine01|spine02|clavicle)/.test(name)) { reg = p[2] < spineZ ? 'chest' : 'back'; t = smooth(waistY, neckY, p[1]); }
    else if (/^(spine03|spine04)/.test(name)) { reg = p[2] < spineZ ? 'belly' : 'back'; t = smooth(waistY, neckY, p[1]); }
    else if (/^(spine05|root|pelvis)/.test(name)) { reg = p[2] < spineZ ? 'pelvis' : (p[1] < waistY ? 'buttocks' : 'back'); t = smooth(hipY - 0.1, waistY, p[1]); }
    else if (/^(shoulder01|upperarm)/.test(name)) { reg = `upperarm.${side}` as BodyRegion; t = along(p, H(`upperarm01.${side}`), H(`lowerarm01.${side}`)); }
    else if (/^lowerarm/.test(name)) { reg = `forearm.${side}` as BodyRegion; t = along(p, H(`lowerarm01.${side}`), H(`wrist.${side}`)); }
    else if (/^(wrist|finger)/.test(name)) { reg = `hand.${side}` as BodyRegion; t = along(p, H(`wrist.${side}`), T(`finger3-3.${side}`)); }
    else if (/^upperleg/.test(name)) { reg = `thigh.${side}` as BodyRegion; t = along(p, H(`upperleg01.${side}`), H(`lowerleg01.${side}`)); }
    else if (/^lowerleg/.test(name)) { reg = `shin.${side}` as BodyRegion; t = along(p, H(`lowerleg01.${side}`), H(`foot.${side}`)); }
    else if (/^(foot|toes)/.test(name)) { reg = `foot.${side}` as BodyRegion; t = along(p, H(`foot.${side}`), T(`toes.${side}`)); }
    else reg = 'chest';
    region[r] = R(reg);
    regionT[r] = t;
    boneRegion[bb] ??= R(reg);
  }

  const idxOf = (n: 'body' | 'tongue' | 'teeth' | 'lashes') => {
    const s = m.submeshes.find((x) => x.name === n)!;
    return as.index.subarray(s.start, s.start + s.count);
  };
  const index = { body: idxOf('body'), tongue: idxOf('tongue'), teeth: idxOf('teeth'), lashes: idxOf('lashes') };
  const bodyIndex = [new THREE.BufferAttribute(index.body, 1), ...m.lods.map((l) => new THREE.BufferAttribute(as.lodIndex.subarray(l.start, l.start + l.count), 1))];
  let bodyVerts = 0;
  for (const i of index.body) bodyVerts = Math.max(bodyVerts, i + 1);

  staticCache = {
    assets: as,
    renderVerts: RV,
    bodyVerts,
    uv: new THREE.BufferAttribute(as.renderUV, 2),
    skinIndex: new THREE.Uint16BufferAttribute(si, 4),
    skinWeight: new THREE.Uint8BufferAttribute(sw, 4, true),
    maskA: new THREE.Uint8BufferAttribute(maskA, 4, true),
    maskB: new THREE.Uint8BufferAttribute(maskB, 4, true),
    face: new THREE.BufferAttribute(face, 3),
    expr: new THREE.BufferAttribute(expr, 1),
    lashUv: new THREE.BufferAttribute(lashUv, 2),
    index,
    bodyIndex,
    tongueIndex: new THREE.BufferAttribute(index.tongue, 1),
    teethIndex: new THREE.BufferAttribute(index.teeth, 1),
    lashIndex: new THREE.BufferAttribute(index.lashes, 1),
    region,
    regionT,
    exprTex,
    exprNames: m.expressions.names,
    ipd,
  };
  return staticCache;
}
