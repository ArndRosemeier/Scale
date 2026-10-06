/**
 * Check that no sewer trunk breaks through the ground: samples every trunk densely and reports
 * where its vault (plus the masonry over it) comes closer than MIN_COVER to the street above.
 *
 *   npx tsx tools/sewersweep.ts <sizes> <seedA-seedB>      e.g. npx tsx tools/sewersweep.ts 0.5,1 1-20
 */
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { sewerTube, SEWER_H, SEWER_HW } from '../src/underground/layout';

/** Soil (m) wanted over the vault's crown at least (the masonry is drawn as a thin shell). */
export const MIN_COVER = 0.5;

export interface SewerBreach { trunk: number; x: number; z: number; crown: number; ground: number }

/** Worst breach per trunk (cover = ground - crown < MIN_COVER), for one city. */
export function sewerBreaches(seed: number, size: number): { breaches: SewerBreach[]; trunks: number } {
  const terrain = new Terrain(makeProfile({ seed, size }));
  const macro = buildMacroPlan(terrain);
  const out: SewerBreach[] = [];
  macro.sewers.forEach((sw, k) => {
    const t = sewerTube(sw.pts, terrain, sw.culvert);
    const P = t.pts;
    let worst: SewerBreach | null = null;
    for (let i = 0; i + 5 < P.length; i += 3) {
      const ax = P[i], ay = P[i + 1], az = P[i + 2], bx = P[i + 3], by = P[i + 4], bz = P[i + 5];
      const L = Math.hypot(bx - ax, bz - az) || 1, nx = -(bz - az) / L, nz = (bx - ax) / L;
      for (let s = 0; s <= L; s += 1) {
        const f = s / L, x = ax + (bx - ax) * f, z = az + (bz - az) * f, crown = ay + (by - ay) * f + SEWER_H;
        for (const o of [-SEWER_HW, 0, SEWER_HW]) {
          const gx = x + nx * o, gz = z + nz * o;
          // Under water (rivers, lakes) the culvert dips under the bed; the water hides nothing else.
          const ground = terrain.height(gx, gz);
          const c = ground - crown;
          if (c < MIN_COVER && (!worst || c < worst.ground - worst.crown)) worst = { trunk: k, x: gx, z: gz, crown, ground };
        }
      }
    }
    if (worst) out.push(worst);
  });
  return { breaches: out, trunks: macro.sewers.length };
}

const isMain = process.argv[1]?.endsWith('sewersweep.ts');
if (isMain) {
  const sizes = (process.argv[2] ?? '0.5').split(',').map(Number);
  const [a, b] = (process.argv[3] ?? '1-5').split('-').map(Number);
  let bad = 0;
  for (const size of sizes) for (let seed = a; seed <= (b ?? a); seed++) {
    const { breaches, trunks } = sewerBreaches(seed, size);
    bad += breaches.length;
    const w = breaches.sort((p, q) => (p.ground - p.crown) - (q.ground - q.crown));
    console.log(`seed ${seed} @${size}: ${trunks} trunks, ${breaches.length} too shallow` + (w.length ? `; worst cover ${(w[0].ground - w[0].crown).toFixed(2)} m at ${w[0].x.toFixed(0)},${w[0].z.toFixed(0)}` : ''));
    for (const q of w.slice(0, 5)) console.log(`   trunk ${q.trunk}: cover ${(q.ground - q.crown).toFixed(2)} m at ${q.x.toFixed(0)},${q.z.toFixed(0)}`);
  }
  console.log(bad ? `${bad} trunks too shallow` : 'all trunks covered');
  process.exit(bad ? 1 : 0);
}
