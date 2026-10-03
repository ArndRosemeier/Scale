/**
 * Ground layers (GroundMat 0..12). Same orientation conventions as facades (row 0 = v = 0).
 */
import { Rng } from '../../core/rng';
import { RGB, TNoise, Tex, blur, clamp01, mix, newCell, rgb, rnd, smooth, worley, wrap, wrapd } from './core';
import { randomCourses, runningBond, blockDist, newHit } from './layout';
import { stoneBlocks } from './masonry';
import { pebbles, splat, stroke } from './paint';

type Gen = (t: Tex) => void;

// ----------------------------------------------------------------------------------- asphalt
interface AsphaltOpts {
  binder: number;
  /** fraction of exposed aggregate */
  expose: number;
  stone: number;
  cracks: number;
  sealed: number;
  oil: number;
  ravel: number;
  patch: boolean;
}

function asphalt(t: Tex, seed: number, o: AsphaltOpts): void {
  const W = t.W;
  const n1 = new TNoise(seed + 1, W), n2 = new TNoise(seed + 2, W), n3 = new TNoise(seed + 3, W), n4 = new TNoise(seed + 4, W);
  const cell = newCell();
  const fa = Math.round(W / 0.012), fb = Math.round(W / 0.03);
  const fc = Math.round(W / 0.9), fs = Math.round(W / 1.7);
  const rng = new Rng(seed + 5);
  const px = rng.float() * W, py = rng.float() * W, pw = rng.range(0.8, 1.6), ph = rng.range(0.6, 1.4);
  t.each((u, v, x, y, idx) => {
    // aggregate
    worley(seed + 6, u * fa, v * fa, fa, fa, 1, cell);
    const ex = o.expose * (1 + n3.fbm(u, v, 0.5, 3) * 0.6);
    let stone = (cell.id & 255) < ex * 255 ? smooth(0.55, 0.3, cell.f1) : 0;
    let sc = o.stone * (0.75 + 0.5 * ((cell.id >>> 8) & 255) / 255);
    worley(seed + 7, u * fb, v * fb, fb, fb, 1, cell);
    if ((cell.id & 255) < ex * 120 && cell.f1 < 0.4) { stone = Math.max(stone, smooth(0.4, 0.25, cell.f1)); sc = o.stone * (0.8 + 0.4 * ((cell.id >>> 8) & 255) / 255); }
    let h = stone * 0.0015 + n1.fbm(u, v, 1.0, 3) * 0.003 + n1.fbm(u, v, 0.1, 3) * 0.0006;
    const bk = o.binder * (1 + n2.fbm(u, v, 0.3, 4) * 0.1 + n1.fbm(u + 0.4, v, 2.0, 3) * 0.12 + (rnd(seed, idx) - 0.5) * 0.15);
    let r = mix(bk, sc, stone), g = mix(bk, sc * 0.99, stone), b = mix(bk * 1.02, sc * 0.97, stone);
    let rough = mix(0.9, 0.75, stone);
    // raveling: pits where aggregate fell out
    const rav = smooth(0.3, 0.6, n3.fbm(u, v, 0.4, 4)) * o.ravel * (rnd(seed + 8, idx) < 0.35 ? 1 : 0);
    h -= rav * 0.003; r *= 1 - rav * 0.3; g *= 1 - rav * 0.3; b *= 1 - rav * 0.3;
    // repair patch
    if (o.patch) {
      const dx = Math.abs(wrapd(x - px, W)) - pw / 2, dy = Math.abs(wrapd(y - py, W)) - ph / 2;
      const d = Math.max(dx, dy);
      if (d < 0) { r *= 0.8; g *= 0.8; b *= 0.8; h += 0.002; }
      const seam = 1 - smooth(0.0, 0.02, Math.abs(d));
      r = mix(r, 0.1, seam * 0.6); g = mix(g, 0.1, seam * 0.6); b = mix(b, 0.105, seam * 0.6);
      rough = mix(rough, 0.55, seam * 0.6);
    }
    // cracks (open) in some areas
    const crArea = smooth(0.12, 0.4, n4.fbm(u, v, 1.5, 3)) * o.cracks;
    if (crArea > 0) {
      worley(seed + 9, u * fc + n4.fbm(u, v, 0.15, 3) * 0.3, v * fc + n4.fbm(u + 0.3, v, 0.15, 3) * 0.3, fc, fc, 1, cell, true);
      const cw = cell.edge * (W / fc);
      const cr = (1 - smooth(0.0015, 0.005, cw)) * crArea;
      h -= cr * 0.006; r *= 1 - cr * 0.6; g *= 1 - cr * 0.6; b *= 1 - cr * 0.6;
    }
    // sealed cracks ("tar snakes")
    const sealArea = o.sealed > 0 ? smooth(-0.1, 0.2, n1.fbm(u, v, 2, 2)) : 0;
    if (sealArea > 0) {
      worley(seed + 10, u * fs + n2.fbm(u, v, 0.3, 3) * 0.25, v * fs + n2.fbm(u + 0.5, v, 0.3, 3) * 0.25, fs, fs, 1, cell, true);
      const sw = cell.edge * (W / fs);
      const sm = smooth(0.004, -0.004, n4.fbm(u + 0.7, v, 0.5, 2) * 0.006 + sw - 0.014) * o.sealed * sealArea;
      r = mix(r, 0.085, sm); g = mix(g, 0.085, sm); b = mix(b, 0.09, sm);
      rough = mix(rough, 0.45, sm); h = mix(h, 0.0012, sm);
    }
    // oil stains & tire polish
    const oil = smooth(0.25, 0.7, n2.fbm(u + 0.2, v, 0.5, 5, 0.6)) * o.oil;
    r *= 1 - oil * 0.35; g *= 1 - oil * 0.35; b *= 1 - oil * 0.33;
    rough -= oil * 0.25 + smooth(0, 0.6, n3.fbm(u, v, 0.8, 3, 0.5, 0.15)) * 0.08;
    t.set(idx, r, g, b, rough, h);
  });
}

const roadAsphalt: Gen = (t) => asphalt(t, 3001, { binder: 0.2, expose: 0.4, stone: 0.37, cracks: 0.7, sealed: 0.8, oil: 0.4, ravel: 0.2, patch: false });
const lightAsphalt: Gen = (t) => asphalt(t, 3101, { binder: 0.3, expose: 0.6, stone: 0.5, cracks: 1, sealed: 0.3, oil: 0.9, ravel: 0.7, patch: false });

function roadPaint(color: RGB, seed: number): Gen {
  return (t) => {
    asphalt(t, seed, { binder: 0.2, expose: 0.4, stone: 0.4, cracks: 0, sealed: 0, oil: 0, ravel: 0.1, patch: false });
    const W = t.W;
    const n1 = new TNoise(seed + 20, W), n2 = new TNoise(seed + 21, W);
    const cell = newCell();
    const fc = Math.round(W / 0.08);
    const hb = blur(t.h, t.size, 3);
    t.each((u, v, _x, _y, idx) => {
      const hgt = t.h[idx] - hb[idx];
      // paint wears off on high points (aggregate) and in worn patches
      const wear = n1.fbm(u, v, 0.35, 5, 0.6) * 0.3 + n2.fbm(u, v, 0.02, 3) * 0.3 + hgt * 300;
      const pm = smooth(0.42, 0.34, wear);
      worley(seed + 22, u * fc, v * fc + n2.fbm(u, v, 0.05, 2) * 0.3, fc, fc, 1, cell, true);
      const crack = (1 - smooth(0.0, 0.025, cell.edge)) * smooth(0.1, 0.4, n1.fbm(u + 0.5, v, 0.5, 3)) * 0.6;
      const dirt = 1 - smooth(-0.2, 0.7, n1.fbm(u, v, 0.3, 4)) * 0.07 - (rnd(seed + 23, idx) - 0.5) * 0.05;
      const k = dirt * (1 - crack * 0.35);
      t.r[idx] = mix(t.r[idx], color[0] * k, pm);
      t.g[idx] = mix(t.g[idx], color[1] * k, pm);
      t.b[idx] = mix(t.b[idx], color[2] * k, pm);
      t.rough[idx] = mix(t.rough[idx], 0.6, pm);
      t.h[idx] += pm * 0.0008 - crack * pm * 0.0004;
    });
  };
}

// ----------------------------------------------------------------------------------- paving
/** Sidewalk concrete slabs 1.5 x 1.5 m: tooled margins, broom finish, gum, stains. */
const paving: Gen = (t) => {
  const W = t.W;
  const lay = runningBond(W, 2, 2, 3201, 0, 0);
  const hit = newHit();
  const n1 = new TNoise(3202, W), n2 = new TNoise(3203, W), n3 = new TNoise(3204, W);
  const cell = newCell();
  const fg = Math.round(W / 0.12);
  t.each((u, v, x, y, idx) => {
    lay.at(x, y, hit);
    const id = hit.id;
    const ra = rnd(3205, id), rb = rnd(3206, id);
    const e = blockDist(hit, 0.006, 0.006) + n1.fbm(u, v, 0.05, 2) * 0.0015;
    const mask = smooth(-0.002, 0.002, e);
    const margin = 1 - smooth(0.035, 0.045, e);
    const lx = (hit.x - (hit.x0 + hit.x1) / 2), ly = (hit.y - (hit.y0 + hit.y1) / 2);
    let hs = 0.008 + (ra - 0.5) * 0.004 + lx * (rb - 0.5) * 0.004 + ly * (ra - 0.5) * 0.003;
    hs -= (1 - smooth(0, 0.008, e)) * 0.003;
    // broom finish lines across the slab (outside the tooled margin)
    const broom = n2.fbm(u, v, 0.25, 3, 0.5, 0.004) * (1 - margin);
    hs += broom * 0.0003 + n3.fbm(u, v, 0.006, 2) * 0.0002;
    const hm = -0.004 + n1.fbm(u, v, 0.01, 2) * 0.001;
    let h = mix(hm, hs, mask);
    const tone = 1 + (ra - 0.5) * 0.08 + n1.fbm(u, v, 0.4, 4) * 0.05 + broom * 0.03 + margin * 0.03 + (rnd(3207, idx) - 0.5) * 0.07 + n3.fbm(u, v, 0.012, 2) * 0.04;
    let r = 0.64 * tone, g = 0.625 * tone, b = 0.6 * tone, rough = mix(0.9, 0.8, margin);
    // stains
    const st = smooth(0.25, 0.65, n2.fbm(u + 0.3, v, 0.6, 5, 0.6)) * 0.22;
    r *= 1 - st; g *= 1 - st; b *= 1 - st * 0.95;
    const edgeDirt = (1 - smooth(0.0, 0.03, e)) * 0.2;
    r *= 1 - edgeDirt; g *= 1 - edgeDirt; b *= 1 - edgeDirt;
    // chewing gum spots
    worley(3208, u * fg, v * fg, fg, fg, 1, cell);
    const gr = 0.06 + ((cell.id >>> 8) & 255) / 255 * 0.08;
    if ((cell.id & 255) < 22 && cell.f1 < gr) {
      const gk = smooth(gr, gr * 0.6, cell.f1);
      const gc = 0.28 + ((cell.id >>> 16) & 255) / 255 * 0.12;
      r = mix(r, gc, gk); g = mix(g, gc, gk); b = mix(b, gc * 1.02, gk); rough = mix(rough, 0.55, gk); h += gk * 0.0006;
    }
    // joints
    const jc = 0.22 + n3.fbm(u, v, 0.02, 2) * 0.04;
    r = mix(jc * 1.05, r, mask); g = mix(jc, g, mask); b = mix(jc * 0.9, b, mask); rough = mix(1, rough, mask);
    t.set(idx, r, g, b, rough, h);
  });
};

/** Granite speckle mixed over a stone color (feldspar, quartz, mica). */
function graniteSpeckle(seed: number, W: number, lambda: number, P: RGB[], weights: number[]) {
  const cell = newCell();
  const f = Math.round(W / lambda);
  const cum: number[] = [];
  let acc = 0;
  for (const w of weights) { acc += w; cum.push(acc); }
  return (u: number, v: number, mask: number, c: number[]): number => {
    worley(seed, u * f, v * f, f, f, 1, cell);
    const m = ((cell.id & 1023) / 1024) * acc;
    let p = 0;
    while (p < cum.length - 1 && m > cum[p]) p++;
    const col = P[p];
    const k = mask * (0.7 + 0.3 * smooth(0.6, 0.4, cell.f1));
    c[0] = mix(c[0], col[0], k); c[1] = mix(c[1], col[1], k); c[2] = mix(c[2], col[2], k);
    return p;
  };
}

const curb: Gen = (t) => {
  const sp = graniteSpeckle(3301, t.W, 0.008, [rgb(150, 148, 144), rgb(120, 118, 116), rgb(178, 176, 172), rgb(50, 50, 52)], [40, 30, 20, 10]);
  stoneBlocks(t, {
    seed: 3302, layout: randomCourses(t.W, [1, 1, 1], 0.8, 1.6, 3303),
    joint: 0.008, depth: 0.004, bevel: 0.006, ragged: 0.002, bulge: 0, rough3d: 0,
    base: rgb(140, 138, 134), vary: 0.04, hue: 0.01, grain: 0.03, bedding: 1,
    mortar: rgb(76, 74, 70), jointDirt: 0.7, soot: 0.5, streaks: 0, rough: 0.68, roughJoint: 0.95, erosion: 0.2,
    extra: (u, v, mask, _h, c) => { sp(u, v, mask * 0.55, c); },
  });
};

const plazaStone: Gen = (t) => {
  stoneBlocks(t, {
    seed: 3401, layout: randomCourses(t.W, [0.6, 0.4, 0.6, 0.4, 0.6, 0.4, 0.6, 0.4], 0.5, 1.1, 3402),
    joint: 0.006, depth: 0.003, bevel: 0.003, ragged: 0.0008, bulge: 0.0006, rough3d: 0,
    base: rgb(180, 172, 160), vary: 0.06, hue: 0.03, grain: 0.06, bedding: 1,
    mortar: rgb(110, 104, 96), jointDirt: 0.6, soot: 0.25, streaks: 0, rough: 0.72, roughJoint: 0.95, erosion: 0.1,
  });
};

const promenade: Gen = (t) => {
  const n = new TNoise(3701, t.W);
  stoneBlocks(t, {
    seed: 3702, layout: runningBond(t.W, 8, 4, 3703, 0.01),
    joint: 0.005, depth: 0.002, bevel: 0.003, ragged: 0.0006, bulge: 0.0005, rough3d: 0,
    base: rgb(192, 186, 174), vary: 0.04, hue: 0.02, grain: 0.05, bedding: 1,
    mortar: rgb(130, 124, 114), jointDirt: 0.5, soot: 0.15, streaks: 0, rough: 0.66, roughJoint: 0.9, erosion: 0.05,
    extra: (u, v, mask, _h, c) => {
      // salt / water tide marks
      const s = n.fbm(u, v, 0.8, 4);
      const salt = smooth(0.1, 0.6, s) * 0.05 * mask;
      c[0] += salt; c[1] += salt; c[2] += salt;
    },
  });
};

// ----------------------------------------------------------------------------------- cobble
/** Granite setts laid in segmental arcs (1 m arcs), domed tops, sand/dirt joints. */
const cobble: Gen = (t) => {
  const W = t.W;
  const RH = 0.1, NR = Math.round(W / RH), P = 1.0, SAG = 0.1;
  const nW = new TNoise(3501, W), n1 = new TNoise(3502, W), nM = new TNoise(3503, W);
  // per row random sett lengths (in arc-length units), wrapping
  const rows: number[][] = [];
  const rng = new Rng(3504);
  for (let r = 0; r < NR; r++) {
    const xs: number[] = [];
    let x = rng.float() * 0.1;
    while (x < W) { xs.push(x); x += rng.range(0.085, 0.14); }
    const k = W / x;
    rows.push(xs.map((q) => q * k));
  }
  const S = [rgb(128, 124, 120), rgb(112, 110, 110), rgb(98, 99, 102), rgb(134, 122, 112), rgb(140, 134, 122), rgb(120, 116, 110)];
  t.each((u, v, x, y, idx) => {
    const wx = x + nW.fbm(u, v, 0.4, 3) * 0.02, wy = y + nW.fbm(u + 0.5, v, 0.4, 3) * 0.02;
    const arc = Math.floor(wx / P);
    const xm = wx - (arc + 0.5) * P; // -P/2..P/2
    const yy = wy + SAG * (2 * xm / P) * (2 * xm / P);
    const rowF = yy / RH, row = Math.floor(rowF);
    const ly = (rowF - row) * RH;
    const rr = ((row % NR) + NR) % NR;
    const xs = rows[rr];
    const xq = wrap(wx, W);
    let b = xs.length - 1;
    for (let k = 0; k < xs.length; k++) if (xs[k] <= xq) b = k; else break;
    const x0 = xs[b] > xq ? xs[b] - W : xs[b];
    const x1 = b + 1 < xs.length ? xs[b + 1] : xs[0] + W;
    // stretch along x to keep stones roughly square despite the arc slope
    const slope = Math.sqrt(1 + (8 * SAG * xm / (P * P)) ** 2);
    const dx = Math.min(xq - x0, x1 - xq), dy = Math.min(ly, RH - ly) / slope;
    const cusp = (P / 2 - Math.abs(xm));
    const sid = rr * 256 + b + ((((arc % 2) + 2) % 2) * 65536) * (cusp < 0.15 ? 1 : 0);
    const ra = rnd(3505, sid), rb = rnd(3506, sid), rc = rnd(3507, sid);
    const hj = 0.005 + rc * 0.003;
    const ex = Math.min(dx, cusp) - hj, ey = dy - hj, CR = 0.022;
    let e0 = Math.min(ex, ey);
    if (ex < CR && ey < CR) e0 = CR - Math.hypot(CR - ex, CR - ey);
    const e = e0 + n1.fbm(u, v, 0.03, 3) * 0.006;
    const mask = smooth(-0.001, 0.002, e);
    const dome = Math.sqrt(clamp01(e / 0.03));
    let hs = 0.01 + dome * 0.012 + (ra - 0.5) * 0.006 + n1.fbm(u, v, 0.01, 3) * 0.0008;
    const hj0 = -0.004 + n1.fbm(u, v, 0.01, 2) * 0.002;
    const h = mix(hj0, hs, mask);
    const sc = S[Math.floor(rb * S.length) % S.length];
    const tone = (0.85 + 0.3 * ra) * (1 + n1.fbm(u, v, 0.012, 2) * 0.08 + (rnd(3508, idx) - 0.5) * 0.12);
    const polish = smooth(0.0, 0.035, e);
    let r = sc[0] * tone * (1 + polish * 0.05), g = sc[1] * tone * (1 + polish * 0.05), bl = sc[2] * tone * (1 + polish * 0.05);
    const dirt = (1 - smooth(0, 0.02, e)) * 0.25;
    r *= 1 - dirt; g *= 1 - dirt; bl *= 1 - dirt;
    // joints: sand/dirt with moss in places
    const moss = smooth(0.2, 0.5, nM.fbm(u, v, 0.6, 4));
    const jk = 1 + n1.fbm(u, v, 0.006, 2) * 0.2;
    const jr = mix(0.3, 0.2, moss) * jk, jg = mix(0.27, 0.26, moss) * jk, jb = mix(0.23, 0.12, moss) * jk;
    r = mix(jr, r, mask); g = mix(jg, g, mask); bl = mix(jb, bl, mask);
    const rough = mix(0.97, mix(0.82, 0.55, polish), mask);
    t.set(idx, r, g, bl, rough, h);
  });
};

// ----------------------------------------------------------------------------------- loose
const gravelPath: Gen = (t) => {
  const W = t.W;
  const n1 = new TNoise(3601, W);
  t.each((u, v, _x, _y, idx) => {
    const k = 1 + n1.fbm(u, v, 0.3, 4) * 0.08 + (rnd(3602, idx) - 0.5) * 0.3;
    t.set(idx, 0.6 * k, 0.55 * k, 0.46 * k, 0.95, n1.fbm(u, v, 0.15, 3) * 0.003 - 0.003);
  });
  pebbles(t, 3603, {
    count: 1.1, rMin: 0.004, rMax: 0.011, height: 0.45, bed: false,
    palette: [rgb(170, 160, 140), rgb(150, 140, 125), rgb(120, 112, 104), rgb(190, 182, 166), rgb(140, 120, 100)],
    fines: rgb(152, 140, 118), finesH: 0, dust: 0.35,
    mask: (u, v) => 0.55 + 0.45 * n1.fbm(u, v, 0.4, 3),
  });
};

const dirt: Gen = (t) => {
  const W = t.W;
  const n1 = new TNoise(3801, W), n2 = new TNoise(3802, W), n3 = new TNoise(3803, W);
  const cell = newCell();
  const fc = Math.round(W / 0.12);
  t.each((u, v, _x, _y, idx) => {
    const lump = n1.fbm(u, v, 0.06, 4, 0.55);
    let h = n1.fbm(u, v, 0.8, 3) * 0.012 + lump * 0.003 + n2.fbm(u, v, 0.008, 2) * 0.0006;
    const damp = smooth(-0.2, 0.6, n2.fbm(u, v, 0.9, 4)) * 0.6;
    // dry cracks where not damp
    worley(3804, u * fc + n3.fbm(u, v, 0.05, 2) * 0.3, v * fc, fc, fc, 1, cell, true);
    const cr = (1 - smooth(0.0, 0.04, cell.edge)) * (1 - damp) * smooth(0.0, 0.3, n3.fbm(u, v, 0.7, 3));
    h -= cr * 0.003;
    const k = (1 + lump * 0.1 + (rnd(3805, idx) - 0.5) * 0.12) * (1 - damp * 0.28) * (1 - cr * 0.3);
    t.set(idx, 0.49 * k, 0.4 * k * (1 - damp * 0.05), 0.3 * k, 0.95 - damp * 0.15, h);
  });
  pebbles(t, 3806, {
    count: 0.12, rMin: 0.003, rMax: 0.012, height: 0.4, bed: false,
    palette: [rgb(140, 128, 112), rgb(110, 100, 90), rgb(160, 150, 132)],
    fines: rgb(125, 102, 76), finesH: 0, dust: 0.4,
  });
};

// ----------------------------------------------------------------------------------- grass
/** Lawn: z-buffered blade strokes over thatch, clumps, dry patches and clover. */
const grass: Gen = (t) => {
  const W = t.W;
  const nD = new TNoise(3901, W), nC = new TNoise(3902, W), nT = new TNoise(3903, W);
  t.each((u, v, _x, _y, idx) => {
    const k = 0.8 + nT.fbm(u, v, 0.05, 3) * 0.3 + (rnd(3904, idx) - 0.5) * 0.3;
    t.set(idx, 0.2 * k, 0.19 * k, 0.09 * k, 0.95, 0);
  });
  const rng = new Rng(3905);
  const ps = t.ps;
  const n = Math.round(((W * W) / (0.03 * ps)) * 1.6);
  for (let k = 0; k < n; k++) {
    const x = rng.float() * W, y = rng.float() * W;
    const u = x / W, v = y / W;
    const dens = 0.65 + 0.35 * nC.fbm(u, v, 0.12, 3);
    if (rng.float() > dens) continue;
    const dry = smooth(0.15, 0.55, nD.fbm(u, v, 1.2, 4) + nD.fbm(u, v, 0.15, 2) * 0.3);
    const len = rng.range(0.015, 0.045);
    const a = rng.float() * Math.PI * 2;
    const z0 = rng.float() * 0.012;
    const hue = rng.float();
    const vk = rng.range(0.7, 1.25);
    // fresh green -> yellow-green; dry -> straw
    let cr = mix(0.2, 0.3, hue), cg = mix(0.33, 0.4, hue), cb = mix(0.09, 0.12, hue);
    const dk = dry * rng.range(0.5, 1);
    cr = mix(cr, 0.55, dk); cg = mix(cg, 0.48, dk); cb = mix(cb, 0.26, dk);
    stroke(t, x, y, a, len, (s, idx) => {
      const z = z0 + s * len * 0.9;
      if (z <= t.h[idx]) return;
      const sh = vk * (0.5 + 0.5 * s);
      t.set(idx, cr * sh, cg * sh, cb * sh, 0.7 + dk * 0.2, z);
    });
  }
  // clover patches
  const nClover = 24;
  for (let c = 0; c < nClover; c++) {
    const px = rng.float() * W, py = rng.float() * W, pr = rng.range(0.05, 0.15);
    const leaves = Math.round(pr * pr * 4000);
    for (let l = 0; l < leaves; l++) {
      const a = rng.float() * 6.283, d = Math.sqrt(rng.float()) * pr;
      const cx = px + Math.cos(a) * d, cy = py + Math.sin(a) * d;
      const z0 = rng.range(0.01, 0.035), rot = rng.float() * 6.283, R = rng.range(0.006, 0.01);
      const vk = rng.range(0.8, 1.1);
      splat(t, cx, cy, R, (dx, dy, idx) => {
        const an = Math.atan2(dy, dx) * 3 + rot;
        const rr = Math.hypot(dx, dy) / R;
        if (rr > 0.6 + 0.4 * Math.abs(Math.cos(an * 0.5))) return;
        const z = z0 + (1 - rr) * 0.003;
        if (z <= t.h[idx]) return;
        t.set(idx, 0.16 * vk, 0.3 * vk, 0.12 * vk, 0.6, z);
      });
    }
  }
};

// ----------------------------------------------------------------------------------- quay
const quayWall: Gen = (t) => {
  const W = t.W;
  const n = new TNoise(4001, W), n2 = new TNoise(4002, W);
  stoneBlocks(t, {
    seed: 4003, layout: randomCourses(W, [0.55, 0.7, 0.6, 0.65, 0.75, 0.75], 0.9, 1.7, 4004),
    joint: 0.022, depth: 0.025, bevel: 0.02, ragged: 0.006, bulge: 0.02, rough3d: 0.025,
    base: rgb(138, 130, 118), vary: 0.08, hue: 0.03, grain: 0.06, bedding: 1.5,
    mortar: rgb(110, 106, 98), jointDirt: 0.8, soot: 0.4, streaks: 0.6, rough: 0.85, roughJoint: 0.95, erosion: 0.4,
    extra: (u, v, mask, _h, c) => {
      // wet/algae band at the bottom (v = 0 = waterline), wrapping softly at the top edge
      const wet0 = Math.max(1 - smooth(0.0, 0.42, v + n.fbm(u, v, 0.3, 3) * 0.06), 1 - smooth(0, 0.03, 1 - v));
      const wet = clamp01(wet0 * (0.75 + 0.25 * n2.fbm(u, v, 0.1, 3)));
      const algae = smooth(0.4, 0.85, wet) * (0.6 + 0.4 * n.fbm(u, v, 0.05, 3));
      const dk = 1 - wet * 0.45;
      c[0] = mix(c[0] * dk, 0.2, algae * 0.5);
      c[1] = mix(c[1] * dk, 0.24, algae * 0.5);
      c[2] = mix(c[2] * dk, 0.14, algae * 0.5);
      c[3] = mix(c[3], 0.45, wet * 0.6);
      // efflorescence from joints above the wet band
      const eff = (1 - mask) * smooth(0.3, 0.6, n2.fbm(u, v, 0.2, 3)) * (1 - wet) * 0.4;
      c[0] = mix(c[0], 0.72, eff); c[1] = mix(c[1], 0.72, eff); c[2] = mix(c[2], 0.7, eff);
    },
  });
};

export const GROUNDS: { W: number; gen: Gen; normal: number; aoK: number; aoR: [number, number] }[] = [
  { W: 4.0, gen: roadAsphalt, normal: 1, aoK: 60, aoR: [0.01, 0.04] },
  { W: 3.0, gen: paving, normal: 1, aoK: 50, aoR: [0.008, 0.03] },
  { W: 3.0, gen: curb, normal: 1, aoK: 50, aoR: [0.008, 0.03] },
  { W: 3.0, gen: grass, normal: 0.35, aoK: 25, aoR: [0.01, 0.04] },
  { W: 4.0, gen: plazaStone, normal: 1, aoK: 50, aoR: [0.008, 0.03] },
  { W: 2.0, gen: cobble, normal: 1, aoK: 40, aoR: [0.006, 0.025] },
  { W: 2.0, gen: gravelPath, normal: 0.8, aoK: 70, aoR: [0.005, 0.02] },
  { W: 4.0, gen: promenade, normal: 1, aoK: 50, aoR: [0.008, 0.03] },
  { W: 4.0, gen: lightAsphalt, normal: 1, aoK: 60, aoR: [0.01, 0.04] },
  { W: 2.0, gen: roadPaint(rgb(222, 220, 212), 4101), normal: 1, aoK: 60, aoR: [0.008, 0.03] },
  { W: 2.0, gen: roadPaint(rgb(226, 170, 40), 4201), normal: 1, aoK: 60, aoR: [0.008, 0.03] },
  { W: 3.0, gen: dirt, normal: 0.8, aoK: 50, aoR: [0.01, 0.04] },
  { W: 4.0, gen: quayWall, normal: 1, aoK: 25, aoR: [0.015, 0.06] },
];
