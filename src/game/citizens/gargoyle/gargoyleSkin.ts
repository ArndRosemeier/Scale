/**
 * The gargoyle's skin (pure, tested like the Roc's): closed parts lofted round the bind pose of
 * `gargoyleRig.ts` and skinned to its bones, in weathered cathedral limestone.
 *
 *   body     one tube from the seat up the pot belly, the barrel chest and the hunched shoulders to
 *            the neck, a ridge of knobs down the spine.
 *   head     a big round skull with a heavy brow, deep-set eyes (the `eyes` glow channel: they light
 *            amber at night), a broad flat nose, curled horns sweeping back, pointed ears, and the
 *            lower jaw on its hinge with two little tusks (a grin, not a snarl).
 *   arms     thick upper arms and forearms, hands with three blunt claws.
 *   legs     squat thighs, shins, feet with three clawed toes.
 *   wings    per side a stone bat wing: the arm of it along the leading edge, the membrane between
 *            the fingers scalloped at the trailing edge, inner and outer halves on their own bones.
 *   tail     a tapering tail ending in a spade.
 *
 * Colours: pale grey stone darkening in the creases and down the back where the rain ran (six
 * hundred years of being a waterspout), lichen in yellow-green patches, moss on the feet.
 */
import { Builder, type V3, type Glow, type SkinData } from '../../threats/rig/skin';
import { lerp, saturate, smoothstep, v3norm, v3cross, v3madd, v3add } from '../../../core/math';
import { mix3, hash2, blend, loft, spline, blade, faceOut, type UvScale } from '../../threats/rig/loft';
import { GARGOYLE, GARGOYLE_BONES, GARGOYLE_BIND } from './gargoyleRig';

// ------------------------------------------------------------------ colours (linear RGB)

const STONE: V3 = [0.27, 0.26, 0.235], PALE: V3 = [0.37, 0.355, 0.32], DARK: V3 = [0.14, 0.135, 0.125], STREAK: V3 = [0.2, 0.19, 0.17];
const LICHEN: V3 = [0.33, 0.32, 0.13], MOSS: V3 = [0.09, 0.13, 0.04], EYE: V3 = [0.22, 0.12, 0.03], PUPIL: V3 = [0.03, 0.02, 0.01];
const NO: Glow = [0, 0, 0, 0];
/** Stone grain: weathered chisel facets about 15 cm across. */
const UV: UvScale = { along: 1.5, around: 1 };

const b = GARGOYLE_BONES;
const J = (bone: number): V3 => GARGOYLE_BIND[bone];

/** Weathered stone at a point: pale on top, dark in the creases, rain streaks, lichen patches. */
function stone(p: V3, top: number, crease = 0): V3 {
  const n = hash2(Math.round(p[0] * 9), Math.round(p[1] * 9) + Math.round(p[2] * 9) * 7);
  let c = mix3(STONE, PALE, saturate(top * 0.6 + 0.2) * (0.6 + 0.4 * n));
  // Rain streaks: vertical bands, darker toward the back.
  const streak = Math.sin(p[0] * 47 + Math.sin(p[2] * 13) * 2) > 0.72 ? 0.55 : 0;
  c = mix3(c, STREAK, streak * smoothstep(0.1, -0.2, p[2]) + crease);
  const lich = hash2(Math.round(p[0] * 4 + 3), Math.round(p[1] * 4) * 3 + Math.round(p[2] * 4));
  if (lich > 0.86) c = mix3(c, LICHEN, 0.7);
  return c;
}

function eyesOf(): { L: V3; R: V3 } {
  const H = J(b.head);
  return { L: [H[0] + 0.065, H[1] + 0.085, H[2] + 0.15], R: [H[0] - 0.065, H[1] + 0.085, H[2] + 0.15] };
}

export function buildGargoyleSkin(): SkinData {
  const B = new Builder();
  const C = J(b.chest), N = J(b.neck), H = J(b.head);

  // ---- body: seat, pot belly, chest, shoulders, neck (vertical, depth along Z)
  const body = spline([
    [[0, -0.13, -0.01], 0.1, 0.09],
    [[0, -0.06, 0.0], 0.19, 0.16],
    [[0, 0.08, 0.05], 0.23, 0.21],
    [[0, 0.22, 0.05], 0.22, 0.19],
    [[0, C[1] + 0.02, 0.01], 0.24, 0.16],
    [[0, C[1] + 0.17, -0.02], 0.28, 0.15],
    [[0, N[1] - 0.02, 0.0], 0.15, 0.11],
    [[0, N[1] + 0.07, 0.03], 0.085, 0.085],
    [[0, H[1] + 0.02, 0.05], 0.07, 0.07],
  ], 16);
  loft(B, 'body', body, [0, 0, 1],
    (i, th, p) => {
      // Front (th 0) paler; the belly's crease under the chest; the back where the water ran darker.
      const front = Math.cos(th), y = body[i].c[1];
      const crease = Math.exp(-(((y - 0.3) / 0.03) ** 2)) * 0.35 * saturate(front);
      return stone(p, 0.5 + front * 0.3, crease + (front < -0.3 ? 0.15 : 0));
    },
    () => NO,
    (i) => blend([[-0.05, b.pelvis], [C[1], b.chest], [N[1], b.neck], [H[1] + 0.02, b.head]], body[i].c[1], 0.1),
    20, true, true, UV);
  // Spine knobs down the back.
  for (let k = 0; k < 6; k++) {
    const y = 0.05 + k * 0.11, z = -0.17 + (k > 3 ? 0.03 * (k - 3) : 0) - (k < 2 ? 0.02 : 0);
    const knob = spline([[[0, y, z + 0.04], 0.035, 0.035], [[0, y + 0.01, z - 0.03], 0.03, 0.03], [[0, y + 0.02, z - 0.05], 0.008, 0.008]], 30);
    loft(B, 'knob', knob, [0, 1, 0], (_i, _t, p) => stone(p, 0.3, 0.1), () => NO, () => (y > C[1] - 0.05 ? [b.chest, 1] : [b.pelvis, 1]), 8, true, true, UV);
  }

  // ---- head (along Z from the back of the skull to the nose)
  const head = spline([
    [[0, H[1] + 0.06, H[2] - 0.12], 0.06, 0.06],
    [[0, H[1] + 0.08, H[2] - 0.08], 0.12, 0.12],
    [[0, H[1] + 0.08, H[2] - 0.01], 0.15, 0.14],
    [[0, H[1] + 0.07, H[2] + 0.07], 0.16, 0.13],
    [[0, H[1] + 0.05, H[2] + 0.13], 0.145, 0.105],
    [[0, H[1] + 0.03, H[2] + 0.19], 0.12, 0.075],
    [[0, H[1] + 0.035, H[2] + 0.235], 0.085, 0.05],
    [[0, H[1] + 0.03, H[2] + 0.26], 0.04, 0.03],
  ], 30);
  const E = eyesOf();
  const eyeD = (p: V3) => Math.min(Math.hypot(p[0] - E.L[0], p[1] - E.L[1], p[2] - E.L[2]), Math.hypot(p[0] - E.R[0], p[1] - E.R[1], p[2] - E.R[2]));
  loft(B, 'head', head, [0, 1, 0],
    (i, th, p) => {
      const de = eyeD(p), z = head[i].c[2] - H[2];
      if (de < 0.03) return de < 0.012 ? PUPIL : EYE;
      // The brow's shadow over the eyes, the nostrils dark, the mouth line under the snout.
      if (de < 0.05) return DARK;
      const top = Math.cos(th);
      const mouth = top < -0.55 && z > 0.05 ? 0.4 : 0;
      const nostril = z > 0.22 && Math.abs(p[0]) > 0.012 && Math.abs(p[0]) < 0.035 && top > -0.2 && top < 0.4 ? 0.6 : 0;
      return stone(p, 0.4 + top * 0.4, mouth + nostril);
    },
    (_i, _th, p) => [0, 0, 0, eyeD(p) < 0.03 && eyeD(p) >= 0.012 ? 1 : 0],
    () => [b.head, 1], 22, true, true, UV);
  // The eyes: a small stone ball each, set into the face under the brow, that glow amber at night.
  for (const s of [1, -1]) {
    const ex = s * 0.074, ey = H[1] + 0.082, ez = H[2] + 0.19;
    const ball = spline([[[ex, ey, ez - 0.026], 0.006, 0.006], [[ex, ey, ez - 0.014], 0.022, 0.02], [[ex, ey, ez], 0.027, 0.024], [[ex, ey, ez + 0.012], 0.021, 0.019], [[ex, ey, ez + 0.022], 0.006, 0.006]], 40);
    loft(B, 'eye', ball, [0, 1, 0], () => EYE, () => [0, 0, 0, 1], () => [b.head, 1], 12, true, true, UV);
  }
  // The brow: a heavy ridge over each eye.
  for (const s of [1, -1]) {
    const brow = spline([[[s * 0.02, H[1] + 0.13, H[2] + 0.15], 0.025, 0.02], [[s * 0.075, H[1] + 0.135, H[2] + 0.145], 0.035, 0.025], [[s * 0.125, H[1] + 0.125, H[2] + 0.1], 0.02, 0.018]], 40);
    loft(B, 'brow', brow, [0, 1, 0], (_i, _t, p) => stone(p, 0.7), () => NO, () => [b.head, 1], 10, true, true, UV);
  }
  // Horns: from the top of the skull, curling back and up, then out.
  for (const s of [1, -1]) {
    const horn = spline([
      [[s * 0.07, H[1] + 0.17, H[2] + 0.02], 0.04, 0.04],
      [[s * 0.11, H[1] + 0.25, H[2] - 0.04], 0.032, 0.032],
      [[s * 0.15, H[1] + 0.3, H[2] - 0.13], 0.022, 0.022],
      [[s * 0.2, H[1] + 0.28, H[2] - 0.2], 0.012, 0.012],
      [[s * 0.23, H[1] + 0.31, H[2] - 0.23], 0.003, 0.003],
    ], 40);
    loft(B, 'horn', horn, [0, 1, 0], (i, _t, p) => mix3(stone(p, 0.6), DARK, (i / horn.length) * 0.4), () => NO, () => [b.head, 1], 10, true, true, UV);
  }
  // Ears: flat pointed blades out to the sides.
  for (const s of [1, -1]) {
    const root: V3 = [s * 0.13, H[1] + 0.07, H[2] + 0.0];
    const ax = v3norm([s, 0.55, -0.35]);
    const across = v3norm(v3cross(ax, [0, 0, 1]));
    blade(B, 'ear', root, ax, 0.13, across, v3norm(v3cross(across, ax)), 7,
      (u) => lerp(0.04, 0.004, u), () => 0, (u) => lerp(0.028, 0.008, u),
      (u, _v, top) => mix3(STONE, DARK, top ? 0.1 : 0.35 + u * 0.2), () => [b.head, 1], 10, UV);
  }

  // ---- jaw (on its hinge), with two tusks
  const JW = J(b.jaw);
  const jaw = spline([
    [[0, JW[1] - 0.005, JW[2] - 0.05], 0.11, 0.045],
    [[0, JW[1] - 0.02, JW[2] + 0.05], 0.12, 0.045],
    [[0, JW[1] - 0.03, JW[2] + 0.14], 0.1, 0.038],
    [[0, JW[1] - 0.025, JW[2] + 0.2], 0.06, 0.025],
  ], 30);
  loft(B, 'jaw', jaw, [0, 1, 0], (_i, th, p) => stone(p, 0.2 + Math.cos(th) * 0.3, Math.cos(th) > 0.6 ? 0.35 : 0), () => NO, () => [b.jaw, 1], 18, true, true, UV);
  for (const s of [1, -1]) {
    const t0: V3 = [s * 0.06, JW[1] - 0.0, JW[2] + 0.15];
    const tusk = spline([[t0, 0.014, 0.014], [v3add(t0, [s * 0.006, 0.035, 0.005]), 0.009, 0.009], [v3add(t0, [s * 0.012, 0.055, 0.0]), 0.002, 0.002]], 80);
    loft(B, 'tusk', tusk, [0, 0, 1], () => PALE, () => NO, () => [b.jaw, 1], 8, true, true, UV);
  }

  // ---- arms
  for (const s of [1, -1]) {
    const a = b.arm(s), S = J(a), El = J(a + 1), Wr = J(a + 2);
    const arm = spline([
      [[S[0] - s * 0.02, S[1] + 0.05, S[2]], 0.075, 0.075],
      [[S[0], S[1] - 0.05, S[2]], 0.085, 0.08],
      [[(S[0] + El[0]) / 2, (S[1] + El[1]) / 2, S[2]], 0.07, 0.068],
      [[El[0], El[1], El[2]], 0.058, 0.058],
      [[(El[0] + Wr[0]) / 2, (El[1] + Wr[1]) / 2, El[2]], 0.062, 0.058],
      [[Wr[0], Wr[1] + 0.01, Wr[2]], 0.045, 0.042],
    ], 16);
    loft(B, 'arm', arm, [0, 0, 1], (_i, th, p) => stone(p, 0.4 + Math.cos(th) * 0.2), () => NO,
      (i) => blend([[S[1] + 0.03, a], [El[1], a + 1], [Wr[1] + 0.02, a + 2]].map(([y, bn]) => [-y, bn]) as [number, number][], -arm[i].c[1], 0.05),
      14, true, true, UV);
    // Hand: a fist-like palm, three claws curling down and forward.
    const hand = spline([[[Wr[0], Wr[1] + 0.01, Wr[2]], 0.045, 0.04], [[Wr[0] + s * 0.005, Wr[1] - 0.05, Wr[2] + 0.015], 0.055, 0.035], [[Wr[0] + s * 0.005, Wr[1] - 0.09, Wr[2] + 0.02], 0.045, 0.03]], 40);
    loft(B, 'hand', hand, [0, 0, 1], (_i, _t, p) => stone(p, 0.4), () => NO, () => [a + 2, 1], 12, true, true, UV);
    for (let k = 0; k < 3; k++) {
      const off = (k - 1) * 0.03;
      const c0: V3 = [Wr[0] + s * 0.005 + off * s, Wr[1] - 0.085, Wr[2] + 0.03];
      const claw = spline([[c0, 0.016, 0.016], [v3add(c0, [0, -0.04, 0.02]), 0.012, 0.012], [v3add(c0, [0, -0.06, 0.045]), 0.003, 0.003]], 60);
      loft(B, 'claw', claw, [0, 0, 1], (_i, _t, p) => mix3(stone(p, 0.3), DARK, 0.4), () => NO, () => [a + 2, 1], 8, true, true, UV);
    }
  }

  // ---- legs
  for (const s of [1, -1]) {
    const l = b.leg(s), Hp = J(l), K = J(l + 1), A = J(l + 2);
    const leg = spline([
      [[Hp[0] * 0.6, Hp[1] + 0.07, Hp[2]], 0.1, 0.1],
      [[Hp[0], Hp[1] - 0.04, Hp[2] + 0.01], 0.115, 0.115],
      [[(Hp[0] + K[0]) / 2, (Hp[1] + K[1]) / 2, Hp[2] + 0.01], 0.095, 0.09],
      [[K[0], K[1], K[2] + 0.01], 0.07, 0.07],
      [[(K[0] + A[0]) / 2, (K[1] + A[1]) / 2, K[2]], 0.065, 0.06],
      [[A[0], A[1] + 0.02, A[2]], 0.05, 0.048],
    ], 16);
    loft(B, 'leg', leg, [0, 0, 1], (_i, th, p) => stone(p, 0.4 + Math.cos(th) * 0.2), () => NO,
      (i) => blend([[-(Hp[1] + 0.05), b.pelvis], [-(Hp[1] - 0.06), l], [-K[1], l + 1], [-(A[1] + 0.01), l + 2]], -leg[i].c[1], 0.05),
      14, true, true, UV);
    // Foot: heel to the toes along +Z, three clawed toes, moss creeping up.
    const sy = A[1] - GARGOYLE.sole;
    const foot = spline([[[A[0], sy + 0.04, A[2] - 0.05], 0.045, 0.035], [[A[0], sy + 0.045, A[2] + 0.03], 0.06, 0.045], [[A[0], sy + 0.035, A[2] + 0.1], 0.065, 0.035]], 30);
    loft(B, 'foot', foot, [0, 1, 0], (_i, _t, p) => mix3(stone(p, 0.3), MOSS, 0.35 * smoothstep(sy + 0.07, sy, p[1]) + 0.15), () => NO, () => [l + 2, 1], 14, true, true, UV);
    for (let k = 0; k < 3; k++) {
      const ang = (k - 1) * 0.42;
      const d: V3 = [Math.sin(ang), 0, Math.cos(ang)];
      const t0: V3 = [A[0] + d[0] * 0.03, sy + 0.03, A[2] + 0.1];
      const t1 = v3madd(t0, d, 0.06), t2 = v3add(v3madd(t0, d, 0.1), [0, -0.025, 0]);
      const toe = spline([[t0, 0.024, 0.022], [t1, 0.02, 0.018], [t2, 0.004, 0.004]], 60);
      loft(B, 'toe', toe, [0, 1, 0], (i, _t, p) => mix3(mix3(stone(p, 0.3), MOSS, 0.25), DARK, i > toe.length * 0.6 ? 0.5 : 0), () => NO, () => [l + 2, 1], 8, true, true, UV);
    }
  }

  // ---- wings: leading-edge arm, membranes (inner, outer), scalloped trailing edges
  for (const s of [1, -1]) {
    const w = b.wing(s), W0 = J(w), W1 = J(w + 1);
    const tip: V3 = [W1[0] + s * GARGOYLE.wingOut, W1[1] + 0.06, W1[2] + 0.04];
    const armIn = spline([[[W0[0] - s * 0.04, W0[1], W0[2]], 0.04, 0.04], [W1, 0.03, 0.03]], 20);
    loft(B, 'wingarm', armIn, [0, 1, 0], (_i, _t, p) => stone(p, 0.5), () => NO, () => [w, 1], 10, true, true, UV);
    const armOut = spline([[W1, 0.03, 0.03], [[(W1[0] + tip[0]) / 2, (W1[1] + tip[1]) / 2 + 0.02, (W1[2] + tip[2]) / 2], 0.022, 0.022], [tip, 0.004, 0.004]], 20);
    loft(B, 'wingarm', armOut, [0, 1, 0], (_i, _t, p) => stone(p, 0.5), () => NO, () => [w + 1, 1], 10, true, true, UV);
    const memb = (name: string, root: V3, len: number, ch0: number, ch1: number, bone: number, pts: number) => {
      blade(B, name, root, [s, 0, 0], len, [0, 0, -1], [0, 1, 0], 16,
        (u) => {
          const scal = 0.06 * Math.abs(Math.sin(u * Math.PI * pts));
          return Math.max(0.01, (lerp(ch0, ch1, u) - scal) / 2);
        },
        (u) => { const scal = 0.06 * Math.abs(Math.sin(u * Math.PI * pts)); return (lerp(ch0, ch1, u) - scal) / 2 + 0.02; },
        (u, v) => lerp(0.035, 0.018, u) * (1 - 0.5 * smoothstep(-0.5, 1, v)),
        (u, v, top) => mix3(top ? STONE : DARK, STREAK, saturate(v) * 0.5 + (top ? 0 : 0.2) + u * 0.1),
        () => [bone, 1], 12, UV);
    };
    memb('membrane', [W0[0] - s * 0.02, W0[1] - 0.01, W0[2]], Math.abs(W1[0] - W0[0]) + 0.03, 0.42, 0.44, w, 2);
    memb('membrane', [W1[0] - s * 0.01, W1[1] - 0.005, W1[2]], GARGOYLE.wingOut * 0.97, 0.44, 0.06, w + 1, 3);
  }

  // ---- tail with its spade
  const T0 = J(b.tail), T1 = J(b.tail2);
  const tEnd: V3 = [T1[0], T1[1] - 0.01, T1[2] - 0.3];
  const tail = spline([[[T0[0], T0[1] + 0.03, T0[2] + 0.06], 0.07, 0.07], [T0, 0.06, 0.058], [T1, 0.04, 0.038], [tEnd, 0.022, 0.02]], 16);
  loft(B, 'tail', tail, [0, 1, 0], (_i, th, p) => stone(p, 0.3 + Math.cos(th) * 0.3), () => NO,
    (i) => blend([[-(T0[2] + 0.04), b.pelvis], [-T0[2], b.tail], [-T1[2], b.tail2]], -tail[i].c[2], 0.08), 12, true, true, UV);
  blade(B, 'spade', v3add(tEnd, [0, 0, 0.03]), [0, 0, -1], 0.15, [1, 0, 0], [0, 1, 0], 9,
    (u) => Math.max(0.006, 0.075 * Math.sin(Math.min(1, u * 1.6) * Math.PI * 0.6) * (u > 0.55 ? (1 - u) / 0.45 : 1)), () => 0, () => 0.025,
    (_u, _v, top) => (top ? STONE : DARK), () => [b.tail2, 1], 10, UV);

  faceOut(B);
  const normal = B.normals();
  return {
    position: Float32Array.from(B.pos), normal, uv: Float32Array.from(B.uv), color: Float32Array.from(B.col), glow: Float32Array.from(B.glow),
    skinIndex: Uint16Array.from(B.si), skinWeight: Float32Array.from(B.sw), index: Uint32Array.from(B.idx), parts: B.parts,
  };
}
