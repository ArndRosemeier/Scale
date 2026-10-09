/**
 * The prop catalogue the themes feed rooms from: each prop is a few landmark parts built at a
 * local point, its front facing the frame's +v after turning by `rot`. Small pieces are detail
 * only; anything one would bump into or stand on is solid.
 */
import { Kit, mat, GREEN_ROOF, PLASTER, GRANITE, GLASS, GRAVEL, CONC, type Opt } from '../../plan/landmarkParts';
import type { Rng } from '../../core/rng';
import type { PropName, Theme } from './theme';

const D: Opt = { detail: true, map: 0 };
const DS: Opt = { detail: true, solid: true, map: 0 };
const leaves = () => mat(GREEN_ROOF, [0.55, 0.85, 0.5]);
const bark = () => mat(PLASTER, [0.45, 0.35, 0.25]);

/** `h`: the piece's height where it varies (plants). */
export function buildProp(k: Kit, name: PropName, u: number, v: number, y: number, rot: number, T: Theme, r: Rng, h = 0): void {
  k.sub(u, v, rot, () => {
    switch (name) {
      case 'pod': // A sleep capsule: a base, a glass hood, a light strip along its foot.
        k.box(0, 0, 0.55, 1.1, y, y + 0.55, T.furniture, DS);
        k.box(0, 0.05, 0.5, 1.0, y + 0.55, y + 1.15, T.glass, { ...D, clear: true });
        k.box(0, -1.08, 0.5, 0.03, y + 0.2, y + 0.3, T.glow, D);
        break;
      case 'locker':
        k.box(0, 0, 0.9, 0.3, y, y + 2.1, T.wall, DS);
        for (const s of [-0.45, 0.45]) k.box(s, 0.31, 0.02, 0.01, y + 0.9, y + 1.3, T.glow, D);
        break;
      case 'console': // A desk with a sloped, glowing screen.
        k.box(0, 0, 0.8, 0.35, y, y + 0.85, T.furniture, DS);
        k.box(0, -0.25, 0.75, 0.04, y + 0.95, y + 1.45, T.glow, D);
        k.box(0, 0.1, 0.7, 0.2, y + 0.85, y + 0.88, T.trim, D);
        break;
      case 'holo': // A round table projecting a glowing column.
        k.cyl(0, 0, 0.75, 0.6, y, y + 0.9, T.furniture, { ...DS, seg: 16 });
        k.cyl(0, 0, 0.6, 0.6, y + 0.9, y + 0.93, T.glow, { ...D, seg: 16 });
        k.cyl(0, 0, 0.45, 0.25, y + 0.93, y + 1.9, T.glass, { ...D, clear: true, seg: 12 });
        break;
      case 'table':
        k.box(0, 0, 0.12, 0.12, y, y + 0.72, T.trim, DS);
        k.box(0, 0, 0.75, 0.45, y + 0.72, y + 0.77, T.furniture, D);
        break;
      case 'stool':
        k.cyl(0, 0, 0.2, 0.22, y, y + 0.46, T.trim, { ...D, seg: 10 });
        break;
      case 'bench':
        k.box(0, 0, 0.95, 0.28, y, y + 0.45, T.furniture, DS);
        k.box(0, 0.25, 0.95, 0.04, y + 0.45, y + 0.85, T.furniture, D);
        k.box(0, -0.29, 0.9, 0.01, y + 0.05, y + 0.1, T.glow, D);
        break;
      case 'seat': // A backless gallery bench: a padded top on two legs.
        for (const s of [-0.75, 0.75]) k.box(s, 0, 0.06, 0.2, y, y + 0.38, T.trim, D);
        k.box(0, 0, 0.9, 0.25, y + 0.3, y + 0.46, T.furniture, DS);
        break;
      case 'case': // A display case: a plinth, a glass box, something in it.
        k.box(0, 0, 0.6, 0.4, y, y + 0.9, T.furniture, DS);
        k.box(0, 0, 0.58, 0.38, y + 0.9, y + 1.5, T.glass, { ...D, clear: true });
        k.box(r.range(-0.25, 0.25), 0, r.range(0.08, 0.2), r.range(0.08, 0.15), y + 0.9, y + 0.9 + r.range(0.15, 0.45), T.trim, D);
        break;
      case 'statue': { // A figure on a plinth.
        k.box(0, 0, 0.5, 0.5, y, y + 1.0, T.wall, DS);
        const h = r.range(1.2, 1.7);
        k.cyl(0, 0, 0.26, 0.2, y + 1.0, y + 1.0 + h * 0.8, T.trim, { ...D, seg: 10 });
        k.cyl(0, 0, 0.13, 0.12, y + 1.0 + h * 0.8, y + 1.0 + h, T.trim, { ...D, seg: 8 });
        break;
      }
      case 'bigStatue': { // The great hall's centrepiece: a tall figure on a stepped pedestal.
        k.box(0, 0, 1.6, 1.6, y, y + 0.5, T.wall, DS);
        k.box(0, 0, 1.2, 1.2, y + 0.5, y + 1.6, T.wall, DS);
        k.cyl(0, 0, 0.75, 0.55, y + 1.6, y + 4.2, T.trim, { ...D, seg: 14 });
        k.cyl(0, 0, 0.35, 0.3, y + 4.2, y + 4.9, T.trim, { ...D, seg: 10 });
        for (const s of [-1, 1]) k.box(s * 0.75, 0.1, 0.12, 0.12, y + 3.0, y + 4.1, T.trim, { ...D, rot: s * 0.4 });
        break;
      }
      case 'painting': { // A framed canvas on the wall behind (at eye height).
        const w = r.range(0.45, 0.75), h = r.range(0.4, 0.7), c = r.pick<[number, number, number]>([[0.55, 0.3, 0.2], [0.25, 0.35, 0.55], [0.6, 0.55, 0.3], [0.3, 0.45, 0.3], [0.7, 0.6, 0.5]]);
        k.box(0, 0.02, w + 0.06, 0.03, y + 1.6 - h - 0.06, y + 1.6 + h + 0.06, T.trim, D);
        k.box(0, 0.05, w, 0.01, y + 1.6 - h, y + 1.6 + h, mat(PLASTER, c), D);
        break;
      }
      case 'reception':
        k.box(0, 0, 1.5, 0.45, y, y + 1.1, T.furniture, DS);
        k.box(0, -0.05, 1.55, 0.5, y + 1.1, y + 1.15, T.trim, D);
        break;
      case 'planter':
        k.box(0, 0, 0.45, 0.45, y, y + 0.6, T.trim, DS);
        k.box(0, 0, 0.38, 0.38, y + 0.6, y + 0.6 + r.range(0.35, 0.8), leaves(), D);
        break;
      case 'screen': // A glowing panel on the wall behind.
        k.box(0, 0.05, 0.9, 0.02, y + 1.2, y + 2.0, T.glow, D);
        break;
      case 'crate': {
        const s = r.range(0.35, 0.55);
        k.box(0, 0, s, s, y, y + s * 2, T.trim, DS);
        break;
      }
      case 'counter':
        k.box(0, 0, 1.4, 0.35, y, y + 1.0, T.furniture, DS);
        k.box(0, -0.36, 1.35, 0.01, y + 0.1, y + 0.16, T.glow, D);
        break;
      case 'rack':
        k.box(0, 0, 0.6, 0.25, y, y + 1.9, T.trim, DS);
        for (const t of [0.5, 1.0, 1.5]) k.box(0, -0.26, 0.55, 0.01, y + t, y + t + 0.04, T.glow, D);
        break;
      case 'palm': { // A slender trunk, fronds drooping round its head.
        const H = h || 5, lean = r.range(-0.4, 0.4), tu = lean, tv = r.range(-0.3, 0.3);
        k.strut(0, 0, y, tu, tv, y + H, 0.18, bark(), { ...D, solid: true });
        const n = r.int(7, 9), L = Math.min(2.6, H * 0.45);
        for (let i = 0; i < n; i++) {
          // Each frond arches out and droops: two thin blades.
          const a = (i / n) * Math.PI * 2 + r.range(-0.2, 0.2), c = Math.cos(a), sn = Math.sin(a);
          k.beam(tu, tv, y + H, tu + c * L * 0.5, tv + sn * L * 0.5, y + H + 0.15, 0.2, leaves(), D);
          k.beam(tu + c * L * 0.5, tv + sn * L * 0.5, y + H + 0.15, tu + c * L, tv + sn * L, y + H - L * 0.5, 0.16, leaves(), D);
        }
        k.dome(tu, tv, 0.35, 0.35, y + H - 0.3, y + H + 0.25, leaves(), D);
        break;
      }
      case 'tree': { // A broadleaf: a trunk and a round crown.
        const H = h || 4, cr = Math.min(1.4, H * 0.3);
        k.cyl(0, 0, 0.16, 0.12, y, y + H - cr, bark(), { ...DS, seg: 8 });
        k.dome(0, 0, cr, cr, y + H - cr * 1.6, y + H, leaves(), D);
        k.dome(0, 0, cr, cr, y + H - cr * 1.6, y + H - cr * 2.4, leaves(), D);
        break;
      }
      case 'fern':
        k.dome(0, 0, 0.6, 0.6, y, y + 0.9, mat(GREEN_ROOF, [0.4, 0.75, 0.38]), D);
        break;
      case 'flowerBed': { // A low stone border, soil, shrubs and flowers.
        const w = 1.0, dd = 0.55;
        k.box(0, 0, w + 0.1, dd + 0.05, y, y + 0.35, T.wall, DS);
        k.box(0, 0, w, dd - 0.03, y + 0.35, y + 0.37, mat(GRAVEL, [0.35, 0.25, 0.18]), D);
        for (let i = 0; i < 5; i++) {
          const fu = r.range(-w + 0.25, w - 0.25), fv = r.range(-dd + 0.2, dd - 0.2), s = r.range(0.2, 0.35);
          const c = r.pick<[number, number, number]>([[0.4, 0.75, 0.38], [1.2, 0.35, 0.4], [1.2, 1.0, 0.3], [0.9, 0.5, 1.1], [1.25, 1.2, 1.2]]);
          k.dome(fu, fv, s, s, y + 0.37, y + 0.37 + s * 1.6, mat(GREEN_ROOF, c), D);
        }
        break;
      }
      case 'cactus': { // A column with an arm or two, in a ring of gravel.
        const H = h || 2, cm = mat(GREEN_ROOF, [0.45, 0.7, 0.45]);
        k.cyl(0, 0, 0.5, 0.5, y, y + 0.03, mat(GRAVEL, [1.0, 0.9, 0.7]), { ...D, seg: 10 });
        k.cyl(0, 0, 0.2, 0.18, y, y + H, cm, { ...DS, seg: 10 });
        k.dome(0, 0, 0.18, 0.18, y + H, y + H + 0.15, cm, D);
        for (const s of r.chance(0.5) ? [-1, 1] : [1]) {
          const ay = y + H * r.range(0.4, 0.6);
          k.box(s * 0.3, 0, 0.14, 0.1, ay, ay + 0.18, cm, D);
          k.cyl(s * 0.42, 0, 0.11, 0.1, ay, ay + H * 0.35, cm, { ...D, seg: 8 });
        }
        break;
      }
      case 'rock':
        k.dome(0, 0, 0.7, 0.55, y - 0.1, y + 0.8, mat(GRANITE, [0.75, 0.68, 0.6]), { ...DS, seg: 8 });
        break;
      case 'fountain': { // A round basin, a column with a bowl, water.
        k.cyl(0, 0, 1.8, 1.8, y, y + 0.45, mat(GRANITE, [0.9, 0.88, 0.84]), { ...DS, seg: 24 });
        k.cyl(0, 0, 1.6, 1.6, y + 0.45, y + 0.47, mat(GLASS, [0.25, 0.45, 0.55]), { ...D, seg: 24 });
        k.cyl(0, 0, 0.25, 0.2, y + 0.45, y + 1.2, mat(GRANITE, [0.9, 0.88, 0.84]), { ...D, seg: 10 });
        k.dome(0, 0, 0.7, 0.7, y + 1.4, y + 1.1, mat(GRANITE, [0.9, 0.88, 0.84]), { ...D, seg: 14 });
        k.cyl(0, 0, 0.06, 0.03, y + 1.4, y + 2.3, mat(GLASS, [0.8, 0.9, 1.0]), { ...D, clear: true, seg: 6 });
        break;
      }
      case 'checkDesk': // A check-in desk: a counter with the bag belt beside it, a sign above.
        k.box(-0.45, 0, 0.75, 0.35, y, y + 1.05, T.furniture, DS);
        k.box(0.8, 0.05, 0.4, 0.3, y, y + 0.45, T.trim, DS);
        k.box(-0.45, 0.3, 0.5, 0.03, y + 1.9, y + 2.3, T.glow, D);
        k.box(-0.45, 0.3, 0.04, 0.02, y + 1.05, y + 1.9, T.trim, D);
        break;
      case 'scanner': // A walk-through scanner arch.
        for (const s of [-0.5, 0.5]) k.box(s, 0, 0.08, 0.3, y, y + 2.2, T.wall, DS);
        k.box(0, 0, 0.58, 0.3, y + 2.2, y + 2.4, T.wall, D);
        k.box(0, -0.31, 0.3, 0.01, y + 2.25, y + 2.35, T.glow, D);
        break;
      case 'belt': // A bag scanner on its belt.
        k.box(0, 0, 1.4, 0.4, y, y + 0.8, T.trim, DS);
        k.box(0, 0, 0.5, 0.45, y + 0.8, y + 1.5, T.wall, DS);
        break;
      case 'gateDesk': // The gate's desk and its sign.
        k.box(0, 0, 0.9, 0.35, y, y + 1.05, T.furniture, DS);
        k.box(0, 0.25, 0.04, 0.04, y, y + 2.6, T.trim, D);
        k.box(0, 0.25, 0.6, 0.04, y + 2.6, y + 3.1, T.glow, D);
        break;
      case 'seatRow': { // A row of linked seats.
        k.box(0, 0, 1.45, 0.25, y + 0.3, y + 0.46, T.furniture, DS);
        k.box(0, 0.24, 1.45, 0.04, y + 0.46, y + 0.9, T.furniture, D);
        for (const s of [-1.3, 0, 1.3]) k.box(s, 0, 0.04, 0.2, y, y + 0.3, T.trim, D);
        break;
      }
      case 'board': // A departures board on a post.
        k.box(0, 0, 0.06, 0.06, y, y + 2.2, T.trim, DS);
        k.box(0, 0, 0.9, 0.05, y + 2.2, y + 2.9, mat(CONC, [0.15, 0.16, 0.2]), D);
        k.box(0, -0.06, 0.8, 0.01, y + 2.3, y + 2.8, T.glow, D);
        break;
    }
  });
}
