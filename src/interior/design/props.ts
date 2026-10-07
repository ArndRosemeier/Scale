/**
 * The prop catalogue the themes feed rooms from: each prop is a few landmark parts built at a
 * local point, its front facing the frame's +v after turning by `rot`. Small pieces are detail
 * only; anything one would bump into or stand on is solid.
 */
import { Kit, mat, GREEN_ROOF, type Opt } from '../../plan/landmarkParts';
import type { Rng } from '../../core/rng';
import type { PropName, Theme } from './theme';

const D: Opt = { detail: true, map: 0 };
const DS: Opt = { detail: true, solid: true, map: 0 };
const leaves = () => mat(GREEN_ROOF, [0.55, 0.85, 0.5]);

export function buildProp(k: Kit, name: PropName, u: number, v: number, y: number, rot: number, T: Theme, r: Rng): void {
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
        for (const h of [0.5, 1.0, 1.5]) k.box(0, -0.26, 0.55, 0.01, y + h, y + h + 0.04, T.glow, D);
        break;
    }
  });
}
