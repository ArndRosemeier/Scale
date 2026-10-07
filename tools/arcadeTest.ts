/**
 * Self test of the arcades, run by tools/selftest.ts (or on its own: `npx tsx tools/arcadeTest.ts`):
 * the city has arcades on its shopping streets, each hall is filled with video game cabinets that
 * stand inside the storey, apart from each other, with room in front to stand and play; every
 * game runs for a long while with random buttons (and in attract mode) without failing.
 */
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { planCell } from '../src/plan/cell';
import { buildingLayout } from '../src/build/buildingLayout';
import { planFloor, planLift, planStair, coreFits, isArcade, CABINET, type Furn } from '../src/interior/InteriorGen';
import { pointInPoly } from '../src/core/geom2';
import { GAMES, type Btn, type Pad } from '../src/arcade/games';
import { Rng } from '../src/core/rng';

type Check = (ok: boolean, msg: string) => void;

/** Corners of a piece's footprint, grown by m. */
function corners(f: Furn, m = 0): [number, number][] {
  const c = Math.cos(f.yaw), s = Math.sin(f.yaw), w = f.w / 2 + m, d = f.d / 2 + m;
  return [[-w, -d], [w, -d], [w, d], [-w, d]].map(([lx, lz]) => [f.x + lx * c + lz * s, f.z - lx * s + lz * c]);
}
function inFoot(f: Furn, x: number, z: number, m = 0): boolean {
  const c = Math.cos(f.yaw), s = Math.sin(f.yaw), dx = x - f.x, dz = z - f.z;
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  return Math.abs(lx) <= f.w / 2 + m && Math.abs(lz) <= f.d / 2 + m;
}

export function arcadeChecks(check: Check): void {
  const t0 = performance.now();
  const seed = 42, size = 0.35;
  const terrain = new Terrain(makeProfile({ seed, size }));
  const macro = buildMacroPlan(terrain);
  let halls = 0, cabs = 0, outside = 0, overlap = 0, blocked = 0, few = 0;
  const games = new Set<number>();
  for (const c of macro.cells) {
    const p = planCell(macro, c, terrain);
    for (const b of p.buildings) {
      if (!isArcade(b)) continue;
      halls++;
      const L = buildingLayout(b, terrain, 0);
      const fl = L.floors[0], poly = L.tiers[fl.tier].poly;
      const lift = planLift(b, poly);
      const stair = planStair(b, poly, lift, Math.max(...L.floors.map((q) => q.y1 - q.y0)));
      const next = L.floors.find((q) => q.f === 1);
      const up = !!stair && !!next && coreFits(stair, poly) && coreFits(stair, L.tiers[next.tier].poly);
      const fp = planFloor(b, poly, 0, fl.y0, fl.y1 - fl.y0, 0, lift, stair, up, false, L.door);
      const list = fp.furniture.filter((f) => f.kind === 'arcade');
      cabs += list.length;
      if (list.length < 4) few++;
      for (const f of list) {
        games.add(f.game ?? -1);
        if (corners(f).some(([x, z]) => !pointInPoly(poly, x, z))) outside++;
        for (const g of list) if (g !== f && corners(g).some(([x, z]) => inFoot(f, x, z, -0.02))) overlap++;
        // Where the player stands: 0.8 m in front of the deck, inside, clear of other cabinets.
        const sx = f.x + Math.sin(f.yaw) * (CABINET.d / 2 + 0.8), sz = f.z + Math.cos(f.yaw) * (CABINET.d / 2 + 0.8);
        if (!pointInPoly(poly, sx, sz) || list.some((g) => g !== f && inFoot(g, sx, sz, 0.35))) blocked++;
      }
    }
  }
  check(halls >= 1, `seed ${seed} size ${size}: arcades in the city (${halls})`);
  check(few === 0, `arcades: every hall has at least 4 cabinets (${cabs} in ${halls} halls, ${few} with fewer)`);
  check(outside === 0 && overlap === 0, `arcades: cabinets inside the storey (${outside} outside) and apart (${overlap} overlapping)`);
  check(blocked === 0, `arcades: room to stand in front of every cabinet (${blocked} blocked)`);
  check(games.size === GAMES.length, `arcades: all ${GAMES.length} games on cabinets (${games.size})`);

  // Every game, a long session with random buttons, then attract mode.
  const r = new Rng(7);
  const btns: Btn[] = ['left', 'right', 'up', 'down', 'fire'];
  for (const G of GAMES) {
    const g = new G();
    let err = '', resets = 0, maxScore = 0;
    try {
      g.reset();
      const held = new Set<Btn>();
      for (let i = 0; i < 6000; i++) {
        const hit = new Set<Btn>();
        if (r.chance(0.2)) { const b = r.pick(btns); if (held.has(b)) held.delete(b); else { held.add(b); hit.add(b); } }
        const pad: Pad = { left: held.has('left'), right: held.has('right'), up: held.has('up'), down: held.has('down'), fire: held.has('fire'), hit };
        g.step(1 / 60, pad);
        if (!Number.isFinite(g.score) || g.score < 0) throw new Error(`score ${g.score}`);
        maxScore = Math.max(maxScore, g.score);
        if (g.over) { g.reset(); resets++; }
      }
      for (let i = 0; i < 3000; i++) g.idle(1 / 30);
    } catch (e) { err = String(e); }
    check(!err, `arcade game ${g.title}: 100 s of random play and attract mode without errors${err ? ` (${err})` : ''} (best ${maxScore}, ${resets} games over)`);
  }
  console.log(`arcades: ${halls} halls, ${cabs} cabinets in ${Math.round(performance.now() - t0)} ms`);
}

if (process.argv[1]?.endsWith('arcadeTest.ts')) {
  let fails = 0;
  arcadeChecks((ok, msg) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); });
  process.exit(fails ? 1 : 0);
}
