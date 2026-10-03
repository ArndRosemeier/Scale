/**
 * Zoomed debug map of cell plans:
 * `npx tsx tools/celldump.ts <seed> <size> <out.png> <width_m> [cx cz]`
 * (cx,cz default: the main centre)
 */
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { planCell, PropType } from '../src/plan/cell';
import { Raster } from './raster';

const STYLE_COLOR: Record<string, number> = {
  rowhouse: 0x9c5b45, tenement: 0xa0503c, haussmann: 0xd8cdb4, timber: 0xc9b38a, oldstone: 0xc8a982, artdeco: 0xb59a6a,
  glass: 0x7fa6c4, modern: 0xe0e0d8, brutalist: 0x9a9a96, house: 0xd9a066, warehouse: 0x80706a, church: 0xf0e6c8,
  shop: 0xd47f5a, garage: 0x8a8a8a, mediterranean: 0xe8c99a,
};

const seed = Number(process.argv[2] ?? 1);
const size = Number(process.argv[3] ?? 0.35);
const out = process.argv[4] ?? 'cells.png';
const span = Number(process.argv[5] ?? 800);
const profile = makeProfile({ seed, size });
const terrain = new Terrain(profile);
const macro = buildMacroPlan(terrain);
const pickD = (d: string) => macro.cells.filter((c) => c.district === d).sort((a, b) => Math.hypot(...a.centroid) - Math.hypot(...b.centroid))[0]?.centroid;
const arg6 = process.argv[6];
const at: [number, number] = arg6 === 'core' ? macro.core : arg6 && isNaN(Number(arg6)) ? (pickD(arg6) ?? [0, 0]) : arg6 !== undefined ? [Number(arg6), Number(process.argv[7])] : [macro.centres[0].x, macro.centres[0].z];
const cx = at[0], cz = at[1];
const ras = new Raster(1400, 1400, 0x3a4a30);
ras.view(cx, cz, span);
ras.shade((x, z) => (terrain.waterLevel(x, z) > terrain.height(x, z) ? 0x1d4f7a : 0x4a5e3a));
let t = 0, nb = 0, nl = 0, np = 0, nc = 0;
for (const c of macro.cells) {
  if (Math.abs(c.centroid[0] - cx) > span / 2 + c.radius || Math.abs(c.centroid[1] - cz) > span / 2 + c.radius) continue;
  const t0 = performance.now();
  const cp = planCell(macro, c, terrain);
  t += performance.now() - t0;
  nc++;
  for (const s of cp.parks) ras.fill([s.outer, ...s.holes], 0x4f7f3a);
  for (const s of cp.yards) ras.fill([s.outer, ...s.holes], 0x5f7a45);
  for (const s of cp.blocks) ras.fill([s.outer, ...s.holes], 0x6d6a60, 0.35);
  for (const s of cp.plazas) ras.fill([s.outer, ...s.holes], 0xb8ab90);
  for (const s of cp.promenade) ras.fill([s.outer, ...s.holes], 0xa89c88);
  for (const s of cp.sidewalks) ras.fill([s.outer, ...s.holes], 0xa8a8a0);
  for (const s of cp.carriageway) ras.fill([s.outer, ...s.holes], 0x3a3a3e);
  for (const l of cp.lots) ras.polygon(l.poly, 0x77736a);
  for (const b of cp.buildings) {
    ras.fill([b.poly], STYLE_COLOR[b.style] ?? 0xff00ff);
    ras.polygon(b.poly, 0x202020);
    nb++;
  }
  nl += cp.lots.length;
  for (let i = 0; i < cp.props.length; i += 6) {
    const ty = cp.props[i];
    const col = ty === PropType.Tree ? 0x2f6f2a : ty === PropType.Lamp ? 0xffee88 : ty === PropType.ParkedCar ? 0xd03030 : ty === PropType.TrafficLight ? 0x30ff30 : ty === PropType.Manhole ? 0x222222 : 0xffffff;
    ras.dot(cp.props[i + 1], cp.props[i + 2], ty === PropType.Tree ? 3 : 1, col);
    np++;
  }
  ras.polygon(c.poly, 0xff4040);
}
ras.save(out);
console.log(`${nc} cells in ${t.toFixed(0)} ms (${(t / Math.max(1, nc)).toFixed(1)} ms/cell), ${nl} lots, ${nb} buildings, ${np} props → ${out}`);
