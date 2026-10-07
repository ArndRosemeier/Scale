// Count the cemeteries (and their graves) of whole cities.
//   npx tsx tools/cemeteries.ts 0.35,1 40-45     sizes, seed range
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { planCell, PropType } from '../src/plan/cell';
import { shapeArea } from '../src/core/clip';
const args = process.argv.slice(2);
const sizes = args[0].split(',').map(Number);
const [s0, s1] = args[1].split('-').map(Number);
for (const size of sizes) for (let seed = s0; seed <= s1; seed++) {
  const terrain = new Terrain(makeProfile({ seed, size }));
  const macro = buildMacroPlan(terrain);
  const out: string[] = [];
  for (const cell of macro.cells) {
    const p = planCell(macro, cell, terrain);
    for (const c of p.cemeteries) {
      const n = (t: PropType) => { let k = 0; for (let i = 0; i < p.props.length; i += 6) if (p.props[i] === t) k++; return k; };
      out.push(`${cell.district} ${Math.round(shapeArea(c))} m² at ${Math.round(c.outer[0])},${Math.round(c.outer[1])}: ${n(PropType.Gravestone) + n(PropType.Grave)} graves, ${n(PropType.Tomb)} tombs, ${n(PropType.Yew)} yews, ${n(PropType.CemWall)} wall`);
    }
  }
  console.log(`seed ${seed} size ${size}: ${out.length} cemeteries in ${macro.cells.length} cells`);
  for (const l of out) console.log('  ' + l);
}
