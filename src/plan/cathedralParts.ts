/**
 * The cathedral (plan/landmarkParts): a stone shell one can walk into. Through the west door
 * (under the tower, between the towers, or between the bell towers) into the nave: pillars and
 * pointed arches to the aisles, vaults overhead, pews, a crossing under the transept (gothic:
 * the vaults cross; domed: an open dome over it), the chancel with the altar in the apse.
 *
 * The windows are real openings filled with stained glass (lancets, roses at the transept ends
 * and the west front). The cathedral is breakable (build/landmarkDice, destruction/LandmarkWreck):
 * its glass is diced into pieces of its own (LmPart.pane) that shatter at a touch and hold
 * nothing up, while the stone breaks like the marvels'.
 *
 * Local frame as every landmark: the west front at -v, the apse at +v.
 */
import { Rng, deriveSeed } from '../core/rng';
import type { Landmark } from './landmarks';
import {
  Kit, mat, wallRun, bench, D, DS, WHITE, WIN, ARCH, ROOF, GLOW, LIME, SAND, GRANITE, BRICK, PLASTER, METAL, SLATE, ZINC, CLAY,
  COPPER, GOLD, type Opening, type Opt, type PartMat, type LmPart, type RGB,
  entranceSteps,
} from './landmarkParts';

/** Stained glass colours (bright: seen against the dim inside they read as lit by the day). */
const STAINED: RGB[] = [[0.3, 0.5, 1.9], [1.9, 0.3, 0.26], [1.8, 1.35, 0.35], [0.4, 1.4, 0.5], [1.15, 0.4, 1.6], [1.65, 1.6, 1.4]];
/** Wall thickness, pillar radius, bay length aimed at. */
const T = 1.0, PR = 0.6, BAY = 7;

/** A pointed arch over the half span hs rising h (≥ hs): (x, y) pairs from -hs to hs, y from 0. */
function pointed(hs: number, h: number, n = 10): number[] {
  h = Math.max(h, hs);
  const c = (h * h - hs * hs) / (2 * hs), R = hs + c, out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const x = -hs + (2 * hs * i) / n;
    out.push(x, Math.sqrt(Math.max(0, R * R - (Math.abs(x) + c) ** 2)));
  }
  return out;
}

/** A vault's cross section (half ellipse) over the half span hs rising h: (x, y) from -hs to hs. */
function ellipse(hs: number, h: number, n = 12): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) { const f = (i / n) * Math.PI; out.push(-Math.cos(f) * hs, Math.sin(f) * h); }
  return out;
}

const shift = (P: number[], dx: number, dy: number) => P.map((v, i) => v + (i % 2 ? dy : dx));

export function cathedral(k: Kit, lm: Landmark, r0: Rng): void {
  const r = new Rng(deriveSeed(lm.seed, 'glass'));
  const P = lm.p, B = k.B, st = lm.style;
  const wallL = [SAND, LIME, GRANITE, BRICK][P.wall % 4];
  const tint: RGB = wallL === GRANITE ? [0.85, 0.83, 0.8] : wallL === BRICK ? [0.92, 0.85, 0.8] : [0.96, 0.93, 0.86];
  const plain = mat(wallL, tint);
  // Inside: the same stone a little lighter (limewashed brick), the vaults pale.
  const inner = wallL === BRICK ? mat(PLASTER, [0.98, 0.94, 0.86]) : mat(wallL, [tint[0] * 1.06, tint[1] * 1.06, tint[2] * 1.06]);
  const ceil = mat(PLASTER, [0.98, 0.95, 0.88]);
  const rib = mat(wallL === BRICK ? LIME : wallL, [tint[0] * 0.95, tint[1] * 0.93, tint[2] * 0.9]);
  const roofM = mat([SLATE, ZINC, CLAY][P.roof % 3], P.roof % 3 === 1 ? COPPER : WHITE, ROOF);
  const C = {
    floorA: mat(LIME, [1.12, 1.1, 1.04]),
    floorB: mat(GRANITE, [0.42, 0.42, 0.46]),
    wood: mat(PLASTER, [0.42, 0.26, 0.15]),
    dark: mat(PLASTER, [0.24, 0.14, 0.08]),
    red: mat(PLASTER, [0.52, 0.07, 0.08]),
    cloth: mat(PLASTER, [1.15, 1.13, 1.08]),
    gold: mat(METAL, GOLD),
    iron: mat(METAL, [0.16, 0.16, 0.17]),
    flame: mat(PLASTER, [2.4, 1.9, 1.2]),
    lead: mat(METAL, [0.1, 0.1, 0.12]),
    step: mat(GRANITE, [0.85, 0.85, 0.85]),
  };
  const vc = 6, L = P.L, W = P.W, H = B + P.H;
  const nw = W * 0.28, aw = W * 0.12, ao = nw + 2 * aw;
  const front = vc - L / 2, back = vc + L / 2;
  const Ha = B + P.H * 0.5;
  /** Vault springing and crown: nave (and transept), aisles. */
  const crownN = H - 0.3, Sn = crownN - (nw - T) * 0.85;
  const ac = (nw + ao - T) / 2, ahs = (ao - T - nw) / 2;
  const crownA = Ha - 0.15, Sa = crownA - ahs * 0.9;
  const ts = W * [0.17, 0.2, 0.13][st];
  const tdep = nw * (st === 2 ? 1.1 : 0.95);
  const tl = st === 2 ? Math.max(L * 0.36, ao + 6) : Math.max(W * P.transept / 2, ao + 4);
  const aisleStart = st === 2 ? front + 2 * ts + 1 : front + 6, aisleEnd = back - 2;
  const tv = Math.max(aisleStart + tdep + 5, Math.min(aisleEnd - tdep - 4, st === 2 ? vc + L * 0.08 : vc + L * 0.18));
  /** The aisles: west of the crossing and (when there is room) east of it. */
  const segs = ([[aisleStart, tv - tdep], [tv + tdep, aisleEnd]] as const).filter(([a, b]) => b - a >= 2.5);
  const eastAisle = segs.some(([a]) => a > tv);
  const wo: Opt = { foot: true, map: 0 };

  // ------------------------------------------------------------ windows

  const rot = (axis: 'u' | 'v') => (axis === 'v' ? Math.PI / 2 : 0);
  const at = (axis: 'u' | 'v', c: number, a: number): [number, number] => (axis === 'u' ? [a, c] : [c, a]);
  /** The hidden collision of a window: glass (breaks with it). */
  const paneSolid = (axis: 'u' | 'v', c: number, a: number, hw: number, y0: number, y1: number) => {
    const [u, v] = at(axis, c, a);
    const p = axis === 'u' ? k.box(u, v, hw, T / 2, y0, y1, plain, { map: 0 }) : k.box(u, v, T / 2, hw, y0, y1, plain, { map: 0 });
    p.hidden = true;
    p.pane = true;
  };
  const glass = (p: LmPart) => { p.pane = true; return p; };
  /** A glass tile (outline in the wall plane), standing proud of the leading on both faces. */
  const tile = (axis: 'u' | 'v', c: number, a: number, outline: number[], col: RGB) => {
    const [u, v] = at(axis, c, a);
    glass(k.prism(u, v, outline, 0.05, mat(PLASTER, col, GLOW), { rot: rot(axis), solid: false, detail: true }));
  };

  /**
   * A lancet in a wall (axis, at c, centred at a along it): its opening (for wallRun), the
   * stone filling the corners of the pointed head, the leading and the coloured glass.
   */
  const lancet = (axis: 'u' | 'v', c: number, a: number, w: number, y0: number, y1: number): Opening => {
    const hs = w / 2, hh = Math.min(hs * 1.5, (y1 - y0) * 0.4), ys = y1 - hh;
    const A = shift(pointed(hs, hh), 0, ys), n = A.length / 2, m = (n - 1) / 2;
    const [u, v] = at(axis, c, a);
    const o: Opt = { rot: rot(axis), solid: false };
    const left = [-hs, y1, 0, y1], right = [hs, y1, 0, y1];
    for (let i = m - 1; i >= 0; i--) left.push(A[i * 2], A[i * 2 + 1]);
    for (let i = m + 1; i < n; i++) right.push(A[i * 2], A[i * 2 + 1]);
    k.prism(u, v, left, T / 2, plain, o);
    k.prism(u, v, right, T / 2, plain, o);
    // The leading (far: the whole window, dark), then the tiles.
    const out = [-hs, y0, hs, y0];
    for (let i = n - 1; i >= 0; i--) out.push(A[i * 2], A[i * 2 + 1]);
    glass(k.prism(u, v, out, 0.03, C.lead, o));
    const g = 0.07, nc = w > 1.9 ? 3 : 2, nr = Math.max(2, Math.round((ys - y0) / 0.75));
    const cw = w / nc, rh = (ys - y0) / nr;
    const scheme = Array.from({ length: nr * 2 }, () => r.pick(STAINED));
    const border = r.pick(STAINED);
    for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) {
      const x0 = -hs + j * cw + g, x1 = -hs + (j + 1) * cw - g, b = y0 + i * rh + g, t = y0 + (i + 1) * rh - g;
      const edge = j === 0 || j === nc - 1;
      const col = edge && nc > 2 ? border : scheme[i * 2 + Math.abs(j - (nc - 1) / 2) * (nc > 2 ? 1 : 0)];
      tile(axis, c, a, [x0, b, x1, b, x1, t, x0, t], col);
    }
    // The head: the arch drawn in a little.
    const head: number[] = [];
    const sx = (hs - g) / hs, sy = (hh - 2 * g) / hh;
    for (let i = 0; i < n; i++) head.push(A[i * 2] * sx, ys + g + (A[i * 2 + 1] - ys) * sy);
    tile(axis, c, a, head, [1.8, 1.4, 0.4]);
    paneSolid(axis, c, a, hs, y0, y1);
    return { a, w, y0, y1 };
  };

  /** A rose window (radius R, centre height cy): opening, corner stone, leading, petals. */
  const rose = (axis: 'u' | 'v', c: number, a: number, R: number, cy: number): Opening => {
    const [u, v] = at(axis, c, a);
    const o: Opt = { rot: rot(axis), solid: false };
    const N = 32, ring = (rr: number, a0: number, a1: number, n: number) => {
      const out: number[] = [];
      for (let i = 0; i <= n; i++) { const t = a0 + ((a1 - a0) * i) / n; out.push(Math.cos(t) * rr, cy + Math.sin(t) * rr); }
      return out;
    };
    for (const [sx, sy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
      // Corner: the square's corner, then the quarter circle between the two sides it touches.
      const pts = [sx * R, cy + sy * R];
      const t0 = sx > 0 ? (sy > 0 ? 0 : -Math.PI / 2) : sy > 0 ? Math.PI / 2 : Math.PI;
      pts.push(...ring(R, t0, t0 + Math.PI / 2, 8));
      k.prism(u, v, pts, T / 2, plain, o);
    }
    glass(k.prism(u, v, ring(R, 0, Math.PI * 2 * (N - 1) / N, N - 1), 0.03, C.lead, o));
    const g = 0.08, petals = R > 4 ? 12 : 8;
    const ca = r.pick(STAINED), cb = r.pick(STAINED), cc = r.pick(STAINED);
    tile(axis, c, a, ring(R * 0.2, 0, Math.PI * 2 * 11 / 12, 11), [1.8, 1.4, 0.4]);
    const wedge = (r0: number, r1: number, t0: number, t1: number, col: RGB) => {
      const gi = g / r0, go = g / r1;
      tile(axis, c, a, [...ring(r1, t0 + go, t1 - go, 4), ...ring(r0, t1 - gi, t0 + gi, 2)], col);
    };
    for (let i = 0; i < petals; i++) {
      const t0 = (i / petals) * Math.PI * 2, t1 = ((i + 1) / petals) * Math.PI * 2;
      wedge(R * 0.24, R * 0.6, t0, t1, i % 2 ? ca : cb);
      wedge(R * 0.63, R * 0.95, t0, (t0 + t1) / 2, cc);
      wedge(R * 0.63, R * 0.95, (t0 + t1) / 2, t1, i % 2 ? cb : ca);
    }
    paneSolid(axis, c, a, R, cy - R, cy + R);
    return { a, w: 2 * R, y0: cy - R, y1: cy + R };
  };

  /** Windows spread along a wall from a0 to a1 (a lancet every `every` metres or so). */
  const lancets = (axis: 'u' | 'v', c: number, a0: number, a1: number, every: number, wMax: number, y0: number, y1: number): Opening[] => {
    const len = a1 - a0, n = Math.floor(len / every);
    if (n < 1 || y1 - y0 < 2.2) return [];
    const w = Math.min(wMax, (len / n) * 0.4);
    return Array.from({ length: n }, (_, i) => lancet(axis, c, a0 + (len * (i + 0.5)) / n, w, y0, y1));
  };

  // ------------------------------------------------------------ the shell

  // Floors (with foundations: the ground may fall away) and the map's and the planner's outline.
  const floor = (u: number, v: number, hu: number, hv: number) => k.box(u, v, hu, hv, B - 0.3, B, C.floorA, { foot: true, map: 0 });
  const outline = (p: LmPart) => { p.hidden = true; p.footprint = true; };
  floor(0, (front + back) / 2, nw, L / 2);
  outline(k.box(0, (front + back) / 2, nw, L / 2, B, H, plain, { solid: false, map: 1 }));
  for (const [v0, v1] of segs) for (const s of [-1, 1]) {
    floor(s * (nw + aw), (v0 + v1) / 2, aw, (v1 - v0) / 2);
    outline(k.box(s * (nw + aw), (v0 + v1) / 2, aw, (v1 - v0) / 2, B, Ha, plain, { solid: false, map: 1 }));
  }
  floor(0, tv, tl, tdep);
  outline(k.box(0, tv, tl, tdep, B, H, plain, { solid: false, map: 1 }));
  k.cyl(0, back, nw - 0.2, nw - 0.2, B - 0.3, B, C.floorA, { foot: true, map: 0, seg: 16 });
  outline(k.cyl(0, back, nw, nw, B, H - 2, plain, { solid: false, map: 1, seg: 16 }));
  k.room(-nw, front, nw, back + nw, B - 0.5, H);
  if (segs.length) k.room(-ao, segs[0][0], ao, segs[segs.length - 1][1], B - 0.5, Ha);
  k.room(-tl, tv - tdep, tl, tv + tdep, B - 0.5, H);

  // West front: the door, and a rose over it where no tower stands in front.
  const doorW = 4.4, doorH = Math.min(7, P.H * 0.3);
  {
    const open: Opening[] = [{ a: 0, w: doorW, y0: B, y1: B + doorH }];
    const R = Math.min(nw - T - 1, st === 0 ? W / 2 - 2 * ts - 1 : nw, (Sn - (B + doorH + 1.5)) / 2, 6);
    if (st !== 1 && R >= 2) open.push(rose('u', front + T / 2, 0, R, Math.min(Sn - R - 0.6, B + doorH + 1.5 + R)));
    wallRun(k, 'u', front + T / 2, -nw, nw, B, H, T, plain, open, wo);
  }
  // Nave walls where there are no aisles (west of them, and on to the apse).
  for (const s of [-1, 1]) {
    const c = s * (nw - T / 2);
    // (The domed front's bell towers stand against these walls: no windows there.)
    wallRun(k, 'v', c, front + T, aisleStart, B, H, T, plain, st === 2 ? [] : lancets('v', c, front + T, aisleStart, 3.5, 1.8, B + 3, Sn - 0.5), wo);
    const e = eastAisle ? aisleEnd : tv + tdep;
    wallRun(k, 'v', c, e, back, B, H, T, plain, lancets('v', c, e, back, 4, 1.8, B + 3, Sn - 0.5), wo);
  }

  // Aisles: arcades of pillars and pointed arches to the nave, the clerestory over them, the
  // outer walls with their windows, vaults, roofs, buttresses outside.
  const bays: number[][] = [];
  for (const [v0, v1] of segs) {
    const n = Math.max(1, Math.round((v1 - v0) / BAY)), bay = (v1 - v0) / n;
    const vs = Array.from({ length: n + 1 }, (_, i) => v0 + i * bay);
    bays.push(vs);
    const hs = bay / 2 - PR, apex = Sa - 0.05, rise = Math.min(hs * 1.3, (apex - B) * 0.45);
    const spring = apex - Math.max(rise, hs), top = apex + 0.6;
    const A = pointed(hs, apex - spring);
    for (const s of [-1, 1]) {
      const c = s * (nw - T / 2);
      for (const v of vs) {
        k.cyl(c, v, PR, PR, B, spring, inner, { seg: 12 });
        k.box(c, v, PR + 0.18, PR + 0.18, B, B + 0.5, inner, D);
        k.box(c, v, PR + 0.22, PR + 0.22, spring - 0.45, spring, inner, D);
      }
      for (let i = 0; i < n; i++) {
        const vm = (vs[i] + vs[i + 1]) / 2;
        const sp = [-(hs + PR), spring, ...shift(A, 0, spring), hs + PR, spring, hs + PR, top, -(hs + PR), top];
        k.prism(c, vm, sp, T / 2, inner, { rot: Math.PI / 2, solid: false });
      }
      const clere = Array.from({ length: n }, (_, i) => (vs[i] + vs[i + 1]) / 2);
      const cy0 = Math.max(Ha + 0.9, top + 0.5), cy1 = Sn - 0.5;
      wallRun(k, 'v', c, v0, v1, top, H, T, plain, cy1 - cy0 >= 2.2 ? clere.map((a) => lancet('v', c, a, Math.min(2.4, bay * 0.38), cy0, cy1)) : [], { map: 0 });
      // Outer wall, end walls, vault, ceiling, roof.
      const oc = s * (ao - T / 2);
      wallRun(k, 'v', oc, v0, v1, B, Ha, T, plain, Sa - 0.4 - (B + 2.6) >= 2.2 ? clere.map((a) => lancet('v', oc, a, Math.min(2.2, bay * 0.34), B + 2.6, Sa - 0.4)) : [], wo);
      const [ua, ub] = s > 0 ? [nw, ao] : [-ao, -nw];
      if (v0 < tv) wallRun(k, 'u', v0 + T / 2, ua, ub, B, Ha, T, plain, [], wo);
      if (v1 > tv) wallRun(k, 'u', v1 - T / 2, ua, ub, B, Ha, T, plain, [], wo);
      const lo = v0 < tv ? v0 + T : v0, hi = v1 > tv ? v1 - T : v1;
      k.vault(s * ac, (lo + hi) / 2, (hi - lo) / 2, ahs, Sa, crownA, ceil, { rot: Math.PI / 2, solid: false }).inward = true;
      k.solidBox(s * (nw + aw), (v0 + v1) / 2, aw, (v1 - v0) / 2, crownA - 0.3, Ha);
      k.gable(s * (nw + aw), (v0 + v1) / 2, (v1 - v0) / 2, aw, Ha, Ha + aw * 0.6, plain, roofM, { rot: Math.PI / 2 });
      for (const v of vs) {
        k.box(s * (ao + 0.7), v, 0.7, 0.9, B, Ha + 0.6, plain, { detail: true, solid: false });
        k.box(s * (nw - T - 0.15), v, 0.15, 0.3, apex, Sn, rib, D); // (shaft up to the vault)
      }
    }
  }

  // Transept: end walls with a rose over lancets, side walls, arch walls over the aisles.
  const St = crownN - (tdep - T) * 0.85;
  for (const s of [-1, 1]) {
    const c = s * (tl - T / 2);
    const R = Math.min(tdep - T - 1, (Sn - (B + 3)) * 0.3, 7), cy = Sn - R - 0.6;
    const open: Opening[] = [];
    if (R >= 2) open.push(rose('v', c, tv, R, cy));
    const lw = Math.min(1.6, (2 * tdep - 2 * T) / 6);
    if (cy - R - 0.8 - (B + 2.6) >= 2.2) for (const d of [-1.7, 0, 1.7]) open.push(lancet('v', c, tv + d * lw, lw, B + 2.6, cy - R - 0.8));
    wallRun(k, 'v', c, tv - tdep, tv + tdep, B, H, T, plain, open, wo);
    for (const sv of [-1, 1]) {
      const vc2 = tv + sv * (tdep - T / 2), aisle = sv < 0 ? segs.some(([a]) => a < tv) : eastAisle;
      const [a0, a1] = s > 0 ? [aisle ? ao - T : nw, tl] : [-tl, aisle ? -(ao - T) : -nw];
      wallRun(k, 'u', vc2, a0, a1, B, H, T, plain, lancets('u', vc2, a0 + (s > 0 ? 0.5 : T), a1 - (s > 0 ? T : 0.5), 6, 2.0, B + 2.6, St - 0.5), wo);
      if (aisle) {
        // Over the aisle's mouth: a wall down to its vault's arch.
        const out = [-ahs, Sa, ...shift(ellipse(ahs, crownA - Sa), 0, Sa).slice(2, -2), ahs, Sa, ahs, H, -ahs, H];
        k.prism(s * ac, vc2, out, T / 2, inner, { solid: false });
        k.solidBox(s * ac, vc2, ahs, T / 2, crownA, H);
      }
      // Crossing piers.
      k.box(s * (nw - T / 2), vc2, T / 2 + 0.3, T / 2 + 0.3, B, H, inner, { foot: true, map: 0 });
    }
  }

  // Apse: a half ring of walls with tall windows, a half dome over it.
  const apseTop = st === 2 ? H - 3 : H - 2;
  {
    const N = 7, R = nw - T / 2;
    for (let i = 0; i < N; i++) {
      const t0 = (i / N) * Math.PI, t1 = ((i + 1) / N) * Math.PI;
      const ax = Math.cos(t0) * R, av = back + Math.sin(t0) * R, bx = Math.cos(t1) * R, bv = back + Math.sin(t1) * R;
      const half = Math.hypot(bx - ax, bv - av) / 2;
      k.sub((ax + bx) / 2, (av + bv) / 2, Math.atan2(bv - av, bx - ax), () => {
        wallRun(k, 'u', 0, -half - 0.2, half + 0.2, B, apseTop, T, plain, [lancet('u', 0, 0, Math.min(2.0, half * 0.9), B + 3, Sn - 0.5)], wo);
      });
    }
    const d = k.dome(0, back, nw - T, nw - T, Sn, crownN, ceil, { seg: 20, solid: false });
    d.inward = true;
    d.half = true;
    // Closes the seam between the nave's vault and the half dome (the roofs show through otherwise).
    const seam = [-nw, Sn, ...shift(ellipse(nw - T - 0.05, crownN - Sn - 0.05), 0, Sn), nw, Sn, nw, H, -nw, H];
    k.prism(0, back + 0.12, seam, 0.1, inner, { solid: false });
    k.solidCyl(0, back, nw, crownN - 0.4, apseTop);
  }

  // Vaults (seen from inside) and the solid ceilings over them; ribs.
  const vault = (u: number, v: number, hu: number, hv: number, y0: number, o: Opt = {}) => { k.vault(u, v, hu, hv, y0, crownN, ceil, { ...o, solid: false }).inward = true; };
  const ribs = (axis: 'u' | 'v', c: number, a: number, hs: number, y0: number) => {
    const [u, v] = at(axis, c, a), o: Opt = { ...D, rot: rot(axis) };
    const outer = shift(ellipse(hs, crownN - y0), 0, y0), inr = shift(ellipse(hs - 0.3, crownN - y0 - 0.3), 0, y0);
    const band: number[] = [...outer];
    for (let i = inr.length / 2 - 1; i >= 0; i--) band.push(inr[i * 2], inr[i * 2 + 1]);
    k.prism(u, v, band, 0.18, rib, o);
  };
  if (st === 2) {
    // Domed: the vaults stop at the crossing, which opens into a dome on four arches.
    const cn = tv - tdep, cs = tv + tdep;
    vault(0, (front + T + cn) / 2, (cn - front - T) / 2, nw - T, Sn, { rot: Math.PI / 2 });
    vault(0, (cs + back) / 2, (back - cs) / 2, nw - T, Sn, { rot: Math.PI / 2 });
    for (const s of [-1, 1]) vault(s * (nw + tl - T) / 2, tv, (tl - T - nw) / 2, tdep - T, St);
    // Pendentives carry a ring over the crossing's square; on it a drum and the dome.
    const a = nw - T, b = tdep - T, r = Math.min(a, b) - 0.2, ys = crownN - 0.85 * Math.min(a, b);
    const yc = ys + 0.85 * Math.sqrt(a * a + b * b - r * r), dh = r * 0.55, hD = r * 0.9;
    const pd = k.dome(0, tv, a, b, ys, yc, ceil, { solid: false });
    pd.pend = true;
    pd.r = r;
    k.cyl(0, tv, r - 0.05, r - 0.05, yc - 0.05, yc + 0.35, C.gold, { ...D, seg: 32, solid: false }).inward = true;
    k.cyl(0, tv, r, r, yc + 0.35, yc + dh, inner, { seg: 32, solid: false }).inward = true;
    k.cyl(0, tv, r - 0.08, r - 0.08, yc + dh - 0.05, yc + dh + 0.2, C.gold, { ...D, seg: 32, solid: false }).inward = true;
    const dm = k.dome(0, tv, r, r, yc + dh, yc + dh + hD, ceil, { seg: 32, solid: false });
    dm.inward = true;
    const yTop = yc + 0.4;
    for (const sv of [-1, 1]) {
      const out = [-nw, Sn, ...shift(ellipse(nw - T, crownN - Sn), 0, Sn), nw, Sn, nw, yTop, -nw, yTop];
      k.prism(0, tv + sv * (tdep - T / 2), out, T / 2, inner, { solid: false });
    }
    for (const s of [-1, 1]) {
      const out = [-tdep, St, ...shift(ellipse(tdep - T, crownN - St), 0, St), tdep, St, tdep, yTop, -tdep, yTop];
      k.prism(s * (nw - T / 2), tv, out, T / 2, inner, { rot: Math.PI / 2, solid: false });
    }
    // A gilded sunburst at the dome's crown.
    k.cyl(0, tv, 1.6, 1.6, yc + dh + hD - 0.05, yc + dh + hD + 0.02, C.gold, { ...D, seg: 20 });
  } else {
    // Gothic: the nave's and the transept's vaults cross.
    vault(0, (front + T + back) / 2, (back - front - T) / 2, nw - T, Sn, { rot: Math.PI / 2 });
    vault(0, tv, tl - T, tdep - T, St);
    for (const sv of [-1, 1]) ribs('u', tv + sv * (tdep - T), 0, nw - T, Sn);
    for (const s of [-1, 1]) ribs('v', s * (nw - T), tv, tdep - T, St);
  }
  for (const vs of bays) for (const v of vs) ribs('u', v, 0, nw - T, Sn);
  k.solidBox(0, (front + back) / 2, nw, L / 2, crownN - 0.4, H);
  k.solidBox(0, tv, tl, tdep, crownN - 0.4, H);

  // ------------------------------------------------------------ outside

  // (The domed one's roofs stop inside its drum: none of them crosses the dome seen from inside.)
  const drumR = Math.max(nw * 1.15, Math.hypot(nw - T, tdep - T) + 0.4), cut = drumR - 0.5;
  const span = (a0: number, a1: number, f: (m: number, h: number) => void) => {
    if (st !== 2) return f((a0 + a1) / 2, (a1 - a0) / 2);
    for (const [p, q] of [[a0, -cut], [cut, a1]]) if (q - p > 0.5) f((p + q) / 2, (q - p) / 2);
  };
  span(vc - L / 2 - tv, vc + L / 2 - tv, (m, h) => k.gable(0, tv + m, h, nw, H, H + nw * 1.5, plain, roofM, { rot: Math.PI / 2 }));
  /** Where the entrance steps start (in front of the west door, or of the tower it passes under). */
  let stepV = front, stepW = nw + 1;
  if (st !== 2) {
    k.gable(0, tv, tl, tdep, H, H + nw * 1.4, plain, roofM);
    // (Standing on the walls: no underside, which would hang into the nave.)
    // (Only the half over the apse: the other half would poke into the nave's vault.)
    k.cyl(0, back, nw + 0.3, 0, apseTop, H + nw * 1.2, roofM, { seg: 16, solid: false, foot: apseTop }).half = true;
    if (st === 0) {
      // Twin west towers flanking the front, with spires.
      const th = B + P.towerH * 0.62;
      for (const s of [-1, 1]) {
        const tu = s * (W / 2 - ts), tvv = front - ts;
        k.box(tu, tvv, ts, ts, B, th, mat(wallL, tint, WIN | ARCH, ts, 8, P.H), { foot: true });
        k.pyramid(tu, tvv, ts * 0.9, ts * 0.9, th, B + P.towerH, 0, roofM);
        for (const c of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) k.pyramid(tu + c[0] * ts * 0.85, tvv + c[1] * ts * 0.85, 0.6, 0.6, th, th + 5, 0, plain, { detail: true });
      }
      stepW = Math.max(doorW / 2 + 0.5, W / 2 - 2 * ts - 0.3);
    } else {
      // A single west tower and spire: the way in passes under it. A flèche over the crossing.
      const th = B + P.towerH * 0.55, tvv = front - ts, dw = doorW / 2;
      const tm = mat(wallL, tint, WIN | ARCH, ts, 8, P.H);
      for (const s of [-1, 1]) k.box(s * (dw + (ts - dw) / 2), tvv, (ts - dw) / 2, ts, B, B + doorH, tm, { foot: true });
      k.box(0, tvv, ts, ts, B + doorH, th, tm);
      k.box(0, tvv, dw, ts, B - 0.3, B, C.step, { foot: true, map: 0 });
      k.pyramid(0, tvv, ts * 0.85, ts * 0.85, th, B + P.towerH, 0, roofM);
      k.pyramid(0, tv, 1.6, 1.6, H + nw * 1.3, H + nw * 1.3 + 16, 0, roofM, { detail: true });
      stepV = front - 2 * ts;
      stepW = ts;
    }
  } else {
    // Domed: a great dome on a drum over the crossing, two bell towers with cupolas.
    span(-tl, tl, (m, h) => k.gable(m, tv, h, tdep, H, H + nw * 0.7, plain, roofM));
    // (Wider than the dome inside: none of the drum shows below it.)
    const dr = drumR;
    k.cyl(0, tv, dr, dr, H, H + P.H * 0.45, mat(wallL, tint, WIN | ARCH, 3.2, P.H * 0.45, P.H * 0.45), { solid: false, foot: H });
    k.dome(0, tv, dr + 0.5, dr + 0.5, H + P.H * 0.45, H + P.H * 0.45 + dr * 1.25, roofM, { seg: 24 });
    k.cyl(0, tv, 1.8, 1.8, H + P.H * 0.45 + dr * 1.2, H + P.H * 0.45 + dr * 1.2 + 4, plain, { detail: true, solid: false });
    k.dome(0, tv, 2.1, 2.1, H + P.H * 0.45 + dr * 1.2 + 4, H + P.H * 0.45 + dr * 1.2 + 6.5, mat(ZINC, GOLD, ROOF), { detail: true });
    const th = B + P.towerH * 0.5;
    for (const s of [-1, 1]) {
      const tu = s * (nw + ts), tvv = front + ts;
      k.box(tu, tvv, ts, ts, B, th, mat(wallL, tint, WIN | ARCH, ts, 7, P.H), { foot: true });
      k.cyl(tu, tvv, ts * 0.8, ts * 0.8, th, th + 5, mat(wallL, tint, WIN | ARCH, 2.4, 5, 5), { solid: false });
      k.dome(tu, tvv, ts * 0.85, ts * 0.85, th + 5, th + 5 + ts * 1.3, roofM);
    }
    k.dome(0, back, nw, nw, apseTop, apseTop + nw * 0.8, roofM, { seg: 16, solid: false }).half = true;
  }
  // Steps up to the door from the square.
  const foot = entranceSteps(k, stepV, stepW, B, C.step);

  // ------------------------------------------------------------ inside

  const p: Plan = { B, nw, front, back, tv, tdep, tl, Sn, crownN, aisleStart, doorW, doorH, st, ao, Sa, bays, stepV, foot };
  furnish(k, p, C, r);
  walkways(k, p);
  void r0;
}

interface Plan {
  B: number; nw: number; front: number; back: number; tv: number; tdep: number; tl: number; Sn: number; crownN: number; aisleStart: number; doorW: number; doorH: number; st: number;
  /** Outer edge of the aisles, their vault springing, the pillar positions of each aisle stretch. */
  ao: number; Sa: number; bays: number[][];
  /** Where the entrance steps start and where they meet the square. */
  stepV: number; foot: number;
}
type Pal = { [k in 'floorA' | 'floorB' | 'wood' | 'dark' | 'red' | 'cloth' | 'gold' | 'iron' | 'flame' | 'lead' | 'step']: PartMat };

/** Pews, the crossing's floor, the chancel with altar and choir stalls, pulpit, font, lamps. */
function furnish(k: Kit, p: Plan, C: Pal, r: Rng): void {
  const { B, nw, front, back, tv, tdep } = p;
  const iw = nw - T;
  // The doors stand open inward.
  const dw = p.doorW / 2;
  for (const s of [-1, 1]) k.box(s * (dw - 0.06), front + T + dw / 2 + 0.05, 0.06, dw / 2, B, B + p.doorH - 0.1, C.dark, D);
  // Floor: a runner from the door to the crossing, a chequer under the crossing.
  const v0 = front + T + 0.4, v1 = tv - tdep - 0.6;
  k.flat(0, (v0 + v1) / 2, 1.0, (v1 - v0) / 2, B + 0.012, C.red, D);
  const tile = 1.8;
  for (let u = -iw, i = 0; u < iw - 0.01; u += tile, i++)
    for (let v = tv - tdep + T, j = 0; v < tv + tdep - T - 0.01; v += tile, j++) {
      if ((i + j) % 2) continue;
      const hu = Math.min(tile, iw - u) / 2, hv = Math.min(tile, tv + tdep - T - v) / 2;
      k.flat(u + hu, v + hv, hu, hv, B + 0.006, C.floorB, D);
    }
  // Pews in two blocks either side of the runner, facing the altar.
  const pw = pewLen(p);
  for (const v of pewRows(p)) for (const s of [-1, 1]) bench(k, s * (1.4 + pw / 2), v, 0, B, pw, C.wood);
  // Chancel: a raised floor from the crossing into the apse, choir stalls, the altar.
  const c0 = tv + tdep + 0.5, top = B + 0.45;
  if (back > c0) k.box(0, (c0 + back) / 2, iw, (back - c0) / 2, B - 0.5, top, C.floorA, { ...DS, top: C.floorA });
  k.cyl(0, back, iw - 0.05, iw - 0.05, B - 0.5, top, C.floorA, { ...DS, seg: 20 });
  k.box(0, c0 - 0.2, iw * 0.6, 0.2, B - 0.5, B + 0.22, C.floorA, DS);
  for (const v of stallRows(p)) for (const s of [-1, 1]) bench(k, s * (iw - 0.6), v, s * Math.PI / 2, top, 1.0, C.wood);
  const av = back + Math.min(1.2, iw * 0.25);
  k.box(0, av, 1.7, 0.6, top, top + 1.0, C.cloth, DS);
  k.box(0, av - 0.62, 1.5, 0.02, top + 0.15, top + 0.9, C.red, D);
  k.box(0, av - 0.64, 0.25, 0.02, top + 0.3, top + 0.8, C.gold, D);
  for (const s of [-1, -0.45, 0.45, 1]) {
    k.cyl(s * 1.4, av, 0.06, 0.04, top + 1.0, top + 1.5, C.gold, { ...D, seg: 6 });
    k.cyl(s * 1.4, av, 0.04, 0.04, top + 1.5, top + 1.75, C.cloth, { ...D, seg: 6 });
    k.dome(s * 1.4, av, 0.035, 0.035, top + 1.75, top + 1.85, C.flame, { ...D, seg: 6 });
  }
  k.box(0, av + 0.3, 0.07, 0.07, top + 1.0, top + 2.4, C.gold, D);
  k.box(0, av + 0.3, 0.4, 0.07, top + 1.95, top + 2.05, C.gold, D);
  k.light(0, av - 2, B + 4);
  // A great cross hangs at the chancel's mouth.
  const cy = Math.min(p.Sn - 1, B + 11);
  k.box(0, c0, 0.14, 0.1, cy - 2.4, cy + 1.2, C.wood, D);
  k.box(0, c0, 1.3, 0.1, cy - 0.1, cy + 0.15, C.wood, D);
  for (const s of [-1, 1]) k.beam(s * 1.1, c0, cy + 0.1, s * 1.1, c0, p.crownN - 0.5, 0.012, C.iron, D);
  // Pulpit at a crossing pier, a font by the door.
  const pu = -(iw - 1.3), pv = tv - tdep - 1.2;
  k.cyl(pu, pv, 0.25, 0.25, B, B + 1.6, C.wood, { ...D, seg: 8 });
  k.cyl(pu, pv, 0.75, 0.6, B + 1.6, B + 2.7, C.wood, { ...DS, seg: 8, top: C.dark });
  k.box(pu, pv - 0.5, 0.3, 0.02, B + 2.7, B + 5.5, C.dark, D);
  const fu = iw - 1.6, fv = front + T + 2.6;
  k.cyl(fu, fv, 0.3, 0.3, B, B + 0.6, C.floorA, { ...DS, seg: 10 });
  k.cyl(fu, fv, 0.75, 0.6, B + 0.6, B + 1.05, C.floorA, { ...D, seg: 14, top: mat(PLASTER, [0.3, 0.45, 0.6]) });
  // Crown lamps on long chains down the nave, the crossing, the transept arms.
  const lamp = (u: number, v: number) => {
    const y = B + 6.5;
    k.beam(u, v, y + 0.4, u, v, p.crownN - 0.4, 0.015, C.iron, D);
    k.cyl(u, v, 1.0, 1.0, y, y + 0.12, C.iron, { ...D, seg: 14 });
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2, x = u + Math.cos(a) * 0.95, z = v + Math.sin(a) * 0.95;
      k.cyl(x, z, 0.03, 0.03, y + 0.12, y + 0.35, C.cloth, { ...D, seg: 5 });
      k.dome(x, z, 0.03, 0.03, y + 0.35, y + 0.43, C.flame, { ...D, seg: 5 });
    }
    k.light(u, v, y - 1);
  };
  for (let v = front + T + 8; v < tv - tdep - 4; v += 12) lamp(0, v);
  lamp(0, tv);
  for (const s of [-1, 1]) if (p.tl - T - nw > 6) lamp(s * (nw + p.tl - T) / 2, tv);
  void r;
}

/** Pew length (each block) and rows (v), facing the altar; none in a narrow nave. */
function pewLen(p: Plan): number {
  return p.nw - T - 0.7 - 1.4;
}
function pewRows(p: Plan): number[] {
  const out: number[] = [];
  if (pewLen(p) <= 1.2) return out;
  for (let v = Math.max(p.aisleStart, p.front + T + 5); v < p.tv - p.tdep - 0.6 - 1.5; v += 1.15) out.push(v);
  return out;
}
/** Choir stalls along the chancel (v). */
function stallRows(p: Plan): number[] {
  const out: number[] = [];
  for (let v = p.tv + p.tdep + 0.5 + 1.5; v < p.back - 0.6; v += 1.2) out.push(v);
  return out;
}

/**
 * Where people walk and stay (sim/LandmarkCrowds): up the steps and in at the west door, up the
 * middle between the pews (a lane along each row to its seats), across the crossing into the
 * transept arms and the aisles, up into the chancel. Spots: the pews, the choir stalls, the altar
 * (the priest), and places to stand and look: at the aisle windows, the roses, up into the
 * crossing, at the font and the pulpit.
 */
function walkways(k: Kit, p: Plan): void {
  const { B, nw, front, back, tv, tdep, tl } = p;
  const iw = nw - T, top = B + 0.45, c0 = tv + tdep + 0.5;
  const av = back + Math.min(1.2, iw * 0.25);
  const segs = p.bays.map((vs) => [vs[0], vs[vs.length - 1]]);
  /** Middle of the aisles (between the arcade's plinths and the outer wall). */
  const ua = (nw + 0.3 + p.ao - T) / 2;
  const arm = segs.length ? ua : (nw + tl - T) / 2;
  const d = k.node(0, front + T + 0.9, B);
  k.exit(d, [[0, front, B], [0, p.stepV, B]], 0, p.foot);
  const nF = k.node(0, front + T + 3, B);
  k.path(d, nF);
  // Up the middle: a lane along each pew row, its seats off it.
  const pw = pewLen(p);
  let last = nF;
  for (const v of pewRows(p)) {
    const n = k.node(0, v + 0.57, B);
    k.path(last, n);
    last = n;
    for (const s of [-1, 1]) for (let u = 1.4 + 0.32; u < 1.4 + pw - 0.25; u += 0.62) k.spot(s * u, v + 0.03, B, 0, true, 'faithful', n, [[s * u, v + 0.57]]);
  }
  const nP = k.node(0, tv - tdep - 0.9, B);
  const nC = k.node(0, tv, B);
  k.path(last, nP, nC);
  // The crossing: look up into the vault or the dome.
  const up = p.st === 2 ? p.crownN + 6 : p.crownN;
  for (const [u, v] of [[-1.6, tv - 1.2], [1.4, tv + 0.9], [0.3, tv - 2.2]]) k.spot(u, v, B, Math.atan2(u, tv - v), false, 'visitor', nC, [], [0, tv, up]);
  // The transept arms, a rose at each end; the aisles off them.
  const R = Math.min(tdep - T - 1, (p.Sn - (B + 3)) * 0.3, 7), cy = p.Sn - R - 0.6;
  for (const s of [-1, 1]) {
    const a = k.node(s * arm, tv, B), e = k.node(s * (tl - T - 2.4), tv, B);
    k.path(nC, a, e);
    k.spot(s * (tl - T - 2.4), tv + 0.5, B, -s * Math.PI / 2, false, 'visitor', e, [], R >= 2 ? [s * (tl - T / 2), tv, cy] : [s * (tl - T / 2), tv, B + 4]);
    k.spot(s * (tl - T - 2.4), tv - 0.7, B, -s * Math.PI / 2 + s * 0.4, false, 'visitor', e, [], R >= 2 ? [s * (tl - T / 2), tv, cy] : [s * (tl - T / 2), tv, B + 4]);
    for (const vs of p.bays) {
      const west = vs[0] < tv;
      const mids = vs.slice(1).map((v, i) => (v + vs[i]) / 2);
      if (west) mids.reverse();
      let prev = a;
      for (const vm of mids) {
        const n = k.node(s * ua, vm, B);
        k.path(prev, n);
        prev = n;
        // At the window of each bay, looking up at its glass.
        k.spot(s * (p.ao - T - 0.9), vm, B, -s * Math.PI / 2, false, 'visitor', n, [], [s * (p.ao - T / 2), vm, (B + 2.6 + p.Sa - 0.4) / 2 + 0.8]);
      }
    }
  }
  // The font by the door, the pulpit at the crossing, the view down the nave from the door.
  const fu = iw - 1.6, fv = front + T + 2.6, pu = -(iw - 1.3), pv = tv - tdep - 1.2;
  k.spot(fu - 1.2, fv, B, -Math.PI / 2, false, 'visitor', nF, [], [fu, fv, B + 1]);
  k.spot(pu + 1.5, pv + 0.3, B, Math.PI / 2, false, 'visitor', nP, [], [pu, pv, B + 2.6]);
  k.spot(-1.5, front + T + 2.2, B, 0, false, 'visitor', nF, [], [0, back, B + 8]);
  k.spot(1.6, front + T + 2.0, B, -0.15, false, 'visitor', nF, [], [0, back, B + 10]);
  // Chancel: up its steps, the stalls either side, the altar (the priest behind it at a service,
  // in front of it praying, or by the pulpit).
  const h0 = k.node(0, c0 - 0.9, B), h1 = k.node(0, c0 + 0.8, top), hA = k.node(0, av - 1.5, top);
  k.path(nC, h0, h1, hA);
  for (const v of stallRows(p)) for (const s of [-1, 1]) for (const dv of [-0.25, 0.25]) k.spot(s * (iw - 0.62), v + dv, top, s * Math.PI / 2, true, 'server', h1, [[s * (iw - 1.25), v + dv]]);
  k.spot(0, av + 1.0, top, Math.PI, false, 'priest', hA, [[2.3, av - 1.0], [2.3, av + 1.0]]);
  k.spot(0, av - 1.1, top, 0, false, 'priest', hA);
  k.spot(pu + 1.1, pv - 0.4, B, 0.6, false, 'priest', nP);
}
