/**
 * The airport terminal: a long glazed hall that can be walked into through the doors under the
 * kerbside canopy. Inside, along the front the check-in hall, along the apron the gate lounges,
 * and between them a low band of shops, cafés and back rooms (under its own ceiling) with the
 * security lanes through it; the core cuts and furnishes it all (interior/design/storey with
 * fill/terminal).
 */
import { deriveSeed } from '../core/rng';
import type { Landmark } from './landmarks';
import { Kit, mat, wallRun, type PartMat, METAL_ROOF, PLASTER, GRANITE, ROOF } from './landmarkParts';
import { emptyDesign } from '../interior/design/types';
import { emitDesign } from '../interior/design/emit';
import { terminalTheme } from '../interior/design/theme';
import { fillStorey } from '../interior/design/storey';
import { terminalItems, type TerminalPlan } from '../interior/fill/terminal';
import type { Program, Space } from '../interior/fill/split';
import type { WallSeg } from '../interior/fill/area';
import { setDesign } from './designs';

const T = 0.5, DOOR_W = 4, DOOR_H = 3.2;
/** Depths of the check-in hall and the shop band; the low band's ceiling. */
const CHECKIN = 20, BAND = 14, BAND_H = 4.6, LANE_W = 14;

/**
 * The terminal centred at (0, tc), 2 hw wide and 2 hd deep, th high; doors at `doorsU` in the
 * front (-v); the gates' u along the back.
 */
export function terminal(k: Kit, lm: Landmark, tc: number, hw: number, hd: number, th: number, glass: PartMat, roof: PartMat, doorsU: number[], gateU: number[]): void {
  const B = k.B, fv = tc - hd, bv = tc + hd;
  // The shell: glass walls, the roof slab, the floor.
  const o = { foot: true, map: 0 };
  wallRun(k, 'u', fv + T / 2, -hw, hw, B, B + th, T, glass, doorsU.map((a) => ({ a, w: DOOR_W, y0: B, y1: B + DOOR_H })), o);
  wallRun(k, 'u', bv - T / 2, -hw, hw, B, B + th, T, glass, [], o);
  for (const s of [-1, 1]) wallRun(k, 'v', s * (hw - T / 2), fv + T, bv - T, B, B + th, T, glass, [], o);
  const ceil = mat(PLASTER, [1.05, 1.05, 1.05]);
  k.box(0, tc, hw, hd, B + th - 0.8, B + th, ceil, { top: roof, map: 1 });
  k.box(0, tc, hw - T, hd - T, B - 0.3, B, mat(GRANITE, [1.0, 1.0, 0.98]), { map: 0, foot: true });
  const iu = hw - T, iv0 = fv + T, iv1 = bv - T;
  k.room(-iu, iv0, iu, iv1, B - 0.5, B + th - 0.8);
  // The bands: check-in, shops and security, gates.
  const b0 = iv0 + CHECKIN, b1 = b0 + BAND;
  const rect = (u0: number, v0: number, u1: number, v1: number) => [u0, v0, u1, v0, u1, v1, u0, v1];
  const laneU = [-1, 1].map((s) => s * Math.min(iu * 0.35, 60));
  const fixed: Space[] = [
    { type: 'checkin', poly: rect(-iu, iv0, iu, b0), hub: true, open: true },
    { type: 'gates', poly: rect(-iu, b1, iu, iv1), hub: true, open: true },
    ...laneU.map((u): Space => ({ type: 'security', poly: rect(u - LANE_W / 2, b0, u + LANE_W / 2, b1), hub: true, open: true })),
  ];
  const program: Program = {
    reserve: [],
    rooms: [
      { type: 'shop', len: [9, 13] }, { type: 'cafe', len: [10, 15] }, { type: 'shop', len: [8, 12] },
      { type: 'storage', len: [6, 8] }, { type: 'cafe', len: [10, 14] }, { type: 'shop', len: [9, 13] }, { type: 'office', len: [6, 9] },
    ],
    corridor: 0, leaf: ['storage', 'office'], doorW: 2.4, doorsMid: true,
  };
  const plan: TerminalPlan = { deskV: b0 - 5, gateU, glassV: iv1, laneU, laneV: (b0 + b1) / 2 };
  const entrances: WallSeg[] = [{ ax: -iu, az: iv0, bx: iu, bz: iv0, doors: doorsU.map((a) => [(a - DOOR_W / 2 + iu) / (2 * iu), (a + DOOR_W / 2 + iu) / (2 * iu)]) }];
  const D = emptyDesign();
  fillStorey(D, {
    outline: rect(-iu, iv0, iu, iv1), fixed, front: [0, 1], program, items: terminalItems(plan),
    y: B, top: B + BAND_H, seed: deriveSeed(lm.seed, 'terminal-rooms'), wallTh: 0.3, cell: 0.5,
    entrances, furnishFixed: true,
  });
  // The open halls go up to the roof: the low band's walls stop at its ceiling.
  for (const r of D.rooms) if (r.fn === 'checkin' || r.fn === 'gates') r.h = th - 0.8;
  D.lights.length = 0;
  const Th = terminalTheme();
  k.inner(() => emitDesign(k, D, Th));
  setDesign(lm, D);
  // The shop band's ceiling (with the security lanes under it), lights high in the halls.
  k.box(0, (b0 + b1) / 2, iu, BAND / 2, B + BAND_H, B + BAND_H + 0.35, ceil, { map: 0, top: mat(METAL_ROOF, [0.85, 0.86, 0.88], ROOF) });
  for (let u = -iu + 10; u < iu - 5; u += 20) {
    for (const v of [(iv0 + b0) / 2, (b1 + iv1) / 2]) k.light(u, v, B + th - 2);
    k.light(u, (b0 + b1) / 2, B + BAND_H - 0.3);
  }
  // Ways in: through each door to the kerb in front.
  for (const a of doorsU) {
    const n = k.node(a, iv0 + 1.5, B);
    k.exit(n, [[a, fv - 0.7, B], [a, fv - 5, B]], a, fv - 5);
  }
}
