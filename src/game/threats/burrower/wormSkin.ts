/**
 * The Burrower's skin (pure, tested like the Strider's): one closed body lofted along the straight
 * bind pose (the lip at the origin, the tail along −Z) and skinned to the joint bones — and closed
 * parts for the maw's three petals, their teeth, the teeth in the throat and the bristles on the
 * flanks. Every part is watertight, consistently wound and faces out, so no pose opens a hole.
 *
 *   body     ONE tube from deep in the throat (it folds in at the lip: a soft red gullet with rings of
 *            hooked teeth, glowing amber from inside — the `eyes` glow channel) back over the head's
 *            keratin cap, ring after ring of armoured segments (a ridge at every joint, overlapping
 *            dorsal plates, a flatter, paler, folded belly) to the tail tip. Glowing pits along the
 *            flanks (the `ridge` channel, a wave from the tail to the head before it strikes).
 *   petals   three thick shells, each a 120° wedge of the blunt ogive nose (closed they make the
 *            snout), hinged on the lip; inside each, rows of teeth that face forward when they open.
 *   bristles stiff spines along the flanks, swept back.
 *
 * Vertex attributes as the creature material wants them (`CreatureMesh`): colour, glow (x pits, y
 * order tail → head, z unused, w gullet), uv (scales), four bone influences.
 */
import { Builder, type V3, type Glow, type SkinData } from '../rig/skin';
import { saturate, smoothstep, lerp, v3norm, v3cross, v3scale, v3add, v3sub, v3madd } from '../../../core/math';
import { WORM, WORM_BONES, WORM_LENGTH, wormRadius, petalHinge } from './wormRig';

// ------------------------------------------------------------------ colours (linear RGB, like the Strider's)

const PLATE: V3 = [0.02, 0.016, 0.012], PLATE_EDGE: V3 = [0.062, 0.046, 0.03], FLANK: V3 = [0.046, 0.025, 0.015];
const BELLY: V3 = [0.092, 0.062, 0.052], FOLD: V3 = [0.04, 0.026, 0.022], CAP: V3 = [0.03, 0.025, 0.02];
const GULLET: V3 = [0.055, 0.006, 0.006], LIP: V3 = [0.085, 0.028, 0.025], FLESH: V3 = [0.075, 0.018, 0.016];
const TOOTH: V3 = [0.42, 0.37, 0.27], PIT: V3 = [0.01, 0.012, 0.014], HORN: V3 = [0.03, 0.026, 0.02], HORN_TIP: V3 = [0.13, 0.11, 0.08];

/** Around the body (points per ring) and rings per segment. */
const AROUND = 36, PER_SEG = 10;
/** Scale-texture tiles round the body. */
const TILES = 12;

const mix3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Hash noise 0..1 (baked mottling). */
function hash2(x: number, y: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/** The joint bones a point at arc length s (from the lip) belongs to, blended between neighbours. */
function bodyWeights(s: number): number[] {
  const u = Math.max(0, s) / WORM.seg;
  const i = Math.min(WORM.joints - 2, Math.floor(u)), f = saturate(u - i);
  return [WORM_BONES.joint0 + i, 1 - f, WORM_BONES.joint0 + i + 1, f];
}

/**
 * Outline of the body at arc length s and angle θ (0 on top, π/2 right): radius with the segment
 * ridges, the dorsal plates, the flatter belly and the head's cap; and its colour and glow.
 */
function ring(s: number): { pts: V3[]; col: V3[]; glow: Glow[] } {
  const R = wormRadius(s), seg = WORM.seg;
  const f = ((s % seg) + seg) % seg / seg;
  const edge = Math.min(f, 1 - f);
  const ridge = 0.05 * Math.exp(-((edge / 0.06) ** 2)) - 0.035 * Math.exp(-(((f - 0.1) / 0.05) ** 2));
  // A plate per segment, rising towards its back edge and dropping off (they overlap tailwards).
  const plate = 0.07 * smoothstep(0.08, 0.9, f) * (1 - smoothstep(0.9, 0.99, f));
  const cap = s < 5 ? 0.09 * (1 - smoothstep(3.5, 5, s)) : 0;
  const pts: V3[] = [], col: V3[] = [], glow: Glow[] = [];
  const order = saturate(s / WORM_LENGTH);
  for (let j = 0; j < AROUND; j++) {
    const th = (j / AROUND) * Math.PI * 2, sn = Math.sin(th), cs = Math.cos(th);
    const dorsal = smoothstep(-0.2, 0.35, cs);
    const belly = Math.max(0, -cs) ** 2;
    const r = R * (1 + ridge + (plate + cap) * dorsal) * (1 - 0.13 * belly);
    pts.push([r * sn, r * cs, -s]);
    // Colour: plates on the back (paler trailing edges), rust flanks, a pale folded belly; mottled.
    const n = 0.85 + 0.3 * hash2(Math.round(s * 3), j);
    let c = mix3(FLANK, mix3(PLATE, PLATE_EDGE, smoothstep(0.75, 0.95, f)), dorsal);
    c = mix3(c, BELLY, smoothstep(-0.25, -0.6, cs));
    if (cs < -0.3 && Math.abs(((f * 3) % 1) - 0.5) < 0.08) c = mix3(c, FOLD, 0.7);
    if (edge < 0.05) c = mix3(c, PIT, 0.45);
    if (s < 5) c = mix3(c, CAP, dorsal * (1 - smoothstep(3.5, 5, s)));
    // Pits along both flanks, one per segment (and a smaller lower row).
    const side = Math.abs(Math.abs(th - Math.PI) - Math.PI / 2); // 0 at the flank (θ = ±90°)
    const p1 = Math.exp(-((side / 0.16) ** 2) - (((f - 0.5) / 0.07) ** 2));
    const low = Math.abs(Math.abs(th - Math.PI) - 0.7);
    const p2 = 0.6 * Math.exp(-((low / 0.12) ** 2) - (((f - 0.5) / 0.05) ** 2));
    const pit = s > 6 && s < WORM_LENGTH - 6 ? Math.max(p1, p2) : 0;
    if (pit > 0.2) c = mix3(c, PIT, pit);
    col.push([c[0] * n, c[1] * n, c[2] * n]);
    glow.push([pit > 0.25 ? pit : 0, order, 0, 0]);
  }
  return { pts, col, glow };
}

/** A closed cone (tooth, bristle): base circle at `b` (radius r, axis towards the tip), tip at `t`. */
function cone(B: Builder, b: V3, t: V3, r: number, cb: V3, ct: V3, w: number[], name: string): void {
  const ax = v3norm(v3sub(t, b));
  const ref: V3 = Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = v3norm(v3cross(ax, ref)), v = v3cross(ax, u);
  const n = 7;
  B.begin();
  const base: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    base.push(B.vert(v3madd(v3madd(b, u, Math.cos(a) * r), v, Math.sin(a) * r), k / n, 0, cb, [0, 0, 0, 0], w));
  }
  const tip = B.vert(t, 0.5, 1, ct, [0, 0, 0, 0], w);
  const bc = B.vert(v3madd(b, ax, -r * 0.2), 0.5, 0, cb, [0, 0, 0, 0], w);
  for (let k = 0; k < n; k++) { const a = base[k], c = base[(k + 1) % n]; B.tri(a, c, tip); B.tri(a, bc, c); }
  B.end(name);
}

/** Petal k's outer surface at u (base → tip) and v (−1 … 1 across), in the head frame (bind = world). */
function petalPoint(k: number, u: number, v: number): { p: V3; n: V3 } {
  const half = (Math.PI / WORM.petals) * 1.035;
  const a = (k / WORM.petals) * Math.PI * 2 + v * half;
  const d: V3 = [Math.sin(a), Math.cos(a), 0];
  // A blunt ogive: radius cos(u·π/2)^0.85 × R, forward sin(u·π/2) × length.
  const q = u * Math.PI / 2;
  const rr = WORM.petalR * 1.02 * Math.pow(Math.cos(q), 0.85), z = 0.15 + WORM.petalLen * Math.sin(q);
  const drr = -WORM.petalR * 1.02 * 0.85 * Math.pow(Math.max(1e-4, Math.cos(q)), -0.15) * Math.sin(q), dz = WORM.petalLen * Math.cos(q);
  // Normal in the (radial, z) plane, outwards.
  const l = Math.hypot(dz, drr) || 1;
  return { p: [d[0] * rr, d[1] * rr, z], n: [d[0] * (dz / l), d[1] * (dz / l), -drr / l] };
}

/** A thick shell from an outer grid (rows × cols) and its thickness per row: closed (both faces and the rim). */
function shell(B: Builder, outer: { p: V3; n: V3 }[][], thick: number[], colOut: (i: number, j: number) => V3, colIn: (i: number, j: number) => V3, glowIn: (i: number) => Glow, w: number[], name: string): void {
  const R = outer.length, C = outer[0].length;
  B.begin();
  const O: number[][] = [], I: number[][] = [];
  for (let i = 0; i < R; i++) {
    O.push([]); I.push([]);
    for (let j = 0; j < C; j++) {
      const { p, n } = outer[i][j];
      O[i].push(B.vert(p, j / (C - 1), i / (R - 1), colOut(i, j), [0, 0, 0, 0], w));
      I[i].push(B.vert(v3madd(p, n, -thick[i]), j / (C - 1), i / (R - 1), colIn(i, j), glowIn(i), w));
    }
  }
  const quad = (a: number, b: number, c: number, d: number) => { B.tri(a, b, c); B.tri(a, c, d); };
  for (let i = 0; i + 1 < R; i++) for (let j = 0; j + 1 < C; j++) {
    quad(O[i][j], O[i][j + 1], O[i + 1][j + 1], O[i + 1][j]);
    quad(I[i][j], I[i + 1][j], I[i + 1][j + 1], I[i][j + 1]);
  }
  // The rim: base row, tip row, both sides.
  for (let j = 0; j + 1 < C; j++) {
    quad(O[0][j], I[0][j], I[0][j + 1], O[0][j + 1]);
    quad(O[R - 1][j], O[R - 1][j + 1], I[R - 1][j + 1], I[R - 1][j]);
  }
  for (let i = 0; i + 1 < R; i++) {
    quad(O[i][0], O[i + 1][0], I[i + 1][0], I[i][0]);
    quad(O[i][C - 1], I[i][C - 1], I[i + 1][C - 1], O[i + 1][C - 1]);
  }
  B.end(name);
}

/** Signed volume of a part (positive: closed and facing out). */
function partVolume(B: Builder, part: { i0: number; i1: number }): number {
  const P = B.pos, I = B.idx;
  let V = 0;
  for (let t = part.i0; t < part.i1; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    V += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
  }
  return V;
}

export function buildWormSkin(): SkinData {
  const B = new Builder();
  // ---- the body: throat (folded in at the lip) → head → segments → tail tip
  type Ring = { pts: V3[]; u: number; vs: number[]; col: V3[]; glow: Glow[]; w: number[] };
  const rings: Ring[] = [];
  const vs = (_r: number) => Array.from({ length: AROUND + 1 }, (_, j) => (j / AROUND) * TILES);
  const along = (s: number) => s / ((2 * Math.PI * 4.2) / TILES);
  // The gullet: from deep inside out to the lip (z, radius), amber light from deep down.
  const throat: [number, number][] = [[-5.2, 0.42], [-4.7, 0.78], [-3.9, 1.12], [-3.0, 1.42], [-2.1, 1.72], [-1.3, 2.0], [-0.6, 2.28], [-0.15, 2.55]];
  for (const [z, r] of throat) {
    const pts: V3[] = [], col: V3[] = [], glow: Glow[] = [];
    const deep = saturate(-z / 5);
    for (let j = 0; j < AROUND; j++) {
      const th = (j / AROUND) * Math.PI * 2;
      // Ridged inside (folds every 30°).
      const rr = r * (1 + 0.06 * Math.cos(th * 12));
      pts.push([rr * Math.sin(th), rr * Math.cos(th), z]);
      col.push(mix3(LIP, GULLET, deep));
      glow.push([0, 0, 0, 0.25 + 0.75 * deep * deep]);
    }
    // (Inside the head the throat runs back: its points belong to the head's joints by depth.)
    rings.push({ pts, u: along(-z), vs: vs(r), col, glow, w: bodyWeights(-z) });
  }
  // The lip, rolled outwards.
  for (const [z, r] of [[0.05, 2.82], [-0.25, 3.12]] as [number, number][]) {
    const pts: V3[] = [], col: V3[] = [], glow: Glow[] = [];
    for (let j = 0; j < AROUND; j++) {
      const th = (j / AROUND) * Math.PI * 2;
      pts.push([r * Math.sin(th), r * Math.cos(th), z]);
      col.push(LIP);
      glow.push([0, 0, 0, 0.12]);
    }
    rings.push({ pts, u: along(-z), vs: vs(r), col, glow, w: bodyWeights(-z) });
  }
  const step = WORM.seg / PER_SEG;
  for (let s = 0.7; s < WORM_LENGTH - 0.3; s += step) {
    const r = ring(s);
    rings.push({ pts: r.pts, u: along(s), vs: vs(1), col: r.col, glow: r.glow, w: bodyWeights(s) });
  }
  const tipS = WORM_LENGTH + 0.6;
  B.begin();
  // (A tube and its two caps.)
  B.tube(rings, { p: [0, 0, -5.45], col: GULLET, glow: [0, 0, 0, 1] }, { p: [0, 0, -tipS], col: FLANK, glow: [0, 1, 0, 0] });
  B.end('body');

  // ---- bristles along the flanks (two each side per segment), swept back
  for (let i = 2; i < WORM.joints - 3; i++) {
    const s = (i + 0.55) * WORM.seg, R = wormRadius(s);
    for (const th of [1.25, 2.05, -1.25, -2.05]) {
      const d: V3 = [Math.sin(th), Math.cos(th), 0];
      const b = v3scale(d, R * 0.96);
      b[2] = -s;
      const len = (th === 1.25 || th === -1.25 ? 1.2 : 0.9) * (1 - s / (WORM_LENGTH * 1.6));
      const tip = v3add(b, v3add(v3scale(d, len * 0.65), [0, 0, -len * 0.75]));
      cone(B, b, tip, 0.2, HORN, HORN_TIP, bodyWeights(s), 'bristle');
    }
  }

  // ---- teeth in the throat: rings of hooked teeth, pointing in and back
  for (const [z, r, n, len] of [[-0.9, 2.12, 14, 0.85], [-2.1, 1.66, 12, 0.66], [-3.3, 1.22, 10, 0.5]] as [number, number, number, number][]) {
    for (let k = 0; k < n; k++) {
      const a = ((k + (n % 2) * 0.5) / n) * Math.PI * 2;
      const d: V3 = [Math.sin(a), Math.cos(a), 0];
      const b: V3 = [d[0] * (r + 0.12), d[1] * (r + 0.12), z];
      const tip: V3 = [d[0] * (r - len * 0.8), d[1] * (r - len * 0.8), z - len * 0.55];
      cone(B, b, tip, 0.17 + len * 0.08, TOOTH, TOOTH, bodyWeights(-z), 'throat tooth');
    }
  }

  // ---- the petals and their teeth
  const ROWS = 12, COLS = 9;
  for (let k = 0; k < WORM.petals; k++) {
    const bone = [WORM_BONES.petal0 + k, 1];
    const grid: { p: V3; n: V3 }[][] = [], thick: number[] = [];
    for (let i = 0; i < ROWS; i++) {
      const u = (i / (ROWS - 1)) * 0.985;
      const row: { p: V3; n: V3 }[] = [];
      for (let j = 0; j < COLS; j++) row.push(petalPoint(k, u, (j / (COLS - 1)) * 2 - 1));
      grid.push(row);
      thick.push(0.42 * (1 - u) + 0.07);
    }
    const ribs = (j: number) => (j === 2 || j === 4 || j === 6 ? 0.6 : 0);
    shell(B, grid, thick,
      (i, j) => mix3(mix3(PLATE, PLATE_EDGE, ribs(j) * 0.8 + (i === 0 ? 0.3 : 0)), CAP, 0.2),
      (i) => mix3(FLESH, LIP, i / ROWS),
      (i) => [0, 0, 0, 0.18 * (1 - i / ROWS)], bone, 'petal');
    // Teeth on the inside, facing in (forward once the petal is open), hooked towards its base.
    const rowsT: [number, number[]][] = [[0.16, [-0.65, -0.22, 0.22, 0.65]], [0.36, [-0.6, -0.2, 0.2, 0.6]], [0.56, [-0.45, 0, 0.45]], [0.74, [-0.25, 0.25]]];
    for (const [u, vsT] of rowsT) {
      const th = 0.42 * (1 - u) + 0.07;
      for (const v of vsT) {
        const o = petalPoint(k, u, v), back = petalPoint(k, Math.max(0, u - 0.08), v);
        const base = v3madd(o.p, o.n, -th * 0.85);
        const hook = v3norm(v3sub(back.p, o.p));
        const len = 0.95 * (1 - u * 0.55);
        const tip = v3add(v3madd(base, o.n, -len), v3scale(hook, len * 0.35));
        cone(B, base, tip, 0.16 + 0.06 * (1 - u), TOOTH, TOOTH, bone, 'petal tooth');
      }
    }
  }

  // Every part facing out (the winding of a fold or a shell depends on how it was laid out).
  for (const part of B.parts) {
    if (partVolume(B, part) >= 0) continue;
    for (let t = part.i0; t < part.i1; t += 3) { const a = B.idx[t + 1]; B.idx[t + 1] = B.idx[t + 2]; B.idx[t + 2] = a; }
  }
  const normal = B.normals();
  return {
    position: Float32Array.from(B.pos), normal, uv: Float32Array.from(B.uv), color: Float32Array.from(B.col), glow: Float32Array.from(B.glow),
    skinIndex: Uint16Array.from(B.si), skinWeight: Float32Array.from(B.sw), index: Uint32Array.from(B.idx), parts: B.parts,
  };
}

/** The petals' hinges (for the rig's tests: they sit on the lip). */
export const PETAL_HINGES = Array.from({ length: WORM.petals }, (_, k) => petalHinge(k));
