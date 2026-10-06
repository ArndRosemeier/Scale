/**
 * Plan the deep realm (the slime civilisation) for a range of cities headlessly and report what came
 * out: roads, waypoint edges a walker cannot take, and the Front's trench line.
 *
 *   npx tsx tools/deepsweep.ts <sizes> <seedA-seedB>      e.g. npx tsx tools/deepsweep.ts 0.4,0.6,1 1-20
 */
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { planRooms } from '../src/underground/rooms';
import { metroTube, sewerTube, stationHalls } from '../src/underground/layout';
import { tubeAt, boxAt } from '../src/underground/Volumes';
import { planDeep, walkable, type DeepPlan } from '../src/underground/deep/plan';
import { DeepField } from '../src/underground/deep/field';

/** Plan one city's realm the way the game does (same blocked test). */
export function deepFor(seed: number, size: number): { plan: DeepPlan | null; colonies: number } {
  const terrain = new Terrain(makeProfile({ seed, size }));
  const macro = buildMacroPlan(terrain);
  const tubes = [...macro.metroLines.map(metroTube), ...macro.sewers.map((s) => sewerTube(s.pts, terrain, s.culvert))];
  const halls = stationHalls(macro);
  const rooms = planRooms(macro, terrain, tubes, halls);
  const allT = [...tubes, ...rooms.colonies.map((c) => c.crawl)];
  const allB = [...halls, ...rooms.rooms.flatMap((r) => r.boxes), ...rooms.colonies.map((c) => c.chamber)];
  const occupied = (x: number, y: number, z: number) => allT.some((t) => { const h = tubeAt(t, x, y, z, 1.0); return !!h && y > h.floor - 2 && y < h.floor + t.height + 1; }) || allB.some((b) => !!boxAt(b, x, y, z, 1.0) && y > b.y0 - 2 && y < b.y1 + 1);
  const blocked = (x: number, y: number, z: number) => occupied(x, y, z) || halls.some((h) => Math.hypot(h.cx - x, h.cz - z) < h.hu + 80 && y > h.y0 - 4);
  return { plan: planDeep({ seed: macro.seed, colonies: rooms.colonies, ground: (x, z) => terrain.height(x, z), blocked }), colonies: rooms.colonies.length };
}

const isMain = process.argv[1]?.endsWith('deepsweep.ts');
if (isMain) {
  const sizes = (process.argv[2] ?? '0.6').split(',').map(Number);
  const [a, b] = (process.argv[3] ?? '1-5').split('-').map(Number);
  let bad = 0;
  for (const size of sizes) for (let seed = a; seed <= (b ?? a); seed++) {
    const t0 = performance.now();
    const { plan, colonies } = deepFor(seed, size);
    const ms = performance.now() - t0;
    if (!plan) { console.log(`seed ${seed} @${size}: no realm (${colonies} colonies)`); continue; }
    const F = new DeepField(plan.prims, plan.seed);
    const notWalk = plan.edges.filter(([p, q]) => !walkable(F, plan.nodes[p], plan.nodes[q])).map(([p, q]) => `${plan.nodes[p].name}→${plan.nodes[q].name}`);
    if (notWalk.length) bad++;
    const T = (plan as { trench?: DeepPlan["trench"] }).trench;
    console.log(`seed ${seed} @${size}: ${plan.roads.length}/${colonies} roads, ${plan.nodes.length} nodes, trench ${T ? `${T.segs.length} bays, ${T.craters.length} craters` : 'none'}${notWalk.length ? `, NOT WALKABLE: ${notWalk.slice(0, 6).join(', ')}` : ''} (${ms.toFixed(0)} ms)`);
  }
  if (bad) { console.log(`${bad} realm(s) with edges a walker cannot take`); process.exitCode = 1; }
}
