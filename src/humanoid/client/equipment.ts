/**
 * Equipment fitting: turns `EquipmentVisuals` into geometry on a Character.
 *
 *  - Shell layers (soft garments): body render vertices of the requested
 *    regions/cuts are duplicated, pushed out along the normal by the layer
 *    offset (outer layers smoothed so cloth hides muscle and navel detail),
 *    and skinned with the body weights, so they deform perfectly with any body
 *    and animation. Body triangles under shells are removed from the body
 *    index buffer (no poke-through, no overdraw). Boundary vertices carry an
 *    edge attribute for trims. Skirts/robes hang from the hips as skinned
 *    cones blending pelvis and thighs; hoods are skinned caps over the head.
 *  - Rigid parts are built by the items module in socket space and parented
 *    to the character's sockets (BodyFit computed from the morphed body).
 *  - Held items (main/off hand) come from `buildItemObject`, gripped at the
 *    fist; one-handed weapons can be sheathed at the hip and two-handers /
 *    bows slung on the back while out of combat.
 *
 * Rebuilt only when the equipment set changes (keyed by def ids + seeds).
 */
import * as THREE from 'three';
import type { EquipmentVisuals, EquipSlot } from '../../items/types';
import type { BodyRegion, ShellLayer, ShellMaterial, RigidPart, WearableSpec, BodyFit } from '../../items/wearable';
import type { ItemVisual } from '../../items/types';
import { resolveWearable, buildItemObject, animateItem, setItemSkyVis, disposeItemObject, itemDef } from './wardrobe';
import { disposeOwn, type Character } from './Character';
import { BODY_REGIONS, type HumanStatic } from './staticData';
import { createGarmentMaterial } from './garmentMaterial';
import type { GripClass } from './anim/actions';
import type { SkyVisPatch } from '../../render/skyOcclusion';

/** Classify a held item for animation and carry poses. */
export function gripClassOf(defId: string | undefined, shape: string | undefined): GripClass {
  if (!defId && !shape) return 'none';
  const def = defId ? itemDef(defId) : undefined;
  const s = shape ?? def?.visual.shape ?? '';
  if (/^shield/.test(s)) return 'shield';
  if (/torch|lantern/.test(s) || def?.category === 'light') return 'torch';
  if (/^bow/.test(s)) return 'bow';
  if (/crossbow/.test(s)) return 'crossbow';
  if (/^staff/.test(s)) return 'staff';
  if (/wand/.test(s)) return 'wand';
  if (/^(spear|glaive|halberd|javelin)/.test(s)) return def?.twoHanded === false ? 'blade' : 'polearm';
  if (/^throw|sling/.test(s)) return 'thrown';
  if (def?.twoHanded || /great|maul|\.war$/.test(s)) return 'twohand';
  if (/^dagger|knife/.test(s)) return 'dagger';
  if (/^axe/.test(s)) return 'axe';
  if (/^(mace|hammer|flail|club)/.test(s)) return 'blunt';
  if (/^sword/.test(s)) return 'blade';
  if (def?.tool || /pick|shovel|sickle|rod|tool/.test(s)) return 'tool';
  if (def?.category === 'weapon') return 'blade';
  return 'item';
}

interface ShellBuild {
  mesh: THREE.SkinnedMesh;
  sky: SkyVisPatch;
}

const _v = new THREE.Vector3();

const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

type ShellParts = { P: number[]; N: number[]; UV: number[]; SI: number[]; SW: number[]; E: number[]; I: number[] };

/** A shoe's generated toe box, in the bind pose (sole frame of one foot). */
interface ToeCap {
  /** Heel point (x, z) and the horizontal foot direction. */
  back: [number, number]; dx: number; dz: number;
  /** Ball of the foot along the foot (m), toe box length beyond it. */
  s0: number; len: number;
  /** Rounded-box section: centre across / up and half extents. */
  cx: number; cy: number; a: number; b: number;
  /** Shell vertices of the forefoot and toes (skin weights for the cap). */
  ids: number[];
}

const SHOE_PW = 3.2; // superellipse exponent of the shoe section: boxy but rounded
const seNorm = (u: number, v: number) => Math.pow(Math.pow(Math.abs(u), SHOE_PW) + Math.pow(Math.abs(v), SHOE_PW), 1 / SHOE_PW);

/**
 * Turns the foot part of a shell into a shoe. The toes are too fine to reshape (their gaps fold
 * over when pressed onto a smooth surface), so the shell stops at the ball of the foot and a
 * generated toe box (`buildToeCap`) closes the front. Behind the ball, the cross-sections are
 * pressed out onto a rounded box (filled arch and instep hollows, flat sole), blended in from
 * mid-foot so ankle and heel keep following the body. Bind pose, so it fits any body.
 * Returns the shell vertices to drop (toes) and the toe boxes to add.
 */
function shapeShoe(st: HumanStatic, topo: ShellTopo, P: Float32Array, N: Float32Array): { drop: Uint8Array; caps: ToeCap[] } {
  const { src, idx, nbStart, nbList, edge, twins } = topo;
  const n = src.length;
  const drop = new Uint8Array(n);
  const caps: ToeCap[] = [];
  for (const side of ['L', 'R'] as const) {
    const reg = BODY_REGIONS.indexOf(`foot.${side}` as BodyRegion);
    const ids: number[] = [];
    for (let i = 0; i < n; i++) if (st.region[src[i]] === reg) ids.push(i);
    if (ids.length < 16) continue;
    const tOf = (i: number) => st.regionT[src[i]];
    // Foot axis (horizontal): heel/ankle centroid → toe-tip centroid.
    const cen = (lo: number, hi: number) => {
      let x = 0, z = 0, c = 0;
      for (const i of ids) { const t = tOf(i); if (t >= lo && t <= hi) { x += P[i * 3]; z += P[i * 3 + 2]; c++; } }
      return c ? [x / c, z / c] as [number, number] : null;
    };
    const back = cen(0, 0.2), tip = cen(0.85, 1);
    if (!back || !tip) continue;
    let dx = tip[0] - back[0], dz = tip[1] - back[1];
    const dl = Math.hypot(dx, dz);
    if (dl < 1e-4) continue;
    dx /= dl; dz /= dl;
    // Local frame: s along the foot, x across (side), y up.
    const S = (i: number) => (P[i * 3] - back[0]) * dx + (P[i * 3 + 2] - back[1]) * dz;
    const X = (i: number) => (P[i * 3] - back[0]) * dz - (P[i * 3 + 2] - back[1]) * dx;
    // Cross-section of the forefoot (ball of the foot): bounds of the layer around t 0.5..0.68.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, s0 = 0, c0 = 0, sMax = -Infinity;
    for (const i of ids) {
      const t = tOf(i), s = S(i);
      sMax = Math.max(sMax, s);
      if (t < 0.5 || t > 0.68) continue;
      const x = X(i), y = P[i * 3 + 1];
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      s0 += s; c0++;
    }
    if (!c0 || x1 <= x0 || y1 <= y0) continue;
    s0 /= c0;
    const cx = (x0 + x1) / 2, a = (x1 - x0) / 2 * 1.04;
    // Sole stays where the foot's sole is; the toe box gets a little extra room on top.
    const b = (y1 - y0) / 2 * 1.08, cy = y0 + b;
    const w = new Float32Array(n);
    const capIds: number[] = [];
    for (const i of ids) {
      if (tOf(i) > 0.45) capIds.push(i);
      if (S(i) > s0) drop[i] = 1;
      else w[i] = smoothstep(0.3, 0.5, tOf(i));
    }
    caps.push({ back, dx, dz, s0, len: Math.max(0.02, (sMax - s0) * 1.06), cx, cy, a, b, ids: capIds });
    // Rounded-box section; behind the ball the foot is taller (instep): never pull inward there.
    const project = (i: number) => {
      const x = X(i), y = P[i * 3 + 1];
      const v = (x - cx) / a, h = (y - cy) / b;
      const r = seNorm(v, h);
      if (r < 1e-4 || r > 1) return;
      const nx = cx + (v / r) * a, s = S(i);
      P[i * 3] = back[0] + s * dx + nx * dz;
      P[i * 3 + 1] = cy + (h / r) * b;
      P[i * 3 + 2] = back[1] + s * dz - nx * dx;
    };
    // Fully shaped copy first (projection, then a few rounds of smoothing + re-projection to even
    // out the vertices), blended in from mid-foot at the end.
    const orig = P.slice();
    for (const i of ids) if (w[i] > 0) project(i);
    const tmp = new Float32Array(P.length);
    for (let it = 0; it < 4; it++) {
      tmp.set(P);
      for (const i of ids) {
        const q0 = nbStart[i], q1 = nbStart[i + 1];
        if (!w[i] || edge[i] || q1 === q0) continue;
        let x = 0, y = 0, z = 0;
        for (let q = q0; q < q1; q++) { const j = nbList[q]; x += P[j * 3]; y += P[j * 3 + 1]; z += P[j * 3 + 2]; }
        const c = 1 / (q1 - q0);
        tmp[i * 3] = (P[i * 3] + x * c) / 2; tmp[i * 3 + 1] = (P[i * 3 + 1] + y * c) / 2; tmp[i * 3 + 2] = (P[i * 3 + 2] + z * c) / 2;
      }
      P.set(tmp);
      // UV-seam twins only see the neighbours on their own side: keep them together.
      if (twins) for (const gl of twins) {
        if (!w[gl[0]]) continue;
        let x = 0, y = 0, z = 0;
        for (const i of gl) { x += P[i * 3]; y += P[i * 3 + 1]; z += P[i * 3 + 2]; }
        const c = 1 / gl.length;
        for (const i of gl) { P[i * 3] = x * c; P[i * 3 + 1] = y * c; P[i * 3 + 2] = z * c; }
      }
      for (const i of ids) if (w[i] > 0) project(i);
    }
    for (const i of ids) if (!drop[i]) for (let k = 0; k < 3; k++) P[i * 3 + k] = orig[i * 3 + k] + (P[i * 3 + k] - orig[i * 3 + k]) * w[i];
  }
  // Body normals still carry the foot's detail: shade the shoe by its own surface.
  const acc = new Float32Array(n * 3);
  for (let k = 0; k < idx.length; k += 3) {
    if (drop[idx[k]] || drop[idx[k + 1]] || drop[idx[k + 2]]) continue;
    const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    for (const o of [a, b, c]) { acc[o] += fx; acc[o + 1] += fy; acc[o + 2] += fz; }
  }
  const feet = new Set(['foot.L', 'foot.R'].map((r) => BODY_REGIONS.indexOf(r as BodyRegion)));
  for (let i = 0; i < n; i++) {
    if (!feet.has(st.region[src[i]])) continue;
    const x = acc[i * 3], y = acc[i * 3 + 1], z = acc[i * 3 + 2], l = Math.hypot(x, y, z);
    if (l < 1e-12) continue;
    N[i * 3] = x / l; N[i * 3 + 1] = y / l; N[i * 3 + 2] = z / l;
  }
  return { drop, caps };
}

/**
 * The closed toe box of a shoe: a short band over the end of the shell at the ball of the foot,
 * then a half-ellipsoid with the shoe's rounded-box section out to the toe tip. Slightly larger
 * than the shell so the overlap reads as the toe cap's seam. Skinned like the nearest shell vertex.
 */
function buildToeCap(cap: ToeCap, st: HumanStatic, src: number[], P: Float32Array, out: ShellParts, base: number) {
  const rows = 10, cols = 28, k = 1.025, band = 0.03;
  const v0 = base + out.P.length / 3, first = out.P.length;
  const ssi = st.skinIndex.array as Uint16Array, ssw = st.skinWeight.array as Uint8Array;
  const put = (s: number, lx: number, y: number, u: number, v: number) => {
    const px = cap.back[0] + s * cap.dx + lx * cap.dz, pz = cap.back[1] + s * cap.dz - lx * cap.dx;
    out.P.push(px, y, pz);
    out.N.push(0, 0, 0);
    out.UV.push(u, v);
    out.E.push(0);
    let best = cap.ids[0], bd = Infinity;
    for (const i of cap.ids) {
      const d = (P[i * 3] - px) ** 2 + (P[i * 3 + 1] - y) ** 2 + (P[i * 3 + 2] - pz) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    const sv = src[best];
    for (let q = 0; q < 4; q++) { out.SI.push(ssi[sv * 4 + q]); out.SW.push(ssw[sv * 4 + q]); }
  };
  // Rings: r = 0 at the back of the band, r = 1 at the ball, then up the cap toward the tip.
  for (let r = 0; r <= rows; r++) {
    const f = r === 0 ? 0 : ((r - 1) / rows) * Math.PI * 0.5;
    const s = r === 0 ? cap.s0 - band : cap.s0 + cap.len * Math.sin(f);
    const sc = Math.cos(f) * k;
    for (let c = 0; c < cols; c++) {
      const th = (c / cols) * Math.PI * 2, ct = Math.cos(th), sn = Math.sin(th);
      const ux = Math.sign(ct) * Math.pow(Math.abs(ct), 2 / SHOE_PW), uy = Math.sign(sn) * Math.pow(Math.abs(sn), 2 / SHOE_PW);
      put(s, cap.cx + ux * cap.a * sc, cap.cy + uy * cap.b * sc, c / cols, r / (rows + 1));
    }
  }
  const tip = v0 + (rows + 1) * cols;
  put(cap.s0 + cap.len, cap.cx, cap.cy, 0.5, 1);
  const tri: number[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const a = v0 + r * cols + c, b = v0 + r * cols + ((c + 1) % cols), a2 = a + cols, b2 = b + cols;
    tri.push(a, a2, b, b, a2, b2);
  }
  for (let c = 0; c < cols; c++) tri.push(v0 + rows * cols + c, tip, v0 + rows * cols + ((c + 1) % cols));
  // Winding: outward faces front (the frame's handedness depends on the foot's side).
  const Pt = (i: number) => out.P.slice((i - base) * 3, (i - base) * 3 + 3);
  const [p0, p1, p2] = [Pt(tri[0]), Pt(tri[1]), Pt(tri[2])];
  const fn = [(p1[1] - p0[1]) * (p2[2] - p0[2]) - (p1[2] - p0[2]) * (p2[1] - p0[1]), (p1[2] - p0[2]) * (p2[0] - p0[0]) - (p1[0] - p0[0]) * (p2[2] - p0[2]), (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0])];
  const ax = cap.back[0] + cap.s0 * cap.dx + cap.cx * cap.dz, az = cap.back[1] + cap.s0 * cap.dz - cap.cx * cap.dx;
  if (fn[0] * (p0[0] - ax) + fn[1] * (p0[1] - cap.cy) + fn[2] * (p0[2] - az) < 0) for (let q = 0; q < tri.length; q += 3) [tri[q + 1], tri[q + 2]] = [tri[q + 2], tri[q + 1]];
  // Smooth normals from the cap's own faces.
  for (let q = 0; q < tri.length; q += 3) {
    const [i0, i1, i2] = [tri[q] - base, tri[q + 1] - base, tri[q + 2] - base];
    const A = out.P, o0 = i0 * 3, o1 = i1 * 3, o2 = i2 * 3;
    const ux = A[o1] - A[o0], uy = A[o1 + 1] - A[o0 + 1], uz = A[o1 + 2] - A[o0 + 2];
    const vx = A[o2] - A[o0], vy = A[o2 + 1] - A[o0 + 1], vz = A[o2 + 2] - A[o0 + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    for (const o of [o0, o1, o2]) { out.N[o] += fx; out.N[o + 1] += fy; out.N[o + 2] += fz; }
  }
  for (let o = first; o < out.N.length; o += 3) {
    const l = Math.hypot(out.N[o], out.N[o + 1], out.N[o + 2]) || 1;
    out.N[o] /= l; out.N[o + 1] /= l; out.N[o + 2] /= l;
  }
  out.I.push(...tri);
}

/** New geometry sharing all vertex attributes of `g` (no copies) with its own index. */
function shareGeometry(g: THREE.BufferGeometry, index: number[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(g.attributes)) out.setAttribute(name, attr);
  out.setIndex(new THREE.BufferAttribute(new Uint16Array(index), 1));
  out.boundingSphere = g.boundingSphere;
  return out;
}

/** Character-independent topology of a garment shell (see shellTopology). */
interface ShellTopo {
  /** Body render vertices covered by the shell (selection mask). */
  sel: Uint8Array;
  /** Shell vertex → body render vertex. */
  src: number[];
  /** Shell triangles (shell vertex indices) and the decimated LOD 1/2 triangles. */
  idx: number[];
  lodIdx: number[][];
  /** 1 on the hem (boundary not welded to a seam twin). */
  edge: Float32Array;
  /** Shell vertices that are co-located copies (UV seams): kept welded after displacement. */
  twins?: number[][];
  /** Neighbour lists for cloth smoothing (CSR: start offsets + flat list, duplicates kept). */
  nbStart: Int32Array;
  nbList: Int32Array;
}

/**
 * Garment shell topology depends only on the covered body regions and the shared body mesh,
 * never on the individual body shape (seam twins are co-located in every body), so it is
 * computed once per region set and reused: building it per character (string-keyed seam
 * welding, remap and edge maps over the whole body) cost tens of milliseconds per garment.
 */
/**
 * Rest-pose distance of the body surface from the skirt's axis per ring (rows+1, from topY down
 * over len) and direction (cols, angle 0 = front): the widest body vertex
 * (not the arms) within the ring's band and its neighbouring directions; 0 where there is none.
 */
function skirtClearance(ch: Character, cx: number, cz: number, topY: number, len: number, rows: number, cols: number): Float32Array {
  const st = ch.geo.st, pos = ch.geo.build.renderPos;
  const si = st.skinIndex.array as Uint16Array, sw = st.skinWeight.array as Uint8Array;
  const bodyBones = new Set<number>();
  for (const [name, i] of ch.boneIndex) if (!/(clavicle|shoulder|arm|wrist|hand|finger|metacarpal|thumb)/.test(name)) bodyBones.add(i);
  const ext = new Float32Array((rows + 1) * cols);
  const seen = new Uint8Array(st.renderVerts);
  const band = len / rows;
  for (const v of st.index.body) {
    if (seen[v]) continue;
    seen[v] = 1;
    const y = pos[v * 3 + 1];
    if (y > topY + band * 0.5 || y < topY - len - band) continue;
    let best = 0, bone = -1;
    for (let k = 0; k < 4; k++) if (sw[v * 4 + k] > best) { best = sw[v * 4 + k]; bone = si[v * 4 + k]; }
    if (!bodyBones.has(bone)) continue;
    const dx = pos[v * 3] - cx, dz = pos[v * 3 + 2] - cz;
    const d = Math.hypot(dx, dz);
    const c0 = Math.round(((Math.atan2(dx, -dz) / (Math.PI * 2)) + 1) * cols) % cols;
    const rf = (topY - y) / band;
    // The waistband ring only takes the waist itself (a wider band reached the hips and stood
    // the top out from the body like a shelf); lower rings take their neighbours' bands too.
    for (let r = Math.max(0, Math.floor(rf - 0.6)); r <= Math.min(rows, Math.ceil(rf + 0.6)); r++) {
      if (r === 0 && Math.abs(rf) > 0.25) continue;
      for (let k = -1; k <= 1; k++) {
        const i = r * cols + ((c0 + k + cols) % cols);
        if (d > ext[i]) ext[i] = d;
      }
    }
  }
  return ext;
}

const SHELL_TOPO = new Map<string, ShellTopo | null>();

/** Cumulative equipment build cost by step (diagnostics, ms; window.norgoEquipStats). */
const EQ_STATS = { held: 0, rigid: 0, shells: 0, shellCount: 0, garmentMaterial: 0 };
if (typeof window !== 'undefined') (window as unknown as { norgoEquipStats?: typeof EQ_STATS }).norgoEquipStats = EQ_STATS;

function shellTopology(st: HumanStatic, regions: ShellLayer['regions'], pos: Float32Array): ShellTopo | null {
  const l = { regions };
  const body = st.index.body;
  const want = new Map<number, [number, number]>();
  for (const r of l.regions) want.set(BODY_REGIONS.indexOf(r.region), [r.from ?? 0, r.to ?? 1]);
  const sel = new Uint8Array(st.renderVerts);
  for (let v = 0; v < st.bodyVerts; v++) {
    const cut = want.get(st.region[v]);
    if (!cut) continue;
    const t = st.regionT[v];
    if (t >= cut[0] - 1e-3 && t <= cut[1] + 1e-3) sel[v] = 1;
  }
  // Triangles fully inside the selection.
  const tris: number[] = [];
  for (let i = 0; i < body.length; i += 3) if (sel[body[i]] && sel[body[i + 1]] && sel[body[i + 2]]) tris.push(body[i], body[i + 1], body[i + 2]);
  if (!tris.length) return null;
  const remap = new Map<number, number>();
  const src: number[] = [];
  for (const v of tris) if (!remap.has(v)) { remap.set(v, src.length); src.push(v); }
  // Decimated LOD triangles of the same selection (they reference a subset of the same vertices).
  const lodTris = [1, 2].map((l) => {
    const a = st.bodyIndex[l].array as ArrayLike<number>;
    const out: number[] = [];
    for (let i = 0; i < a.length; i += 3) if (remap.has(a[i]) && remap.has(a[i + 1]) && remap.has(a[i + 2])) out.push(remap.get(a[i])!, remap.get(a[i + 1])!, remap.get(a[i + 2])!);
    return out;
  });
  const n = src.length;
  // Boundary edges → trim attribute; also used to keep edges glued to the body.
  const edgeCount = new Map<number, number>();
  const ek = (a: number, b: number) => (a < b ? a * 65536 + b : b * 65536 + a);
  for (let i = 0; i < tris.length; i += 3) for (let k = 0; k < 3; k++) {
    const key = ek(tris[i + k], tris[i + ((k + 1) % 3)]);
    edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
  }
  const edge = new Float32Array(n);
  // Welded boundary: render vertices at UV seams are separate but co-located; treat a vertex as edge
  // only if the boundary edge is not matched by a co-located twin (approximate via position hashing).
  const posKey = (v: number) => `${pos[v * 3].toFixed(4)},${pos[v * 3 + 1].toFixed(4)},${pos[v * 3 + 2].toFixed(4)}`;
  const welded = new Map<string, number>();
  for (let i = 0; i < tris.length; i += 3) for (let k = 0; k < 3; k++) {
    const a = tris[i + k], b = tris[i + ((k + 1) % 3)];
    const wk = [posKey(a), posKey(b)].sort().join('|');
    welded.set(wk, (welded.get(wk) ?? 0) + 1);
  }
  for (let i = 0; i < tris.length; i += 3) for (let k = 0; k < 3; k++) {
    const a = tris[i + k], b = tris[i + ((k + 1) % 3)];
    if (edgeCount.get(ek(a, b)) === 1 && welded.get([posKey(a), posKey(b)].sort().join('|')) === 1) {
      edge[remap.get(a)!] = 1;
      edge[remap.get(b)!] = 1;
    }
  }
  const idx = tris.map((v) => remap.get(v)!);
  // Neighbour lists in CSR form (same multiplicity as the per-triangle push it replaces).
  const deg = new Int32Array(n);
  for (let i = 0; i < tris.length; i += 3) for (let k = 0; k < 3; k++) {
    deg[remap.get(tris[i + k])!]++;
    deg[remap.get(tris[i + ((k + 1) % 3)])!]++;
  }
  const nbStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) nbStart[i + 1] = nbStart[i] + deg[i];
  const fill = nbStart.slice(0, n);
  const nbList = new Int32Array(nbStart[n]);
  for (let i = 0; i < tris.length; i += 3) for (let k = 0; k < 3; k++) {
    const x = remap.get(tris[i + k])!, y = remap.get(tris[i + ((k + 1) % 3)])!;
    nbList[fill[x]++] = y;
    nbList[fill[y]++] = x;
  }
  // Seam twins: separate render vertices at the same position must move together, or the
  // pushed-out shell opens cracks along UV seams (see-through lines on the back).
  const groups = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const k = posKey(src[i]);
    const gl = groups.get(k);
    if (gl) gl.push(i); else groups.set(k, [i]);
  }
  const twins = [...groups.values()].filter((gl) => gl.length > 1);
  return { sel, src, idx, lodIdx: lodTris, edge, nbStart, nbList, twins };
}

export class EquipmentRig {
  /** Bumped by every set(): staged jobs of an outdated outfit skip themselves. */
  private gen = 0;
  private key = '#unset';
  private shells: ShellBuild[] = [];
  private rigids: THREE.Object3D[] = [];
  private held: { slot: 'mainhand' | 'offhand'; obj: THREE.Object3D; grip: GripClass; stowSocket: string | null }[] = [];
  private bodyIndex: THREE.BufferAttribute | null = null;
  private skyVis = 1;
  main: GripClass = 'none';
  off: GripClass = 'none';
  /** Held items currently drawn (vs. stowed). */
  drawn = true;

  constructor(private ch: Character) {}

  /** Apply an equipment set; rebuilds only if it changed. */
  /**
   * Dress the character. With `schedule`, every held item, rigid part and garment shell is
   * built as its own job (a character's outfit costs tens of milliseconds in total, a few per
   * piece) and `done` runs after the last one; without, everything is built immediately.
   * A newer `set` makes jobs still pending from an older one skip themselves.
   */
  set(eq: EquipmentVisuals | undefined, schedule?: (job: () => void, label: string) => void, done?: () => void) {
    // Everything visible counts (colours, pattern, cut), not only item and seed: a recoloured
    // garment was ignored (the character creator's colour swatches did nothing).
    const key = eq ? Object.entries(eq).filter(([, v]) => v).map(([k, v]) => `${k}:${v!.defId}:${JSON.stringify(v!.visual)}`).sort().join('|') : '';
    if (key === this.key) {
      done?.();
      return;
    }
    this.key = key;
    const gen = ++this.gen;
    const run = (job: () => void, label = 'equipment') => {
      const guarded = () => {
        if (gen === this.gen) job();
      };
      if (schedule) schedule(guarded, label);
      else guarded();
    };
    this.clear();
    eq ??= {};
    const hiddenRegions = new Set<BodyRegion>();
    // Per body vertex: bit k set = covered by shell k (a triangle is hidden only when ONE shell
    // covers all three corners; a union would cut holes at seams between garments).
    const covered = new Uint32Array(this.ch.geo.st.renderVerts);
    let hideHair = false, hideBeard = false;
    const fit = this.ch.geo.build.body.fit;
    const layers: { layer: ShellLayer; seed: number; slot?: string }[] = [];
    for (const [slot, item] of Object.entries(eq) as [EquipSlot, NonNullable<EquipmentVisuals[EquipSlot]>][]) {
      if (!item || item.defId === 'no-underwear') continue;
      if (slot === 'mainhand' || slot === 'offhand') {
        run(() => { const t0 = performance.now(); this.addHeld(slot, item.defId, item.visual); EQ_STATS.held += performance.now() - t0; }, `held ${item.defId}`);
        continue;
      }
      let spec: WearableSpec | null = null;
      try {
        spec = resolveWearable(item.defId, item.visual);
      } catch (e) {
        console.warn('[humanoid] resolveWearable failed', item.defId, e);
      }
      if (!spec) continue;
      hideHair ||= !!spec.hideHair;
      hideBeard ||= !!spec.hideBeard;
      for (const r of spec.hideRegions ?? []) hiddenRegions.add(r);
      for (const l of spec.layers) {
        if (l.kind === 'shell') layers.push({ layer: l, seed: item.visual.seed, slot });
        else run(() => { const t0 = performance.now(); this.addRigid(l, slot, fit); EQ_STATS.rigid += performance.now() - t0; }, `rigid ${item.defId}`);
      }
    }
    // Modest default underclothes where nothing covers hips (and chest for women).
    const covers = (r: BodyRegion) => layers.some((l) => l.layer.regions.some((x) => x.region === r));
    // Dyed cloth colours chosen per individual so underclothes never read as skin.
    const dyes: [number, number, number][] = [[0.2, 0.14, 0.1], [0.16, 0.2, 0.3], [0.34, 0.11, 0.09], [0.86, 0.83, 0.75], [0.17, 0.23, 0.14], [0.1, 0.1, 0.11]];
    const dye = dyes[(this.ch.app.seed >>> 4) % dyes.length];
    const under: ShellMaterial = { color: dye, color2: [dye[0] * 0.6, dye[1] * 0.6, dye[2] * 0.6], pattern: 'quilted', patternScale: 9, roughness: 0.9, metalness: 0, sheen: 0.45, glow: 0, glowColor: [0, 0, 0], wear: 0.25 };
    // (Not when the outfit asks for none: the character creator's underwear switch.)
    const bare = Object.values(eq).some((it) => it?.defId === 'no-underwear');
    if (!bare && !covers('pelvis')) layers.push({ seed: 7, layer: { kind: 'shell', regions: [{ region: 'pelvis', to: 0.75 }, { region: 'buttocks' }, { region: 'thigh.L', to: 0.12 }, { region: 'thigh.R', to: 0.12 }], offset: 0.004, layer: 0, material: under, trim: { width: 0.008, color: [dye[0] * 0.45, dye[1] * 0.45, dye[2] * 0.45] } } });
    if (!bare && this.ch.app.gender < 0.5 && !covers('chest')) layers.push({ seed: 8, layer: { kind: 'shell', regions: [{ region: 'chest', from: 0.42, to: 0.78 }, { region: 'back', from: 0.5, to: 0.72 }], offset: 0.004, layer: 0, material: under, trim: { width: 0.008, color: [dye[0] * 0.45, dye[1] * 0.45, dye[2] * 0.45] } } });
    layers.sort((a, b) => a.layer.layer - b.layer.layer);
    let order = 0;
    for (const { layer, seed, slot } of layers) {
      const o = order++;
      run(() => { const t0 = performance.now(); this.addShell(layer, seed, covered, o, slot ?? 'under'); EQ_STATS.shells += performance.now() - t0; EQ_STATS.shellCount++; }, `shell ${layer.regions.map((r) => r.region).join('+')}`);
    }
    run(() => {
      this.applyHidden([...hiddenRegions], hideHair, hideBeard, covered);
      done?.();
    });
  }

  // ------------------------------------------------------------------ shells

  private addShell(l: ShellLayer, seed: number, covered: Uint32Array, order: number, slot = 'under') {
    const ch = this.ch, st = ch.geo.st;
    const pos = ch.geo.build.renderPos, nrm = ch.geo.build.renderNormal;
    const body = st.index.body;
    const topoKey = JSON.stringify(l.regions);
    let topo = SHELL_TOPO.get(topoKey);
    if (topo === undefined) {
      topo = shellTopology(st, l.regions, pos);
      SHELL_TOPO.set(topoKey, topo);
    }
    if (!topo && !l.skirt && !l.hood) return;
    const empty: ShellTopo = { sel: new Uint8Array(st.renderVerts), src: [], idx: [], lodIdx: [[], []], edge: new Float32Array(0), nbStart: new Int32Array(1), nbList: new Int32Array(0) };
    const { sel, src, edge, nbStart, nbList, twins } = topo ?? empty;
    const n = src.length;
    // Positions: push out along the normal; outer layers are smoothed (cloth drapes over detail).
    // A little more room than the nominal offset (thin shirts let skin poke through in motion,
    // where skinning bends body and shell slightly differently), and between stacked layers.
    const off = Math.max(0.002, l.offset) * 1.25 + 0.004 + order * 0.002;
    const P = new Float32Array(n * 3), N = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = src[i];
      for (let k = 0; k < 3; k++) {
        P[i * 3 + k] = pos[v * 3 + k] + nrm[v * 3 + k] * off;
        N[i * 3 + k] = nrm[v * 3 + k];
      }
    }
    // Cloth bridges small body detail (navel, abs, toes): smoother for thicker layers, and feet
    // are rounded into a boot/shoe shape.
    const footShell = l.regions.some((r) => r.region.startsWith('foot'));
    const smoothIters = Math.max(l.offset >= 0.012 ? 5 : l.offset >= 0.006 ? 3 : 2, footShell ? 10 : 0);
    if (smoothIters) {
      const tmp = new Float32Array(P.length);
      for (let it = 0; it < smoothIters; it++) {
        for (let i = 0; i < n; i++) {
          const s0 = nbStart[i], s1 = nbStart[i + 1];
          if (edge[i] || s1 === s0) { tmp.set(P.subarray(i * 3, i * 3 + 3), i * 3); continue; }
          let x = 0, y = 0, z = 0;
          for (let q = s0; q < s1; q++) { const j = nbList[q]; x += P[j * 3]; y += P[j * 3 + 1]; z += P[j * 3 + 2]; }
          const c = 1 / (s1 - s0);
          tmp[i * 3] = P[i * 3] * 0.4 + x * c * 0.6;
          tmp[i * 3 + 1] = P[i * 3 + 1] * 0.4 + y * c * 0.6;
          tmp[i * 3 + 2] = P[i * 3 + 2] * 0.4 + z * c * 0.6;
        }
        P.set(tmp);
        // Never sink below the minimum clearance.
        for (let i = 0; i < n; i++) {
          const v = src[i];
          const dx = P[i * 3] - pos[v * 3], dy = P[i * 3 + 1] - pos[v * 3 + 1], dz = P[i * 3 + 2] - pos[v * 3 + 2];
          const d = dx * nrm[v * 3] + dy * nrm[v * 3 + 1] + dz * nrm[v * 3 + 2];
          if (d < off * 0.6) {
            const k = off * 0.6 - d;
            P[i * 3] += nrm[v * 3] * k; P[i * 3 + 1] += nrm[v * 3 + 1] * k; P[i * 3 + 2] += nrm[v * 3 + 2] * k;
          }
        }
      }
    }
    // Shoes are solid: the shell stops at the ball of the foot and a closed toe box covers the toes.
    const shoe = footShell && topo ? shapeShoe(st, topo, P, N) : null;
    const keepTri = (t: number[]) => {
      if (!shoe) return t;
      const d = shoe.drop, o: number[] = [];
      for (let k = 0; k < t.length; k += 3) if (!d[t[k]] && !d[t[k + 1]] && !d[t[k + 2]]) o.push(t[k], t[k + 1], t[k + 2]);
      return o;
    };
    // Weld seam twins (same displaced position and normal).
    if (twins) for (const gl of twins) {
      let x = 0, y = 0, z = 0, nx = 0, ny = 0, nz = 0;
      for (const i of gl) { x += P[i * 3]; y += P[i * 3 + 1]; z += P[i * 3 + 2]; nx += N[i * 3]; ny += N[i * 3 + 1]; nz += N[i * 3 + 2]; }
      const c = 1 / gl.length, nl = Math.hypot(nx, ny, nz) || 1;
      for (const i of gl) {
        P[i * 3] = x * c; P[i * 3 + 1] = y * c; P[i * 3 + 2] = z * c;
        N[i * 3] = nx / nl; N[i * 3 + 1] = ny / nl; N[i * 3 + 2] = nz / nl;
      }
    }
    const g = new THREE.BufferGeometry();
    const uv = new Float32Array(n * 2), si = new Uint16Array(n * 4), sw = new Uint8Array(n * 4);
    const suv = st.uv.array as Float32Array, ssi = st.skinIndex.array as Uint16Array, ssw = st.skinWeight.array as Uint8Array;
    for (let i = 0; i < n; i++) {
      const v = src[i];
      uv[i * 2] = suv[v * 2]; uv[i * 2 + 1] = suv[v * 2 + 1];
      for (let k = 0; k < 4; k++) { si[i * 4 + k] = ssi[v * 4 + k]; sw[i * 4 + k] = ssw[v * 4 + k]; }
      if (sel[v]) covered[v] |= 1 << (order & 31);
    }
    let idx = keepTri(topo?.idx ?? []);
    const parts: ShellParts = { P: [], N: [], UV: [], SI: [], SW: [], E: [], I: [] };
    if (shoe) for (const cap of shoe.caps) buildToeCap(cap, st, src, P, parts, n);
    if (l.skirt) {
      const { topY, hemY } = this.buildSkirt(l, parts, n);
      // A closed skirt hides the hips and upper thighs inside it (they can't poke through when
      // the legs swing or the wearer sits; only what's near the hem can be seen). A skirt over a
      // shirt leaves the lower pelvis bare under it, which showed on the lap when sitting.
      if (!l.skirt.slits) {
        const cut = Math.max(hemY + 0.12, ch.rest[ch.boneIndex.get('lowerleg01.L')!].y + 0.08);
        const thighs = new Set([BODY_REGIONS.indexOf('thigh.L'), BODY_REGIONS.indexOf('thigh.R')]);
        const hips = new Set([BODY_REGIONS.indexOf('pelvis'), BODY_REGIONS.indexOf('buttocks')]);
        for (const v of body) {
          const y = pos[v * 3 + 1];
          if ((thighs.has(st.region[v]) && y > cut) || (hips.has(st.region[v]) && y < topY - 0.02)) covered[v] |= 1 << (order & 31);
        }
      }
    }
    if (l.hood) this.buildHood(parts, n);
    const total = n + parts.P.length / 3;
    const fP = new Float32Array(total * 3), fN = new Float32Array(total * 3), fUV = new Float32Array(total * 2), fSI = new Uint16Array(total * 4), fSW = new Uint8Array(total * 4), fE = new Float32Array(total);
    fP.set(P); fN.set(N); fUV.set(uv); fSI.set(si); fSW.set(sw); fE.set(edge);
    fP.set(parts.P, n * 3); fN.set(parts.N, n * 3); fUV.set(parts.UV, n * 2); fSI.set(parts.SI, n * 4); fSW.set(parts.SW, n * 4); fE.set(parts.E, n);
    idx = idx.concat(parts.I);
    g.setAttribute('position', new THREE.BufferAttribute(fP, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(fN, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(fUV, 2));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(fSI, 4));
    g.setAttribute('skinWeight', new THREE.Uint8BufferAttribute(fSW, 4, true));
    g.setAttribute('aEdge', new THREE.BufferAttribute(fE, 1));
    g.setIndex(idx);
    g.boundingSphere = ch.geo.body[0].boundingSphere!.clone();
    if (l.skirt || l.hood) g.computeVertexNormals();
    const tm = performance.now();
    const mat = createGarmentMaterial(l.material, seed, l.trim?.color);
    EQ_STATS.garmentMaterial += performance.now() - tm;
    if (l.skirt || l.hood) mat.material.side = THREE.DoubleSide;
    const mesh = new THREE.SkinnedMesh(g, mat.material);
    mesh.userData.slot = slot;
    mesh.userData.color = l.material.color;
    // Body vertices under this shell (shared topology, no copy) and its layer order: the crowd
    // baker paints covered body vertices in the garment's colour (CrowdBaker).
    mesh.userData.covers = src;
    mesh.userData.order = order;
    mesh.bind(ch.skeleton, new THREE.Matrix4());
    mesh.boundingSphere = g.boundingSphere.clone();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.renderOrder = 1 + order;
    // Visible at the near & mid LODs; the far LOD tints the body instead.
    ch.lods[0].add(mesh);
    // Mid/far LODs use the decimated body triangles (+ the same skirt/hood).
    for (const l of [1, 2]) {
      const gl = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(g.attributes)) gl.setAttribute(name, attr);
      gl.setIndex(keepTri(topo?.lodIdx[l - 1] ?? []).concat(parts.I));
      gl.boundingSphere = g.boundingSphere;
      const far = new THREE.SkinnedMesh(gl, mat.material);
      far.userData.slot = slot;
      far.userData.color = mesh.userData.color;
      far.userData.covers = src;
      far.userData.order = order;
      far.bind(ch.skeleton, new THREE.Matrix4());
      far.boundingSphere = mesh.boundingSphere.clone();
      far.castShadow = l === 1;
      ch.lods[l].add(far);
    }
    ch.addSkyPatch(mat.sky);
    mat.sky.uniform!.value = this.skyVis;
    this.shells.push({ mesh, sky: mat.sky });
  }

  /**
   * Skirt/robe hanging from the hips, skinned to the hips, both thighs and the shins. Its shape
   * follows this body: every ring clears the widest hips, buttocks and thighs measured at or
   * above it (fabric falls, it doesn't tuck in under the bottom), with room for the legs to
   * move, then flares. The top ring hugs the waist (no gap to see skin through). Coat and
   * jacket tails (slits, worn over trousers) keep the plain flared ellipse from the hips.
   * Returns the heights of the waistband and the hem.
   */
  private buildSkirt(l: ShellLayer, out: { P: number[]; N: number[]; UV: number[]; SI: number[]; SW: number[]; E: number[]; I: number[] }, base: number): { topY: number; hemY: number } {
    const ch = this.ch;
    const fit = ch.geo.build.body.fit;
    const pel = ch.geo.build.body.sockets.pelvis.pos;
    const bi = (n: string) => ch.boneIndex.get(n)!;
    const root = bi('root'), thL = bi('upperleg01.L'), thR = bi('upperleg01.R'), shL = bi('lowerleg01.L'), shR = bi('lowerleg01.R');
    const sk = l.skirt!, closed = !sk.slits;
    // The waistband sits above the hips on the waist (skin showed between a dress's bodice and
    // a skirt that started out at the hips); the hem stays where the length puts it.
    const hipY = pel[1] + 0.06 * (fit.height / 1.75);
    const topY = closed ? hipY + 0.05 * (fit.height / 1.75) : hipY;
    const len = Math.min(sk.length, hipY - 0.03) + (topY - hipY);
    const rows = 12, cols = 40;
    const kneeY = ch.rest[shL].y;
    const cx = pel[0], cz0 = pel[2] - 0.01;
    // Widest body (hips, buttocks, legs; not the hanging arms) per ring and direction.
    const ext = closed ? skirtClearance(ch, cx, cz0, topY, len, rows, cols) : null;
    const R = new Float32Array((rows + 1) * (cols + 1));
    // Just outside the garment shell under it (its offset rule in addShell, plus a little).
    const off = Math.max(0.002, l.offset) * 1.25 + 0.008;
    for (let c = 0; c < cols; c++) {
      const a = (c / cols) * Math.PI * 2, sx = Math.sin(a), cz = Math.cos(a);
      // Tails, and a fallback where the body gives no measure: a fixed ellipse, slightly
      // flattened at the front, deeper at the back (buttocks).
      const zr = (fit.chestDepth * 0.55 + l.offset) * (cz > 0 ? 1.08 : 0.95), xr = fit.waistRadius * 1.3 + l.offset;
      const ell = 1 / Math.hypot(sx / xr, cz / zr);
      let hang = 0;
      for (let r = 0; r <= rows; r++) {
        const t = r / rows;
        if (!ext) { R[r * (cols + 1) + c] = ell * (1 + sk.flare * t * 1.2 + t * 0.25); continue; }
        // Room for the legs to swing (more lower down, most at the front where knees come up).
        const ease = off + (0.012 + 0.035 * (0.6 + 0.4 * Math.max(0, cz))) * smoothstep(0.1, 0.55, t) + (0.025 + 0.03 * Math.max(0, -cz)) * smoothstep(0.5, 1, t);
        const e = ext[r * cols + c];
        hang = Math.max(hang, e > 0 ? e + ease : r === 0 ? ell * 0.8 : 0);
        R[r * (cols + 1) + c] = hang * (1 + sk.flare * t * 0.9 + t * 0.12);
      }
    }
    // Smooth around each ring below the waistband (never below what it had: no lumps, no new
    // clipping); the seam column repeats the first.
    R[cols] = R[0];
    for (let r = 1; r <= rows; r++) {
      const row = R.subarray(r * (cols + 1), r * (cols + 1) + cols);
      for (let it = 0; it < 3; it++) {
        const prev = row.slice();
        for (let c = 0; c < cols; c++) row[c] = Math.max(prev[c], (prev[(c + cols - 1) % cols] + prev[c] * 2 + prev[(c + 1) % cols]) * 0.25);
      }
      R[r * (cols + 1) + cols] = row[0];
    }
    const v0 = base + out.P.length / 3;
    for (let r = 0; r <= rows; r++) {
      const t = r / rows;
      const y = topY - len * t;
      for (let c = 0; c <= cols; c++) {
        const a = (c / cols) * Math.PI * 2;
        const sx = Math.sin(a), cz = Math.cos(a);
        const wob = 1 + 0.03 * Math.sin(a * 7 + t * 3) * t;
        const rr = R[r * (cols + 1) + c] * wob;
        out.P.push(sx * rr + cx, y, -cz * rr + cz0);
        out.N.push(sx, 0, -cz);
        out.UV.push(c / cols, 1 - t);
        // Weights: hips at the top, the thighs lower down, each side its own leg (shared by
        // both at the middle). A closed skirt follows the legs early and most at the front and
        // sides; tails mostly at the sides. Below the knee the shins take part.
        const legW = closed ? Math.min(0.9, t * (1.6 + 1.6 * Math.max(0, cz) + 1.2 * (1 - Math.abs(cz)))) * (1 - 0.2 * Math.max(0, -cz))
          : Math.min(0.85, t * 1.5) * (0.35 + 0.65 * Math.min(1, Math.abs(sx) * 1.4));
        // Character's left is −X. A wide blend at the back: the back hangs between the legs
        // (a narrow one pulled the hem up into a V when the legs split).
        const bw = 0.35 + 0.25 * Math.max(0, -cz), pL = smoothstep(-bw, bw, -sx);
        const below = y < kneeY ? Math.min(1, (kneeY - y) / 0.25) * 0.7 : 0;
        // One shin slot: the shin of this side, fading out towards the middle front and back
        // where the side changes (by column, so the seam's columns 0 and cols agree). A hard
        // switch there tore the fabric open between the legs.
        const sh = below * Math.abs(2 * pL - 1);
        const wRoot = 1 - legW, wL = legW * pL * (1 - sh), wR = legW * (1 - pL) * (1 - sh);
        const shin = c % cols < cols / 2 ? shR : shL;
        out.SI.push(root, thL, thR, shin);
        const a8 = Math.round(wRoot * 255), b8 = Math.min(255 - a8, Math.round(wL * 255)), c8 = Math.min(255 - a8 - b8, Math.round(wR * 255));
        out.SW.push(a8, b8, c8, 255 - a8 - b8 - c8);
        out.E.push(r === rows ? 1 : 0);
      }
    }
    const slitCols = sk.slits ? new Set<number>() : null;
    if (slitCols && sk.slits) for (let k = 0; k < sk.slits; k++) slitCols.add(Math.round(((k + 0.5) / sk.slits) * cols) % cols);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (slitCols?.has(c) && r > rows * 0.45) continue;
      const a = v0 + r * (cols + 1) + c, b = a + cols + 1;
      out.I.push(a, b, a + 1, a + 1, b, b + 1);
    }
    return { topY, hemY: topY - len };
  }

  /** Hood: a skinned cap over the head with a face opening, draping onto the shoulders. */
  private buildHood(out: { P: number[]; N: number[]; UV: number[]; SI: number[]; SW: number[]; E: number[]; I: number[] }, base: number) {
    const ch = this.ch;
    const hs = ch.geo.build.body.headSphere;
    const bi = (n: string) => ch.boneIndex.get(n)!;
    const head = bi('head'), neck = bi('neck01'), sp = bi('spine01');
    const R = hs[3] * 1.32;
    const rows = 14, cols = 36;
    const v0 = base + out.P.length / 3;
    const neckY = ch.rest[neck].y;
    for (let r = 0; r <= rows; r++) {
      const t = r / rows; // 0 top → 1 bottom drape
      const theta = t * Math.PI * 0.82;
      for (let c = 0; c <= cols; c++) {
        const phi = (c / cols) * Math.PI * 2;
        let x = Math.sin(theta) * Math.sin(phi) * R;
        let y = Math.cos(theta) * R * 1.05;
        let z = Math.sin(theta) * Math.cos(phi) * R * 1.1 + R * 0.12;
        // Point at the back of the hood, drape widening at the bottom.
        if (t < 0.35 && Math.cos(phi) > 0.6) z += (0.35 - t) * R * 0.5 * Math.cos(phi);
        if (t > 0.6) { const w = (t - 0.6) / 0.4; x *= 1 + w * 0.6; z *= 1 + w * 0.3; y -= w * R * 0.6; }
        const px = hs[0] + x, py = hs[1] + y, pz = hs[2] + z;
        out.P.push(px, py, pz);
        out.N.push(x / R, y / R, z / R);
        out.UV.push(c / cols, 1 - t);
        const lowW = Math.max(0, Math.min(1, (hs[1] - py) / Math.max(0.05, hs[1] - neckY)));
        out.SI.push(head, neck, sp, 0);
        const wH = Math.round((1 - lowW) * 255), wN = Math.min(255 - wH, Math.round(lowW * 0.6 * 255));
        out.SW.push(wH, wN, 255 - wH - wN, 0);
        out.E.push(0);
      }
    }
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      // Face opening: front (cos(phi) < -0.55) between brow and chin rows.
      const phi = ((c + 0.5) / cols) * Math.PI * 2;
      const t = (r + 0.5) / rows;
      if (Math.cos(phi) < -0.5 && t > 0.12 && t < 0.7) continue;
      const a = v0 + r * (cols + 1) + c, b = a + cols + 1;
      out.I.push(a, b, a + 1, a + 1, b, b + 1);
    }
    // Trim around the opening.
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      const phi = (c / cols) * Math.PI * 2, t = r / rows;
      if (Math.abs(Math.cos(phi) + 0.5) < 0.12 && t > 0.1 && t < 0.72) out.E[(v0 - base) + r * (cols + 1) + c] = 1;
    }
  }

  // ------------------------------------------------------------------ rigid & held

  private addRigid(part: RigidPart, slot: EquipSlot, fit: BodyFit) {
    let socket: string = part.socket;
    // Rings: ring1 goes on the left hand (resolver builds for hand.R).
    if (slot === 'ring1' && socket === 'hand.R') socket = 'hand.L';
    const s = this.ch.sockets.get(socket);
    if (!s) return;
    let obj: THREE.Object3D;
    try {
      obj = part.build(fit);
    } catch (e) {
      console.warn('[humanoid] rigid part build failed', slot, e);
      return;
    }
    obj.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
    s.add(obj);
    setItemSkyVis(obj, this.skyVis);
    this.rigids.push(obj);
  }

  private addHeld(slot: 'mainhand' | 'offhand', defId: string, visual: ItemVisual) {
    const grip = gripClassOf(defId, visual.shape);
    let obj: THREE.Object3D;
    try {
      obj = buildItemObject(defId, visual);
    } catch (e) {
      console.warn('[humanoid] held item build failed', defId, e);
      return;
    }
    obj.traverse((o) => { o.castShadow = true; });
    setItemSkyVis(obj, this.skyVis);
    // Bows are held in the left hand even when equipped as main hand.
    const hand = grip === 'bow' || grip === 'shield' || slot === 'offhand' ? 'L' : 'R';
    const stow = grip === 'twohand' || grip === 'polearm' || grip === 'bow' || grip === 'crossbow' ? 'back' : grip === 'blade' || grip === 'axe' || grip === 'blunt' || grip === 'dagger' ? (hand === 'R' ? 'hip.L' : 'hip.R') : grip === 'shield' ? 'back' : null;
    const holder = new THREE.Group();
    holder.add(obj);
    holder.userData.hand = hand;
    this.held.push({ slot, obj: holder, grip, stowSocket: stow });
    if (slot === 'mainhand') this.main = grip;
    else this.off = grip;
    if (grip === 'bow' && slot === 'mainhand') this.off = this.off === 'none' ? 'bow' : this.off;
    this.place(this.held[this.held.length - 1], this.drawn);
  }

  private place(h: { obj: THREE.Object3D; grip: GripClass; stowSocket: string | null }, drawn: boolean) {
    const hand = h.obj.userData.hand as 'L' | 'R';
    const atHand = drawn || !h.stowSocket;
    const sock = this.ch.sockets.get(atHand ? `grip.${hand}` : h.stowSocket === 'back' ? 'back' : h.stowSocket!);
    if (!sock) return;
    sock.add(h.obj);
    h.obj.position.set(0, 0, 0);
    h.obj.rotation.set(0, 0, 0);
    h.obj.scale.setScalar(1);
    if (atHand) {
      if (h.grip === 'shield') {
        // Shield strapped to the forearm: face (+Z) out of the back of the hand, top (+Y)
        // toward the elbow, centred on the forearm.
        const body = this.ch.geo.build.body;
        const hb = body.sockets[`hand.${hand}`].basis, gb = body.sockets[`grip.${hand}`].basis;
        const d = new THREE.Vector3(hb[6], hb[7], hb[8]);
        const gx = new THREE.Vector3(gb[0], gb[1], gb[2]), gy = new THREE.Vector3(gb[3], gb[4], gb[5]), gz = new THREE.Vector3(gb[6], gb[7], gb[8]);
        const dl = new THREE.Vector3(d.dot(gx), d.dot(gy), d.dot(gz)).normalize();
        const up = new THREE.Vector3(0, 0, -1);
        up.addScaledVector(dl, -up.dot(dl)).normalize();
        const xo = new THREE.Vector3().crossVectors(up, dl);
        h.obj.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xo, up, dl));
        h.obj.position.copy(up).multiplyScalar(0.13).addScaledVector(dl, body.fit.forearmRadius * 0.6);
      } else if (h.grip === 'bow') {
        h.obj.rotation.set(0, 0, 0);
      } else if (h.grip === 'torch') {
        h.obj.rotation.set(0, 0, 0);
      }
    } else if (h.stowSocket === 'back') {
      // Diagonal across the back (body-aligned socket: +Z forward, so push to −Z behind).
      h.obj.position.set(0, -0.05, -0.06);
      h.obj.rotation.set(0, 0, h.grip === 'shield' ? 0 : 2.5);
      if (h.grip === 'shield') h.obj.rotation.set(0, Math.PI, 0), h.obj.position.set(0, 0, -0.08);
      if (h.grip === 'bow') h.obj.rotation.set(0, Math.PI / 2, 2.6);
    } else {
      // Sheathed at the hip, hilt up and forward.
      h.obj.position.set(h.stowSocket === 'hip.L' ? 0.1 : -0.1, -0.02, 0.02);
      h.obj.rotation.set(0.35, 0, Math.PI - 0.25 * (h.stowSocket === 'hip.L' ? 1 : -1));
    }
  }

  /** Draw or stow weapons. */
  setDrawn(d: boolean) {
    if (d === this.drawn) return;
    this.drawn = d;
    for (const h of this.held) this.place(h, d);
  }

  update(time: number) {
    for (const h of this.held) if (h.grip === 'torch') animateItem(h.obj.children[0], time);
  }

  setSkyVis(v: number) {
    this.skyVis = v;
    for (const s of this.shells) if (s.sky.uniform) s.sky.uniform.value = v;
    for (const r of this.rigids) setItemSkyVis(r, v);
    for (const h of this.held) setItemSkyVis(h.obj, v);
  }

  /** Object to anchor effects/lights to for a held slot. */
  heldObject(slot: 'mainhand' | 'offhand'): THREE.Object3D | null {
    return this.held.find((h) => h.slot === slot)?.obj ?? null;
  }

  private applyHidden(regions: BodyRegion[], hideHair: boolean, hideBeard: boolean, covered?: Uint32Array) {
    const ch = this.ch, st = ch.geo.st;
    const hide = new Set(regions.map((r) => BODY_REGIONS.indexOf(r)));
    const full = st.index.body;
    if (!hide.size && !covered) {
      for (let l = 0; l < 3; l++) ch.bodyMeshes[l].geometry = ch.geo.body[l];
      ch.setHairHidden(false, false);
      return;
    }
    // Rebuild the near body index without hidden/covered triangles; LODs keep their own (cheap) index
    // but drop triangles whose vertices are all hidden.
    const keep = (a: number, b: number, c: number) => {
      if (hide.has(st.region[a]) && hide.has(st.region[b]) && hide.has(st.region[c])) return false;
      return !(covered && (covered[a] & covered[b] & covered[c]) !== 0);
    };
    const filtered: number[] = [];
    for (let i = 0; i < full.length; i += 3) if (keep(full[i], full[i + 1], full[i + 2])) filtered.push(full[i], full[i + 1], full[i + 2]);
    const g0 = shareGeometry(ch.geo.body[0], filtered);
    this.bodyIndex = g0.index as THREE.BufferAttribute;
    ch.bodyMeshes[0].geometry = g0;
    for (let l = 1; l < 3; l++) {
      const src = ch.geo.body[l].index!.array as ArrayLike<number>;
      const f: number[] = [];
      for (let i = 0; i < src.length; i += 3) if (keep(src[i], src[i + 1], src[i + 2])) f.push(src[i], src[i + 1], src[i + 2]);
      ch.bodyMeshes[l].geometry = shareGeometry(ch.geo.body[l], f);
    }
    ch.setHairHidden(hideHair, hideBeard);
  }

  private clear() {
    const ch = this.ch;
    for (const s of this.shells) {
      s.mesh.geometry.dispose();
      (s.mesh.material as THREE.Material).dispose();
      ch.removeSkyPatch(s.sky);
    }
    for (const l of ch.lods) for (const o of [...l.children]) {
      const g = (o as THREE.Mesh).geometry;
      if (g?.getAttribute('aEdge')) { l.remove(o); g.dispose(); }
    }
    this.shells = [];
    for (const r of this.rigids) { r.removeFromParent(); disposeItemObject(r); }
    this.rigids = [];
    for (const h of this.held) { h.obj.removeFromParent(); disposeItemObject(h.obj); }
    this.held = [];
    this.main = this.off = 'none';
    // Restore the shared body geometry (custom index clones are dropped).
    for (let l = 0; l < 3; l++) {
      const g = ch.bodyMeshes[l].geometry;
      // (The clone shares every vertex attribute with the body: only its index is its own.)
      if (g !== ch.geo.body[l]) { disposeOwn(g, (a) => a !== g.index); ch.bodyMeshes[l].geometry = ch.geo.body[l]; }
    }
    this.bodyIndex = null;
    void _v;
  }

  dispose() {
    this.clear();
  }
}
