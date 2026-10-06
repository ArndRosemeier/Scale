// Resolve every power core of many cities headlessly and report cores placed inside something solid
// (fountains, statues, kiosks, trees, metro stairwells, rooftop equipment).
//   npx tsx tools/coresweep.ts 0.5,1 1-20     sizes, seed range (exit 1 on any bad core)
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { planCell } from '../src/plan/cell';
import { planCoreSites, needsPlan, resolveCoreSite } from '../src/game/abilities/cores';
import { propR } from '../src/plan/terrace';
import { buildingLayout } from '../src/build/buildingLayout';
import { roofEquipment } from '../src/build/buildingShell';
import { pointInPoly } from '../src/core/geom2';
const args = process.argv.slice(2);
const sizes = args[0].split(',').map(Number);
const [s0, s1] = args[1].split('-').map(Number);
const NAMES: Record<number, string> = { 0: 'tree', 9: 'fountain', 10: 'statue', 12: 'kiosk', 16: 'playground', 17: 'metro entrance' };
let bad = 0, total = 0;
for (const size of sizes) for (let seed = s0; seed <= s1; seed++) {
  const terrain = new Terrain(makeProfile({ seed, size }));
  const macro = buildMacroPlan(terrain);
  const sites = planCoreSites(macro, terrain);
  for (const s of sites) {
    const plan = needsPlan(s) ? planCell(macro, macro.cells[s.cell], terrain) : null;
    const spot = resolveCoreSite(s, plan, terrain);
    if (!spot || !plan) continue;
    total++;
    const why: string[] = [];
    if (spot.surface === 'ground') {
      const P = plan.props;
      for (let i = 0; i < P.length; i += 6) {
        if (P[i] === 18) continue;
        const d = Math.hypot(P[i + 1] - spot.x, P[i + 2] - spot.z);
        if (d < propR(P[i]) * Math.max(1, P[i + 4])) why.push(`${NAMES[P[i]] ?? 'prop ' + P[i]} at ${d.toFixed(1)} m`);
      }
      for (let i = 0; i < plan.entrances.length; i += 6) if (Math.hypot(plan.entrances[i] - spot.x, plan.entrances[i + 1] - spot.z) < 3.2) why.push('metro stairwell');
      if (plan.buildings.some((b) => pointInPoly(b.poly, spot.x, spot.z))) why.push('building');
    } else if (spot.surface === 'roof') {
      for (const b of plan.buildings) {
        const L = buildingLayout(b, terrain, 0);
        if (Math.abs(L.base + L.height - spot.y) > 0.01 || !pointInPoly(L.tiers[L.tiers.length - 1].poly, spot.x, spot.z)) continue;
        for (const it of roofEquipment(b, L.tiers[L.tiers.length - 1].poly, L.base + L.height)) {
          const dx = spot.x - it.x, dz = spot.z - it.z, c = Math.cos(it.yaw), sn = Math.sin(it.yaw);
          const inside = it.kind === 'tank' ? Math.hypot(dx, dz) < it.hx : Math.abs(dx * c - dz * sn) < it.hx && Math.abs(dx * sn + dz * c) < it.hz;
          if (inside) why.push(`roof ${it.kind}`);
        }
      }
    }
    if (why.length) { bad++; console.log(`BAD seed ${seed} size ${size} core ${s.id} (${s.kind}/${spot.surface}) at ${spot.x.toFixed(1)},${spot.z.toFixed(1)}: ${why.join(', ')}`); }
  }
  console.log(`seed ${seed} size ${size}: ${sites.length} cores`);
}
console.log(`${bad} of ${total} resolved cores inside something solid`);
process.exit(bad ? 1 : 0);
