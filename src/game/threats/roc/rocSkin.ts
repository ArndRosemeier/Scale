/**
 * The Roc's skin (pure, tested like the Burrower's): closed parts lofted round the bind pose of
 * `rocRig.ts` and skinned to its bones. Every part is watertight, consistently wound and faces out.
 *
 *   body     ONE tube from the tail's root along the back, over the deep breast, up the neck and
 *            the head to the hooked tip of the upper beak: dark brown above, tawny and streaked
 *            below, a paler golden head with a ruff, a horn-yellow beak darkening to the hook. The
 *            eyes are amber spots on the head's sides (the `eyes` glow channel).
 *   jaw      the lower beak, hinged under the upper.
 *   wings    per side a thick tapered aerofoil from the shoulder to the hand, its trailing edge
 *            scalloped by the secondaries' tips (coverts lighter, flight feathers dark with pale
 *            bars), and seven long primaries fanned from the hand: the fingered wingtip.
 *   tail     nine broad feathers fanned from the tail's root (spread by scaling the fan bone).
 *   legs     feathered thighs ("trousers"), scaly yellow shanks, three toes forward and one back,
 *            each with a black hooked talon.
 *
 * Vertex attributes as the creature material wants them (`CreatureMesh`): colour, glow (x ridge, y
 * order, z throat, w eyes), uv (scales: they read as feather texture at this size), four influences.
 */
import { Builder, type V3, type Glow, type SkinData } from '../rig/skin';
import { saturate, smoothstep, lerp, v3norm, v3cross, v3sub, v3madd, v3add } from '../../../core/math';
import { ROC, ROC_BONES, ROC_BIND } from './rocRig';

// ------------------------------------------------------------------ colours (linear RGB)

const BACK: V3 = [0.03, 0.019, 0.011], BACK_EDGE: V3 = [0.06, 0.04, 0.022], BREAST: V3 = [0.12, 0.085, 0.05], STREAK: V3 = [0.05, 0.03, 0.016];
const HEAD: V3 = [0.16, 0.105, 0.045], RUFF: V3 = [0.22, 0.17, 0.1], BEAK: V3 = [0.36, 0.27, 0.07], HOOK: V3 = [0.035, 0.03, 0.025];
const EYE: V3 = [0.25, 0.12, 0.01], COVERT: V3 = [0.075, 0.05, 0.028], FLIGHT: V3 = [0.022, 0.016, 0.012], BAR: V3 = [0.09, 0.075, 0.06];
const UNDERWING: V3 = [0.1, 0.08, 0.06], TAIL: V3 = [0.045, 0.03, 0.018], TAIL_BAND: V3 = [0.12, 0.1, 0.075];
const SHANK: V3 = [0.32, 0.23, 0.05], TALON: V3 = [0.012, 0.011, 0.01];

const NO: Glow = [0, 0, 0, 0];
const AROUND = 24;

const mix3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
function hash2(x: number, y: number): number { const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return s - Math.floor(s); }

/** Blend between neighbouring bones along a coordinate: [[at, bone], …] sorted by `at`. */
function blend(keys: [number, number][], v: number, soft = 0.6): number[] {
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
function loft(B: Builder, name: string, st: { c: V3; rx: number; ry: number }[], up: V3,
  col: (i: number, th: number, p: V3) => V3, glow: (i: number, th: number, p: V3) => Glow, w: (i: number) => number[], n = AROUND, closeA = true, closeB = true): void {
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
    rings.push({ pts, u: along / 2.2, vs: Array.from({ length: n + 1 }, (_, j) => (j / n) * 6), col: cs, glow: gs, w: w(i) });
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
function spline(keys: [V3, number, number][], per: number): { c: V3; rx: number; ry: number }[] {
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
function blade(B: Builder, name: string, root: V3, axis: V3, len: number, across: V3, norm: V3, rows: number,
  ch: (u: number) => number, off: (u: number) => number, th: (u: number, v: number) => number,
  col: (u: number, v: number, top: boolean) => V3, w: (u: number) => number[], n = 14): void {
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
  const rings = st.map((s, i) => ({ pts: s.pts, u: i / (rows - 1) * len / 2.2, vs: Array.from({ length: n + 1 }, (_, j) => j / n * 2), col: s.col, glow: s.col.map(() => NO), w: w(i / (rows - 1)) }));
  const cA = v3madd(root, axis, -0.02 * len), cB = v3madd(root, axis, len * 1.01);
  B.tube(rings, { p: v3madd(cA, across, off(0)), col: st[0].col[0], glow: NO }, { p: v3madd(cB, across, off(1)), col: st[rows - 1].col[0], glow: NO });
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

/** The body's centreline keys (bind): centre, half width, half height. */
export const ROC_BODY: [V3, number, number][] = [
  [[0, 0.45, -6.7], 0.55, 0.4],
  [[0, 0.35, -6.1], 0.95, 0.7],
  [[0, 0.1, -4.6], 1.75, 1.55],
  [[0, -0.1, -2.2], 2.35, 2.05],
  [[0, -0.15, 0.4], 2.4, 2.3],
  [[0, 0.35, 2.3], 1.9, 1.85],
  [[0, 0.95, 3.4], 1.25, 1.3],
  [[0, 1.4, 4.7], 0.95, 1.0],
  [[0, 1.8, 6.0], 0.85, 0.92],
  [[0, 2.05, 6.85], 1.0, 1.05],
  [[0, 2.12, 7.7], 0.98, 0.98],
  [[0, 1.98, 8.45], 0.6, 0.72],
  [[0, 1.78, 9.25], 0.34, 0.48],
  [[0, 1.4, 9.85], 0.14, 0.24],
  [ROC.beakTip, 0.03, 0.05],
];

export function buildRocSkin(): SkinData {
  const B = new Builder();
  const b = ROC_BONES;

  // ---- body, neck, head, upper beak
  const st = spline(ROC_BODY, 3.2);
  const eyeL: V3 = [0.86, 2.3, 7.75], eyeR: V3 = [-0.86, 2.3, 7.75];
  loft(B, 'body', st, [0, 1, 0],
    (i, th, p) => {
      const z = st[i].c[2], top = Math.cos(th);
      const n = hash2(Math.round(p[2] * 3), Math.round(th * 6));
      if (z > 8.2) return mix3(BEAK, HOOK, smoothstep(9.2, 9.9, z));
      // Head and neck: golden, a pale ruff where the neck meets the head.
      const headK = smoothstep(3.6, 5.6, z);
      const ruff = Math.exp(-(((z - 6.1) / 0.45) ** 2)) * 0.8;
      // Back dark, breast tawny with streaks.
      const below = smoothstep(0.25, -0.45, top);
      let c = mix3(mix3(BACK, BACK_EDGE, n * 0.5), mix3(BREAST, STREAK, n > 0.62 ? 0.8 : 0), below);
      c = mix3(c, HEAD, headK * (0.7 + 0.3 * n));
      c = mix3(c, RUFF, ruff);
      // The eyes (amber) and a dark brow above them.
      const de = Math.min(Math.hypot(p[0] - eyeL[0], p[1] - eyeL[1], p[2] - eyeL[2]), Math.hypot(p[0] - eyeR[0], p[1] - eyeR[1], p[2] - eyeR[2]));
      if (de < 0.27) c = mix3(EYE, [0.01, 0.008, 0.005], de < 0.1 ? 1 : 0);
      else if (de < 0.55 && p[1] > eyeL[1]) c = mix3(c, BACK, 0.7);
      return c;
    },
    (_i, _th, p) => {
      const de = Math.min(Math.hypot(p[0] - eyeL[0], p[1] - eyeL[1], p[2] - eyeL[2]), Math.hypot(p[0] - eyeR[0], p[1] - eyeR[1], p[2] - eyeR[2]));
      return [0, saturate((p[2] + 7) / 17), 0, de < 0.27 && de >= 0.1 ? 0.3 : 0];
    },
    (i) => blend([[-6.6, b.tail], [-4.4, b.pelvis], [0, b.chest], [3.5, b.neck0], [4.8, b.neck0 + 1], [6.0, b.neck0 + 2], [7.0, b.head]], st[i].c[2], 0.5),
  );

  // ---- lower beak (on the jaw's hinge)
  const J = ROC_BIND[b.jaw];
  const jaw = spline([[[0, J[1] + 0.05, J[2] - 0.3], 0.55, 0.32], [[0, J[1] - 0.05, J[2] + 0.6], 0.45, 0.26], [[0, J[1] - 0.2, J[2] + 1.3], 0.22, 0.14], [[0, J[1] - 0.32, J[2] + 1.7], 0.05, 0.04]], 4);
  loft(B, 'jaw', jaw, [0, 1, 0], (i) => mix3(BEAK, HOOK, i / jaw.length * 0.6), () => NO, () => [b.jaw, 1], 14);

  // ---- wings
  for (const side of [1, -1]) {
    const w = b.wing(side), p = b.prim(side);
    const x0 = ROC_BIND[w][0], xE = ROC_BIND[w + 1][0], xW = ROC_BIND[w + 2][0], xH = ROC_BIND[p][0];
    const z0 = ROC_BIND[w][2], y0 = ROC_BIND[w][1];
    const span = Math.abs(xH - x0);
    // The leading edge from the shoulder out (swept a touch forward at the wrist), the chord narrowing.
    const lead = (u: number) => z0 + 0.25 + 0.35 * Math.sin(u * Math.PI * 0.9);
    const chord = (u: number) => lerp(5.6, 2.6, Math.pow(u, 1.3));
    // The trailing edge scalloped by the secondaries' tips.
    const scallop = (u: number) => (u < 0.97 ? 0.3 * Math.abs(Math.sin(u * Math.PI * 13)) : 0);
    blade(B, 'wing', [x0 - side * 0.6, y0 - 0.1, 0], [side, 0, 0], span + 0.6, [0, 0, -1], [0, 1, 0], 26,
      (u) => (chord(u) - scallop(u)) / 2,
      // (across is −Z: the middle sits half a chord behind the leading edge.)
      (u) => -lead(u) + (chord(u) - scallop(u)) / 2,
      (u, v) => lerp(0.75, 0.16, u) * (v < -0.6 ? 1 : 1 - 0.65 * smoothstep(-0.6, 1, v)) + 0.03,
      (u, v, top) => {
        if (!top) return mix3(UNDERWING, FLIGHT, smoothstep(0.2, 0.9, v) * 0.7);
        const k = smoothstep(-0.2, 0.35, v);
        const bar = Math.sin(u * 40 + v * 3) > 0.75 && k > 0.5 ? 0.6 : 0;
        return mix3(mix3(COVERT, BACK, hash2(Math.round(u * 30), Math.round(v * 4)) * 0.4), mix3(FLIGHT, BAR, bar), k);
      },
      (u) => {
        const x = x0 - side * 0.6 + side * u * (span + 0.6);
        const ax = Math.abs(x);
        return [...blend([[Math.abs(x0) - 0.4, b.chest], [Math.abs(x0) + 0.5, w], [Math.abs(xE), w + 1], [Math.abs(xW), w + 2], [Math.abs(xH) + 0.4, p]], ax, 0.45)];
      });
    // The primaries: seven long feathers fanned from the hand (outermost reaching furthest forward).
    for (let k = 0; k < 7; k++) {
      const q = k / 6;
      const ang = lerp(0.2, -0.9, q);             // from the span axis, + forward
      const len = lerp(6.6, 4.6, q);
      const at = lerp(xH - side * 0.2, xW + side * 0.4, q);
      const rootZ = lead((Math.abs(at) - Math.abs(x0)) / span) - lerp(0.4, 1.3, q);
      const ax: V3 = v3norm([side * Math.cos(ang), 0, Math.sin(ang)]);
      const acr: V3 = v3norm(v3cross([0, 1, 0], ax));
      const bars = (u: number) => (Math.sin(u * 22) > 0.7 ? 0.5 : 0);
      blade(B, 'primary', [at, y0 - 0.05 - q * 0.06, rootZ], ax, len, acr, [0, 1, 0], 12,
        (u) => lerp(0.55, 0.42, u) * (u > 0.82 ? Math.sqrt(Math.max(0.05, (1 - u) / 0.18)) : 1),
        () => 0,
        (u) => lerp(0.2, 0.06, u),
        (u, _v, top) => (top ? mix3(FLIGHT, BAR, bars(u)) : mix3(UNDERWING, FLIGHT, 0.5)),
        (u) => (u < 0.12 ? [w + 2, 1 - u / 0.12, p, u / 0.12] : [p, 1]), 10);
    }
  }

  // ---- tail: nine feathers fanned from the fan bone
  const F = ROC_BIND[b.fan];
  for (let k = 0; k < 9; k++) {
    const q = k / 8 * 2 - 1;                      // −1 … 1 across
    const ang = q * 0.55;
    const ax: V3 = v3norm([Math.sin(ang), 0.02, -Math.cos(ang)]);
    const acr: V3 = v3norm(v3cross([0, 1, 0], ax));
    const len = 5.6 - Math.abs(q) * 0.7;
    blade(B, 'tail', [F[0] + q * 0.5, F[1] + 0.06 * (1 - Math.abs(q)), F[2] + 0.4], ax, len, acr, [0, 1, 0], 10,
      (u) => lerp(0.55, 0.75, u) * (u > 0.85 ? Math.sqrt(Math.max(0.05, (1 - u) / 0.15)) : 1),
      () => 0,
      (u) => lerp(0.24, 0.1, u),
      (u, _v, top) => (top ? mix3(TAIL, TAIL_BAND, Math.sin(u * 18) > 0.6 ? 0.8 : 0) : mix3(UNDERWING, TAIL_BAND, 0.4)),
      (u) => (u < 0.15 ? [b.tail, 1 - u / 0.15, b.fan, u / 0.15] : [b.fan, 1]), 10);
  }

  // ---- legs
  for (const side of [1, -1]) {
    const l = b.leg(side), H = ROC_BIND[l], K = ROC_BIND[l + 1], A = ROC_BIND[l + 2];
    // Feathered thigh, from inside the belly down to the knee.
    const thigh = spline([[[H[0] * 0.7, H[1] + 0.9, H[2]], 0.9, 0.9], [[H[0], H[1], H[2]], 1.0, 1.0], [[K[0], K[1] + 1.0, K[2]], 0.75, 0.75], [[K[0], K[1] - 0.2, K[2]], 0.45, 0.45]], 3);
    loft(B, 'thigh', thigh, [0, 0, 1], (i, th) => mix3(BREAST, STREAK, hash2(i, Math.round(th * 5)) > 0.6 ? 0.7 : 0), () => NO,
      (i) => { const y = thigh[i].c[1]; return y > H[1] + 0.4 ? [b.pelvis, 0.6, l, 0.4] : y < K[1] + 0.3 ? [l, 0.5, l + 1, 0.5] : [l, 1]; }, 16);
    // Scaly shank.
    const shank = spline([[[K[0], K[1] + 0.3, K[2]], 0.38, 0.38], [[A[0], A[1] + 0.3, A[2]], 0.32, 0.32], [[A[0], A[1] - 0.15, A[2]], 0.34, 0.34]], 3);
    loft(B, 'shank', shank, [0, 0, 1], () => SHANK, () => NO, (i) => (shank[i].c[1] > K[1] - 0.2 ? [l, 0.4, l + 1, 0.6] : shank[i].c[1] < A[1] + 0.25 ? [l + 1, 0.5, l + 2, 0.5] : [l + 1, 1]), 12);
    // Toes: three forward, one back, each ending in a hooked talon.
    const toes: [number, number][] = [[0.0, 1.9], [0.45, 1.6], [-0.45, 1.6], [Math.PI, 1.15]];
    for (const [a, len] of toes) {
      const d: V3 = [Math.sin(a) * side, 0, Math.cos(a)];
      const p0: V3 = [A[0], A[1] - 0.2, A[2]];
      const p1 = v3madd(p0, d, len * 0.55), p2 = v3add(v3madd(p0, d, len), [0, -0.05, 0]);
      const toe = spline([[p0, 0.26, 0.24], [p1, 0.22, 0.2], [p2, 0.17, 0.16]], 4);
      loft(B, 'toe', toe, [0, 1, 0], () => SHANK, () => NO, () => [l + 2, 1], 10);
      // The talon: a curved cone down and forward.
      const t0 = v3madd(p2, d, 0.05), t1 = v3add(v3madd(t0, d, 0.45), [0, -0.12, 0]), t2 = v3add(v3madd(t0, d, 0.62), [0, -0.5, 0]);
      const tal = spline([[t0, 0.16, 0.18], [t1, 0.1, 0.12], [t2, 0.02, 0.02]], 8);
      loft(B, 'talon', tal, [0, 1, 0], () => TALON, () => NO, () => [l + 2, 1], 8);
    }
  }

  // Every part facing out.
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
