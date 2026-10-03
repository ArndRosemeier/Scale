/**
 * Shared masonry shading: brick walls (any bond, optional paint) and dressed stone blocks.
 */
import { RGB, TNoise, Tex, clamp01, mix, newCell, rnd, smooth, worley } from './core';
import { Hit, Layout, blockDist, newHit } from './layout';

export interface BrickOpts {
  seed: number;
  layout: Layout;
  /** mortar joint width (m) */
  joint: number;
  /** mortar recess below the brick face (m) */
  depth: number;
  /** arris rounding width (m) */
  bevel: number;
  /** edge raggedness amplitude (m) */
  ragged: number;
  /** chipped edges 0..1 */
  chips: number;
  /** base brick color from two per-brick randoms and the block kind */
  palette: (a: number, b: number, kind: number, out: number[]) => void;
  /** within-brick mottling amplitude */
  mottle: number;
  mortar: RGB;
  soot: number;
  streaks: number;
  rough: number;
  /** painted brick: paint color and coverage (0..1) */
  paint?: { color: RGB; coverage: number };
}

const lum = (r: number, g: number, b: number): number => r * 0.3 + g * 0.59 + b * 0.11;

export function brickWall(t: Tex, o: BrickOpts): void {
  const W = t.W, s = o.seed;
  const nEdge = new TNoise(s + 1, W), nChip = new TNoise(s + 2, W), nMot = new TNoise(s + 3, W);
  const nSoot = new TNoise(s + 4, W), nStr = new TNoise(s + 5, W), nFace = new TNoise(s + 6, W);
  const nPaint = new TNoise(s + 7, W), nMort = new TNoise(s + 8, W);
  const hit: Hit = newHit();
  const cell = newCell();
  const col = [0, 0, 0];
  const aa = t.ps * 0.6;
  const fs = nFace.f(0.007); // speckle cells
  const hj0 = o.joint / 2;
  t.each((u, v, x, y, idx) => {
    o.layout.at(x, y, hit);
    const id = hit.id;
    const ra = rnd(s, id, 1), rb = rnd(s, id, 2), rc = rnd(s, id, 3), rd = rnd(s, id, 4);
    const hj = hj0 + (rc - 0.5) * o.joint * 0.35;
    const eRaw = blockDist(hit, hj, o.bevel * 1.2) + nEdge.fbm(u, v, 0.014, 3) * o.ragged;
    // chips concentrate near arrises
    const chipN = nChip.fbm(u, v, 0.05, 4, 0.55);
    const chip = smooth(0.3 - o.chips * 0.25, 0.75, chipN) * o.chips * 0.014 * (0.6 + 0.8 * rd);
    const e = eRaw - chip;
    const mask = smooth(-aa, aa, e);
    const inChip = eRaw > 0 && e < 0 ? smooth(0, 0.003, eRaw) : 0;

    // --- heights
    const cxm = (hit.x0 + hit.x1) * 0.5, len = hit.x1 - hit.x0;
    const face = nFace.fbm(u, v, 0.012, 4, 0.55) * 0.0007 + nFace.fbm(u, v, 0.08, 2) * 0.0008;
    worley(s + 9, u * fs, v * fs, fs, fs, 1, cell);
    const pit = (cell.id & 255) < 22 ? -smooth(0.45, 0.1, cell.f1) * 0.0012 : 0;
    let hb = o.depth + (ra - 0.5) * 0.002 + ((hit.x - cxm) / len) * (rb - 0.5) * 0.002 + face + pit;
    hb -= o.depth * 0.45 * (1 - smooth(0, o.bevel, e));
    const sand = nMort.fbm(u, v, 0.005, 2) * 0.0006;
    const hm = sand + smooth(0, hj * 1.4, eRaw + hj) * 0.0012; // mortar slightly concave to the brick
    const hChip = o.depth * 0.35 + face;
    let h = mix(hm, hb, mask);
    if (inChip > 0) h = mix(h, hChip, inChip);

    // --- brick color
    o.palette(ra, rb, hit.kind, col);
    const mot = 1 + nMot.fbm(u, v, 0.06, 4) * o.mottle + (nMot.fbm(u + 0.5, v, 0.015, 2)) * o.mottle * 0.5;
    const endD = Math.min(hit.x - hit.x0, hit.x1 - hit.x);
    const flash = rd > 0.55 ? (1 - smooth(0, len * 0.35, endD)) * 0.16 : 0;
    let spec = 1;
    const sid = (cell.id >>> 8) & 255;
    if (sid < 14) spec = mix(1, 0.55, smooth(0.5, 0.15, cell.f1));
    else if (sid < 19) spec = mix(1, 1.35, smooth(0.4, 0.1, cell.f1));
    const k = mot * (1 - flash) * spec;
    let br = col[0] * k, bg = col[1] * k, bb = col[2] * k;
    if (inChip > 0) { br *= 0.88; bg *= 0.86; bb *= 0.86; }

    // --- mortar color
    const grain = nMort.fbm(u, v, 0.004, 2) * 0.08 + (rnd(s + 11, idx) - 0.5) * 0.07;
    const mdirt = 1 - 0.18 * (1 - smooth(-hj, 0, eRaw - hj)); // darker next to bricks
    let mr = o.mortar[0] * (1 + grain) * mdirt, mg = o.mortar[1] * (1 + grain) * mdirt, mb = o.mortar[2] * (1 + grain) * mdirt;

    let r = mix(mr, br, mask), g = mix(mg, bg, mask), b = mix(mb, bb, mask);
    let rough = mix(0.95, o.rough + nFace.fbm(u, v, 0.03, 2) * 0.05, mask);

    // --- paint
    if (o.paint) {
      const pn = nPaint.fbm(u, v, 0.3, 6, 0.62) + nPaint.fbm(u, v, 0.04, 3) * 0.3 + (1 - mask) * 0.1;
      const thr = 0.65 - o.paint.coverage * 1.0;
      const pm = smooth(thr, thr + 0.03, pn);
      // flake edge lip
      h += pm * 0.0004 + (smooth(thr - 0.01, thr + 0.01, pn) - smooth(thr + 0.01, thr + 0.04, pn)) * 0.0004;
      const pv = 0.94 + nPaint.fbm(u, v, 0.1, 3) * 0.04 + (1 - mask) * -0.03;
      // residual paint specks in flaked areas
      const resid = smooth(0.45, 0.6, nPaint.fbm(u + 0.3, v, 0.01, 2)) * 0.6;
      const pmm = Math.max(pm, resid * (1 - pm));
      r = mix(r, o.paint.color[0] * pv, pmm); g = mix(g, o.paint.color[1] * pv, pmm); b = mix(b, o.paint.color[2] * pv, pmm);
      rough = mix(rough, 0.78, pmm);
    }

    // --- weathering: soot macro + rain streaks
    const soot = smooth(-0.6, 1.0, nSoot.fbm(u, v, 1.1, 3) + nSoot.fbm(u, v, 0.25, 3, 0.5, 1.2) * 0.3) * o.soot;
    const st = smooth(0.05, 0.75, nStr.fbm(u, v, 0.09, 3, 0.5, 1.6) + nStr.fbm(u, v, 0.5, 2) * 0.3) * o.streaks;
    const dk = clamp01(1 - 0.3 * soot - 0.22 * st - (1 - mask) * 0.12 * soot);
    const L = lum(r, g, b);
    const ds = 0.35 * soot + 0.2 * st;
    r = mix(r, L, ds) * dk; g = mix(g, L, ds) * dk; b = mix(b, L * 1.02, ds) * dk;
    t.set(idx, r, g, b, rough, h);
  });
}

export interface StoneOpts {
  seed: number;
  layout: Layout;
  joint: number;
  /** joint recess (m) */
  depth: number;
  /** edge rounding width (m) */
  bevel: number;
  /** edge raggedness (m) */
  ragged: number;
  /** face bulge / rustication height (m) */
  bulge: number;
  /** pitched/rough-dressed face relief (m) */
  rough3d: number;
  /** base color, per-block value variation, per-block hue variation */
  base: RGB;
  vary: number;
  hue: number;
  /** grain: fine speckle amplitude, bedding anisotropy (lx/ly) */
  grain: number;
  bedding: number;
  mortar: RGB;
  /** dirt in joints and around edges 0..1 */
  jointDirt: number;
  soot: number;
  streaks: number;
  rough: number;
  roughJoint: number;
  /** erosion pits (sandstone) 0..1 */
  erosion: number;
  /** optional extra per-pixel hook (u, v, x, y, insideMask, hit, color in/out [r,g,b,rough,h]) */
  extra?: (u: number, v: number, mask: number, hit: Hit, c: number[]) => void;
}

/** Dressed stone blocks / slabs with joints. */
export function stoneBlocks(t: Tex, o: StoneOpts): void {
  const W = t.W, s = o.seed;
  const nEdge = new TNoise(s + 1, W), nGrain = new TNoise(s + 2, W), nMac = new TNoise(s + 3, W);
  const nSoot = new TNoise(s + 4, W), nStr = new TNoise(s + 5, W), nEro = new TNoise(s + 6, W), nRough = new TNoise(s + 7, W);
  const hit = newHit();
  const cell = newCell();
  const aa = t.ps * 0.6;
  const fe = nEro.f(0.02);
  const c = [0, 0, 0, 0, 0];
  t.each((u, v, x, y, idx) => {
    o.layout.at(x, y, hit);
    const id = hit.id;
    const ra = rnd(s, id, 1), rb = rnd(s, id, 2), rc = rnd(s, id, 3);
    const hj = o.joint / 2 * (0.8 + 0.4 * rc);
    const e = blockDist(hit, hj, o.bevel) + nEdge.fbm(u, v, 0.03, 4) * o.ragged;
    const mask = smooth(-aa, aa, e);
    const bw = hit.x1 - hit.x0, bh = hit.y1 - hit.y0;
    const lx = (hit.x - hit.x0) / bw - 0.5, ly = (hit.y - hit.y0) / bh - 0.5;
    // face
    let hb = o.depth + (ra - 0.5) * 0.002;
    hb -= o.depth * 0.5 * (1 - smooth(0, o.bevel, e));
    hb += o.bulge * (1 - (lx * lx + ly * ly) * 2.2) * smooth(0, o.bevel * 2 + 0.01, e);
    if (o.rough3d > 0) {
      const rr = nRough.ridged(u, v, 0.12, 5, 0.55) - 0.5;
      hb += rr * o.rough3d * smooth(0, 0.03, e);
    }
    const gr = nGrain.fbm(u, v, 0.006 * o.bedding, 3, 0.6, 0.006);
    hb += gr * 0.0004;
    // erosion pits
    let ero = 0;
    if (o.erosion > 0) {
      worley(s + 8, u * fe, v * fe, fe, fe, 1, cell);
      const em = smooth(0.1, 0.6, nEro.fbm(u, v, 0.4, 3)) * o.erosion;
      ero = smooth(0.5, 0.15, cell.f1) * em * ((cell.id & 3) === 0 ? 1 : 0.3);
      hb -= ero * 0.004;
      hb -= em * (1 - smooth(0, 0.03, e)) * 0.003; // rounded weathered arrises
    }
    const hm = nGrain.fbm(u, v, 0.005, 2) * 0.0005;
    const h = mix(hm, hb, mask);

    // color
    const vv = 1 + (ra - 0.5) * 2 * o.vary + nMac.fbm(u, v, 0.35, 4) * o.vary * 0.6;
    const hu = (rb - 0.5) * 2 * o.hue;
    const fineG = gr * o.grain + (rnd(s + 9, idx) - 0.5) * o.grain * 0.6;
    const bedd = nGrain.fbm(u + 0.2, v, 0.5 * o.bedding, 3, 0.5, 0.05) * o.grain * 0.8;
    const k = vv * (1 + fineG + bedd) * (1 - ero * 0.2);
    let r = o.base[0] * k * (1 + hu), g = o.base[1] * k, b = o.base[2] * k * (1 - hu);
    const edgeDirt = (1 - smooth(0, 0.025, e)) * o.jointDirt * 0.25;
    r *= 1 - edgeDirt; g *= 1 - edgeDirt; b *= 1 - edgeDirt;
    const jd = 1 - o.jointDirt * 0.3;
    const mg0 = 1 + nGrain.fbm(u, v, 0.004, 2) * 0.08;
    r = mix(o.mortar[0] * jd * mg0, r, mask); g = mix(o.mortar[1] * jd * mg0, g, mask); b = mix(o.mortar[2] * jd * mg0, b, mask);
    let rough = mix(o.roughJoint, o.rough + nGrain.fbm(u, v, 0.05, 2) * 0.05, mask);
    c[0] = r; c[1] = g; c[2] = b; c[3] = rough; c[4] = h;
    if (o.extra) o.extra(u, v, mask, hit, c);
    r = c[0]; g = c[1]; b = c[2]; rough = c[3];
    const soot = smooth(-0.3, 0.8, nSoot.fbm(u, v, 1.3, 5)) * o.soot;
    const st = smooth(0.1, 0.8, nStr.fbm(u, v, 0.12, 3, 0.5, 1.8) + nStr.fbm(u, v, 0.6, 2) * 0.3) * o.streaks;
    const dk = clamp01(1 - 0.35 * soot - 0.25 * st);
    const L = lum(r, g, b);
    r = mix(r, L, 0.25 * soot) * dk; g = mix(g, L, 0.25 * soot) * dk; b = mix(b, L, 0.25 * soot) * dk;
    t.set(idx, r, g, b, rough, c[4]);
  });
}
