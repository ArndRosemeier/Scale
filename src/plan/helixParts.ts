/**
 * The helix tower's core, walkable (plan/marvelParts builds the walkway round it and the crown): a
 * round lobby at its foot (the way in from the square, and a door onto each walkway where it passes
 * at the lobby's floor), storeys above it, and a sky lounge under the roof. The walkway is the way
 * up: each storey has a door onto it where the walkway's floor passes at the storey's floor. Inside,
 * a hall from that door to the middle, the rooms round it (a café, a lounge, studios, a capsule
 * hotel); between the lowest storeys and the sky lounge the core is solid. Furnished by the
 * interior core.
 */
import { Rng, deriveSeed } from '../core/rng';
import type { Landmark } from './landmarks';
import { Kit, mat, wallAB, CONC, type PartMat, type RGB, type Opening } from './landmarkParts';
import { wayIn } from './lookoutParts';
import { storeyProgram } from './twistParts';
import { emptyDesign, type Design } from '../interior/design/types';
import { emitDesign } from '../interior/design/emit';
import { scifiTheme } from '../interior/design/theme';
import { fillStorey } from '../interior/design/storey';
import { lookoutItems } from '../interior/fill/lookout';
import { starshipItems } from '../interior/fill/starship';
import type { Program } from '../interior/fill/split';
import type { WallSeg } from '../interior/fill/area';
import type { RoomType } from '../interior/InteriorGen';
import type { Area } from '../interior/fill/area';
import { setDesign } from './designs';
import { polyArea } from '../core/geom2';

type P2 = [number, number];

/** The core and its walkways (from plan/marvelParts). */
export interface HelixShell {
  /** Core radius, its sides (as the solid core above), the roof's height. */
  R: number;
  n: number;
  yTop: number;
  wall: PartMat;
  plain: PartMat;
  roof: PartMat;
  accent: RGB;
  /** Each walkway: its start angle (local), sense, floor from y0 to yTop over `full` radians, mid radius. */
  walks: { a: number; sg: number; y0: number; full: number; rm: number }[];
}

/** Wall thickness, plate depth, lobby and storey heights, doors. */
const TH = 0.3, PL = 0.3, LOBBY = 6, DH = 4.5, DOOR_W = 1.4, DOOR_H = 2.5;
/** Storeys above the lobby (at most). */
const UP = 5;

const ALL = (type: RoomType): Program => ({ reserve: [{ type, at: 'all' }], rooms: [], corridor: 0 });

/** Angle where a walkway's floor passes at height y (from its start, along its sense), or null. */
function walkAt(w: HelixShell['walks'][number], yTop: number, y: number): number | null {
  const phi = ((y - w.y0) / (yTop - w.y0)) * w.full;
  return phi > 0 && phi < w.full ? w.a + w.sg * phi : null;
}

/** Convex hull (CCW). */
function hull(pts: P2[]): P2[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: P2[] = [], hi: P2[] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return [...lo.slice(0, -1), ...hi.slice(0, -1)];
}

/**
 * Builds the core: the walls and floors of the walkable storeys, the solid core between them, the
 * roof; keeps the design.
 */
export function helixCore(k: Kit, lm: Landmark, S: HelixShell): void {
  const B = k.B, R = S.R, n = S.n, step = (Math.PI * 2) / n, cosH = Math.cos(step / 2);
  // (The sides line up with the solid core's, whose corners are at world angles i·step.)
  const ph = -lm.angle;
  // Wall centre line and inner face: corners on circles whose flats are where the solid core's are.
  const Rw = R - TH / 2 / cosH, Ri = R - TH / cosH;
  const ringAt = (r: number): P2[] => Array.from({ length: n }, (_, i): P2 => [r * Math.cos(ph + i * step), r * Math.sin(ph + i * step)]);
  const W = ringAt(Rw), I = ringAt(Ri);
  // Where an angle meets the ring: the side and how far along it (clamped so a door fits).
  const side = (a: number, w: number): { j: number; t: number } => {
    let x = (a - ph) / step;
    x -= Math.floor(x / n) * n;
    const j = Math.floor(x) % n, L = 2 * Rw * Math.sin(step / 2), m = Math.min(0.5, (w / 2 + 0.15) / L);
    return { j, t: Math.min(1 - m, Math.max(m, x - j)) };
  };
  const at = (P: P2[], j: number, t: number): P2 => { const a = P[j], b = P[(j + 1) % n]; return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; };

  // The storeys: the lobby, those above it, the sky lounge under the roof. Each above the lobby
  // a little higher or lower than even, so that the walkway passes its floor in the middle of a
  // side (where its door is), at least `lo` over the one under it and at most `hi`.
  const w0 = S.walks[0], rise = S.yTop - w0.y0;
  const ref = w0.sg * (ph + step / 2 - w0.a);
  const phiRef = ref - Math.floor(ref / step) * step;
  const snap = (y: number, lo: number, hi: number): number => {
    let k = Math.round(((y - w0.y0) / rise * w0.full - phiRef) / step);
    const yk = (q: number) => w0.y0 + ((phiRef + q * step) / w0.full) * rise;
    while (yk(k) < lo) k++;
    while (yk(k) > hi) k--;
    return yk(k);
  };
  const ys = [B];
  for (let i = 0; i < UP; i++) {
    const prev = ys[ys.length - 1], y = snap(prev + (i === 0 ? LOBBY : DH), prev + (i === 0 ? LOBBY - 1.2 : DH - 0.8), prev + (i === 0 ? LOBBY + 1.5 : DH + 1.5));
    if (y + DH + 1.5 > S.yTop - 2 * DH - 12) break;
    ys.push(y);
  }
  const band = ys.length;
  const sky = snap(S.yTop - DH, S.yTop - DH - 1.5, S.yTop - DH + 0.8);
  ys.push(sky);
  const tops = ys.map((y, i) => (i + 1 < band ? ys[i + 1] : i === 0 ? B + LOBBY : i < band ? y + DH : S.yTop) - PL);

  const r = new Rng(deriveSeed(lm.seed, 'helix-rooms'));
  const kinds: RoomType[] = ['mess', 'lounge', 'lab', 'quarters'];
  for (let i = kinds.length - 1; i > 0; i--) { const j = r.int(0, i); [kinds[i], kinds[j]] = [kinds[j], kinds[i]]; }
  const T = scifiTheme(S.accent);
  const D: Design = emptyDesign();
  const halls: [P2[], number, number][] = [];
  let seed = deriveSeed(lm.seed, 'helix-storeys');
  const sg0 = S.walks[0].sg;
  // The way in from the square: across from where the walkway starts (a quarter round with two
  // walkways), where the walkway passes high over it.
  const plaza = S.walks[0].a + sg0 * (S.walks.length > 1 ? Math.PI / 2 : Math.PI);
  ys.forEach((y, s) => {
    const top = tops[s], lobby = s === 0;
    // The doors of this storey: onto each walkway (only the first above the lobby), from the square.
    const doors: { a: number; y0: number; y1: number; w: number }[] = [];
    S.walks.forEach((w, wi) => {
      if (wi > 0 && !lobby) return;
      const a = walkAt(w, S.yTop, y);
      if (a !== null) doors.push({ a, y0: y - PL, y1: y + DOOR_H, w: DOOR_W });
    });
    if (lobby) doors.push({ a: plaza, y0: B, y1: B + 3, w: 3.0 });
    // The walls (round the lobby on a foundation), with the doors.
    const open: Opening[][] = Array.from({ length: n }, () => []);
    const ent: WallSeg[] = [];
    for (const d of doors) {
      const { j, t } = side(d.a, d.w), L = 2 * Rw * Math.sin(step / 2);
      open[j].push({ a: t * L + TH / 2, w: d.w, y0: d.y0, y1: d.y1 });
      const Li = 2 * Ri * Math.sin(step / 2), h = d.w / 2 / Li;
      ent.push({ ax: I[j][0], az: I[j][1], bx: I[(j + 1) % n][0], bz: I[(j + 1) % n][1], doors: [[t - h, t + h]] });
    }
    const wy0 = y - PL, wy1 = top;
    for (let j = 0; j < n; j++) {
      const a = W[j], b = W[(j + 1) % n], L = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / L, uv = (b[1] - a[1]) / L, e = TH / 2;
      wallAB(k, [a[0] - ux * e, a[1] - uv * e], [b[0] + ux * e, b[1] + uv * e], wy0, wy1, TH, S.wall, open[j], { map: 0, foot: lobby ? true : undefined });
    }
    // The floor (the lobby's on a foundation) and, for the top storey of a run, its ceiling.
    k.cyl(0, 0, Rw, Rw, y - PL, y, S.plain, { top: T.floor, map: 0, deck: true, seg: n, foot: lobby ? true : undefined });
    if (lobby) {
      const fp = k.cyl(0, 0, R, R, B, B + LOBBY, mat(CONC), { solid: false, map: 1, seg: n });
      fp.hidden = true; fp.footprint = true;
      // The steps down to the square (wayIn builds them at the front, -v, of its frame).
      const { j, t } = side(plaza, 3.0), [du, dv] = at(I, j, t);
      k.sub(du, dv, ph + (j + 0.5) * step + Math.PI / 2, () => wayIn(k, [[-1.5, 0], [1.5, 0]], 3.0));
    }
    // The rooms: the lobby one open foyer; above, a hall from the walkway's door to the middle
    // with the rooms round it.
    const outline = I.flat();
    const brief = { outline, front: null, y, top, seed, entrances: ent };
    if (lobby) {
      const items = (type: RoomType, A: Area, rr: Rng) => [...lookoutItems({})(type, A, rr), ...starshipItems('lounge', A, rr), ...(Math.abs(polyArea(A.poly)) > 300 ? starshipItems('mess', A, rr) : [])];
      fillStorey(D, { ...brief, fixed: [], program: ALL('foyer'), items, cell: 0.25 });
    } else {
      const type: RoomType = s === ys.length - 1 ? 'lounge' : kinds[(s - 1) % kinds.length];
      const da = doors.length ? doors[0].a : 0;
      // (The hall runs out past the wall at the door, so no room wraps round it.)
      const c = Math.min(3, Ri * 0.3), w = (DOOR_W / 2 + 0.6) / Ri;
      const hub = hull([
        ...Array.from({ length: 8 }, (_, q): P2 => [c * Math.cos(da + (q * Math.PI) / 4), c * Math.sin(da + (q * Math.PI) / 4)]),
        [(Ri + 1) * Math.cos(da - w), (Ri + 1) * Math.sin(da - w)], [(Ri + 1) * Math.cos(da + w), (Ri + 1) * Math.sin(da + w)],
      ]);
      const angles = Array.from({ length: 16 }, (_, q) => da + (q * Math.PI) / 8);
      const items = (t: RoomType, A: Area, rr: Rng) => starshipItems(t, A, rr);
      const split = fillStorey(D, { ...brief, fixed: [{ type: 'stairs', poly: hub.flat(), hub: true, fixed: true }], program: storeyProgram(type, 0, 0, angles), items, cell: 0.3 });
      const hp = split.spaces[0].poly;
      halls.push([Array.from({ length: hp.length / 2 }, (_, q): P2 => [hp[2 * q], hp[2 * q + 1]]), y, top]);
      D.lights.push([0, 0, top - 0.25]);
    }
    seed += 1000;
  });
  // The solid core between the storeys and the sky lounge (its underside their ceiling), the roof.
  k.cyl(0, 0, R, R, tops[band - 1], sky - PL, S.wall, { seg: n, top: S.plain });
  k.cyl(0, 0, R, R, S.yTop - PL, S.yTop, S.plain, { seg: n, top: S.roof, deck: true });
  k.inner(() => {
    emitDesign(k, D, T);
    for (const [p, y0, y1] of halls) k.roomPoly(p, y0, y1);
  });
  setDesign(lm, D);
}
