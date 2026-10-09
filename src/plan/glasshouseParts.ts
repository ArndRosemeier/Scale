/**
 * The botanical glasshouse: a palm house (a glass dome with vaulted wings either side), a single
 * great dome, or three parallel vaulted halls side by side. All can be walked into through a door
 * in the middle of the front: the walls are glass panels on a low brick plinth (the door a gap in
 * them), the halls open into each other (wide openings, arches between the parallel halls), and
 * each hall is planted by the interior core (interior/design/storey with fill/garden).
 */
import { Rng, deriveSeed } from '../core/rng';
import type { Landmark } from './landmarks';
import type { Poly } from '../core/geom2';
import { Kit, mat, entranceSteps, type PartMat, type RGB, WIN, CURTAIN, BRICK, METAL, GLASS, GRANITE, GREEN_ROOF } from './landmarkParts';
import { emptyDesign, type Design } from '../interior/design/types';
import { emitDesign } from '../interior/design/emit';
import { gardenTheme } from '../interior/design/theme';
import { fillStorey } from '../interior/design/storey';
import { gardenItems, pathFloor, PATH_W, type Planting, type PathSeg } from '../interior/fill/garden';
import type { Program } from '../interior/fill/split';
import type { WallSeg } from '../interior/fill/area';
import { setDesign } from './designs';

type P2 = [number, number];
/** A wall of the shell (local), up to `top`, with openings [centre along it (m), width, height]. */
interface GWall { a: P2; b: P2; top: number; open: [number, number, number][] }
/** A hall: its floor outline (on the walls' centre lines), its walls' top, what grows in it. */
interface Hall { poly: P2[]; top: number; planting: Planting; ent: WallSeg[]; paths: PathSeg[]; fountain: P2 | null }

const PLINTH = 0.9, TH = 0.2, DOOR_W = 2.6, DOOR_H = 2.9, RING = 5.0;

/** A ring path round (cu, cv) and spokes from it out to the given points. */
function ringPaths(cu: number, cv: number, spokes: P2[], outer = 0): PathSeg[] {
  const out: PathSeg[] = [];
  for (const [R, n] of outer ? [[RING, 8], [outer, 16]] : [[RING, 8]]) for (let i = 0; i < n; i++) {
    const a = ((i + 0.5) / n) * Math.PI * 2, b = ((i + 1.5) / n) * Math.PI * 2;
    out.push([[cu + R * Math.cos(a), cv + R * Math.sin(a)], [cu + R * Math.cos(b), cv + R * Math.sin(b)]]);
  }
  for (const [u, v] of spokes) { const L = Math.hypot(u - cu, v - cv); out.push([[cu + ((u - cu) * RING) / L, cv + ((v - cv) * RING) / L], [u, v]]); }
  return out;
}
const ALL: Program = { reserve: [{ type: 'garden', at: 'all' }], rooms: [], corridor: 0 };

export function glasshouse(k: Kit, lm: Landmark, r: Rng): void {
  const P = lm.p, B = k.B;
  const frameC: RGB = [[1.15, 1.15, 1.12], [0.35, 0.55, 0.42], [0.25, 0.26, 0.28]][P.frame % 3] as RGB;
  const glass = mat(GLASS, [0.88 * frameC[0] * 0.5 + 0.5, 0.95 * frameC[1] * 0.4 + 0.6, 0.95], WIN | CURTAIN, 1.6, 2.2, 2.2);
  const plinth = mat(BRICK, [0.9, 0.85, 0.8]), frame = mat(METAL, frameC);
  const Th = gardenTheme(frame, plinth), soil = mat(GREEN_ROOF, [0.55, 0.62, 0.42]);
  const hw = P.W / 2, hl = P.L / 2;
  const walls: GWall[] = [], halls: Hall[] = [];
  const plantings: Planting[] = r.shuffle(['desert', 'flowers'] as Planting[]);
  let door: P2 = [0, 0];
  const front = (a: P2, b: P2, top: number) => { walls.push({ a, b, top, open: [[Math.hypot(b[0] - a[0], b[1] - a[1]) / 2, DOOR_W, DOOR_H]] }); door = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; };
  const seg = (a: P2, b: P2, open: [number, number][] = []): WallSeg => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return { ax: a[0], az: a[1], bx: b[0], bz: b[1], doors: open.map(([c, w]) => [Math.max(0, (c - w / 2) / L), Math.min(1, (c + w / 2) / L)]) };
  };
  /** Points on a circle of radius R from angle t0 to t1 in n steps. */
  const arc = (R: number, t0: number, t1: number, n: number): P2[] => Array.from({ length: n + 1 }, (_, j) => { const t = t0 + ((t1 - t0) * j) / n; return [R * Math.cos(t), R * Math.sin(t)]; });
  /** Odd segment count for an arc (one segment centred on its middle: the door). */
  const odd = (len: number) => 2 * Math.max(1, Math.round(len / 7)) + 1;

  if (lm.style === 0) {
    // Palm house: the dome in the middle, a vaulted wing either side, open into it.
    const dr = hw * 1.1, wv = hw * 0.75, wTop = B + P.H * 0.28, dTop = B + P.H * 0.5, ue = hl + 0.5;
    const beta = Math.asin(wv / dr), uc = dr * Math.cos(beta), n = odd(dr * (Math.PI - 2 * beta));
    const back = arc(dr, beta, Math.PI - beta, n), fr = arc(dr, Math.PI + beta, 2 * Math.PI - beta, n);
    ring(back, dTop, walls);
    const m = (n - 1) / 2;
    for (let j = 0; j < n; j++) (j === m ? (a: P2, b: P2) => front(a, b, dTop) : (a: P2, b: P2) => walls.push({ a, b, top: dTop, open: [] }))(fr[j], fr[j + 1]);
    const chordL: P2[] = [[-uc, wv], [-uc, -wv]], chordR: P2[] = [[uc, -wv], [uc, wv]];
    halls.push({ poly: [...back, ...fr], top: dTop, planting: 'palms', paths: ringPaths(0, 0, [[0, -dr], [-uc, 0], [uc, 0], [0, dr - 2.5]], dr > 13 ? dr * 0.62 : 0), fountain: [0, 0], ent: [seg(fr[m], fr[m + 1], [[Math.hypot(fr[m + 1][0] - fr[m][0], fr[m + 1][1] - fr[m][1]) / 2, DOOR_W]]), seg(chordL[0], chordL[1], [[wv, 2 * wv - 0.4]]), seg(chordR[0], chordR[1], [[wv, 2 * wv - 0.4]])] });
    k.dome(0, 0, dr, dr, dTop, dTop + dr, glass, { seg: 20 });
    k.dome(0, 0, dr - 0.05, dr - 0.05, dTop, dTop + dr - 0.05, glass, { seg: 20, solid: false, clear: true }).inward = true;
    k.cyl(0, 0, 1.5, 1.2, dTop + dr - 0.3, dTop + dr + 2.5, frame, { detail: true, solid: false, seg: 8 });
    const rf = dr * Math.cos((Math.PI - 2 * beta) / n / 2) + 0.15;
    k.cyl(0, 0, rf, rf, B - 0.3, B, soil, { foot: true, map: 0, seg: 24 });
    for (const s of [-1, 1]) {
      const wu = s * (dr + (hl - dr) / 2 - 1), wl = (hl - dr) / 2 + 1.5;
      const p: P2[] = s > 0 ? [[uc, -wv], [ue, -wv], [ue, wv], [uc, wv]] : [[-ue, -wv], [-uc, -wv], [-uc, wv], [-ue, wv]];
      walls.push({ a: [s * uc, -wv], b: [s * ue, -wv], top: wTop, open: [] }, { a: [s * uc, wv], b: [s * ue, wv], top: wTop, open: [] }, { a: [s * ue, -wv], b: [s * ue, wv], top: wTop, open: [] });
      const ch = s > 0 ? chordR : chordL;
      halls.push({ poly: p, top: wTop, planting: plantings[s > 0 ? 0 : 1], paths: [[[s * uc, 0], [s * (ue - 2.5), 0]]], fountain: null, ent: [seg(ch[0], ch[1], [[wv, 2 * wv - 0.4]])] });
      k.vault(wu, 0, wl, wv, wTop, wTop + hw * 0.7, glass);
      k.vault(wu, 0, wl, wv - 0.05, wTop, wTop + hw * 0.7 - 0.05, glass, { solid: false, clear: true }).inward = true;
      k.box((s * uc + s * ue) / 2, 0, (ue - uc) / 2 + 0.15, wv + 0.15, B - 0.3, B, soil, { foot: true, map: 0 });
      foot(k, (s * uc + s * ue) / 2, 0, (ue - uc) / 2, wv, B, wTop + hw * 0.7);
    }
    const f = k.cyl(0, 0, dr, dr, B, dTop + dr, glass, { solid: false, map: 1 });
    f.hidden = true; f.footprint = true;
  } else if (lm.style === 1) {
    // A single great dome.
    const dr = Math.min(hl, hw * 1.6), top = B + P.H * 0.4, n = 2 * Math.max(8, Math.round((dr * Math.PI) / 3.5));
    const step = (Math.PI * 2) / n, pts = arc(dr * 0.98, -Math.PI / 2 - step / 2, -Math.PI / 2 - step / 2 + Math.PI * 2, n).slice(0, n);
    front(pts[0], pts[1], top);
    for (let j = 1; j < n; j++) walls.push({ a: pts[j], b: pts[(j + 1) % n], top, open: [] });
    const e = dr * 0.98 - 2.5;
    halls.push({ poly: pts, top, planting: 'palms', paths: ringPaths(0, 0, [[0, -dr], [-e, 0], [e, 0], [0, e]], dr > 13 ? dr * 0.6 : 0), fountain: [0, 0], ent: [seg(pts[0], pts[1], [[Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) / 2, DOOR_W]])] });
    k.dome(0, 0, dr * 0.96, dr * 0.96, top, top + dr * 0.75, glass, { seg: 24 });
    k.dome(0, 0, dr * 0.96 - 0.05, dr * 0.96 - 0.05, top, top + dr * 0.75 - 0.05, glass, { seg: 24, solid: false, clear: true }).inward = true;
    k.cyl(0, 0, dr * 0.98 * Math.cos(step / 2) + 0.15, dr * 0.98 * Math.cos(step / 2) + 0.15, B - 0.3, B, soil, { foot: true, map: 0, seg: n });
    const f = k.cyl(0, 0, dr, dr, B, top + dr * 0.75, glass, { solid: false, map: 1 });
    f.hidden = true; f.footprint = true;
  } else {
    // Three vaulted halls side by side (the middle one longer and higher), arches between them.
    const w = hw * 0.36, len = [hl * 0.75, hl, hl * 0.75], tops = [0.6, 0.8, 0.6].map((h) => B + P.H * h * 0.35);
    const arches = (L: number): [number, number][] => [[L * 0.3, 3.2], [L * 1.7, 3.2]];
    const archH = Math.min(DOOR_H, tops[0] - B - 0.3);
    for (const [i, s] of [[0, -1], [1, 0], [2, 1]] as const) {
      const L = len[i], v0 = s * 2 * w - w, v1 = s * 2 * w + w, top = tops[i];
      const ent: WallSeg[] = [];
      if (s === -1) { front([-L, v0], [L, v0], top); ent.push(seg([-L, v0], [L, v0], [[L, DOOR_W]])); }
      else if (s === 1) walls.push({ a: [-L, v1], b: [L, v1], top, open: [] });
      // The middle hall: its long walls are partitions where the side halls meet it.
      if (s === 0) {
        const Ls = len[0], a = arches(Ls).map(([c, wd]) => [c + (L - Ls), wd, archH] as [number, number, number]);
        for (const v of [v0, v1]) {
          walls.push({ a: [-L, v], b: [-Ls, v], top, open: [] }, { a: [-Ls, v], b: [Ls, v], top, open: arches(Ls).map(([c, wd]) => [c, wd, archH]) }, { a: [Ls, v], b: [L, v], top, open: [] });
          ent.push(seg([-L, v], [L, v], a.map(([c, wd]) => [c, wd])));
        }
      } else ent.push(seg([-L, s < 0 ? v1 : v0], [L, s < 0 ? v1 : v0], arches(L)));
      for (const e of [-1, 1]) walls.push({ a: [e * L, v0], b: [e * L, v1], top, open: [] });
      // Paths: along the hall (round the fountain in the middle one), across to each opening.
      const vc = s * 2 * w, Ls = len[0], cross: number[] = [-0.7 * Ls, 0.7 * Ls];
      const paths: PathSeg[] = s === 0 ? [...ringPaths(0, vc, [[-(L - 2.5), vc], [L - 2.5, vc]])] : [[[-(L - 2.5), vc], [L - 2.5, vc]]];
      for (const cu of cross) {
        if (s <= 0) paths.push([[cu, v1], [cu, vc]]);
        if (s >= 0) paths.push([[cu, v0], [cu, vc]]);
      }
      if (s === -1) paths.push([[0, v0], [0, vc]]);
      halls.push({ poly: [[-L, v0], [L, v0], [L, v1], [-L, v1]], top, planting: s === 0 ? 'palms' : plantings[i >> 1], paths, fountain: s === 0 ? [0, vc] : null, ent });
      k.vault(0, s * 2 * w, L, w, top, top + w * 1.1, glass);
      k.vault(0, s * 2 * w, L, w - 0.05, top, top + w * 1.1 - 0.05, glass, { solid: false, clear: true }).inward = true;
      // Glass gable ends over the end walls.
      for (const e of [-1, 1]) k.prism(e * L, s * 2 * w, Array.from({ length: 9 }, (_, j) => { const t = (Math.PI * j) / 8; return [w * Math.cos(t), top + w * 1.1 * Math.sin(t)]; }).flat(), 0.05, glass, { rot: Math.PI / 2, solid: false, detail: true });
      k.box(0, s * 2 * w, L + 0.15, w + 0.15, B - 0.3, B, soil, { foot: true, map: 0 });
      foot(k, 0, s * 2 * w, L, w, B, top + w * 1.1);
    }
  }
  for (const w of walls) glassWall(k, w, B, plinth, glass, frame);

  // The planting, hall by hall.
  const D: Design = emptyDesign();
  let seed = deriveSeed(lm.seed, 'glasshouse-plants');
  for (const h of halls) {
    const outline: Poly = h.poly.flat();
    fillStorey(D, { outline, fixed: [], front: null, program: ALL, items: gardenItems(h.planting, h.top - B, h.paths, h.fountain), y: B, top: h.top, seed, cell: 0.3, entrances: h.ent, keepOut: pathFloor(h.paths) });
    seed += 1000;
  }
  // The paths: light gravel over the beds' soil.
  k.inner(() => {
    for (const h of halls) for (const [a, b] of h.paths) {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      k.flat((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, L / 2 + PATH_W / 4, PATH_W / 2, B + 0.01, Th.walk, { rot: Math.atan2(b[1] - a[1], b[0] - a[0]), detail: true, map: 0 });
    }
  });
  // (The halls' own lights: high up under the glass.)
  D.lights.length = 0;
  for (const h of halls) { const [u, v] = mid(h.poly); k.light(u, v, h.top - 0.5); }
  k.inner(() => emitDesign(k, D, Th));
  setDesign(lm, D);
  // The way in: through the door, out to the path in front.
  const [du, dv] = door;
  const stepsFoot = entranceSteps(k, dv + 0.2, DOOR_W / 2 + 0.6, B, mat(GRANITE, [0.85, 0.85, 0.85]));
  const n = k.node(du, dv + 1.4, B);
  k.exit(n, [[du, dv - 0.7, B], [du, dv - 0.4, B]], du, stepsFoot);
}

/** Walls round a closed run of points. */
function ring(p: P2[], top: number, out: GWall[]): void {
  for (let j = 0; j + 1 < p.length; j++) out.push({ a: p[j], b: p[j + 1], top, open: [] });
}

const mid = (p: P2[]): P2 => [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];

/** A hidden footprint box: the building's outline for the planner and the map. */
function foot(k: Kit, u: number, v: number, hu: number, hv: number, y0: number, y1: number): void {
  const f = k.box(u, v, hu, hv, y0, y1, mat(BRICK), { solid: false, map: 1 });
  f.hidden = true; f.footprint = true;
}

/**
 * A glass wall on its brick plinth from a to b, with its openings (a gap down to the floor, glass
 * over it) and an iron post at its start.
 */
function glassWall(k: Kit, w: GWall, B: number, plinth: PartMat, glass: PartMat, frame: PartMat): void {
  const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
  if (L < 0.05) return;
  const ux = (w.b[0] - w.a[0]) / L, uv = (w.b[1] - w.a[1]) / L, rot = Math.atan2(uv, ux);
  const piece = (s0: number, s1: number, y0: number, y1: number, th: number, m: PartMat, o = {}) => {
    if (s1 - s0 < 0.02 || y1 - y0 < 0.02) return;
    const c = (s0 + s1) / 2;
    k.box(w.a[0] + ux * c, w.a[1] + uv * c, (s1 - s0) / 2, th / 2, y0, y1, m, { rot, map: 0, ...o });
  };
  let s = 0;
  const run = (s0: number, s1: number) => { piece(s0, s1, B, B + PLINTH, TH * 1.5, plinth, { foot: true }); piece(s0, s1, B + PLINTH, w.top, TH * 0.5, glass); };
  for (const [c, wd, h] of [...w.open].sort((p, q) => p[0] - q[0])) {
    const o0 = Math.max(s, c - wd / 2), o1 = Math.min(L, c + wd / 2);
    run(s, o0);
    piece(o0, o1, B + h, w.top, TH * 0.5, glass);
    piece(o0, o1, B + h - 0.15, B + h, TH * 0.8, frame, { detail: true });
    for (const e of [o0, o1]) piece(e - 0.08, e + 0.08, B, B + h, TH * 0.8, frame, { detail: true, solid: false });
    s = o1;
  }
  run(s, L);
  piece(-0.07, 0.07, B, w.top, TH * 0.9, frame, { detail: true, solid: false });
}
