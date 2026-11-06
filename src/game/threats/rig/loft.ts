/**
 * Lofting helpers for the creatures' skins (`skin.ts` Builder): closed tubes through stations
 * (`loft`, `spline`), flat feathers / aerofoils / membranes (`blade`), bone blends along a
 * coordinate (`blend`), and turning a part to face out (`faceOut`). Shared by the Roc and the
 * cathedral gargoyle (game/citizens/gargoyle).
 */
import { Builder, type V3, type Glow } from './skin';
import { lerp, smoothstep, v3norm, v3cross, v3sub, v3madd } from '../../../core/math';

/** Texture density: metres per uv unit along a part, uv units round it. */
export interface UvScale { along: number; around: number }
const ROC_UV: UvScale = { along: 2.2, around: 6 };
const NO: Glow = [0, 0, 0, 0];
const AROUND = 24;

export const mix3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export function hash2(x: number, y: number): number { const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return s - Math.floor(s); }

/** Blend between neighbouring bones along a coordinate: [[at, bone], …] sorted by `at`. */
export function blend(keys: [number, number][], v: number, soft = 0.6): number[] {
  if (v <= keys[0][0]) return [keys[0][1], 1];
  for (let i = 1; i < keys.length; i++) {
    const [a0, b0] = keys[i - 1], [a1, b1] = keys[i];
    if (v > a1) continue;
    // Each joint's influence changes over ±soft around the boundary halfway between keys.
    const mid = (a0 + a1) / 2, k = smoothstep(mid - soft, mid + soft, v);
    return [b0, 1 - k, b1, k];
  }
  return [keys[keys.length - 1][1], 1];
}

/** A tube through stations (centre, half width, half height, colour/glow per angle), oriented by `up`. */
export function loft(B: Builder, name: string, st: { c: V3; rx: number; ry: number }[], up: V3,
  col: (i: number, th: number, p: V3) => V3, glow: (i: number, th: number, p: V3) => Glow, w: (i: number) => number[], n = AROUND, closeA = true, closeB = true, uv: UvScale = ROC_UV): void {
  B.begin();
  const rings: { pts: V3[]; u: number; vs: number[]; col: V3[]; glow: Glow[]; w: number[] }[] = [];
  let along = 0;
  for (let i = 0; i < st.length; i++) {
    const a = st[Math.max(0, i - 1)].c, b = st[Math.min(st.length - 1, i + 1)].c;
    const t = v3norm(v3sub(b, a));
    const r = v3norm(v3cross(up, t)), u = v3cross(t, r);
    if (i) along += Math.hypot(st[i].c[0] - st[i - 1].c[0], st[i].c[1] - st[i - 1].c[1], st[i].c[2] - st[i - 1].c[2]);
    const pts: V3[] = [], cs: V3[] = [], gs: Glow[] = [];
    for (let j = 0; j < n; j++) {
      const th = (j / n) * Math.PI * 2;
      const p = v3madd(v3madd(st[i].c, r, Math.sin(th) * st[i].rx), u, Math.cos(th) * st[i].ry);
      pts.push(p); cs.push(col(i, th, p)); gs.push(glow(i, th, p));
    }
    rings.push({ pts, u: along / uv.along, vs: Array.from({ length: n + 1 }, (_, j) => (j / n) * uv.around), col: cs, glow: gs, w: w(i) });
  }
  const end = (k: number, dir: number) => {
    const s = st[k], o = st[Math.max(0, Math.min(st.length - 1, k - dir))];
    const t = v3norm(v3sub(s.c, o.c));
    return { p: v3madd(s.c, t, Math.min(s.rx, s.ry) * 0.6), col: rings[k].col[0], glow: rings[k].glow[0] };
  };
  B.tube(rings, closeA ? end(0, -1) : null, closeB ? end(st.length - 1, 1) : null);
  B.end(name);
}

/** Catmull-Rom through key points (centre, rx, ry), `per` stations per metre. */
export function spline(keys: [V3, number, number][], per: number): { c: V3; rx: number; ry: number }[] {
  const out: { c: V3; rx: number; ry: number }[] = [];
  for (let i = 0; i + 1 < keys.length; i++) {
    const p0 = keys[Math.max(0, i - 1)][0], p1 = keys[i][0], p2 = keys[i + 1][0], p3 = keys[Math.min(keys.length - 1, i + 2)][0];
    const L = Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]);
    const m = Math.max(2, Math.ceil(L * per));
    for (let k = 0; k < m; k++) {
      const t = k / m, t2 = t * t, t3 = t2 * t;
      const c = [0, 1, 2].map((a) => 0.5 * (2 * p1[a] + (-p0[a] + p2[a]) * t + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2 + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * t3)) as V3;
      out.push({ c, rx: lerp(keys[i][1], keys[i + 1][1], t), ry: lerp(keys[i][2], keys[i + 1][2], t) });
    }
  }
  const last = keys[keys.length - 1];
  out.push({ c: last[0], rx: last[1], ry: last[2] });
  return out;
}

/**
 * A flat feather or aerofoil: stations along `axis` from `root`, each a lens across `across` (unit)
 * of half chord `ch(u)` (offset `off(u)` along `across`), thickness `th(u, v)` along `norm`.
 */
export function blade(B: Builder, name: string, root: V3, axis: V3, len: number, across: V3, norm: V3, rows: number,
  ch: (u: number) => number, off: (u: number) => number, th: (u: number, v: number) => number,
  col: (u: number, v: number, top: boolean) => V3, w: (u: number) => number[], n = 14, uv: UvScale = { along: 2.2, around: 2 }): void {
  const st: { pts: V3[]; col: V3[] }[] = [];
  for (let i = 0; i < rows; i++) {
    const u = i / (rows - 1) * 0.995;
    const c = v3madd(root, axis, u * len);
    const pts: V3[] = [], cs: V3[] = [];
    for (let j = 0; j < n; j++) {
      const ph = (j / n) * Math.PI * 2;
      // v: −1 (one edge) … 1 (the other) across; top half (sin > 0) and bottom.
      const v = -Math.cos(ph), h = Math.sin(ph);
      const p = v3madd(v3madd(c, across, off(u) + v * ch(u)), norm, h * th(u, v) * 0.5);
      pts.push(p); cs.push(col(u, v, h >= 0));
    }
    st.push({ pts, col: cs });
  }
  B.begin();
  const rings = st.map((s, i) => ({ pts: s.pts, u: i / (rows - 1) * len / uv.along, vs: Array.from({ length: n + 1 }, (_, j) => j / n * uv.around), col: s.col, glow: s.col.map(() => NO), w: w(i / (rows - 1)) }));
  const cA = v3madd(root, axis, -0.02 * len), cB = v3madd(root, axis, len * 1.01);
  B.tube(rings, { p: v3madd(cA, across, off(0)), col: st[0].col[0], glow: NO }, { p: v3madd(cB, across, off(1)), col: st[rows - 1].col[0], glow: NO });
  B.end(name);
}

export function partVolume(B: Builder, part: { i0: number; i1: number }): number {
  const P = B.pos, I = B.idx;
  let V = 0;
  for (let t = part.i0; t < part.i1; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    V += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
  }
  return V;
}

/** Turn every part of the builder that faces in (negative volume) to face out. */
export function faceOut(B: Builder): void {
  for (const part of B.parts) {
    if (partVolume(B, part) >= 0) continue;
    for (let t = part.i0; t < part.i1; t += 3) { const a = B.idx[t + 1]; B.idx[t + 1] = B.idx[t + 2]; B.idx[t + 2] = a; }
  }
}
