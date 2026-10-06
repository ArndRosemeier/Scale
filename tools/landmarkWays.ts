/**
 * Checks a landmark's walkways (plan/landmarkParts LmInterior nav, spots, exits: what
 * sim/LandmarkCrowds walks people along): every leg is clear of the solids at body height
 * (a little to either side too) with a floor under it at the expected height, and every node is
 * reachable from the door. Used by the self-test and by `npx tsx tools/landmarkWays.ts`.
 */
import type { LmInterior } from '../src/plan/landmarkParts';
import { worldToSite, type Landmark } from '../src/plan/landmarks';
import type { LandmarkSolids } from '../src/world/LandmarkSolids';
import type { Terrain } from '../src/world/terrain';

export interface WaysReport { legs: number; spots: number; bad: string[] }

/** Body heights checked above the floor, and the half width of a person. */
const BODY = [0.35, 1.0, 1.6], HALF = 0.18;

export function auditWays(lm: Landmark, ins: LmInterior, S: LandmarkSolids, terrain: Terrain): WaysReport {
  const bad: string[] = [];
  const N = ins.nav, at = (i: number): [number, number, number] => [N[i * 3], N[i * 3 + 1], N[i * 3 + 2]];
  const loc = (x: number, z: number) => { const [u, v] = worldToSite(lm, x, z); return `(${u.toFixed(1)}, ${v.toFixed(1)})`; };
  /** A straight leg from a to b: clear, and (floor: true) standing on a floor at about the lerped height. */
  const leg = (a: number[], b: number[], what: string, floor = true) => {
    const L = Math.hypot(b[0] - a[0], b[2] - a[2]), n = Math.max(1, Math.ceil(L / 0.15));
    const px = -(b[2] - a[2]) / (L || 1), pz = (b[0] - a[0]) / (L || 1);
    const steep = Math.abs(b[1] - a[1]) > 0.2;
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, z = a[2] + (b[2] - a[2]) * t;
      for (const h of BODY) for (const o of [0, -HALF, HALF]) {
        if (S.hit(x + px * o, y + h, z + pz * o)) { bad.push(`${what}: blocked at ${loc(x, z)} ${h} m up`); return; }
      }
      if (floor) {
        // (A little either way along the leg: a point exactly on the seam of two floor slabs is on neither.)
        const ex = (b[0] - a[0]) / (L || 1) * 0.03, ez = (b[2] - a[2]) / (L || 1) * 0.03;
        const f = Math.max(terrain.height(x, z), S.topAt(x, z, y + 0.35, 0), S.topAt(x + ex, z + ez, y + 0.35, 0), S.topAt(x - ex, z - ez, y + 0.35, 0));
        if (Math.abs(f - y) > (steep ? 0.32 : 0.12)) { bad.push(`${what}: floor ${(f - y).toFixed(2)} m off at ${loc(x, z)}`); return; }
      }
    }
  };
  let legs = 0;
  ins.links.forEach((l, i) => l.forEach((j) => { if (j > i) { legs++; leg(at(i), at(j), `link ${i}-${j}`); } }));
  for (const [k, s] of ins.spots.entries()) {
    const pts = [at(s.node)];
    for (let i = 0; i < s.via.length; i += 2) pts.push([s.via[i], s.y, s.via[i + 1]]);
    pts.push([s.x, s.y, s.z]);
    // (Seats: the last step is onto the chair; council desks stand close, people squeeze past.)
    for (let i = 0; i + 1 < pts.length; i++) {
      const last = i + 2 === pts.length;
      if (s.who === 'councillor' && !last) continue;
      if (last && s.sit) continue;
      leg(pts[i], pts[i + 1], `spot ${k} (${s.who}) leg ${i}`);
    }
    if (Math.abs(pts[0][1] - s.y) > 0.6) bad.push(`spot ${k} (${s.who}): ${(s.y - pts[0][1]).toFixed(2)} m above its node`);
  }
  for (const e of ins.exits) {
    const P = e.pts, pts = [at(e.node)];
    for (let i = 0; i < P.length; i += 3) pts.push([P[i], P[i + 1], P[i + 2]]);
    // (Down the entrance steps: lerped, so only clear, not on each step.)
    for (let i = 0; i + 1 < pts.length; i++) leg(pts[i], pts[i + 1], `exit leg ${i}`, i + 2 < pts.length);
  }
  // Every node reachable from the door.
  const seen = new Set<number>(ins.exits.map((e) => e.node)), q = [...seen];
  while (q.length) for (const j of ins.links[q.pop()!]) if (!seen.has(j)) { seen.add(j); q.push(j); }
  if (seen.size !== ins.links.length) bad.push(`${ins.links.length - seen.size} of ${ins.links.length} nav points not reachable from the door`);
  return { legs, spots: ins.spots.length, bad };
}

// CLI: sweep cities for town halls and cathedrals and report their walkways.
if (process.argv[1]?.endsWith('landmarkWays.ts')) {
  const { makeProfile } = await import('../src/world/settings');
  const { Terrain } = await import('../src/world/terrain');
  const { buildMacroPlan } = await import('../src/plan/macro');
  const { LandmarkSolids } = await import('../src/world/LandmarkSolids');
  const { landmarkInterior } = await import('../src/plan/landmarkParts');
  const [a, b] = (process.argv[3] ?? '1-12').split('-').map(Number);
  const size = Number(process.argv[2] ?? 0.6);
  for (let seed = a; seed <= b; seed++) {
    const terrain = new Terrain(makeProfile({ seed, size }));
    const macro = buildMacroPlan(terrain);
    const S = new LandmarkSolids(macro, terrain);
    for (const lm of macro.landmarks) {
      const ins = landmarkInterior(lm, terrain);
      if (!ins) continue;
      const r = auditWays(lm, ins, S, terrain);
      console.log(`seed ${seed} ${lm.kind} style ${lm.style}: ${r.legs} legs, ${r.spots} spots, ${r.bad.length} bad`);
      for (const m of r.bad.slice(0, 12)) console.log('   ', m);
    }
  }
}
