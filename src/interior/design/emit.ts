/**
 * A design (design/types) as landmark parts: floor plates as flat quads, walls as boxes round
 * their doors (a lintel over each), glass rails with a hidden solid behind, flights as stacked
 * step boxes, the rooms' props from the theme, and the walkable rooms and lights for the inside.
 * Everything is close detail (left out of the far mesh) but solid.
 */
import { Kit, mat, CONC, type PartMat, type Opt } from '../../plan/landmarkParts';
import { Rng } from '../../core/rng';
import type { Design, DRoom, P2 } from './types';
import type { PropAt, Theme } from './theme';
import { buildProp } from './props';
import { lerp2 as lerp } from '../../core/geom2';

const DS: Opt = { detail: true, solid: true, map: 0 };
const DOOR_H = 2.3;

export function emitDesign(k: Kit, D: Design, T: Theme): void {
  for (const f of D.floors) {
    const m = f.fn === 'gallery' ? T.walk : f.fn === 'hall' ? T.wall : T.floor;
    k.rampQ(f.q, f.y - f.th, f.y, f.y, 0, m, { ...DS, deck: true, top: m, noSides: f.fn !== 'gallery' && f.fn !== 'hall' });
  }
  for (const w of D.walls) {
    if (w.kind === 'rail') { rail(k, w.a, w.b, w.y0, w.y1, T); continue; }
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    if (L < 0.05) continue;
    let t = 0;
    const seg = (t0: number, t1: number, y0: number, y1: number) => { if ((t1 - t0) * L > 0.05) slab(k, lerp(w.a, w.b, t0), lerp(w.a, w.b, t1), y0, y1, w.th, T.wall); };
    for (const [d0, d1] of w.doors) {
      seg(t, d0, w.y0, w.y1);
      seg(d0, d1, Math.min(w.y1, w.y0 + DOOR_H), w.y1);
      // A light frame round the door.
      slab(k, lerp(w.a, w.b, d0 - 0.06 / L), lerp(w.a, w.b, d0), w.y0, w.y0 + DOOR_H, w.th + 0.06, T.glow, true);
      slab(k, lerp(w.a, w.b, d1), lerp(w.a, w.b, d1 + 0.06 / L), w.y0, w.y0 + DOOR_H, w.th + 0.06, T.glow, true);
      t = d1;
    }
    seg(t, 1, w.y0, w.y1);
  }
  for (const s of D.stairs) {
    const rise = (s.y1 - s.y0) / s.n, tread = s.tread;
    const rot = Math.atan2(s.dir[1], s.dir[0]);
    for (let i = 0; i < s.n; i++) {
      const c: P2 = [s.from[0] + s.dir[0] * (i + 0.5) * tread, s.from[1] + s.dir[1] * (i + 0.5) * tread];
      const top = s.y0 + (i + 1) * rise;
      k.box(c[0], c[1], tread / 2 + 0.02, s.width / 2, Math.max(s.y0 - 0.3, top - 0.9), top, T.trim, { ...DS, deck: true, rot, top: T.walk });
    }
  }
  for (const room of D.rooms) furnish(k, room, T);
  for (const room of D.rooms) k.roomPoly(room.poly, room.y, room.y + room.h);
  for (const [u, v, y] of D.lights) k.light(u, v, y);
}

/** A wall slab from a to b (centre line), y0–y1, th thick. */
function slab(k: Kit, a: P2, b: P2, y0: number, y1: number, th: number, m: PartMat, detailOnly = false): void {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L < 0.02 || y1 - y0 < 0.02) return;
  k.box((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, L / 2, th / 2, y0, y1, m, detailOnly ? { detail: true, map: 0, rot: Math.atan2(b[1] - a[1], b[0] - a[0]) } : { ...DS, rot: Math.atan2(b[1] - a[1], b[0] - a[0]) });
}

/** A glass balustrade with a lit handrail; a hidden solid keeps one from walking off. */
function rail(k: Kit, a: P2, b: P2, y0: number, y1: number, T: Theme): void {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]), rot = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const cu = (a[0] + b[0]) / 2, cv = (a[1] + b[1]) / 2;
  k.box(cu, cv, L / 2, 0.03, y0, y1 - 0.06, T.glass, { detail: true, clear: true, map: 0, rot });
  k.box(cu, cv, L / 2, 0.05, y1 - 0.06, y1, T.glow, { detail: true, map: 0, rot });
  const s = k.box(cu, cv, L / 2, 0.08, y0, y1, mat(CONC), { solid: true, map: 0, rot });
  s.hidden = true;
}

/** The room's props from its theme recipe, placed in the room's quad (door side first). */
function furnish(k: Kit, room: DRoom, T: Theme): void {
  const recipes = T.rooms[room.fn];
  if (!recipes?.length || room.poly.length !== 4) return;
  const r = new Rng(room.seed);
  const recipe = recipes[r.int(0, recipes.length - 1)];
  const mirror = r.chance(0.5) ? -1 : 1;
  // Quad corners: front left, front right (along the gallery), back right, back left.
  const [F0, F1, K1, K0] = room.poly;
  const at = (s: number, t: number): P2 => {
    const a = lerp(F0, F1, 0.5 + s), b = lerp(K0, K1, 0.5 + s);
    return lerp(a, b, t);
  };
  const back = norm([(K0[0] + K1[0] - F0[0] - F1[0]) / 2, (K0[1] + K1[1] - F0[1] - F1[1]) / 2]);
  const across = norm([F1[0] - F0[0], F1[1] - F0[1]]);
  const dirOf = (f: PropAt['face']): P2 => f === 'door' ? [-back[0], -back[1]] : f === 'back' ? back : f === 'left' ? [-across[0] * mirror, -across[1] * mirror] : [across[0] * mirror, across[1] * mirror];
  for (const it of recipe) {
    const s = it.s * mirror;
    // Keep in from the walls by a margin that grows where the wedge narrows.
    const [u, v] = at(Math.max(-0.42, Math.min(0.42, s)), Math.max(0.08, Math.min(0.97, it.t)));
    const d = dirOf(it.face);
    buildProp(k, it.prop, u, v, room.y, Math.atan2(d[1], d[0]) - Math.PI / 2, T, r);
  }
}

const norm = (v: P2): P2 => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
