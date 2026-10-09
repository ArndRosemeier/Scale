/**
 * The giant mech's skin (pure, tested like the creatures'): hard-surface parts — slanted armour
 * blocks (hexahedra) and cylinders — built round the bind pose of `mechRig.ts`, each riding ONE bone
 * (rigid: no blending). Every part is watertight and faces out; normals are flat per face (no
 * welding across a block's edges) and smooth only round a cylinder.
 *
 *   pelvis + hull   a slab-sided hull, its front sloped, gunmetal with lighter panels, a hazard band
 *                   (yellow and black) across the pelvis; a backpack behind it holding the two heat
 *                   vents (glowing white-blue as they open: the `ridge` channel).
 *   cockpit         a block on the hull's brow with a long red visor slit (the `eyes` channel).
 *   pods            a missile box on each shoulder, six launch tubes in its face.
 *   arms            shoulder plates, piston upper arms, armoured forearms: a three-barrel cannon on
 *                   the right (+X), a hammer fist on the left.
 *   legs            reverse-jointed: armoured thighs, big knee drums (hazard-striped), shins with a
 *                   hydraulic ram behind them, ankle drums, splayed feet with two toes and a heel.
 *
 * Vertex attributes as the creature material wants them (`CreatureMesh`): colour, glow (x ridge, y
 * order, z throat, w eyes), uv (stretched far: the scale texture only weathers the paint),
 * four influences (all on one bone here).
 */
import { Builder, type V3, type Glow, type SkinData } from '../rig/skin';
import { v3sub, v3cross, v3norm, v3add, v3scale } from '../../../core/math';
import { MECH, MECH_BONES, MECH_BIND } from './mechRig';

// ------------------------------------------------------------------ colours (linear RGB)

const STEEL: V3 = [0.045, 0.05, 0.055], PANEL: V3 = [0.085, 0.09, 0.095], DARK: V3 = [0.018, 0.019, 0.02];
const HAZARD: V3 = [0.42, 0.26, 0.015], BLACK: V3 = [0.008, 0.008, 0.008], RED: V3 = [0.2, 0.025, 0.015];
const VISOR: V3 = [0.12, 0.02, 0.005], GRILLE: V3 = [0.03, 0.035, 0.04], PISTON: V3 = [0.22, 0.22, 0.21];

const NO: Glow = [0, 0, 0, 0];
const VISOR_GLOW: Glow = [0, 0, 0, 1];
const VENT_GLOW: Glow = [1, 1, 0, 0];
/** uv per metre: stretched so far the material's scale texture only shades the plates a little unevenly (weathered paint). */
const UVS = 0.006;

/**
 * A block from 8 corners — bottom (y0) four then top four, each ring (−x−z, +x−z, +x+z, −x+z) —
 * every face its own four vertices (flat), wound to face out. `col(face)`: 0 −y, 1 +y, 2 −z, 3 +x,
 * 4 +z, 5 −x.
 */
function block(B: Builder, name: string, c: V3[], bone: number, col: (f: number) => V3, glow: (f: number) => Glow = () => NO): void {
  B.begin();
  const faces = [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]];
  const mid = c.reduce((a, p) => v3add(a, v3scale(p, 1 / 8)), [0, 0, 0] as V3);
  faces.forEach((f, fi) => {
    let q = f.map((i) => c[i]);
    // Outward: the face normal points away from the middle.
    const n = v3cross(v3sub(q[1], q[0]), v3sub(q[2], q[0]));
    const fc = v3scale(v3add(v3add(q[0], q[1]), v3add(q[2], q[3])), 0.25);
    if (n[0] * (fc[0] - mid[0]) + n[1] * (fc[1] - mid[1]) + n[2] * (fc[2] - mid[2]) < 0) q = [q[0], q[3], q[2], q[1]];
    const nn = v3norm(v3cross(v3sub(q[1], q[0]), v3sub(q[2], q[0])));
    const ax = Math.abs(nn[0]) > 0.6 ? [2, 1] : Math.abs(nn[1]) > 0.6 ? [0, 2] : [0, 1];
    const ids = q.map((p) => B.vert(p, p[ax[0]] * UVS, p[ax[1]] * UVS, col(fi), glow(fi), [bone, 1]));
    B.tri(ids[0], ids[1], ids[2]); B.tri(ids[0], ids[2], ids[3]);
  });
  B.end(name);
}

/** An axis-aligned box (centre, half sizes), optionally narrowed at the top (x, z) and its top shifted in z. */
function box(B: Builder, name: string, ctr: V3, h: V3, bone: number, col: (f: number) => V3, glow?: (f: number) => Glow, topK: [number, number] = [1, 1], topDz = 0): void {
  const [x, y, z] = ctr, [a, b, d] = h;
  const ring = (yy: number, kx: number, kz: number, dz: number): V3[] => [[x - a * kx, yy, z - d * kz + dz], [x + a * kx, yy, z - d * kz + dz], [x + a * kx, yy, z + d * kz + dz], [x - a * kx, yy, z + d * kz + dz]];
  block(B, name, [...ring(y - b, 1, 1, 0), ...ring(y + b, topK[0], topK[1], topDz)], bone, col, glow);
}

/** Seam duplicate pairs of the cylinders built (vertex indices), for the normals. */
let SEAMS: [number, number][] = [];

/** A cylinder from a to b (radius r, n sides): smooth sides, flat caps. */
function cyl(B: Builder, name: string, a: V3, b: V3, r: number, bone: number, col: V3, n = 14, glow: Glow = NO): void {
  B.begin();
  const t = v3norm(v3sub(b, a));
  const ref: V3 = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = v3norm(v3cross(ref, t)), v = v3cross(t, u);
  const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const ringAt = (o: V3) => Array.from({ length: n }, (_, j) => { const th = (j / n) * Math.PI * 2; return v3add(o, v3add(v3scale(u, Math.cos(th) * r), v3scale(v, Math.sin(th) * r))); });
  const ra = ringAt(a), rb = ringAt(b);
  // Sides (a seam duplicate for the uv).
  const sa: number[] = [], sb: number[] = [];
  for (let j = 0; j <= n; j++) {
    const k = j % n, uu = (j / n) * Math.PI * 2 * r * UVS;
    sa.push(B.vert(ra[k], uu, 0, col, glow, [bone, 1]));
    sb.push(B.vert(rb[k], uu, L * UVS, col, glow, [bone, 1]));
  }
  for (let j = 0; j < n; j++) { B.tri(sa[j], sa[j + 1], sb[j]); B.tri(sa[j + 1], sb[j + 1], sb[j]); }
  SEAMS.push([sa[0], sa[n]], [sb[0], sb[n]]);
  // Caps (own vertices: flat).
  const ca = B.vert(a, 0, 0, col, glow, [bone, 1]), cb = B.vert(b, 0, 0, col, glow, [bone, 1]);
  const pa = ra.map((p) => B.vert(p, 0, 0, col, glow, [bone, 1])), pb = rb.map((p) => B.vert(p, 0, 0, col, glow, [bone, 1]));
  for (let j = 0; j < n; j++) { B.tri(ca, pa[(j + 1) % n], pa[j]); B.tri(cb, pb[j], pb[(j + 1) % n]); }
  B.end(name);
}

function partVolume(B: Builder, part: { i0: number; i1: number }): number {
  const P = B.pos, I = B.idx;
  let V = 0;
  for (let t = part.i0; t < part.i1; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    V += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
  }
  return V;
}

/** Normals by vertex (no welding): flat blocks and caps, smooth cylinder sides. */
function normals(B: Builder): Float32Array {
  const P = B.pos, I = B.idx, N = new Float32Array(P.length);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const f = v3cross([P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]]);
    for (const v of [a, b, c]) { N[v] += f[0]; N[v + 1] += f[1]; N[v + 2] += f[2]; }
  }
  // The seam duplicates of a cylinder share the side normal.
  for (const [a, b] of SEAMS) for (let k = 0; k < 3; k++) { const m = N[a * 3 + k] + N[b * 3 + k]; N[a * 3 + k] = m; N[b * 3 + k] = m; }
  for (let v = 0; v < N.length; v += 3) {
    const l = Math.hypot(N[v], N[v + 1], N[v + 2]) || 1;
    N[v] /= l; N[v + 1] /= l; N[v + 2] /= l;
  }
  return N;
}

export function buildMechSkin(): SkinData {
  const B = new Builder();
  SEAMS = [];
  const J = (b: number) => MECH_BIND[b];
  const pv = MECH_BONES.pelvis, hl = MECH_BONES.hull, ck = MECH_BONES.cockpit;
  const H = MECH.hull, hb = J(hl);
  const panel = (lit: number[]) => (f: number) => (lit.includes(f) ? PANEL : STEEL);

  // ---- pelvis: a slab between the hips, a hazard band across its front.
  box(B, 'pelvis', [0, -0.4, 0], [3.3, 1.1, 2.1], pv, panel([1]));
  box(B, 'band', [0, -0.4, 2.15], [2.6, 0.45, 0.12], pv, () => HAZARD);
  for (const k of [-1.7, 0, 1.7]) box(B, 'stripe', [k, -0.4, 2.3], [0.32, 0.47, 0.06], pv, () => BLACK);

  // ---- hull: narrower at the bottom, front sloped back at the top; a brow plate; the backpack.
  {
    const y0 = hb[1] + H.y0, y1 = hb[1] + H.y1;
    const c: V3[] = [
      [-H.w * 0.82, y0, H.z0 + 0.6], [H.w * 0.82, y0, H.z0 + 0.6], [H.w * 0.82, y0, H.z1], [-H.w * 0.82, y0, H.z1],
      [-H.w, y1, H.z0], [H.w, y1, H.z0], [H.w, y1, H.z1 - 1.2], [-H.w, y1, H.z1 - 1.2],
    ];
    block(B, 'hull', c, hl, panel([1, 4]));
    // Chest plates (lighter) either side of the cockpit, a red warning band low on the front.
    for (const s of [1, -1]) box(B, 'chest', [s * 2.6, hb[1] + 2.6, H.z1 - 0.35], [1.4, 1.7, 0.35], hl, panel([4, 1]), undefined, [1, 0.6], -0.3);
    box(B, 'warn', [0, hb[1] + 0.6, H.z1 + 0.05], [3.2, 0.3, 0.1], hl, () => RED);
    // Backpack: the vents' housing, a grille between them.
    box(B, 'pack', [0, hb[1] + 4.6, H.z0 - 0.5], [3.4, 2.0, 0.6], hl, panel([1]));
    box(B, 'grille', [0, hb[1] + 4.6, H.z0 - 1.12], [0.7, 1.5, 0.05], hl, () => GRILLE);
    // Exhaust stacks on the shoulders' back.
    for (const s of [1, -1]) cyl(B, 'stack', [s * 3.1, hb[1] + 6.2, H.z0 - 0.2], [s * 3.1, hb[1] + 8.4, H.z0 - 0.4], 0.45, hl, DARK, 10);
  }

  // ---- cockpit: a block on the hull's brow, a red visor slit, a chin.
  {
    const cb = J(ck);
    box(B, 'cockpit', [0, cb[1] + 0.9, cb[2] + 0.9], [2.2, 1.2, 1.5], ck, panel([1, 4]), undefined, [0.85, 0.8], -0.2);
    box(B, 'visor', [0, cb[1] + 1.25, cb[2] + 2.45], [1.75, 0.28, 0.12], ck, () => VISOR, () => VISOR_GLOW);
    box(B, 'chin', [0, cb[1] - 0.35, cb[2] + 1.4], [1.5, 0.3, 1.0], ck, () => DARK);
    // Sensor ears.
    for (const s of [1, -1]) box(B, 'ear', [s * 2.35, cb[1] + 1.2, cb[2] + 0.6], [0.2, 0.55, 0.7], ck, () => DARK);
  }

  // ---- pods: a box on each shoulder, six launch tubes in its face, a red band.
  for (const s of [1, -1]) {
    const p = MECH_BONES.pod(s), pb = J(p), [a, b, d] = MECH.pod;
    box(B, 'pod', [pb[0], pb[1], pb[2]], [a, b, d / 2], p, panel([1, 3, 5]));
    box(B, 'podband', [pb[0], pb[1], pb[2] - d / 2 + 0.7], [a + 0.04, b + 0.04, 0.25], p, () => RED);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
      const x = pb[0] + (i - 1) * 0.8, y = pb[1] + (j - 0.5) * 1.1, z0 = pb[2] + d / 2;
      cyl(B, 'tube', [x, y, z0 - 0.05], [x, y, z0 + 0.25], 0.3, p, DARK, 10);
    }
  }

  // ---- arms
  for (const s of [1, -1]) {
    const a = MECH_BONES.arm(s), ab = J(a), fb = J(a + 1);
    // Shoulder plate (on the upper arm: it turns with it), the actuator, an armour sleeve.
    box(B, 'pauldron', [ab[0] + s * 0.25, ab[1] + 0.2, ab[2]], [1.35, 1.0, 1.6], a, panel([1, s > 0 ? 3 : 5]), undefined, [0.8, 0.8]);
    cyl(B, 'shoulder', [ab[0] - s * 0.9, ab[1], ab[2]], [ab[0] + s * 0.4, ab[1], ab[2]], 1.0, a, DARK);
    cyl(B, 'upper', [ab[0], ab[1] - 0.6, ab[2]], [fb[0], fb[1] + 0.4, fb[2]], 0.65, a, PISTON, 10);
    box(B, 'sleeve', [ab[0], ab[1] - MECH.upper * 0.45, ab[2]], [0.85, 1.4, 0.95], a, panel([s > 0 ? 3 : 5]));
    cyl(B, 'elbow', [fb[0] - 0.85, fb[1], fb[2]], [fb[0] + 0.85, fb[1], fb[2]], 0.85, a + 1, DARK);
    const fe = fb[1] - MECH.fore;
    box(B, 'forearm', [fb[0], (fb[1] + fe) / 2 - 0.2, fb[2]], [1.0, MECH.fore / 2 - 0.2, 1.05], a + 1, panel([2, 4, s > 0 ? 3 : 5]), undefined, [1.1, 1.1]);
    if (s > 0) {
      // The cannon: a housing, three barrels round the axis, a muzzle ring.
      cyl(B, 'breech', [fb[0], fe + 0.2, fb[2]], [fb[0], fe - 0.9, fb[2]], 0.8, a + 1, DARK, 12);
      for (let k = 0; k < 3; k++) {
        const th = (k / 3) * Math.PI * 2, x = fb[0] + Math.cos(th) * 0.38, z = fb[2] + Math.sin(th) * 0.38;
        cyl(B, 'barrel', [x, fe - 0.8, z], [x, fe - MECH.barrel, z], 0.2, a + 1, PISTON, 8);
      }
      cyl(B, 'muzzle', [fb[0], fe - MECH.barrel + 0.6, fb[2]], [fb[0], fe - MECH.barrel + 0.25, fb[2]], 0.7, a + 1, DARK, 12);
    } else {
      // The hammer fist: a heavy block with a striking face, ribbed.
      box(B, 'hammer', [fb[0], fe - 1.2, fb[2]], [1.45, 1.2, 1.7], a + 1, panel([1, 4]), undefined, [0.85, 0.85]);
      box(B, 'face', [fb[0], fe - 2.5, fb[2]], [1.2, 0.12, 1.45], a + 1, () => DARK);
      for (const z of [-0.9, 0, 0.9]) box(B, 'rib', [fb[0] + 1.5, fe - 1.2, fb[2] + z], [0.1, 0.95, 0.18], a + 1, () => HAZARD);
    }
  }

  // ---- legs
  for (const s of [1, -1]) {
    const l = MECH_BONES.leg(s), hp = J(l), kn = J(l + 1), an = J(l + 2);
    cyl(B, 'hip', [hp[0] - s * 0.9, hp[1], hp[2]], [hp[0] + s * 0.9, hp[1], hp[2]], 1.35, l, DARK);
    // Thigh: armour tapering to the knee, a lighter outer plate.
    {
      const y0 = kn[1] + 0.9, y1 = hp[1] - 0.3;
      box(B, 'thigh', [hp[0], (y0 + y1) / 2, hp[2]], [1.15, (y1 - y0) / 2, 1.35], l, panel([s > 0 ? 3 : 5]), undefined, [1.15, 1.25]);
      box(B, 'thighplate', [hp[0] + s * 1.2, (y0 + y1) / 2 + 0.6, hp[2]], [0.15, (y1 - y0) / 2 - 1.2, 1.0], l, () => PANEL);
    }
    // Knee drum (hazard band round it), on the shin.
    cyl(B, 'knee', [kn[0] - 1.45, kn[1], kn[2]], [kn[0] + 1.45, kn[1], kn[2]], 1.25, l + 1, DARK);
    cyl(B, 'kneeband', [kn[0] + s * 1.45, kn[1], kn[2]], [kn[0] + s * 1.6, kn[1], kn[2]], 1.0, l + 1, HAZARD);
    // Shin: a box with a ram behind it (from the knee's back to the ankle).
    {
      const y0 = an[1] + 0.8, y1 = kn[1] - 0.8;
      box(B, 'shin', [kn[0], (y0 + y1) / 2, kn[2] + 0.15], [0.95, (y1 - y0) / 2, 0.95], l + 1, panel([4, s > 0 ? 3 : 5]), undefined, [1.15, 1.2]);
      cyl(B, 'ram', [kn[0], y1 + 0.4, kn[2] - 1.25], [kn[0], y0 + 0.2, kn[2] - 1.1], 0.32, l + 1, PISTON, 8);
      cyl(B, 'ramsleeve', [kn[0], y1 + 0.6, kn[2] - 1.25], [kn[0], (y0 + y1) / 2, kn[2] - 1.2], 0.48, l + 1, DARK, 8);
    }
    // Ankle drum and the foot (a splayed plate, two toes, a heel spur).
    cyl(B, 'ankle', [an[0] - 1.0, an[1], an[2]], [an[0] + 1.0, an[1], an[2]], 0.9, l + 2, DARK);
    {
      const ys = an[1] - MECH.sole, yt = an[1] - 0.35;
      box(B, 'foot', [an[0], (ys + yt) / 2, an[2] + 0.4], [1.45, (yt - ys) / 2, 1.9], l + 2, panel([1]), undefined, [0.8, 0.75]);
      for (const k of [-0.75, 0.75]) box(B, 'toe', [an[0] + k, ys + 0.3, an[2] + 2.95], [0.5, 0.3, 0.75], l + 2, () => DARK, undefined, [0.8, 0.6], -0.15);
      box(B, 'heel', [an[0], ys + 0.3, an[2] - 2.0], [0.55, 0.3, 0.55], l + 2, () => DARK, undefined, [0.8, 0.7], 0.1);
    }
  }

  // ---- heat vents (slide out of the backpack; glowing when hot).
  for (const s of [1, -1]) {
    const v = MECH_BONES.vent(s), vb = J(v);
    box(B, 'vent', [vb[0], vb[1] + 0.2, vb[2] - 0.75], [0.95, 1.45, 0.55], v, (f) => (f === 2 ? GRILLE : STEEL), (f) => (f === 1 || f === 3 || f === 5 || f === 2 ? VENT_GLOW : NO));
  }

  // Every part outward (blocks and cylinders are wound so; a guard all the same).
  for (const part of B.parts) {
    if (partVolume(B, part) >= 0) continue;
    for (let t = part.i0; t < part.i1; t += 3) { const a = B.idx[t + 1]; B.idx[t + 1] = B.idx[t + 2]; B.idx[t + 2] = a; }
  }
  const normal = normals(B);
  return {
    position: Float32Array.from(B.pos), normal, uv: Float32Array.from(B.uv), color: Float32Array.from(B.col), glow: Float32Array.from(B.glow),
    skinIndex: Uint16Array.from(B.si), skinWeight: Float32Array.from(B.sw), index: Uint32Array.from(B.idx), parts: B.parts,
  };
}
