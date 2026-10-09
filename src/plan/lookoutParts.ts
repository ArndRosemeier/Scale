/**
 * The lookouts, walkable: the observation tower (a lobby at its foot with the ticket desk and the
 * lift, the observation deck up top behind glass with a gallery round it), the lighthouse (the stair
 * room at its foot, the lantern room with the great lens up on the gallery) and the fortress keep (a
 * great hall at the foot of the keep, up steps from the courtyard, the way out through the gate).
 * The shells are walls round each room with a door in its front; the rooms are furnished by the
 * interior core (interior/design/storey with fill/lookout). The rooms up top have no way up but
 * flying: their doors open onto the gallery.
 */
import { Rng, deriveSeed } from '../core/rng';
import type { Landmark } from './landmarks';
import {
  Kit, mat, wallAB, entranceSteps, PAINT, type PartMat, type RGB, type Opt,
  WIN, CURTAIN, ARCH, ROOF, CONC, GLASS, GRAVEL, METAL_ROOF, METAL, PANEL, GRANITE, PLASTER, CLAY, SAND, LIME, SLATE, WHITE,
} from './landmarkParts';
import { emptyDesign, type Design } from '../interior/design/types';
import { emitDesign } from '../interior/design/emit';
import { towerTheme, lighthouseTheme, keepTheme, type Theme } from '../interior/design/theme';
import { fillStorey } from '../interior/design/storey';
import { lookoutItems, type LookoutPlan } from '../interior/fill/lookout';
import type { Program } from '../interior/fill/split';
import type { RoomType } from '../interior/InteriorGen';
import type { Poly } from '../core/geom2';
import { setDesign } from './designs';

type P2 = [number, number];

/** A room of a lookout: its outline (the walls' inner faces, CCW, edge 0 the front with the door). */
interface Shell { pts: P2[]; doorW: number; type: RoomType; y: number; top: number; plan: LookoutPlan }

/** Points round a circle of radius R, n of them, edge 0 centred on the front (-v). */
function ring(R: number, n: number, cu = 0, cv = 0): P2[] {
  const step = (Math.PI * 2) / n, a0 = -Math.PI / 2 - step / 2;
  return Array.from({ length: n }, (_, j): P2 => [cu + R * Math.cos(a0 + j * step), cv + R * Math.sin(a0 + j * step)]);
}

/** A square's corners (half size a round (cu, cv)), edge 0 the front. */
const square = (a: number, cu = 0, cv = 0): P2[] => [[cu - a, cv - a], [cu + a, cv - a], [cu + a, cv + a], [cu - a, cv + a]];

/** Walls along a closed outline; a door (doorW wide, doorH high) in the middle of edge 0 unless doorW is 0. */
function ringWalls(k: Kit, pts: P2[], y0: number, y1: number, th: number, m: PartMat, doorW: number, doorH: number, o: Opt = {}, sill = y0): void {
  for (let j = 0; j < pts.length; j++) {
    const a = pts[j], b = pts[(j + 1) % pts.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // (Each wall a hair longer, so the corners close.)
    const e = th * 0.5, ux = (b[0] - a[0]) / L, uv = (b[1] - a[1]) / L;
    const open = j === 0 && doorW > 0 ? [{ a: L / 2 + e, w: doorW, y0: sill, y1: sill + doorH }] : [];
    wallAB(k, [a[0] - ux * e, a[1] - uv * e], [b[0] + ux * e, b[1] + uv * e], y0, y1, th, m, open, o);
  }
}

/** A railing round a gallery: a low glass wall on thin posts, solid so one cannot walk off. */
function railing(k: Kit, R: number, n: number, y: number, m: PartMat): void {
  ringWalls(k, ring(R, n), y, y + 1.05, 0.06, m, 0, 0, { detail: true, solid: true, clear: true, map: 0 });
  for (const [u, v] of ring(R, n)) k.cyl(u, v, 0.04, 0.04, y, y + 1.1, mat(METAL, [0.3, 0.3, 0.32]), { detail: true, solid: false, seg: 5 });
}

const ALL = (type: RoomType): Program => ({ reserve: [{ type, at: 'all' }], rooms: [], corridor: 0 });

/** Furnishes the rooms (interior core), builds them, keeps the design for the landmark. */
function furnish(k: Kit, lm: Landmark, rooms: Shell[], Th: Theme): Design {
  const D = emptyDesign();
  let seed = deriveSeed(lm.seed, 'lookout-rooms');
  for (const s of rooms) {
    const outline: Poly = s.pts.flat();
    const L = Math.hypot(s.pts[1][0] - s.pts[0][0], s.pts[1][1] - s.pts[0][1]), h = s.doorW / 2 / L;
    const c = s.plan.core;
    // (A round core kept clear as the octagon round it, flat towards the door.)
    const keepOut: Poly[] = c ? [ring(c.r / Math.cos(Math.PI / 8), 8, c.u, c.v).flat()] : [];
    fillStorey(D, {
      outline, fixed: [], front: null, program: ALL(s.type), items: lookoutItems(s.plan), y: s.y, top: s.top, seed, cell: 0.25,
      entrances: [{ ax: s.pts[0][0], az: s.pts[0][1], bx: s.pts[1][0], bz: s.pts[1][1], doors: [[0.5 - h, 0.5 + h]] }], keepOut,
    });
    seed += 1000;
  }
  k.inner(() => emitDesign(k, D, Th));
  setDesign(lm, D);
  return D;
}

/** The way in at ground level: steps down from the door to the ground in front, the exit to the path. */
function wayIn(k: Kit, pts: P2[], doorW: number): void {
  const d: P2 = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2], B = k.B;
  const foot = entranceSteps(k, d[1] + 0.2, doorW / 2 + 0.6, B, mat(GRANITE, [0.85, 0.85, 0.85]));
  const n = k.node(d[0], d[1] + 1.4, B);
  k.exit(n, [[d[0], d[1] - 0.7, B], [d[0], d[1] - 0.4, B]], d[0], foot);
}

/** A hidden footprint part: the building's outline for the planner and the map. */
function footprint(k: Kit, u: number, v: number, r: number, y0: number, y1: number, round: boolean): void {
  const f = round ? k.cyl(u, v, r, r, y0, y1, mat(CONC), { solid: false, map: 1 }) : k.box(u, v, r, r, y0, y1, mat(CONC), { solid: false, map: 1 });
  f.hidden = true; f.footprint = true;
}

export function tower(k: Kit, lm: Landmark, r: Rng): void {
  const P = lm.p, B = k.B, H = B + P.h;
  const conc = mat(CONC, [0.93, 0.93, 0.92]);
  const glass = mat(GLASS, WHITE, WIN | CURTAIN, 1.6, 3.2, 3.2);
  const clear = mat(GLASS, [0.85, 0.95, 1.0]);
  const stripe = PAINT[[0, 4, 6, 0][P.colour % 4]];
  const floorM = mat(GRANITE, [0.9, 0.9, 0.9]);
  const rooms: Shell[] = [];
  if (lm.style === 0) {
    // Concrete TV tower: tapering shaft, a pod (sphere, disc stack or saucer), antenna.
    const pr = P.podR, py = B + P.h * P.pod;
    // The foot: a glass drum round the shaft, the lobby.
    const LR = 16, core = P.r * 1.7, lob = ring(LR, 24);
    ringWalls(k, lob, B, B + 6, 0.3, glass, 3.0, 3.0, { foot: true, map: 0 });
    k.cyl(0, 0, LR + 0.3, LR + 0.3, B + 5.6, B + 6, conc, { top: mat(GRAVEL, WHITE, ROOF), map: 0, seg: 24 });
    k.cyl(0, 0, LR, LR, B - 0.3, B, floorM, { foot: true, map: 0, seg: 24 });
    footprint(k, 0, 0, LR, B, B + 6, true);
    rooms.push({ pts: ring(LR - 0.15, 24), doorW: 3.0, type: 'foyer', y: B, top: B + 5.6, plan: { core: { u: 0, v: 0, r: core } } });
    k.cyl(0, 0, core, P.r, B, py, conc, { seg: 24 });
    let capTop: number;
    if (P.tiers === 1) {
      // The pod: a bowl below the deck, the glass ring of the deck, a dome over it.
      const yd = py + pr - 1.8, top = yd + 3.6, roofM = mat(METAL_ROOF, [0.85, 0.86, 0.9], ROOF);
      k.dome(0, 0, pr, pr, yd, py, roofM, { seg: 24 });
      k.dome(0, 0, pr, pr, top, top + pr, roofM, { seg: 24 });
      k.cyl(0, 0, pr + 2.2, pr + 2.2, yd - 0.3, yd, conc, { seg: 24, top: floorM });
      ringWalls(k, ring(pr, 24), yd, top, 0.15, glass, 1.8, 2.4);
      railing(k, pr + 2.1, 24, yd, clear);
      k.cyl(0, 0, P.r * 0.7, P.r * 0.7, yd, top, conc, { seg: 12 });
      rooms.push({ pts: ring(pr - 0.075, 24), doorW: 1.8, type: 'deck', y: yd, top, plan: { core: { u: 0, v: 0, r: P.r * 0.7 } } });
      capTop = top + pr;
    } else {
      // Stacked discs: a restaurant ring of glass between concrete rims; the lowest is the deck,
      // its rim run out into a gallery.
      for (let t = 0; t < P.tiers; t++) {
        const y = py + t * 7, rr = pr * (1 - t * 0.12);
        if (t === 0) {
          k.cyl(0, 0, rr * 0.55, rr + 2.0, y, y + 1.6, conc, { seg: 24, top: floorM });
          ringWalls(k, ring(rr - 0.4, 24), y + 1.6, y + 5.2, 0.15, glass, 1.8, 2.4);
          railing(k, rr + 1.9, 24, y + 1.6, clear);
          k.cyl(0, 0, P.r * 0.7, P.r * 0.7, y + 1.6, y + 5.2, conc, { seg: 12 });
          rooms.push({ pts: ring(rr - 0.475, 24), doorW: 1.8, type: 'deck', y: y + 1.6, top: y + 5.2, plan: { core: { u: 0, v: 0, r: P.r * 0.7 } } });
        } else {
          k.cyl(0, 0, rr * 0.55, rr, y, y + 1.6, conc, { seg: 24 });
          k.cyl(0, 0, rr - 0.4, rr - 0.4, y + 1.6, y + 5.2, glass, { seg: 24 });
        }
        k.cyl(0, 0, rr, rr * 0.8, y + 5.2, y + 6.4, conc, { seg: 24 });
      }
      capTop = py + P.tiers * 7;
    }
    k.cyl(0, 0, P.r, P.r * 0.7, capTop, B + P.h * 0.86, conc, { seg: 16 });
    k.cyl(0, 0, 1.2, 0.35, B + P.h * 0.86, H, mat(METAL, stripe), { seg: 8 });
    for (let s = 0; s < 3; s++) k.cyl(0, 0, 1.15 - s * 0.25, 1.1 - s * 0.25, B + P.h * (0.89 + s * 0.035), B + P.h * (0.9 + s * 0.035), mat(PLASTER, [1.2, 1.2, 1.2]), { detail: true, solid: false, seg: 8 });
    furnish(k, lm, rooms, towerTheme());
    wayIn(k, lob, 3.0);
  } else if (lm.style === 1) {
    // Steel lattice tower: four curved legs meeting at the top, platforms, bracing.
    const col = P.colour % 2 ? mat(METAL, [0.62, 0.45, 0.32]) : mat(METAL, [0.82, 0.36, 0.22]);
    const s0 = P.h * 0.13, legs = 7;
    const sAt = (y: number) => 1.6 + (s0 - 1.6) * Math.pow(1 - y, 1.9);
    for (const [su, sv] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
      for (let i = 0; i < legs; i++) {
        const ya = i / legs, yb = (i + 1) / legs;
        k.beam(su * sAt(ya), sv * sAt(ya), B + P.h * 0.85 * ya, su * sAt(yb), sv * sAt(yb), B + P.h * 0.85 * yb, 0.9 * (1 - ya * 0.6), col, { detail: false });
      }
      k.box(su * s0, sv * s0, 2.2, 2.2, B, B + 4, mat(GRANITE, [0.8, 0.78, 0.74]), { foot: true });
    }
    // Bracing on each face per level (near only; thin, nothing one bumps into).
    for (let i = 0; i < legs; i++) {
      const ya = i / legs, yb = (i + 1) / legs, sa = sAt(ya), sb = sAt(yb);
      const y0 = B + P.h * 0.85 * ya, y1 = B + P.h * 0.85 * yb;
      for (const [a, b] of [[[1, 1], [-1, 1]], [[-1, 1], [-1, -1]], [[-1, -1], [1, -1]], [[1, -1], [1, 1]]] as const) {
        k.beam(a[0] * sa, a[1] * sa, y0, b[0] * sb, b[1] * sb, y1, 0.25, col, { detail: true, solid: false });
        k.beam(b[0] * sa, b[1] * sa, y0, a[0] * sb, a[1] * sb, y1, 0.25, col, { detail: true, solid: false });
      }
    }
    const glassP = mat(GLASS, WHITE, WIN | CURTAIN, 1.6, 3.2, 3.2);
    {
      const y = B + P.h * 0.85 * 0.2, s = sAt(0.2) + 1.5;
      k.box(0, 0, s, s, y - 1.2, y + 1.6, col, { solid: true, map: 0 });
      k.box(0, 0, s - 0.6, s - 0.6, y + 1.6, y + 4.5, glassP, { detail: true, solid: false });
    }
    // The deck: on the platform where the third level's legs begin, an octagon (its corners cut
    // clear of the legs) with a gallery round it.
    const f = 3 / legs, yd = B + P.h * 0.85 * f, s = sAt(f) + 1.5, hr = sAt(f) - 0.5, c = 2 * (sAt(4 / legs) - 0.6) - hr;
    k.box(0, 0, s, s, yd - 1.2, yd, col, { solid: true, map: 0, top: mat(GRANITE, [0.85, 0.85, 0.86]) });
    const deck: P2[] = c < hr
      ? [[-c, -hr], [c, -hr], [hr, -c], [hr, c], [c, hr], [-c, hr], [-hr, c], [-hr, -c]]
      : square(hr);
    ringWalls(k, deck, yd, yd + 3.2, 0.15, glassP, 1.6, 2.4);
    k.box(0, 0, hr + 0.3, hr + 0.3, yd + 3.2, yd + 3.5, col, { map: 0 });
    rooms.push({ pts: deck, doorW: 1.6, type: 'deck', y: yd, top: yd + 3.2, plan: {} });
    k.box(0, 0, 3, 3, B + P.h * 0.85, B + P.h * 0.88, glassP, { solid: false });
    k.cyl(0, 0, 0.8, 0.2, B + P.h * 0.88, H, col, { seg: 6 });
    k.box(0, 0, s0 * 0.9, s0 * 0.9, B, B + 0.4, mat(GRANITE), { solid: false, detail: true });
    furnish(k, lm, rooms, towerTheme());
  } else {
    // Slender glass tower: square shaft (the lobby in its foot), an observation box, a spire.
    const w = P.r * 1.3, oy = B + P.h * P.pod, LH = 5, gl = mat(GLASS, [0.85, 0.92, 1], WIN | CURTAIN, 1.5, 3.6, 5);
    const lob = square(w - 0.2), core = w * 0.35;
    ringWalls(k, lob, B, B + LH, 0.4, gl, 3.0, 3.0, { foot: true, map: 0 });
    k.box(0, 0, w - 0.3, w - 0.3, B - 0.3, B, mat(GRANITE, [0.9, 0.9, 0.9]), { foot: true, map: 0 });
    k.box(0, 0, core, core, B, B + LH, mat(PANEL, WHITE), { map: 0 });
    k.box(0, 0, w, w, B + LH, oy - 0.5, gl, { map: 0 });
    footprint(k, 0, 0, w, B, oy, false);
    rooms.push({ pts: square(w - 0.4), doorW: 3.0, type: 'foyer', y: B, top: B + LH, plan: { core: { u: 0, v: 0, r: core } } });
    k.box(0, 0, w + 0.4, 0.4, B + LH, oy, mat(PANEL, WHITE), { solid: false, rot: Math.PI / 4, detail: true });
    // The observation box: the deck in its lower part behind the glass, a gallery round it.
    const DH = 4.2, a = w + 5 - 0.15, clr = mat(GLASS, [0.85, 0.95, 1.0]);
    k.box(0, 0, w + 6.8, w + 6.8, oy - 0.5, oy, mat(PANEL, WHITE), { map: 0, top: mat(GRANITE, [0.85, 0.85, 0.86]) });
    const deck = square(a);
    ringWalls(k, deck, oy, oy + DH, 0.3, glass, 1.8, 2.4);
    k.box(0, 0, w + 5, w + 5, oy + DH, oy + 12, glass, { top: mat(GRAVEL, WHITE, ROOF) });
    k.box(0, 0, w * 0.35, w * 0.35, oy, oy + DH, mat(PANEL, WHITE), { map: 0 });
    for (const [u, v] of square(w + 6.6)) k.cyl(u, v, 0.05, 0.05, oy, oy + 1.1, mat(METAL, [0.3, 0.3, 0.32]), { detail: true, solid: false, seg: 5 });
    ringWalls(k, square(w + 6.6), oy, oy + 1.05, 0.06, clr, 0, 0, { detail: true, solid: true, clear: true, map: 0 });
    rooms.push({ pts: square(a - 0.15), doorW: 1.8, type: 'deck', y: oy, top: oy + DH, plan: { core: { u: 0, v: 0, r: w * 0.35 } } });
    k.box(0, 0, w + 5.5, w + 5.5, oy + 12, oy + 13, mat(PANEL, WHITE), { solid: false });
    k.pyramid(0, 0, w * 0.8, w * 0.8, oy + 13, H, 0, mat(METAL, [0.9, 0.9, 0.92]));
    furnish(k, lm, rooms, towerTheme());
    wayIn(k, lob, 3.0);
  }
  void r;
}

export function lighthouse(k: Kit, lm: Landmark, r: Rng): void {
  const P = lm.p, B = k.B, H = B + P.h;
  const bands = P.stripes ? 6 : 1, RH = 3.6, Y0 = B + RH;
  const c1: RGB = [1, 1, 1], c2: RGB = P.stripes === 1 ? [0.85, 0.15, 0.12] : [0.15, 0.15, 0.16];
  const rAt = (y: number) => P.r * (1.35 - (0.35 * (y - B)) / P.h);
  // The stair room at the foot: walls round it with the door, the tower over it.
  const ra0 = P.r * 1.35, room = ring(ra0 - 0.25, 18);
  ringWalls(k, room, B, Y0, 0.5, mat(PLASTER, c1, WIN, 9, 7, 7), 1.4, 2.4, { foot: true, map: 0 });
  k.cyl(0, 0, ra0 - 0.3, ra0 - 0.3, B - 0.3, B, mat(PLASTER, [0.6, 0.45, 0.3]), { foot: true, map: 0, seg: 18 });
  footprint(k, 0, 0, ra0, B, H, true);
  for (let i = 0; i < bands; i++) {
    const y0 = Y0 + ((H - Y0) * i) / bands, y1 = Y0 + ((H - Y0) * (i + 1)) / bands;
    k.cyl(0, 0, rAt(y0), rAt(y1), y0, y1, mat(PLASTER, i % 2 ? c2 : c1, WIN, 9, 7, 7), { seg: 18, map: 0 });
  }
  // The gallery, the lantern room on it (glass round the lens, a door out), the cap.
  const lr = P.r * 0.75, lan = ring(lr, 10);
  k.cyl(0, 0, P.r + 1.3, P.r + 1.3, H, H + 0.5, mat(METAL, [0.2, 0.2, 0.22]), { seg: 18 });
  railing(k, P.r + 1.2, 18, H + 0.5, mat(GLASS, [0.85, 0.95, 1.0]));
  ringWalls(k, lan, H + 0.5, H + 3.8, 0.12, mat(GLASS, [1.3, 1.25, 1.1], WIN | CURTAIN, 1.2, 3.3, 3.3), 1.2, 2.3);
  k.cyl(0, 0, lr + 0.1, lr + 0.1, H + 3.8, H + 4.0, mat(METAL, [0.2, 0.2, 0.22]), { seg: 10 });
  k.cyl(0, 0, P.r * 0.9, 0, H + 3.8, H + 6, mat(METAL_ROOF, PAINT[[0, 3, 7][P.colour % 3]], ROOF), { seg: 12, solid: false });
  k.dome(0, 0, 0.4, 0.4, H + 5.9, H + 6.6, mat(METAL, [0.2, 0.2, 0.2]), { detail: true, seg: 6 });
  furnish(k, lm, [
    { pts: ring(ra0 - 0.5, 18), doorW: 1.4, type: 'stairhall', y: B, top: Y0, plan: {} },
    { pts: ring(lr - 0.06, 10), doorW: 1.2, type: 'lantern', y: H + 0.5, top: H + 3.8, plan: {} },
  ], lighthouseTheme());
  wayIn(k, room, 1.4);
  // The keeper's house, beside the tower (the door's way kept clear).
  const hu = -(ra0 + 6.5), hv = -1;
  k.box(hu, hv, 5, 3.5, B, B + 3.2, mat(PLASTER, WHITE, WIN, 2.5, 3.2, 3.2), { foot: true });
  k.gable(hu, hv, 5, 3.5, B + 3.2, B + 5.6, mat(PLASTER, WHITE), mat(CLAY, WHITE, ROOF));
  void r;
}

export function fortress(k: Kit, lm: Landmark, r: Rng): void {
  const P = lm.p, n = P.sides, R = P.R;
  const ruin = lm.style === 1;
  const stoneL = [GRANITE, SAND, LIME][P.stone % 3];
  const tint: RGB = ruin ? [0.78, 0.76, 0.72] : [0.88, 0.85, 0.8];
  const wall = mat(stoneL, tint);
  const wallW = mat(stoneL, tint, WIN | ARCH, 6.5, 9, 9);
  const roofM = mat(SLATE, WHITE, ROOF);
  const a0 = r.range(0, Math.PI * 2 / n) - Math.PI / 2;
  const corners: [number, number][] = [];
  for (let i = 0; i < n; i++) { const a = a0 + (i / n) * Math.PI * 2; corners.push([Math.cos(a) * R, Math.sin(a) * R]); }
  // Gate in the edge whose middle faces -v most.
  let gate = 0, gv = Infinity;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n, mv = (corners[i][1] + corners[j][1]) / 2; if (mv < gv) { gv = mv; gate = i; } }
  for (let i = 0; i < n; i++) {
    const [ua, va] = corners[i], [ub, vb] = corners[(i + 1) % n];
    const L = Math.hypot(ub - ua, vb - va), rot = Math.atan2(vb - va, ub - ua);
    const pieces = ruin ? r.int(2, 4) : 1;
    for (let p = 0; p < pieces; p++) {
      const t0 = p / pieces, t1 = (p + 1) / pieces;
      // The gate: a gap in the middle of the gate wall with a gatehouse.
      if (i === gate && t0 < 0.55 && t1 > 0.45 && pieces > 1) continue;
      const tm = (t0 + t1) / 2, mu = ua + (ub - ua) * tm, mv = va + (vb - va) * tm, hl = (L * (t1 - t0)) / 2 - (pieces > 1 ? 0.4 : 0);
      if (ruin && r.chance(0.18)) continue; // fallen
      const gmin = k.groundMin(mu, mv, hl, 1.3, rot), gmax = k.groundMax(mu, mv, hl, 1.3, rot);
      const h = P.wallH * (ruin ? r.range(0.35, 1) : 1);
      if (i === gate && pieces === 1) {
        // Intact: the gate passage through the middle.
        for (const s of [-1, 1]) {
          const su = ua + (ub - ua) * (0.5 + s * 0.27), sv = va + (vb - va) * (0.5 + s * 0.27);
          k.box(su, sv, L * 0.23, 1.3, gmin - 0.5, gmax + h, wall, { rot });
        }
        const gu = (ua + ub) / 2, gvv = (va + vb) / 2;
        k.box(gu, gvv, 3.4, 1.3, gmax + 4.2, gmax + h + 1, wall, { rot });
        for (const s of [-1, 1]) {
          const tu = gu + Math.cos(rot) * s * 5.5, tv = gvv + Math.sin(rot) * s * 5.5;
          k.cyl(tu, tv, 3.2, 3.0, k.groundMin(tu, tv, 3, 3) - 0.5, gmax + h + 4, wallW, { seg: 12 });
          k.cyl(tu, tv, 3.5, 0, gmax + h + 4, gmax + h + 10, roofM, { seg: 12, solid: false });
        }
        continue;
      }
      k.box(mu, mv, hl, 1.3, gmin - 0.5, gmax + h, wall, { rot });
      // Crenellations on intact stretches.
      if (!ruin || h > P.wallH * 0.95) for (let s = -hl + 0.8; s < hl - 0.4; s += 2.4) k.box(mu + Math.cos(rot) * s, mv + Math.sin(rot) * s, 0.6, 1.3, gmax + h, gmax + h + 1.1, wall, { rot, detail: true, solid: false });
    }
  }
  // Towers at the corners.
  for (const [u, v] of corners) {
    if (ruin && r.chance(0.2)) continue;
    const g = k.groundMin(u, v, 5, 5), gt = k.groundMax(u, v, 5, 5);
    const th = (P.wallH + 6) * (ruin ? r.range(0.45, 1) : 1);
    const tr = r.range(4.2, 5.6);
    k.cyl(u, v, tr + 0.4, tr, g - 0.5, gt + th, wallW, { seg: 14 });
    if (!ruin) k.cyl(u, v, tr + 0.5, 0, gt + th, gt + th + tr * 1.6, roofM, { seg: 14, solid: false });
  }
  // The keep at the back: thick walls round its great hall (the door in front, up steps from the
  // courtyard), the keep solid over the hall's ceiling.
  const kv = R * 0.25, ks = R * 0.22, KT = 1.6, HALL = 7;
  const g = k.groundMin(0, kv, ks, ks), gt = k.groundMax(0, kv, ks, ks), F = gt + 0.15;
  const kh = P.keepH * (ruin ? 0.7 : 1);
  const hall = square(ks - KT / 2, 0, kv);
  ringWalls(k, hall, g - 0.5, F + HALL, KT, wallW, 3.0, 4.2, {}, F);
  k.box(0, kv, ks, ks, F + HALL, gt + kh, wallW, { top: ruin ? wall : roofM });
  // (The hall's own ceiling and floor: plain stone, flagstones.)
  const inner = ks - KT + 0.15, flags = mat(GRANITE, [0.72, 0.7, 0.66]);
  k.box(0, kv, inner, inner, F + HALL - 0.3, F + HALL, wall, { map: 0 });
  k.box(0, kv, inner, inner, g - 0.5, F, flags, { map: 0, top: flags });
  footprint(k, 0, kv, ks, g, gt + kh, false);
  if (!ruin) {
    k.pyramid(0, kv, ks + 0.3, ks + 0.3, gt + kh, gt + kh + ks * 1.1, 0, roofM);
    for (const [cu, cv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      k.cyl(cu * ks, kv + cv * ks, 1.6, 1.6, gt + kh - 4, gt + kh + 3, wall, { detail: true, solid: false, seg: 8 });
      k.cyl(cu * ks, kv + cv * ks, 1.8, 0, gt + kh + 3, gt + kh + 7, roofM, { detail: true, solid: false, seg: 8 });
    }
  } else {
    // Broken top: a few jagged blocks.
    for (let i = 0; i < 5; i++) k.box(r.range(-ks, ks) * 0.8, kv + r.range(-ks, ks) * 0.8, r.range(1, 2.5), r.range(1, 2.5), gt + kh, gt + kh + r.range(1, 4), wall, { detail: true, solid: false });
  }
  furnish(k, lm, [{ pts: square(ks - KT, 0, kv), doorW: 3.0, type: 'greatHall', y: F, top: F + HALL - 0.3, plan: { ruin } }], keepTheme(mat(stoneL, [tint[0] * 0.9, tint[1] * 0.9, tint[2] * 0.9])));
  for (const [u, v] of [[-ks * 0.4, kv], [ks * 0.4, kv]]) k.light(u, v, F + HALL - 1);
  // Steps down from the door to the courtyard, then out through the gate.
  const fv = kv - ks, tread = 0.4, rise = 0.2;
  let i = 0, top = F;
  for (; i < 40; i++) {
    const v = fv - (i + 0.5) * tread;
    top = F - (i + 1) * rise;
    if (top <= k.ground(0, v) + 0.02) break;
    k.box(0, v, 2.0 + i * 0.03, tread / 2 + 0.01, k.groundMin(0, v, 2, tread) - 0.5, top, wall, { map: 0 });
  }
  const foot = fv - i * tread - 0.6;
  const [ga, gb] = [corners[gate], corners[(gate + 1) % n]], gm: P2 = [(ga[0] + gb[0]) / 2, (ga[1] + gb[1]) / 2], gl = Math.hypot(gm[0], gm[1]);
  const out: P2 = [gm[0] / gl, gm[1] / gl];
  const node = k.node(0, fv + 2, F);
  k.exit(node, [[0, fv - 0.5, F], [0, foot, k.ground(0, foot)], [gm[0] - out[0] * 5, gm[1] - out[1] * 5, k.ground(gm[0] - out[0] * 5, gm[1] - out[1] * 5)]], gm[0] + out[0] * 6, gm[1] + out[1] * 6);
}
