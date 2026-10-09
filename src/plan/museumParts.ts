/**
 * The museum: a neoclassical block behind a colonnade on a podium (sometimes a dome), or a modern
 * glazed hall under a closed block with a glass pyramid in its forecourt. Both can be walked
 * into: through the middle of the front into a great hall that runs to the back (the full height
 * of the classical block), with gallery corridors and exhibition rooms, a shop and a café in the
 * wings either side, all divided and furnished by the interior core (interior/design/storey with
 * the museum theme, fill/museum).
 */
import { Rng, deriveSeed } from '../core/rng';
import type { Landmark } from './landmarks';
import {
  Kit, mat, wallRun, entranceSteps, type Opt, type PartMat, type RGB,
  WIN, CURTAIN, ARCH, ROOF, LIME, SAND, BRICK_WHITE, PLASTER, PANEL, METAL, GLASS, GRANITE, ZINC, GRAVEL, WHITE, COPPER,
} from './landmarkParts';
import { emptyDesign } from '../interior/design/types';
import { setDesign } from './designs';
import { emitDesign } from '../interior/design/emit';
import { museumTheme } from '../interior/design/theme';
import { fillStorey } from '../interior/design/storey';
import { museumProgram, museumItems } from '../interior/fill/museum';

/** Outer wall thickness, the doorway, the great hall's share of the width. */
const T = 0.6, DOOR_W = 4.4, DOOR_H = 4.4, HALL = 0.34;

export function museum(k: Kit, lm: Landmark, r: Rng): void {
  const P = lm.p, B = k.B, H = B + P.h;
  const vb = lm.hv - 3 - P.d / 2, hw = P.w / 2, hd = P.d / 2, fv = vb - hd;
  const modern = lm.style !== 0;
  // The block as one solid for the map, the ground and the props round it (footprint only).
  const foot = k.box(0, vb, hw, hd, B, modern ? B + 7 : H, mat(PLASTER), { solid: false, map: 1 });
  foot.hidden = true;
  foot.footprint = true;
  let top: number, stepV = fv, stepW: number, facade: PartMat;
  if (!modern) {
    const wallL = [LIME, SAND, BRICK_WHITE][P.wall % 3];
    facade = mat(wallL, [0.96, 0.94, 0.9], WIN | ARCH, 5.5, P.h * 0.5, P.h * 0.5);
    const plain = mat(wallL, [0.94, 0.92, 0.88]);
    const roofM = mat(ZINC, r.chance(0.5) ? COPPER : WHITE, ROOF);
    top = H;
    shell(k, vb, hw, hd, B, H, facade, mat(GRAVEL, WHITE, ROOF));
    k.box(0, vb - hd + 0.3, hw, 0.3, H, H + 1.2, plain, { detail: true, solid: false });
    // Colonnade across the front on a podium, entablature, pediment.
    const cw = P.w * 0.62, cv = fv - 4.5, n = P.cols;
    k.box(0, fv - 3.5, cw / 2 + 1.5, 3.5, k.F, B, mat(GRANITE, [0.85, 0.85, 0.85]), { foot: true, map: 2 });
    for (let i = 0; i < n; i++) k.cyl(-cw / 2 + (i + 0.5) * (cw / n), cv, 0.85, 0.72, B, H - 2.4, mat(wallL, WHITE), { seg: 12 });
    k.box(0, cv + 0.8, cw / 2 + 1, 3.3, H - 2.4, H, plain, { solid: false });
    k.gable(0, cv + 0.8, 3.3, cw / 2 + 1, H, H + cw * 0.14, plain, roofM, { rot: Math.PI / 2 });
    if (P.dome) {
      const dr = Math.min(P.d * 0.3, 11);
      k.cyl(0, vb + 2, dr, dr, H, H + 5, mat(wallL, WHITE, WIN | ARCH, 2.4, 5, 5), { solid: false });
      k.dome(0, vb + 2, dr + 0.3, dr + 0.3, H + 5, H + 5 + dr, roofM, { seg: 24 });
    }
    stepV = fv - 7;
    stepW = Math.min(cw / 2, P.w * 0.12 + 1);
  } else {
    // Modern: a glazed hall, a closed block cantilevered over it, a glass pyramid in the forecourt.
    const clad = mat(r.pick([PANEL, METAL, LIME]), r.pick<RGB>([[0.95, 0.95, 0.95], [0.7, 0.72, 0.75], [0.88, 0.82, 0.72]]));
    facade = mat(GLASS, WHITE, WIN | CURTAIN, 1.8, 7, 7);
    top = B + 7;
    shell(k, vb, hw, hd, B, top, facade, mat(GRAVEL, WHITE, ROOF));
    k.box(-hw * 0.2, vb - 4, hw * 0.75, hd * 0.8, B + 7, H + 4, clad, { top: mat(GRAVEL, WHITE, ROOF) });
    k.box(-hw * 0.2, vb - 4 - hd * 0.8 - 0.1, hw * 0.5, 0.1, B + 10, B + 12, mat(GLASS, [0.5, 0.55, 0.6], WIN | CURTAIN, 1.5, 2, 2), { detail: true, solid: false });
    const pv = fv - P.fc / 2, ps = Math.min(P.fc * 0.32, 11);
    k.pyramid(0, pv, ps, ps, B, B + ps * 1.3, 0, mat(GLASS, [0.92, 0.97, 1], WIN | CURTAIN, 1.4, 1.4, 1.4), { solid: true, foot: true });
    for (const s of [-1, 1]) k.flat(s * (ps + 9), pv, 6, ps * 0.9, B + 0.05, mat(GLASS, [0.25, 0.4, 0.5]), { map: 2 });
    stepW = 2.6;
  }
  const stepsFoot = entranceSteps(k, stepV, stepW, B, mat(GRANITE, [0.85, 0.85, 0.85]));
  inside(k, lm, vb, hw, hd, top, modern, facade, stepV, stepsFoot);
}

/**
 * The outer walls (the doorway in the middle of the front) and the roof slab, from y0 to y1, and
 * the floor inside.
 */
function shell(k: Kit, vb: number, hw: number, hd: number, y0: number, y1: number, m: PartMat, roof: PartMat): void {
  const fv = vb - hd, bv = vb + hd, o: Opt = { foot: true, top: roof, map: 0 };
  wallRun(k, 'u', fv + T / 2, -hw, hw, y0, y1, T, m, [{ a: 0, w: DOOR_W, y0, y1: y0 + DOOR_H }], o);
  wallRun(k, 'u', bv - T / 2, -hw, hw, y0, y1, T, m, [], o);
  for (const s of [-1, 1]) wallRun(k, 'v', s * (hw - T / 2), fv + T, bv - T, y0, y1, T, m, [], o);
}

function inside(k: Kit, lm: Landmark, vb: number, hw: number, hd: number, top: number, modern: boolean, facade: PartMat, stepV: number, stepsFoot: number): void {
  const B = k.B, iu = hw - T, iv0 = vb - hd + T, iv1 = vb + hd - T, ivm = (iv0 + iv1) / 2;
  const Th = museumTheme(modern ? mat(METAL, [0.75, 0.76, 0.78]) : mat(facade.layer, facade.tint), modern);
  // Galleries are one storey; the classical great hall rises to the roof.
  const gh = Math.min(6.5, top - B - 0.6), hu = HALL * iu;
  k.box(0, ivm, iu, (iv1 - iv0) / 2, B - 0.3, B, Th.floor, { map: 0, foot: true });
  const ceil = mat(PLASTER, [1.02, 1, 0.95]), roof = mat(GRAVEL, WHITE, ROOF);
  k.box(0, ivm, iu, (iv1 - iv0) / 2, top - 0.6, top, ceil, { top: roof, map: 0 });
  // Above the wings: solid up to the roof (its underside is their ceiling).
  if (top - 0.6 > B + gh + 0.05) for (const s of [-1, 1]) k.box(s * (hu + iu) / 2, ivm, (iu - hu) / 2, (iv1 - iv0) / 2, B + gh, top - 0.6, ceil, { map: 0 });
  k.room(-iu, iv0, iu, iv1, B - 0.5, top - 0.6);
  // Lining inside the outer walls (their inner faces carry the facade's windows): plaster, or
  // daylight panes behind the modern hall's glass.
  const lin = 0.05, lm_ = modern ? mat(PLASTER, [1.2, 1.35, 1.55]) : Th.wall, D: Opt = { detail: true };
  wallRun(k, 'u', iv0 + lin / 2, -iu, iu, B, top - 0.6, lin, lm_, [{ a: 0, w: DOOR_W, y0: B, y1: B + DOOR_H }], D);
  wallRun(k, 'u', iv1 - lin / 2, -iu, iu, B, top - 0.6, lin, lm_, [], D);
  for (const s of [-1, 1]) wallRun(k, 'v', s * (iu - lin / 2), iv0, iv1, B, top - 0.6, lin, lm_, [], D);
  // The rooms: the great hall through the middle, galleries in the wings.
  const Ds = emptyDesign();
  fillStorey(Ds, {
    outline: [-iu, iv0, iu, iv0, iu, iv1, -iu, iv1], fixed: [], front: [0, 1],
    program: museumProgram(HALL), items: museumItems, y: B, top: B + gh,
    seed: deriveSeed(lm.seed, 'museum-rooms'), wallTh: 0.3,
    entrances: [{ ax: -iu, az: iv0, bx: iu, bz: iv0, doors: [[0.5 - DOOR_W / 4 / iu, 0.5 + DOOR_W / 4 / iu]] }],
  });
  k.inner(() => emitDesign(k, Ds, Th));
  setDesign(lm, Ds);
  // The great hall's light from high up.
  for (let v = iv0 + 4; v < iv1 - 2; v += 7) for (const u of [-hu / 2, hu / 2]) k.light(u, v, top - 1.5);
  const door = k.node(0, iv0 + 1.4, B);
  k.exit(door, [[0, iv0 - 0.7, B], [0, stepV, B]], 0, stepsFoot);
}

