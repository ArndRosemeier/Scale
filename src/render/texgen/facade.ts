/**
 * Facade wall layers (FacadeMat 0..15).
 */
import { Rng } from '../../core/rng';
import { Noise } from '../../core/noise';
import { RGB, TNoise, Tex, clamp01, mix, newCell, rgb, rnd, smooth, worley, wrap, wrapd } from './core';
import { flemishBond, randomCourses, runningBond, Hit } from './layout';
import { brickWall, stoneBlocks } from './masonry';

type Gen = (t: Tex) => void;

const lerp3 = (a: RGB, b: RGB, t: number, out: number[]): void => {
  out[0] = mix(a[0], b[0], t); out[1] = mix(a[1], b[1], t); out[2] = mix(a[2], b[2], t);
};

// ----------------------------------------------------------------------------------- bricks
/** UK/EU brick: 215 x 65 mm + 10 mm joints -> 225 x 75 mm module. */
const brickRed: Gen = (t) => {
  const C1 = rgb(160, 74, 50), C2 = rgb(128, 54, 42), C3 = rgb(96, 44, 40), C4 = rgb(178, 96, 64);
  brickWall(t, {
    seed: 101, layout: runningBond(t.W, 30, 10, 11, 0.003),
    joint: 0.01, depth: 0.007, bevel: 0.004, ragged: 0.0008, chips: 0.35,
    palette: (a, b, _k, o) => {
      lerp3(C1, C2, a, o);
      if (b < 0.1) lerp3(o as RGB, C3, 0.7, o); else if (b > 0.9) lerp3(o as RGB, C4, 0.7, o);
      const v = 0.9 + 0.2 * ((a * 7.31) % 1);
      o[0] *= v; o[1] *= v; o[2] *= v;
    },
    mottle: 0.07, mortar: rgb(176, 170, 158), soot: 0.55, streaks: 0.45, rough: 0.82,
  });
};

/** Flemish bond, purple-brown brick with darker burnt headers. */
const brickBrown: Gen = (t) => {
  const C1 = rgb(112, 66, 52), C2 = rgb(86, 52, 48), C3 = rgb(92, 58, 66), H = rgb(66, 44, 44);
  brickWall(t, {
    seed: 202, layout: flemishBond(t.W, 36, 8, 22, 0.002),
    joint: 0.01, depth: 0.006, bevel: 0.003, ragged: 0.0007, chips: 0.25,
    palette: (a, b, k, o) => {
      lerp3(C1, C2, a, o);
      if (b < 0.25) lerp3(o as RGB, C3, 0.6, o);
      if (k === 1 && b > 0.35) lerp3(o as RGB, H, 0.65, o);
      const v = 0.88 + 0.24 * ((a * 5.17) % 1);
      o[0] *= v; o[1] *= v; o[2] *= v;
    },
    mottle: 0.06, mortar: rgb(150, 144, 134), soot: 0.45, streaks: 0.35, rough: 0.78,
  });
};

/** London stock: yellow-buff, irregular, soot-darkened. */
const brickYellow: Gen = (t) => {
  const C1 = rgb(196, 168, 118), C2 = rgb(168, 138, 96), C3 = rgb(120, 96, 72), C4 = rgb(186, 140, 108);
  brickWall(t, {
    seed: 303, layout: runningBond(t.W, 30, 10, 33, 0.008),
    joint: 0.011, depth: 0.008, bevel: 0.005, ragged: 0.0022, chips: 0.8,
    palette: (a, b, _k, o) => {
      lerp3(C1, C2, a, o);
      if (b < 0.18) lerp3(o as RGB, C3, 0.6 + b, o); else if (b > 0.85) lerp3(o as RGB, C4, 0.7, o);
    },
    mottle: 0.1, mortar: rgb(168, 160, 145), soot: 0.6, streaks: 0.45, rough: 0.88,
  });
};

/** Painted white brick with flaking paint over red brick. */
const brickWhite: Gen = (t) => {
  const C1 = rgb(138, 104, 92), C2 = rgb(112, 86, 78);
  brickWall(t, {
    seed: 1515, layout: runningBond(t.W, 30, 10, 1516, 0.003),
    joint: 0.01, depth: 0.006, bevel: 0.004, ragged: 0.001, chips: 0.4,
    palette: (a, _b, _k, o) => lerp3(C1, C2, a, o),
    mottle: 0.07, mortar: rgb(170, 165, 155), soot: 0.25, streaks: 0.3, rough: 0.82,
    paint: { color: rgb(226, 224, 218), coverage: 0.985 },
  });
};

// ----------------------------------------------------------------------------------- stone
const brownstone: Gen = (t) => {
  stoneBlocks(t, {
    seed: 404, layout: randomCourses(t.W, [0.4, 0.4, 0.4, 0.4, 0.4, 0.4], 0.8, 1.4, 44),
    joint: 0.004, depth: 0.003, bevel: 0.006, ragged: 0.001, bulge: 0.001, rough3d: 0,
    base: rgb(106, 72, 58), vary: 0.05, hue: 0.03, grain: 0.07, bedding: 4,
    mortar: rgb(92, 66, 56), jointDirt: 0.4, soot: 0.4, streaks: 0.35, rough: 0.8, roughJoint: 0.9, erosion: 0.35,
  });
};

const limestone: Gen = (t) => {
  const n = new TNoise(4401, t.W);
  stoneBlocks(t, {
    seed: 505, layout: randomCourses(t.W, [0.6, 0.6, 0.6, 0.6, 0.6], 0.9, 1.6, 55),
    joint: 0.005, depth: 0.003, bevel: 0.004, ragged: 0.0006, bulge: 0.0008, rough3d: 0,
    base: rgb(214, 202, 178), vary: 0.035, hue: 0.02, grain: 0.035, bedding: 2,
    mortar: rgb(186, 176, 156), jointDirt: 0.7, soot: 0.3, streaks: 0.4, rough: 0.78, roughJoint: 0.9, erosion: 0.15,
    extra: (u, v, mask, _hit, c) => {
      // fossil shell fragments / calcite specks
      const f = n.fbm(u, v, 0.01, 2);
      const sp = smooth(0.45, 0.6, f) * 0.06 * mask;
      c[0] *= 1 + sp; c[1] *= 1 + sp; c[2] *= 1 + sp * 0.8;
    },
  });
};

const sandstone: Gen = (t) => {
  stoneBlocks(t, {
    seed: 606, layout: randomCourses(t.W, [0.4, 0.4, 0.4, 0.4, 0.4, 0.4], 0.5, 1.0, 66),
    joint: 0.008, depth: 0.006, bevel: 0.01, ragged: 0.002, bulge: 0.0015, rough3d: 0,
    base: rgb(190, 150, 104), vary: 0.05, hue: 0.022, grain: 0.09, bedding: 6,
    mortar: rgb(170, 152, 126), jointDirt: 0.5, soot: 0.45, streaks: 0.35, rough: 0.9, roughJoint: 0.95, erosion: 0.9,
  });
};

const granite: Gen = (t) => {
  const W = t.W;
  const cell = newCell();
  const fa = Math.round(W / 0.009), fb = Math.round(W / 0.022);
  const P = [rgb(178, 150, 142), rgb(150, 128, 122), rgb(140, 140, 146), rgb(48, 46, 48), rgb(206, 202, 198)];
  stoneBlocks(t, {
    seed: 1313, layout: runningBond(W, 4, 2, 1314, 0),
    joint: 0.004, depth: 0.002, bevel: 0.0015, ragged: 0.0002, bulge: 0, rough3d: 0,
    base: rgb(160, 140, 136), vary: 0.03, hue: 0.01, grain: 0.02, bedding: 1,
    mortar: rgb(90, 88, 88), jointDirt: 0.3, soot: 0.25, streaks: 0.25, rough: 0.2, roughJoint: 0.8, erosion: 0,
    extra: (u, v, mask, _hit, c) => {
      worley(9001, u * fa, v * fa, fa, fa, 1, cell);
      let m = cell.id & 255;
      let p = m < 120 ? 0 : m < 170 ? 1 : m < 225 ? 2 : m < 248 ? 3 : 4;
      const w1 = smooth(0.62, 0.45, cell.f1);
      worley(9002, u * fb, v * fb, fb, fb, 1, cell);
      m = cell.id & 255;
      if (m < 40 && cell.f1 < 0.42) p = 0; // large feldspar phenocrysts
      const col = P[p];
      const k = mask * (0.75 + 0.25 * w1);
      c[0] = mix(c[0], col[0], k); c[1] = mix(c[1], col[1], k); c[2] = mix(c[2], col[2], k);
      if (p === 2) c[3] = mix(c[3], 0.12, mask); // glassy quartz
    },
  });
};

// ----------------------------------------------------------------------------------- render
const plaster: Gen = (t) => {
  const W = t.W;
  const n1 = new TNoise(601, W), n2 = new TNoise(602, W), n3 = new TNoise(603, W), nc = new TNoise(604, W);
  const cell = newCell();
  const fc = Math.round(W / 0.35), fc2 = Math.round(W / 0.12);
  t.each((u, v, _x, y, idx) => {
    // trowel: overlapping sweeps from warped ridged noise
    const wu = u + n1.fbm(u, v, 0.6, 3) * 0.04, wv = v + n1.fbm(u + 0.5, v, 0.6, 3) * 0.04;
    const sweep = n2.ridged(wu, wv, 0.35, 3, 0.5, 0.18);
    let h = sweep * 0.0012 + n2.fbm(u, v, 0.05, 3) * 0.0003 + n3.fbm(u, v, 0.008, 2) * 0.00012;
    // hairline cracks in some areas
    const area = smooth(0.15, 0.45, nc.fbm(u, v, 1.2, 3));
    let crack = 0;
    if (area > 0) {
      worley(6001, u * fc + n3.fbm(u, v, 0.1, 2) * 0.25, v * fc, fc, fc, 0.9, cell, true);
      crack = (1 - smooth(0.0, 0.012, cell.edge)) * area;
      const a2 = area * smooth(0.2, 0.5, nc.fbm(u, v, 0.3, 2));
      if (a2 > 0) {
        worley(6002, u * fc2, v * fc2 + n3.fbm(u, v, 0.05, 2) * 0.2, fc2, fc2, 0.9, cell, true);
        crack = Math.max(crack, (1 - smooth(0, 0.02, cell.edge)) * a2);
      }
    }
    h -= crack * 0.0008;
    // dirt: horizontal band at v=0 (bottom of tile), wraps softly into the top
    const dv = y / W;
    const band = Math.max(1 - smooth(0, 0.3, dv), 1 - smooth(0, 0.03, 1 - dv));
    const dirtN = smooth(-0.3, 0.6, n1.fbm(u, v, 0.4, 4) + n3.fbm(u, v, 0.15, 3, 0.5, 0.6) * 0.4);
    const dirt = band * dirtN * 0.06;
    const streak = smooth(0.2, 0.9, n3.fbm(u, v, 0.35, 3, 0.5, 2.0)) * 0.05;
    const tone = 1 + n2.fbm(u, v, 0.8, 4) * 0.025 + sweep * 0.015 + (rnd(66, idx) - 0.5) * 0.015;
    const k = tone * (1 - dirt - streak) * (1 - crack * 0.25);
    t.set(idx, 0.89 * k, 0.88 * k, 0.855 * k * (1 - dirt * 0.1), 0.88 + sweep * 0.05 - streak * 0.1, h);
  });
};

const stucco: Gen = (t) => {
  const W = t.W;
  const n1 = new TNoise(701, W), n2 = new TNoise(702, W);
  const cell = newCell();
  const f1 = Math.round(W / 0.014), f2 = Math.round(W / 0.007);
  t.each((u, v, _x, y, idx) => {
    worley(7001, u * f1, v * f1, f1, f1, 1, cell);
    const b1 = smooth(0.62, 0.15, cell.f1) * (0.6 + 0.4 * ((cell.id & 255) / 255));
    worley(7002, u * f2, v * f2, f2, f2, 1, cell);
    const b2 = smooth(0.6, 0.1, cell.f1) * ((cell.id & 1) ? 1 : 0.3);
    // knock-down: blobs flattened on top
    let h = Math.min(0.7, b1) * 0.0022 + b2 * 0.0007 + n1.fbm(u, v, 0.4, 3) * 0.0008 + n2.fbm(u, v, 0.05, 2) * 0.0003;
    h += smooth(0.2, 0.8, n2.fbm(u, v, 0.1, 3)) * 0.0006;
    const dv = y / W;
    const band = Math.max(1 - smooth(0, 0.3, dv), 1 - smooth(0, 0.03, 1 - dv));
    const dirt = band * smooth(-0.3, 0.6, n1.fbm(u, v, 0.3, 4)) * 0.035;
    const streak = smooth(0.2, 0.9, n2.fbm(u, v, 0.3, 3, 0.5, 1.6)) * 0.05;
    const tone = (1 + n1.fbm(u, v, 0.7, 4) * 0.03 + b1 * 0.02) * (1 - dirt - streak);
    t.set(idx, 0.88 * tone, 0.87 * tone, 0.845 * tone, 0.93, h);
  });
};

// ----------------------------------------------------------------------------------- concrete
/** Cast-in-place concrete: plywood form panels 1.2 x 0.6 m, tie holes on a 0.6 m grid. */
const concrete: Gen = (t) => {
  const W = t.W;
  const n1 = new TNoise(801, W), n2 = new TNoise(802, W), n3 = new TNoise(803, W);
  const cell = newCell();
  const fb = Math.round(W / 0.025);
  const PW = 1.2, PH = 0.6, R = 0.013;
  t.each((u, v, x, y, idx) => {
    const pi = Math.floor(x / PW), pj = Math.floor(y / PH);
    const pid = (pi % Math.round(W / PW)) * 16 + pj;
    const pr = rnd(808, pid, 1);
    const sx = Math.min(x - pi * PW, (pi + 1) * PW - x), sy = Math.min(y - pj * PH, (pj + 1) * PH - y);
    const seamD = Math.min(sx, sy);
    const seam = 1 - smooth(0.0015, 0.004, seamD);
    // plywood grain imprint (horizontal) differs per panel
    const grain = n2.fbm(u + pr, v, 0.5, 4, 0.55, 0.012) * 0.00025;
    let h = n1.fbm(u, v, 0.3, 3) * 0.0006 + grain + n3.fbm(u, v, 0.006, 2) * 0.00012 + (pr - 0.5) * 0.001;
    h += seam * 0.0007; // fins where the form joints leaked
    // tie holes
    const hx = wrapd(x - 0.3, 0.6), hy = wrapd(y - 0.3, 0.6);
    const hr = Math.sqrt(hx * hx + hy * hy);
    const hole = 1 - smooth(R - 0.0015, R + 0.0015, hr);
    const ring = smooth(R, R + 0.004, hr) * (1 - smooth(R + 0.004, R + 0.012, hr));
    h -= hole * 0.012 * (1 - (hr / R) * 0.4);
    // bug holes (air pores)
    worley(8001, u * fb, v * fb, fb, fb, 1, cell);
    const pore = (cell.id & 255) < 35 ? 1 - smooth(0.12, 0.3, cell.f1) : 0;
    h -= pore * 0.002;
    // stains: rust/water streaks under tie holes
    const below = -hy; // positive below hole
    const stLen = 0.08 + 0.35 * rnd(809, Math.round((x - hx) / 0.6), Math.round((y - hy) / 0.6));
    const runw = Math.abs(hx) < 0.018 + below * 0.03 ? 1 : 0;
    const run = below > 0 && below < stLen ? runw * (1 - below / stLen) * smooth(0.012, 0.004, Math.abs(hx) + n3.fbm(u, v, 0.03, 2, 0.5, 0.2) * 0.008) : 0;
    const mott = n1.fbm(u, v, 0.25, 5, 0.55) * 0.06 + (pr - 0.5) * 0.08 + n3.fbm(u, v, 0.03, 3) * 0.03;
    const streak = smooth(0.2, 0.9, n2.fbm(u, v, 0.1, 3, 0.5, 1.4) + n1.fbm(u, v, 0.8, 2) * 0.3) * 0.12;
    let k = (1 + mott) * (1 - streak) * (1 - seam * 0.08) * (1 - pore * 0.35) * (1 - ring * 0.08);
    let r = 0.6 * k, g = 0.595 * k, b = 0.58 * k;
    if (run > 0) { r = mix(r, r * 0.88, run); g = mix(g, g * 0.82, run); b = mix(b, b * 0.75, run); }
    if (hole > 0) { r = mix(r, 0.3, hole); g = mix(g, 0.29, hole); b = mix(b, 0.28, hole); }
    t.set(idx, r, g, b, 0.86 + streak * 0.3 - hole * 0.1, h);
  });
};

/** Precast exposed-aggregate panel, one 3x3 m panel per tile, joint at the tile edge. */
const concretePanel: Gen = (t) => {
  const W = t.W;
  const n1 = new TNoise(901, W), n2 = new TNoise(902, W);
  const cell = newCell();
  const fa = Math.round(W / 0.011);
  const A = [rgb(196, 188, 172), rgb(150, 146, 140), rgb(108, 104, 100), rgb(178, 160, 136), rgb(212, 208, 200), rgb(140, 120, 104)];
  const binder = rgb(168, 164, 156);
  t.each((u, v, x, y, idx) => {
    const dx = Math.min(x, W - x), dy = Math.min(y, W - y);
    const e = Math.min(dx, dy) - 0.01; // 20 mm joint
    const jm = smooth(-0.001, 0.001, e);
    const cham = smooth(0, 0.012, e);
    worley(9003, u * fa, v * fa, fa, fa, 1, cell);
    const pebble = (cell.id & 255) < 175 ? smooth(0.55, 0.3, cell.f1) : 0;
    const pc = A[(cell.id >>> 8) % 6];
    let h = 0.015 * (0.6 + 0.4 * cham) + pebble * 0.0012 + n1.fbm(u, v, 0.5, 3) * 0.0005;
    const vary = 1 + (rnd(91, cell.id) - 0.5) * 0.15;
    let r = mix(binder[0], pc[0] * vary, pebble), g = mix(binder[1], pc[1] * vary, pebble), b = mix(binder[2], pc[2] * vary, pebble);
    // streaks from top joint, dirt along bottom
    const top = 1 - smooth(0, 1.2, W - y);
    const st = smooth(0.0, 0.8, n2.fbm(u, v, 0.15, 3, 0.5, 1.5)) * (0.35 + 0.65 * top) * 0.22;
    const mac = 1 + n1.fbm(u, v, 0.8, 4) * 0.05;
    const k = mac * (1 - st) * (0.9 + 0.1 * cham);
    r *= k; g *= k; b *= k;
    const sealant = 0.27 + n2.fbm(u, v, 0.02, 2) * 0.02;
    r = mix(sealant, r, jm); g = mix(sealant, g, jm); b = mix(sealant * 1.03, b, jm);
    h = mix(0.003, h, jm);
    t.set(idx, r, g, b, mix(0.6, 0.9, jm), h);
  });
};

// ----------------------------------------------------------------------------------- glass/metal
/** Curtain wall backing: mullions every 1.3 m, floor transom at v=0, spandrel band 0..1.0 m. */
const glassCurtain: Gen = (t) => {
  const W = t.W;
  const n1 = new TNoise(1001, W), n2 = new TNoise(1002, W);
  const MW = 0.03, SP = 1.3, SPAN = 1.0;
  t.each((u, v, x, y, idx) => {
    const mx = Math.abs(wrapd(x, SP));
    const ty = Math.min(Math.abs(wrapd(y, W)), Math.abs(y - SPAN));
    const isFloor = Math.abs(wrapd(y, W)) < 0.06;
    const pane = Math.floor(x / SP) * 4 + (y < SPAN ? 0 : 1);
    const pr = rnd(1010, pane);
    // mullion/transom profile: rounded cap
    const tw = isFloor ? 0.05 : MW;
    const dm = Math.min(mx - MW, ty - tw);
    const frame = smooth(0.002, -0.002, dm);
    const capM = Math.max(0, 1 - (mx / MW) ** 2), capT = Math.max(0, 1 - (ty / tw) ** 2);
    const cap = Math.max(mx < MW ? Math.sqrt(capM) : 0, ty < tw ? Math.sqrt(capT) : 0);
    const groove = Math.abs(mx - MW * 0.55) < 0.002 || Math.abs(ty - tw * 0.55) < 0.002 ? 1 : 0;
    // glass waviness (roller wave) -> distorted reflections via normals
    const wave = n1.fbm(u, v + pr, 0.35, 2, 0.5, 2.5) * 0.0004 + n2.fbm(u, v, 1.5, 2) * 0.0006;
    let h = frame ? 0.045 * cap - groove * 0.002 : wave;
    if (frame > 0 && frame < 1) h = mix(wave, 0.045 * cap, frame);
    const spandrel = y < SPAN && !isFloor;
    let r: number, g: number, b: number, rough: number;
    if (spandrel) {
      const k = 1 + n2.fbm(u, v, 0.2, 3) * 0.04 + (pr - 0.5) * 0.06;
      r = 0.26 * k; g = 0.285 * k; b = 0.31 * k; rough = 0.16;
    } else {
      const k = 1 + (pr - 0.5) * 0.08 + n1.fbm(u, v, 1.0, 3) * 0.03;
      r = 0.17 * k; g = 0.205 * k; b = 0.245 * k; rough = 0.06;
    }
    const fk = 1 + n2.fbm(u, v, 0.05, 2) * 0.03 - groove * 0.3;
    r = mix(r, 0.34 * fk, frame); g = mix(g, 0.35 * fk, frame); b = mix(b, 0.37 * fk, frame);
    rough = mix(rough, 0.35, frame);
    t.set(idx, r, g, b, rough, h);
  });
};

/** Standing-seam / box-rib metal cladding, ribs every 0.2 m, end lap at v=0. */
const metalPanel: Gen = (t) => {
  const W = t.W;
  const n1 = new TNoise(1101, W), n2 = new TNoise(1102, W);
  const P = 0.2, top = 0.012, side = 0.01, H = 0.022;
  t.each((u, v, x, y, idx) => {
    const d = Math.abs(wrapd(x, P));
    let h = d < top ? H : d < top + side ? H * (1 - smooth(0, 1, (d - top) / side)) : 0;
    // two shallow stiffening ribs in the pan
    const pd = Math.abs(Math.abs(wrapd(x - P / 2, P)) - 0.045);
    h += (1 - smooth(0.0, 0.006, pd)) * 0.0015;
    // oil canning
    h += n1.fbm(u, v, 0.6, 3, 0.5, 1.2) * 0.0008 * smooth(top + side, top + side + 0.02, d);
    // end lap at y=0
    const ly = wrap(y, W);
    const lap = ly < 0.03 ? 0.002 : 0;
    h += lap;
    const lapLine = 1 - smooth(0.0, 0.004, Math.min(Math.abs(ly - 0.03), Math.abs(ly - W)));
    const facet = d >= top && d < top + side ? 0.94 : 1;
    const streak = smooth(0.15, 0.9, n2.fbm(u, v, 0.08, 3, 0.5, 1.5)) * 0.1 * (d < top + side ? 0.6 : 1);
    const chalk = n1.fbm(u, v, 0.4, 4) * 0.03;
    const k = (1 + chalk) * (1 - streak) * facet * (1 - lapLine * 0.25);
    t.set(idx, 0.69 * k, 0.70 * k, 0.715 * k, 0.42 + streak * 0.8 + n2.fbm(u, v, 0.2, 2) * 0.04, h);
  });
};

// ----------------------------------------------------------------------------------- timber
interface Beam { ax: number; ay: number; bx: number; by: number; w: number; id: number }
/** Half-timbering: oak posts every 1.2 m, sill + mid rail, braces, white infill. Tile 2.4 m. */
const timber: Gen = (t) => {
  const W = t.W;
  const nWood = new Noise(1201), nw = new TNoise(1202, W), nPl = new TNoise(1203, W), nC = new TNoise(1204, W);
  // members in meters; rails/posts wrap via periodic distance, braces are interior
  const beams: Beam[] = [
    { ax: 0.1, ay: 0.12, bx: 1.1, by: 1.09, w: 0.17, id: 10 },
    { ax: 2.3, ay: 0.12, bx: 1.3, by: 1.09, w: 0.17, id: 11 },
    { ax: 1.2, ay: 1.75, bx: 1.65, by: 1.2, w: 0.14, id: 12 },
    { ax: 2.4, ay: 1.75, bx: 1.95, by: 1.2, w: 0.14, id: 13 },
  ];
  const PW = 0.2, RAIL = 0.22, MID = 0.18;
  const woodCol = (gx: number, gy: number, id: number, out: number[]): number => {
    // gx along grain (m), gy across grain (m)
    const base = 1 + (rnd(1205, id) - 0.5) * 0.18;
    const g1 = nWood.fbm2(gx * 1.2 + id * 13.1, gy * 70 + nWood.n2(gx * 2, id) * 3, 4);
    const ring = Math.abs(Math.sin((gy * 120 + nWood.fbm2(gx * 1.5 + id, gy * 4, 3) * 12)));
    const g2 = nWood.n2(gx * 3 + id * 7, gy * 260) * 0.6 + (ring < 0.25 ? -0.6 : 0);
    const check = smooth(0.85, 0.97, Math.abs(nWood.n2(gx * 0.6 + id * 3.3, gy * 45)) ) * smooth(-0.1, 0.3, nWood.n2(gx * 2.2, id));
    const k = base * (1 + g1 * 0.22 + g2 * 0.1) * (1 - check * 0.55);
    out[0] = 0.28 * k; out[1] = 0.2 * k; out[2] = 0.15 * k;
    return check;
  };
  const wc = [0, 0, 0];
  t.each((u, v, x, y, idx) => {
    // infill plaster
    const ph = -0.015 + nPl.fbm(u, v, 0.4, 4) * 0.002 + nPl.fbm(u, v, 0.03, 3) * 0.0004;
    const pk = 1 + nPl.fbm(u, v, 0.5, 4) * 0.03 - smooth(0.2, 0.9, nC.fbm(u, v, 0.15, 3, 0.5, 1.2)) * 0.07;
    let r = 0.88 * pk, g = 0.86 * pk, b = 0.81 * pk, rough = 0.9, h = ph;
    let best = 1e9, inWood = false, check = 0;
    let bh = 0;
    // posts (vertical, at x = 0, 1.2)
    const dpx = Math.abs(wrapd(x, 1.2));
    const edgeN = nw.fbm(u, v, 0.02, 3) * 0.004;
    const pi = Math.round(x / 1.2) % 2;
    const consider = (dist: number, half: number, along: number, across: number, id: number, z: number): void => {
      const e = half - dist + edgeN;
      if (e > 0 && z + Math.min(1, e / 0.012) * 0.004 > bh - 1e-6) {
        bh = z + smooth(0, 0.015, e) * 0.006;
        check = woodCol(along, across, id, wc);
        inWood = true;
        best = e;
      }
    };
    consider(dpx, PW / 2, y, wrapd(x, 1.2), 1 + pi, 0.003);
    // rails (horizontal): sill at y=0 and mid rail at y=1.2
    const dry = Math.abs(wrapd(y, W)), dmy = Math.abs(y - 1.2);
    consider(dry, RAIL / 2, x, wrapd(y, W), 3, 0.004);
    consider(dmy, MID / 2, x + 7, y - 1.2, 4, 0.0035);
    for (const bm of beams) {
      const dx = bm.bx - bm.ax, dy = bm.by - bm.ay, L = Math.hypot(dx, dy);
      const tx = dx / L, ty = dy / L;
      const qx = x - bm.ax, qy = y - bm.ay;
      const along = qx * tx + qy * ty;
      if (along < -0.05 || along > L + 0.05) continue;
      const across = -qx * ty + qy * tx;
      consider(Math.abs(across), bm.w / 2, along, across, bm.id, 0.002);
    }
    if (inWood) {
      const m = smooth(-0.001, 0.002, best);
      // wooden pegs near member joints
      r = mix(r, wc[0], m); g = mix(g, wc[1], m); b = mix(b, wc[2], m);
      rough = mix(rough, 0.75, m);
      h = mix(h, bh + nWood.n2(x * 40, y * 40) * 0.0004 - check * 0.003, m);
      // dark gap line at the plaster edge
      const gap = smooth(0.006, 0.0, best) * smooth(-0.003, 0.0, best);
      r *= 1 - gap * 0.4; g *= 1 - gap * 0.4; b *= 1 - gap * 0.4;
    }
    // pegs: at post/rail crossings
    for (const px of [0, 1.2, 2.4]) for (const py of [0.06, 1.2, W - 0.06]) {
      const dd = Math.hypot(x - px - 0.0, y - py) - 0.012;
      if (Math.abs(x - px) < 0.05 && Math.abs(y - py) < 0.05 && dd < 0) { r *= 0.75; g *= 0.72; b *= 0.7; h += 0.001; }
    }
    // overall weathering / dirt at the bottom
    const dirt = (1 - smooth(0, 0.5, y)) * smooth(-0.2, 0.6, nC.fbm(u, v, 0.3, 3)) * 0.15;
    t.set(idx, r * (1 - dirt), g * (1 - dirt), b * (1 - dirt * 1.1), rough, h);
  });
};

/** Clapboard lap siding, 0.15 m exposure, painted near-white. */
const woodSiding: Gen = (t) => {
  const W = t.W;
  const N = Math.round(W / 0.15), BH = W / N;
  const nG = new TNoise(1401, W), nP = new TNoise(1402, W), nD = new TNoise(1403, W);
  const rng = new Rng(1404);
  const joints: number[] = [];
  for (let k = 0; k < N; k++) joints.push(rng.float() * W);
  t.each((u, v, x, y, idx) => {
    const row = Math.floor(y / BH) % N;
    const ly = (y - row * BH) / BH; // 0 at butt (bottom edge), 1 at top
    const jx = wrapd(x - joints[row], W);
    const bid = row * 2 + (jx > 0 ? 1 : 0);
    // board cross section: thick at the butt, thin under the next board
    let h = 0.011 * (1 - ly) + 0.002;
    h -= (1 - smooth(0, 0.05, ly)) * 0.0015; // rounded butt edge
    h += (rnd(1405, bid) - 0.5) * 0.0006;
    const grain = nG.fbm(u + rnd(1406, bid), v, 0.6, 4, 0.55, 0.004);
    h += grain * 0.00025;
    const jg = 1 - smooth(0.0012, 0.0025, Math.abs(jx));
    h -= jg * 0.004;
    // paint
    const peel = smooth(0.62, 0.66, nP.fbm(u, v, 0.3, 5, 0.6) + nP.fbm(u, v, 0.03, 2) * 0.15);
    const tone = 1 + grain * 0.025 + (rnd(1407, bid) - 0.5) * 0.03 + nD.fbm(u, v, 0.9, 3) * 0.02;
    const under = smooth(0.0, 0.18, ly); // dirt collects just under the butt
    const dirt = (1 - under) * 0.06 + smooth(0.2, 0.9, nD.fbm(u, v, 0.1, 3, 0.5, 1.4)) * 0.06;
    let r = 0.87 * tone * (1 - dirt), g = 0.86 * tone * (1 - dirt), b = 0.83 * tone * (1 - dirt);
    if (peel > 0) {
      const wood = 0.55 + grain * 0.08;
      r = mix(r, wood * 0.82, peel); g = mix(g, wood * 0.72, peel); b = mix(b, wood * 0.6, peel);
      h -= peel * 0.0003;
    }
    r *= 1 - jg * 0.5; g *= 1 - jg * 0.5; b *= 1 - jg * 0.5;
    t.set(idx, r, g, b, 0.62 + peel * 0.25 + dirt, h);
  });
};

export const FACADE_WALLS: { W: number; gen: Gen; normal: number; aoK: number; aoR: [number, number] }[] = [
  { W: 2.25, gen: brickRed, normal: 1, aoK: 60, aoR: [0.008, 0.03] },
  { W: 2.7, gen: brickBrown, normal: 1, aoK: 60, aoR: [0.008, 0.03] },
  { W: 2.25, gen: brickYellow, normal: 1, aoK: 60, aoR: [0.008, 0.03] },
  { W: 2.4, gen: brownstone, normal: 1, aoK: 50, aoR: [0.01, 0.04] },
  { W: 3.0, gen: limestone, normal: 1, aoK: 50, aoR: [0.01, 0.04] },
  { W: 2.4, gen: sandstone, normal: 1, aoK: 50, aoR: [0.01, 0.04] },
  { W: 3.0, gen: plaster, normal: 1.2, aoK: 80, aoR: [0.01, 0.05] },
  { W: 2.0, gen: stucco, normal: 1, aoK: 120, aoR: [0.006, 0.02] },
  { W: 2.4, gen: concrete, normal: 1, aoK: 50, aoR: [0.008, 0.03] },
  { W: 3.0, gen: concretePanel, normal: 1, aoK: 40, aoR: [0.01, 0.04] },
  { W: 3.9, gen: glassCurtain, normal: 0.6, aoK: 20, aoR: [0.02, 0.06] },
  { W: 2.0, gen: metalPanel, normal: 1, aoK: 25, aoR: [0.01, 0.04] },
  { W: 2.4, gen: timber, normal: 1, aoK: 50, aoR: [0.01, 0.04] },
  { W: 2.4, gen: granite, normal: 1, aoK: 50, aoR: [0.006, 0.02] },
  { W: 2.4, gen: woodSiding, normal: 1, aoK: 60, aoR: [0.01, 0.03] },
  { W: 2.25, gen: brickWhite, normal: 1, aoK: 60, aoR: [0.008, 0.03] },
];

export type { Gen };
