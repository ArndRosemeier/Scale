/**
 * Roof layers (RoofMat 0..7 -> facade layers 16..23). +v is up-slope: shingles/tiles/slates
 * overlap downward (each course's butt edge lies at the bottom of its row).
 */
import { Rng } from '../../core/rng';
import { RGB, TNoise, Tex, clamp01, mix, newCell, rgb, rnd, smooth, worley, wrap, wrapd } from './core';
import { pebbles, splat } from './paint';

type Gen = (t: Tex) => void;

/** Flat bitumen membrane: 1 m rolls with laps, repair patches, blisters, dried puddle marks. */
const tar: Gen = (t) => {
  const W = t.W;
  const n1 = new TNoise(1601, W), n2 = new TNoise(1602, W), n3 = new TNoise(1603, W);
  const cell = newCell();
  const rng = new Rng(1604);
  const patches: number[][] = [];
  for (let k = 0; k < 3; k++) patches.push([rng.float() * W, rng.float() * W, rng.range(0.5, 1.2), rng.range(0.4, 0.9)]);
  const ends: number[] = [];
  for (let k = 0; k < Math.round(W); k++) ends.push(rng.float() * W);
  const fb = Math.round(W / 0.25);
  t.each((u, v, x, y, idx) => {
    const strip = Math.floor(x) % Math.round(W);
    const sx = x - Math.floor(x); // 0..1 across roll
    // side lap: the next roll overlaps 0.08 m; its edge is at sx = 0.08
    const lap = sx < 0.08 ? 1 : 0;
    const edge = 1 - smooth(0, 0.006, Math.abs(sx - 0.08));
    let h = lap * 0.0025 + edge * 0.0012 * (sx < 0.085 ? 1 : 0);
    // end lap across the roll
    const ey = wrapd(y - ends[strip], W);
    const elap = ey > 0 && ey < 0.1 ? 1 : 0;
    const eedge = 1 - smooth(0, 0.006, Math.abs(ey - 0.1));
    h += elap * 0.0025 + eedge * 0.001 * (ey < 0.105 && ey > 0 ? 1 : 0);
    h += n1.fbm(u, v, 0.4, 4) * 0.0015 + n2.fbm(u, v, 0.01, 3) * 0.0003 + n3.ridged(u, v, 0.12, 3, 0.5, 0.5) * 0.0008 + (rnd(1607, idx) - 0.5) * 0.0003;
    // blisters
    worley(1605, u * fb, v * fb, fb, fb, 1, cell);
    if ((cell.id & 255) < 30) h += smooth(0.35, 0.0, cell.f1) * 0.004;
    // patches
    let pm = 0;
    for (const p of patches) {
      const dx = Math.abs(wrapd(x - p[0], W)) - p[2] / 2, dy = Math.abs(wrapd(y - p[1], W)) - p[3] / 2;
      const d = Math.max(dx, dy) + n3.fbm(u, v, 0.08, 3) * 0.025;
      pm = Math.max(pm, smooth(0.002, -0.002, d));
    }
    h += pm * 0.003;
    // dried puddles: lighter dust with dark rims
    const pud = n3.fbm(u, v, 1.6, 5, 0.55);
    const dust = smooth(0.0, 0.6, pud) * (0.7 + 0.3 * n2.fbm(u, v, 0.05, 3));
    const rim = 0;
    const tone = 1 + n1.fbm(u, v, 0.15, 3) * 0.06 + n2.fbm(u, v, 1.5, 3) * 0.1 + (rnd(1606, idx) - 0.5) * 0.12;
    let r = 0.235 * tone, g = 0.23 * tone, b = 0.225 * tone, rough = 0.82;
    r = mix(r, 0.36, dust * 0.7); g = mix(g, 0.35, dust * 0.7); b = mix(b, 0.33, dust * 0.7);
    r *= 1 - rim * 0.15; g *= 1 - rim * 0.15; b *= 1 - rim * 0.15;
    if (pm > 0) { r = mix(r, 0.19 * tone, pm); g = mix(g, 0.19 * tone, pm); b = mix(b, 0.195 * tone, pm); rough = mix(rough, 0.6, pm); }
    r *= 1 - edge * 0.25; g *= 1 - edge * 0.25; b *= 1 - edge * 0.25;
    t.set(idx, r, g, b, rough + dust * 0.1, h);
  });
};

/** Terracotta pantiles: 0.3 m wide S-profile, 0.3 m gauge. */
const clayTile: Gen = (t) => {
  const W = t.W;
  const NC = Math.round(W / 0.3), NR = Math.round(W / 0.3);
  const TWd = W / NC, E = W / NR;
  const n1 = new TNoise(1701, W), n2 = new TNoise(1702, W), nm = new TNoise(1703, W);
  const cell = newCell();
  const fl = Math.round(W / 0.012);
  const C = [rgb(172, 90, 60), rgb(162, 82, 56), rgb(150, 76, 54), rgb(138, 78, 60), rgb(178, 100, 66)];
  const rowOff: number[] = [];
  for (let r = 0; r < NR; r++) rowOff.push(rnd(1704, r) * 0.03);
  t.each((u, v, x, y, idx) => {
    const row = Math.floor(y / E) % NR;
    const ly = y / E - Math.floor(y / E); // 0 = butt (bottom), 1 = under next row
    const xx = x + rowOff[row];
    const col = Math.floor(xx / TWd);
    const lx = xx / TWd - col; // 0..1 across the tile
    const tid = row * 64 + (((col % NC) + NC) % NC);
    const ra = rnd(1705, tid), rb = rnd(1706, tid);
    // pantile profile: wide trough (0..0.68) + roll (0.68..1)
    let prof: number;
    if (lx < 0.68) prof = -Math.sin((lx / 0.68) * Math.PI) * 0.038;
    else prof = Math.sin(((lx - 0.68) / 0.32) * Math.PI) * 0.034;
    // butt edge irregularity
    const butt = ly + n1.fbm(u, v, 0.05, 2) * 0.01;
    const lift = 0.022 * (1 - ly) + (ra - 0.5) * 0.004;
    let h = prof + lift + n2.fbm(u, v, 0.01, 3) * 0.0003;
    h -= (1 - smooth(0, 0.06, butt)) * 0.004; // rounded nose
    const base = C[Math.floor(ra * 5) % 5];
    const vv = 0.93 + 0.14 * rb;
    // weathering: bleached rolls, dirty troughs, moss & lichen
    const trough = lx < 0.68 ? Math.sin((lx / 0.68) * Math.PI) : 0;
    const roll = lx >= 0.68 ? Math.sin(((lx - 0.68) / 0.32) * Math.PI) : 0;
    const mott = 1 + n1.fbm(u, v, 0.08, 4) * 0.08 + n2.fbm(u, v, 0.02, 2) * 0.04;
    const k = vv * mott * (1 - trough * 0.08 + roll * 0.06);
    let r = base[0] * k, g = base[1] * k, b = base[2] * k, rough = 0.78;
    const dirt = smooth(0.0, 0.7, n2.fbm(u, v, 0.7, 4)) * 0.3 * (0.5 + trough * 0.5);
    r = mix(r, 0.3, dirt * 0.5); g = mix(g, 0.27, dirt * 0.5); b = mix(b, 0.24, dirt * 0.5);
    const mossM = smooth(0.15, 0.45, nm.fbm(u, v, 0.4, 4) + nm.fbm(u, v, 0.03, 3) * 0.4) * (1 - smooth(0.1, 0.45, ly)) * (0.4 + trough * 0.6);
    worley(1707, u * fl, v * fl, fl, fl, 1, cell);
    const lich = (cell.id & 255) < 40 && cell.f1 < 0.5 && nm.fbm(u + 0.4, v, 0.35, 3) > 0.3 ? 1 : 0;
    if (lich) { r = mix(r, 0.6, 0.55); g = mix(g, 0.58, 0.55); b = mix(b, 0.46, 0.55); h += 0.0005; }
    if (mossM > 0) {
      const mk = 0.8 + nm.fbm(u, v, 0.006, 2) * 0.3;
      r = mix(r, 0.26 * mk, mossM); g = mix(g, 0.32 * mk, mossM); b = mix(b, 0.14 * mk, mossM);
      rough = mix(rough, 0.95, mossM);
      h += mossM * 0.003 * (0.5 + nm.fbm(u, v, 0.006, 2));
    }
    t.set(idx, r, g, b, rough, h);
  });
};

/** Natural slate: 0.25 m wide slates, 0.2 m exposure, half-bond. */
const slate: Gen = (t) => {
  const W = t.W;
  const NC = Math.round(W / 0.25), NR = Math.round(W / 0.2);
  const SW = W / NC, E = W / NR;
  const n1 = new TNoise(1801, W), n2 = new TNoise(1802, W), n3 = new TNoise(1803, W);
  const C = [rgb(70, 76, 86), rgb(62, 66, 74), rgb(80, 74, 82), rgb(74, 80, 80), rgb(58, 62, 70)];
  t.each((u, v, x, y, idx) => {
    const row = Math.floor(y / E) % NR;
    const ly = y / E - Math.floor(y / E);
    const xx = x + (row % 2) * SW * 0.5 + (rnd(1804, row) - 0.5) * 0.02;
    const col = Math.floor(xx / SW);
    const lx = xx / SW - col;
    const sid = row * 64 + (((col % NC) + NC) % NC);
    const ra = rnd(1805, sid), rb = rnd(1806, sid), rc = rnd(1807, sid);
    const gapD = Math.min(lx, 1 - lx) * SW - 0.002 - rc * 0.002; // side gap
    const gap = smooth(0.0, 0.001, gapD);
    const buttN = n1.fbm(u, v, 0.03, 3) * 0.006 + Math.abs(n2.fbm(u, v, 0.012, 2)) * 0.004;
    const butt = ly * E - buttN; // m from butt edge
    const nose = smooth(0, 0.004, butt);
    const cleave = n3.ridged(u, v, 0.08, 4, 0.5, 0.25) * 0.0008;
    let h = 0.008 * (1 - ly) + (lx - 0.5) * (rb - 0.5) * 0.003 + cleave + (ra - 0.5) * 0.002;
    h = mix(0.008 * 0 + 0.0, h, gap) - (1 - nose) * 0.002;
    const base = C[Math.floor(ra * 5) % 5];
    const k = (0.88 + 0.24 * rb) * (1 + n1.fbm(u, v, 0.1, 4) * 0.06 + cleave * 30);
    let r = base[0] * k, g = base[1] * k, b = base[2] * k;
    const gk = 0.5 + 0.5 * gap;
    r *= gk; g *= gk; b *= gk;
    // salt bloom / lichen & dust
    const bloom = smooth(0.35, 0.7, n2.fbm(u, v, 0.4, 4)) * 0.25;
    r = mix(r, 0.48, bloom * 0.4); g = mix(g, 0.48, bloom * 0.4); b = mix(b, 0.46, bloom * 0.4);
    const edgeWear = (1 - smooth(0, 0.01, butt)) * 0.15;
    r *= 1 + edgeWear; g *= 1 + edgeWear; b *= 1 + edgeWear;
    t.set(idx, r, g, b, 0.62 + (rb - 0.5) * 0.1 + bloom * 0.2, h);
  });
};

/** Paris zinc standing seam: pans 0.5 m, rounded seams, cross welts. */
const zinc: Gen = (t) => {
  const W = t.W;
  const P = 0.5, NP = Math.round(W / P);
  const n1 = new TNoise(1901, W), n2 = new TNoise(1902, W), n3 = new TNoise(1903, W);
  t.each((u, v, x, y, idx) => {
    const d = Math.abs(wrapd(x, P));
    const pan = (((Math.round(x / P) % NP) + NP) % NP);
    const seam = d < 0.012 ? Math.sqrt(1 - (d / 0.012) ** 2) : 0;
    let h = seam * 0.028 + (d < 0.018 && d >= 0.012 ? (1 - (d - 0.012) / 0.006) * 0.003 : 0);
    // oil canning in the pan
    const inPan = smooth(0.015, 0.05, d);
    h += n1.fbm(u + pan * 0.13, v, 0.5, 3, 0.5, 1.0) * 0.0015 * inPan;
    // cross welt (transverse fold) at a per-pan height
    const wy = Math.abs(wrapd(y - rnd(1904, pan) * W, W));
    h += (1 - smooth(0.0, 0.008, wy)) * 0.005 * inPan;
    const welt = (1 - smooth(0.006, 0.01, wy)) * (1 - smooth(0.0, 0.004, Math.abs(wy - 0.008)));
    // patina: white carbonate blotches and darker runoff streaks
    const pat = n2.fbm(u, v, 0.4, 5, 0.55);
    const white = smooth(0.2, 0.55, pat) * 0.18;
    const run = smooth(0.1, 0.9, n3.fbm(u, v, 0.08, 3, 0.5, 1.5)) * 0.14;
    const tone = 1 + (rnd(1905, pan) - 0.5) * 0.06 + seam * 0.04;
    let r = 0.58 * tone, g = 0.615 * tone, b = 0.645 * tone;
    r = mix(r, 0.72, white); g = mix(g, 0.73, white); b = mix(b, 0.73, white);
    r *= 1 - run - welt * 0.15; g *= 1 - run - welt * 0.15; b *= 1 - run * 0.9 - welt * 0.15;
    t.set(idx, r, g, b, 0.48 + white * 0.6 + run * 0.4, h);
  });
};

/** 3-tab asphalt shingles: 1/3 m tabs, 0.1429 m exposure, slots offset half a tab per course. */
const asphaltShingle: Gen = (t) => {
  const W = t.W;
  const NR = Math.round(W / 0.1429), E = W / NR, NT = Math.round(W / 0.3333), TW = W / NT;
  const n1 = new TNoise(2001, W), n2 = new TNoise(2002, W);
  const G = [rgb(112, 110, 106), rgb(66, 66, 66), rgb(118, 98, 82), rgb(150, 146, 138), rgb(90, 84, 78)];
  t.each((u, v, x, y, idx) => {
    const row = Math.floor(y / E) % NR;
    const ly = y / E - Math.floor(y / E);
    const xx = x + (row % 2) * TW * 0.5 + (rnd(2003, row) - 0.5) * 0.01;
    const col = Math.floor(xx / TW);
    const lx = (xx / TW - col) * TW;
    const tid = row * 64 + (((col % NT) + NT) % NT);
    const ra = rnd(2004, tid);
    const slotD = Math.min(lx, TW - lx) - 0.003;
    const inSlot = slotD < 0 && ly < 0.9;
    // the course below shows through the slot (lower, darker)
    let h = 0.004 * (1 - ly) + 0.0005 * n1.fbm(u, v, 0.005, 2);
    h -= (1 - smooth(0, 0.08, ly)) * 0.001;
    // granules
    const gi = Math.floor(rnd(2005, idx) * 100);
    const gc = G[gi < 45 ? 0 : gi < 70 ? 1 : gi < 85 ? 2 : gi < 93 ? 3 : 4];
    const blend = 0.92 + 0.16 * ra + n2.fbm(u, v, 0.5, 3) * 0.08;
    let r = gc[0] * blend, g = gc[1] * blend, b = gc[2] * blend;
    // shadow band (darker granules) just above the butt & weathering
    const sh = 1 - (1 - smooth(0, 0.12, ly)) * 0.1;
    r *= sh; g *= sh; b *= sh;
    if (inSlot) { h = 0.0005; r *= 0.55; g *= 0.55; b *= 0.55; }
    const wash = smooth(0.2, 0.8, n1.fbm(u, v, 0.6, 4)) * 0.12;
    r = mix(r, 0.45, wash); g = mix(g, 0.44, wash); b = mix(b, 0.42, wash);
    h += (rnd(2006, idx) - 0.5) * 0.0004;
    t.set(idx, r, g, b, 0.92, h);
  });
};

/** Corrugated galvanized steel (76 mm pitch), screws on purlin lines, rust. */
const corrugated: Gen = (t) => {
  const W = t.W;
  const NC = Math.round(W / 0.076), P = W / NC;
  const n1 = new TNoise(2101, W), n2 = new TNoise(2102, W), n3 = new TNoise(2103, W);
  const cell = newCell();
  const fs = Math.round(W / 0.04);
  t.each((u, v, x, y, idx) => {
    const ph = (x / P) * Math.PI * 2;
    let h = Math.cos(ph) * 0.009;
    // sheet side lap every ~1 m (12 corrugations) & end lap at y = 0
    const sideLap = Math.abs(wrapd(x, P * 13)) < 0.004 ? 1 : 0;
    const ly = wrap(y, W);
    const endLap = ly < 0.15 ? 0.0015 : 0;
    const endLine = 1 - smooth(0, 0.004, Math.abs(ly - 0.15));
    h += endLap;
    // screws on crests along purlins (y = 0.075, 1.0)
    let screw = 0;
    for (const py of [0.075, 1.0]) {
      const dy = wrapd(y - py, W);
      const k = Math.round(x / (P * 3));
      const dx = x - k * P * 3;
      const d = Math.hypot(dx, dy);
      if (d < 0.009) screw = Math.max(screw, Math.sqrt(1 - (d / 0.009) ** 2));
    }
    h += screw * 0.006;
    // rust: near screws & laps, plus streaks running down from screw lines
    let rustSrc = 0;
    for (const py of [0.075, 1.0]) {
      const dy = wrapd(y - py, W);
      const k = Math.round(x / (P * 3));
      const dx = x - k * P * 3;
      const stream = dy < 0 && dy > -0.6 ? (1 + dy / 0.6) * smooth(0.012, 0.002, Math.abs(dx)) * (rnd(2104, k, py * 10) > 0.4 ? 1 : 0) : 0;
      rustSrc = Math.max(rustSrc, smooth(0.03, 0.0, Math.hypot(dx, dy)), stream * 0.8);
    }
    const rustN = n1.fbm(u, v, 0.3, 5, 0.6);
    const rust = clamp01(smooth(0.25, 0.6, rustN) * 0.8 + rustSrc * (0.5 + 0.5 * n2.fbm(u, v, 0.02, 2)) + endLine * 0.3 * smooth(0, 0.5, rustN));
    // galvanized spangle
    worley(2105, u * fs, v * fs, fs, fs, 1, cell);
    const sp = 1 + ((cell.id & 255) / 255 - 0.5) * 0.08;
    const dull = smooth(0.0, 0.6, n3.fbm(u, v, 0.7, 4)) * 0.15;
    let r = 0.6 * sp, g = 0.61 * sp, b = 0.6 * sp, rough = 0.42 + dull;
    r = mix(r, 0.68, dull); g = mix(g, 0.68, dull); b = mix(b, 0.66, dull);
    const rk = 0.85 + n2.fbm(u, v, 0.01, 3) * 0.25;
    r = mix(r, 0.48 * rk, rust); g = mix(g, 0.26 * rk, rust); b = mix(b, 0.16 * rk, rust);
    rough = mix(rough, 0.88, rust);
    h += rust * n2.fbm(u, v, 0.008, 2) * 0.0004;
    if (sideLap) { r *= 0.7; g *= 0.7; b *= 0.7; }
    r *= 1 - endLine * 0.3; g *= 1 - endLine * 0.3; b *= 1 - endLine * 0.3;
    if (screw > 0) { r = mix(r, 0.5, screw); g = mix(g, 0.5, screw); b = mix(b, 0.52, screw); }
    t.set(idx, r, g, b, rough, h);
  });
};

/** Pebble ballast (16-32 mm river gravel) on a flat roof. */
const gravelRoof: Gen = (t) => {
  pebbles(t, 2201, {
    count: 2.6, rMin: 0.008, rMax: 0.016, height: 0.6,
    palette: [rgb(150, 146, 138), rgb(170, 156, 132), rgb(96, 92, 88), rgb(196, 192, 182), rgb(136, 116, 96), rgb(120, 120, 124)],
    fines: rgb(80, 76, 70), finesH: -0.004,
  });
};

/** Extensive green roof: sedum rosettes in species patches, some grass and bare substrate. */
const greenRoof: Gen = (t) => {
  const W = t.W;
  const nS = new TNoise(2301, W), nB = new TNoise(2302, W);
  t.each((u, v, _x, _y, idx) => {
    const k = 1 + nB.fbm(u, v, 0.03, 3) * 0.2 + (rnd(2303, idx) - 0.5) * 0.2;
    t.set(idx, 0.36 * k, 0.29 * k, 0.22 * k, 0.95, -0.01 + nB.fbm(u, v, 0.1, 3) * 0.003);
  });
  const rng = new Rng(2304);
  const SPEC: [RGB, RGB][] = [
    [rgb(96, 128, 56), rgb(150, 160, 70)], // green / yellow-green
    [rgb(120, 136, 60), rgb(176, 160, 70)], // acre (yellowish)
    [rgb(104, 110, 58), rgb(164, 84, 62)], // red-tipped (spurium)
    [rgb(80, 112, 70), rgb(120, 150, 100)], // glaucous
  ];
  const n = Math.round((W * W) / (Math.PI * 0.02 * 0.02) * 2.2);
  for (let k = 0; k < n; k++) {
    const cx = rng.float() * W, cy = rng.float() * W;
    const bare = nB.fbm(cx / W, cy / W, 0.8, 4);
    if (bare < -0.45 && rng.float() < 0.7) continue;
    const sp = SPEC[Math.floor(clamp01(nS.fbm(cx / W, cy / W, 0.9, 3) * 0.9 + 0.5 + (rng.float() - 0.5) * 0.5) * 3.999)];
    const R = rng.range(0.012, 0.03), np = rng.int(5, 8), rot = rng.float() * 6.283;
    const z0 = rng.range(0, 0.01);
    const vk = rng.range(0.85, 1.15);
    splat(t, cx, cy, R, (dx, dy, idx) => {
      const d = Math.hypot(dx, dy) / R;
      const a = Math.atan2(dy, dx) * np + rot;
      const petal = 0.55 + 0.45 * Math.max(0, Math.cos(a));
      if (d > petal) return;
      const z = z0 + (1 - d * d) * R * 0.8 + Math.cos(a) * 0.001;
      if (z <= t.h[idx]) return;
      const tip = d / petal;
      const c0 = sp[0], c1 = sp[1];
      const f = tip * tip;
      const sh = (0.75 + 0.25 * Math.cos(a)) * vk;
      t.set(idx, mix(c0[0], c1[0], f) * sh, mix(c0[1], c1[1], f) * sh, mix(c0[2], c1[2], f) * sh, 0.7, z);
    });
  }
};

export const ROOFS: { W: number; gen: Gen; normal: number; aoK: number; aoR: [number, number] }[] = [
  { W: 4.0, gen: tar, normal: 1, aoK: 40, aoR: [0.01, 0.05] },
  { W: 2.1, gen: clayTile, normal: 1, aoK: 40, aoR: [0.03, 0.1] },
  { W: 2.0, gen: slate, normal: 1, aoK: 60, aoR: [0.008, 0.03] },
  { W: 3.0, gen: zinc, normal: 1, aoK: 30, aoR: [0.01, 0.04] },
  { W: 2.0, gen: asphaltShingle, normal: 1, aoK: 80, aoR: [0.006, 0.02] },
  { W: 2.0, gen: corrugated, normal: 1, aoK: 20, aoR: [0.01, 0.04] },
  { W: 2.0, gen: gravelRoof, normal: 1, aoK: 60, aoR: [0.006, 0.02] },
  { W: 2.0, gen: greenRoof, normal: 0.7, aoK: 50, aoR: [0.008, 0.03] },
];
