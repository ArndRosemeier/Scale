/**
 * Finds z-fighting in a landmark's meshes: triangles of the near, glass and inside meshes that lie
 * in the same plane and overlap (the facade material is double-sided, so facing either way).
 * npx tsx tools/zfight.ts <kind> [seeds] [size]   e.g. museum 1,7,11 0.8
 * DUMP=inner/inner (or near/inner, …) also prints the first 30 overlapping wall-like triangle pairs.
 */
import { buildMacroPlan } from '../src/plan/macro';
import { Terrain } from '../src/world/terrain';
import { makeProfile } from '../src/world/settings';
import { buildLandmarkMeshes } from '../src/build/landmarks';
import type { MeshBuilder } from '../src/build/meshBuilder';
import type { Landmark } from '../src/plan/landmarks';
import { siteRect } from '../src/plan/landmarks';

const kind = process.argv[2] ?? 'museum';
const seeds = (process.argv[3] ?? '1,7,11,2,10,6,9,5').split(',').map(Number);
const size = Number(process.argv[4] ?? 0.8);

let dumped = 0;
type Tri = { p: number[]; n: number[]; d: number; src: string };
function tris(mb: MeshBuilder, src: string, out: Tri[]): void {
  if (mb.empty) return;
  const md = mb.build(), pos = md.attrs.position.array as Float32Array, idx = md.index, o = md.origin;
  for (let i = 0; i < idx.length; i += 3) {
    const p: number[] = [];
    for (let j = 0; j < 3; j++) { const k = idx[i + j] * 3; p.push(pos[k] + o[0], pos[k + 1] + o[1], pos[k + 2] + o[2]); }
    const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz);
    if (L < 1e-6) continue;
    nx /= L; ny /= L; nz /= L;
    // Canonical direction (either facing).
    if (nx < -1e-6 || (Math.abs(nx) <= 1e-6 && (ny < -1e-6 || (Math.abs(ny) <= 1e-6 && nz < 0)))) { nx = -nx; ny = -ny; nz = -nz; }
    out.push({ p, n: [nx, ny, nz], d: nx * p[0] + ny * p[1] + nz * p[2], src });
  }
}
/** Overlap area of two coplanar triangles (projected to the plane's dominant axes), by clipping. */
function overlap(a: Tri, b: Tri): number {
  const n = a.n, ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const [i, j] = ax >= ay && ax >= az ? [1, 2] : ay >= az ? [0, 2] : [0, 1];
  const P = (t: Tri) => [0, 1, 2].map((k) => [t.p[k * 3 + i], t.p[k * 3 + j]]);
  let poly = P(a);
  const clip = P(b);
  const area = (q: number[][]) => { let s = 0; for (let k = 0; k < q.length; k++) { const [x0, y0] = q[k], [x1, y1] = q[(k + 1) % q.length]; s += x0 * y1 - x1 * y0; } return s / 2; };
  const sgn = Math.sign(area(clip)) || 1;
  for (let k = 0; k < 3 && poly.length; k++) {
    const [x0, y0] = clip[k], [x1, y1] = clip[(k + 1) % 3];
    const side = (q: number[]) => sgn * ((x1 - x0) * (q[1] - y0) - (y1 - y0) * (q[0] - x0));
    const out: number[][] = [];
    for (let m = 0; m < poly.length; m++) {
      const c = poly[m], d = poly[(m + 1) % poly.length], sc = side(c), sd = side(d);
      if (sc >= 0) out.push(c);
      if ((sc >= 0) !== (sd >= 0)) { const t = sc / (sc - sd); out.push([c[0] + (d[0] - c[0]) * t, c[1] + (d[1] - c[1]) * t]); }
    }
    poly = out;
  }
  return poly.length < 3 ? 0 : Math.abs(area(poly)) / Math.max(1e-9, Math.abs(n[[0, 1, 2].find((q) => q !== i && q !== j)!]));
}

for (const seed of seeds) {
  const terrain = new Terrain(makeProfile({ seed, size }));
  for (const real of buildMacroPlan(terrain).landmarks.filter((l) => l.kind === kind)) {
    const flat = { height: () => 0, isWater: () => false } as unknown as Terrain;
    const lm: Landmark = { ...real, x: 0, z: 0, angle: 0, base: 0.15, low: 0, site: [] };
    lm.site = siteRect(lm, -lm.hu, -lm.hv, lm.hu, lm.hv);
    const b = buildLandmarkMeshes(lm, flat);
    const T: Tri[] = [];
    tris(b.near, 'near', T);
    if (b.glass) tris(b.glass[0], 'glass', T);
    if (b.inner) { tris(b.inner[0], 'inner', T); tris(b.inner[1], 'innerGlass', T); }
    // Bucket by plane (normal to 1e-3, offset to 2 mm).
    const key = (t: Tri) => `${Math.round(t.n[0] * 1000)},${Math.round(t.n[1] * 1000)},${Math.round(t.n[2] * 1000)},${Math.round(t.d / 0.002)}`;
    const B = new Map<string, Tri[]>();
    for (const t of T) { const k = key(t); (B.get(k) ?? B.set(k, []).get(k)!).push(t); }
    const hits: { area: number; y: number; n: string; at: string; src: string }[] = [];
    for (const [, L] of B) {
      if (L.length < 2) continue;
      // (Cheap 2D bounds test first.)
      for (let a = 0; a < L.length; a++) for (let c = a + 1; c < L.length; c++) {
        const s = overlap(L[a], L[c]);
        if (s > 0.01 && process.env.DUMP && `${L[a].src}/${L[c].src}` === process.env.DUMP && Math.abs(L[a].n[1]) < 0.5 && dumped++ < 30) console.log(JSON.stringify(L[a].p.map((x) => +x.toFixed(2))), JSON.stringify(L[c].p.map((x) => +x.toFixed(2))), s.toFixed(2));
        if (s > 0.01) {
          const p = L[a].p;
          hits.push({ area: s, y: +((p[1] + p[4] + p[7]) / 3).toFixed(2), n: L[a].n.map((x) => x.toFixed(2)).join(','), at: `${((p[0] + p[3] + p[6]) / 3).toFixed(1)},${((p[2] + p[5] + p[8]) / 3).toFixed(1)}`, src: `${L[a].src}/${L[c].src}` });
        }
      }
    }
    // Group by plane for the report.
    const g = new Map<string, { area: number; n: number; ex: string }>();
    for (const h of hits) { const k = `n=${h.n} ${h.src} y~${h.n === '0.00,1.00,0.00' ? h.y : '*'}`; const e = g.get(k) ?? { area: 0, n: 0, ex: `${h.at} y${h.y}` }; e.area += h.area; e.n++; g.set(k, e); }
    console.log(`seed ${seed} ${kind} style ${lm.style}: ${T.length} tris, ${hits.length} overlapping pairs, ${hits.reduce((s, h) => s + h.area, 0).toFixed(1)} m²`);
    for (const [k, e] of [...g].sort((x, y) => y[1].area - x[1].area).slice(0, 25)) console.log(`   ${e.area.toFixed(2).padStart(8)} m² ${String(e.n).padStart(5)}  ${k}  e.g. ${e.ex}`);
  }
}
