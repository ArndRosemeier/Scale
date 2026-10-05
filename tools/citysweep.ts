// Generate many cities headlessly (the city worker's init plus a sample of cells) and report crashes.
//   npx tsx tools/citysweep.ts 0.5,0.75,1 1-100     sizes, seed range
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { planCell } from '../src/plan/cell';
import { LandUse } from '../src/world/landuse';
import { RuralPlan } from '../src/world/rural';
import { riverChunks, seaPolygon } from '../src/plan/water';
import { Population } from '../src/sim/Population';
const args = process.argv.slice(2);
const sizes = args[0].split(',').map(Number);
const [s0, s1] = args[1].split('-').map(Number);
for (const size of sizes) for (let seed = s0; seed <= s1; seed++) {
  const t0 = Date.now();
  let stage = 'terrain';
  try {
    const terrain = new Terrain(makeProfile({ seed, size }));
    stage = 'macro'; const macro = buildMacroPlan(terrain);
    stage = 'rural'; const land = new LandUse(terrain); land.settle = new RuralPlan(terrain, land, macro);
    stage = 'water'; riverChunks(terrain, 0); seaPolygon(terrain, 0, 40, terrain.worldExtent * 1.1);
    terrain.lakes.forEach((_, k) => terrain.lakePolygon(k));
    stage = 'cells';
    const step = Math.max(1, Math.floor(macro.cells.length / 12));
    for (let i = 0; i < macro.cells.length; i += step) planCell(macro, macro.cells[i], terrain);
    stage = 'population'; new Population(macro, seed);
    console.log(`ok seed ${seed} size ${size} ${macro.cells.length} cells ${Date.now() - t0} ms`);
  } catch (e) {
    console.log(`FAIL seed ${seed} size ${size} at ${stage}: ${(e as Error).stack?.split('\n').slice(0, 3).join(' | ')}`);
  }
}
