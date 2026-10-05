/**
 * Headless countryside map: lakes, villages, farmsteads, roads and buildings.
 * `npx tsx tools/ruraldump.ts <seed> <size> [out.png] [widthMeters] [cx] [cz]`
 */
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { LandUse, newLandSample } from '../src/world/landuse';
import { RuralPlan, RoadKind, SettleKind, BOX_STRIDE } from '../src/world/rural';
import { Raster } from './raster';

const seed = Number(process.argv[2] ?? 1);
const size = Number(process.argv[3] ?? 0.35);
const out = process.argv[4] ?? `rural_${seed}_${size}.png`;
const terrain = new Terrain(makeProfile({ seed, size }));
const macro = buildMacroPlan(terrain);
const land = new LandUse(terrain);
const t0 = performance.now();
const plan = new RuralPlan(terrain, land, macro);
if (!process.env.NOSETTLE) land.settle = plan;
console.log(`rural plan ${(performance.now() - t0).toFixed(0)} ms: ${plan.settlements.length} settlements, ${plan.roads.length} roads, ${terrain.lakes.length} lakes`);
const W = 1400;
const ras = new Raster(W, W);
const span = Number(process.argv[5] ?? terrain.worldExtent * 2);
ras.view(Number(process.argv[6] ?? 0), Number(process.argv[7] ?? 0), span);
const ls = newLandSample();
ras.shade((x, z) => {
  const wl = terrain.waterLevel(x, z);
  const h = terrain.height(x, z);
  if ((wl > -Infinity && wl > h) || terrain.isWater(x, z, 0)) return 0x2a6aa0;
  land.sample(x, z, ls);
  const e = span / W;
  const dx = terrain.height(x + e, z) - h, dz = terrain.height(x, z + e) - h;
  const sh = Math.max(0.4, Math.min(1.2, 0.85 + (dx - dz) / e * 0.6));
  if (ls.rural < 0.5) return ((150 * sh) << 16) | ((140 * sh) << 8) | (130 * sh);
  const r = (ls.forest * 40 + ls.field * 190 + ls.meadow * 110 + ls.bank * 60) * sh, g = (ls.forest * 80 + ls.field * 170 + ls.meadow * 150 + ls.bank * 140) * sh, b = (ls.forest * 40 + ls.field * 90 + ls.meadow * 80 + ls.bank * 70) * sh;
  return ((Math.min(255, r) | 0) << 16) | ((Math.min(255, g) | 0) << 8) | (Math.min(255, b) | 0);
});
for (const e of macro.edges) ras.polyline(e.pts, 0xdddddd, 1.5);
const px = W / span;
for (const R of plan.roads) ras.polyline(R.pts, R.kind === RoadKind.Main ? 0x303030 : R.kind === RoadKind.Lane ? 0x606060 : 0x8a6a40, Math.max(1, R.hw * 2 * px));
for (const s of plan.settlements) {
  const L = plan.layout(s.id);
  for (const p of L.paved) ras.fill([p.poly], 0xb0a090, 1);
  for (const b of L.buildings) ras.fill([b.poly], b.style === 'church' ? 0xffd040 : b.style === 'warehouse' ? 0xa04030 : 0xe06040, 1);
  if (s.kind !== SettleKind.Farm && span > 6000) ras.dot(s.x, s.z, s.kind + 2, 0xffffff);
  void BOX_STRIDE;
}
ras.save(out);
console.log('wrote', out);
