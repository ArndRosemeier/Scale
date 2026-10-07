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
import { planDeeps, walkable, type DeepPlan } from '../src/underground/deep/plan';
import { DeepField } from '../src/underground/deep/field';

/** Plan one city's realms the way the game does (same blocked test); plan is the first. */
export function deepFor(seed: number, size: number): { plan: DeepPlan | null; plans: DeepPlan[]; colonies: number; centre: { x: number; z: number }[] } {
  const terrain = new Terrain(makeProfile({ seed, size }));
  const macro = buildMacroPlan(terrain);
  const tubes = [...macro.metroLines.map(metroTube), ...macro.sewers.map((s) => sewerTube(s.pts, terrain, s.culvert))];
  const halls = stationHalls(macro);
  const rooms = planRooms(macro, terrain, tubes, halls);
  const allT = [...tubes, ...rooms.colonies.map((c) => c.crawl)];
  const allB = [...halls, ...rooms.rooms.flatMap((r) => r.boxes), ...rooms.colonies.map((c) => c.chamber)];
  const occupied = (x: number, y: number, z: number) => allT.some((t) => { const h = tubeAt(t, x, y, z, 1.0); return !!h && y > h.floor - 2 && y < h.floor + t.height + 1; }) || allB.some((b) => !!boxAt(b, x, y, z, 1.0) && y > b.y0 - 2 && y < b.y1 + 1);
  const blocked = (x: number, y: number, z: number) => occupied(x, y, z) || halls.some((h) => Math.hypot(h.cx - x, h.cz - z) < h.hu + 80 && y > h.y0 - 4);
  const plans = planDeeps({ seed: macro.seed, colonies: rooms.colonies, ground: (x, z) => terrain.height(x, z), blocked });
  return { plan: plans[0] ?? null, plans, colonies: rooms.colonies.length, centre: rooms.colonies.map((c) => ({ x: c.chamber.cx, z: c.chamber.cz })) };
}

const isMain = process.argv[1]?.endsWith('deepsweep.ts');
if (isMain) {
  const sizes = (process.argv[2] ?? '0.6').split(',').map(Number);
  const [a, b] = (process.argv[3] ?? '1-5').split('-').map(Number);
  let bad = 0;
  for (const size of sizes) for (let seed = a; seed <= (b ?? a); seed++) {
    const t0 = performance.now();
    const { plans, colonies, centre } = deepFor(seed, size);
    const ms = performance.now() - t0;
    const far = Math.max(0, ...centre.map((c) => Math.hypot(c.x, c.z)));
    if (plans.length < colonies) bad++;
    console.log(`seed ${seed} @${size}: ${plans.length}/${colonies} colonies with a realm, farthest ${far.toFixed(0)} m from the centre (${ms.toFixed(0)} ms)${plans.length < colonies ? '  MISSING' : ''}`);
    const fields = plans.map((p) => new DeepField(p.prims, p.seed));
    plans.forEach((plan, i) => {
      const F = fields[i];
      const notWalk = plan.edges.filter(([p, q]) => !walkable(F, plan.nodes[p], plan.nodes[q])).map(([p, q]) => `${plan.nodes[p].name}→${plan.nodes[q].name}`);
      // Realms must not run into each other: no node of one in another's air.
      const clash = fields.some((o, j) => j !== i && plan.nodes.some((n) => o.near(n.x, n.y, n.z) && o.air(n.x, n.y + 0.5, n.z)));
      if (notWalk.length || clash) bad++;
      const T = plan.trench;
      console.log(`   colony ${plan.hub}: ${plan.nodes.length} nodes, ${T.style} (${T.segs.length} bays, ${T.craters.length} craters)${clash ? ', OVERLAPS ANOTHER REALM' : ''}${notWalk.length ? `, NOT WALKABLE: ${notWalk.slice(0, 6).join(', ')}` : ''}`);
    });
  }
  if (bad) { console.log(`${bad} problem(s): missing realms, overlaps or edges a walker cannot take`); process.exitCode = 1; }
}
