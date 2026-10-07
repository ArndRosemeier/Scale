/**
 * Self test of the arcades, run by tools/selftest.ts (or on its own: `npx tsx tools/arcadeTest.ts`):
 * cities have arcades on their shopping streets, each hall is filled with video game cabinets that
 * stand inside the storey, apart from each other, with room in front to stand and play, and every
 * one can be walked to from the street door (nothing walled off); every
 * game runs for a long while with random buttons (and in attract mode) without failing.
 */
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { planCell } from '../src/plan/cell';
import { buildingLayout } from '../src/build/buildingLayout';
import { planFloor, planLift, planStair, coreFits, isArcade, CABINET, type Furn, type FloorPlan } from '../src/interior/InteriorGen';
import { wallCollisionSegments } from '../src/interior/InteriorBuilder';
import { pointInPoly, distSqPointSeg, distPointPolyEdge, type Poly } from '../src/core/geom2';
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

/**
 * Walk the storey from the street door on a 0.25 m grid (a body of 0.3 m radius, kept off walls and
 * furniture): which of the points can be reached?
 */
function reachable(fp: FloorPlan, poly: Poly, door: { x: number; z: number }, pts: [number, number][]): boolean[] {
  const G = 0.25, R = 0.3;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < poly.length; i += 2) { x0 = Math.min(x0, poly[i]); z0 = Math.min(z0, poly[i + 1]); x1 = Math.max(x1, poly[i]); z1 = Math.max(z1, poly[i + 1]); }
  const nx = Math.ceil((x1 - x0) / G) + 1, nz = Math.ceil((z1 - z0) / G) + 1;
  const walls = wallCollisionSegments(fp);
  const solid = fp.furniture.filter((f) => f.kind !== 'rug' && f.kind !== 'painting' && f.h >= 0.3);
  const free = (x: number, z: number) => {
    if (!pointInPoly(poly, x, z) || distPointPolyEdge(poly, x, z) < R) return false;
    for (let i = 0; i < walls.length; i += 4) if (distSqPointSeg(x, z, walls[i], walls[i + 1], walls[i + 2], walls[i + 3]) < R * R) return false;
    return !solid.some((f) => inFoot(f, x, z, R - 0.05));
  };
  const seen = new Uint8Array(nx * nz);
  const queue: number[] = [];
  // Start just inside the door: the free cells within 1.2 m of it.
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
    const x = x0 + i * G, z = z0 + k * G;
    if (Math.hypot(x - door.x, z - door.z) < 1.2 && free(x, z)) { seen[i * nz + k] = 1; queue.push(i * nz + k); }
  }
  while (queue.length) {
    const c = queue.pop()!, i = Math.floor(c / nz), k = c % nz;
    for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, b = k + dk;
      if (a < 0 || b < 0 || a >= nx || b >= nz || seen[a * nz + b]) continue;
      seen[a * nz + b] = 2;
      if (free(x0 + a * G, z0 + b * G)) { seen[a * nz + b] = 1; queue.push(a * nz + b); }
    }
  }
  return pts.map(([x, z]) => {
    const i = Math.round((x - x0) / G), k = Math.round((z - z0) / G);
    for (let a = i - 1; a <= i + 1; a++) for (let b = k - 1; b <= k + 1; b++) if (a >= 0 && b >= 0 && a < nx && b < nz && seen[a * nz + b] === 1) return true;
    return false;
  });
}

export function arcadeChecks(check: Check): void {
  const t0 = performance.now();
  let halls = 0, cabs = 0, outside = 0, overlap = 0, blocked = 0, few = 0, cut = 0, minCabs = Infinity;
  const games = new Set<number>(), perCity: string[] = [];
  for (const [seed, size] of [[42, 0.35], [7, 0.35], [12, 0.6]]) {
  const terrain = new Terrain(makeProfile({ seed, size }));
  const macro = buildMacroPlan(terrain);
  const before = halls;
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
      if (list.length < 7) few++;
      minCabs = Math.min(minCabs, list.length);
      const stand = list.map((f): [number, number] => [f.x + Math.sin(f.yaw) * (CABINET.d / 2 + 0.8), f.z + Math.cos(f.yaw) * (CABINET.d / 2 + 0.8)]);
      cut += reachable(fp, poly, L.door, stand).filter((ok) => !ok).length;
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
  perCity.push(`seed ${seed}@${size}: ${halls - before}`);
  }
  check(halls >= 3, `arcades in the cities (${perCity.join(', ')})`);
  check(few === 0, `arcades: every hall has at least 7 cabinets (${cabs} in ${halls} halls, fewest ${minCabs}, ${few} with fewer)`);
  check(cut === 0, `arcades: every cabinet can be walked to from the street door (${cut} cut off)`);
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
