/**
 * Top-down floor plans of real storeys as SVG, to check interior layouts and furnishing without a
 * GPU: rooms (tinted by type), walls with their doors, windows (blue facade), furniture boxes with
 * a tick on their front side and their name. Also prints timing per storey.
 *
 *   npx tsx tools/interiorPlans.ts [seed=42] [size=0.4] [count=8] [outDir=reports/interiors] [floor=1]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { planCell } from '../src/plan/cell';
import { buildingLayout } from '../src/build/buildingLayout';
import { planFloor, planCores, coreFits, shopKindOf, type FloorPlan } from '../src/interior/InteriorGen';
import { polyBounds } from '../src/core/geom2';
import type { BuildingDesc } from '../src/plan/building';

const ROOM: Record<string, string> = {
  living: '#f3e3c3', bedroom: '#dfe6f5', kitchen: '#e5f2dc', bath: '#d8f0f2', hall: '#eeeeee', corridor: '#e8e8e8', stairs: '#dddddd',
  office: '#f0f0e0', meeting: '#e6e0f0', shop: '#f6e8e8', cafe: '#f6eadb', storage: '#e0e0e0', lobby: '#f2f2f2', arcade: '#d9d2ea',
};

export function planSvg(plan: FloorPlan, outline: number[], title: string): string {
  const [x0, z0, x1, z1] = polyBounds(outline);
  const S = 40, pad = 1, W = (x1 - x0 + 2 * pad) * S, H = (z1 - z0 + 2 * pad) * S;
  const X = (x: number) => ((x - x0 + pad) * S).toFixed(1), Z = (z: number) => ((z - z0 + pad) * S).toFixed(1);
  const pts = (p: number[]) => { const o: string[] = []; for (let i = 0; i < p.length; i += 2) o.push(`${X(p[i])},${Z(p[i + 1])}`); return o.join(' '); };
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + 30}" font-family="sans-serif">`, `<rect width="100%" height="100%" fill="white"/>`];
  out.push(`<text x="8" y="${H + 20}" font-size="16">${title}</text>`);
  out.push(`<polygon points="${pts(outline)}" fill="#fafafa" stroke="#3a7bd5" stroke-width="5"/>`);
  for (const r of plan.rooms) {
    out.push(`<polygon points="${pts(r.poly)}" fill="${ROOM[r.type] ?? '#f5f5f5'}" stroke="none"/>`);
    const [a, b, c, d] = polyBounds(r.poly);
    out.push(`<text x="${X((a + c) / 2)}" y="${Z((b + d) / 2)}" font-size="13" fill="#999" text-anchor="middle">${r.type}</text>`);
  }
  for (const f of plan.furniture) {
    const c = Math.cos(f.yaw), s = Math.sin(f.yaw), w = f.w / 2, d = f.d / 2;
    const P = (lx: number, lz: number) => [f.x + lx * c + lz * s, f.z - lx * s + lz * c];
    const q = [...P(-w, -d), ...P(w, -d), ...P(w, d), ...P(-w, d)];
    const flat = f.kind === 'rug', hung = f.kind === 'painting' || f.kind === 'mirror';
    const col = `rgb(${f.color.map((v) => Math.round(Math.min(1, v) * 255)).join(',')})`;
    out.push(`<polygon points="${pts(q)}" fill="${col}" fill-opacity="${flat ? 0.35 : 0.85}" stroke="${hung ? '#c00' : '#222'}" stroke-width="${hung ? 3 : 1}"/>`);
    if (!flat) { const [ax, az] = P(0, d * 0.6), [bx, bz] = P(0, d + 0.15); out.push(`<line x1="${X(ax)}" y1="${Z(az)}" x2="${X(bx)}" y2="${Z(bz)}" stroke="#d00" stroke-width="2"/>`); }
    if (!hung && f.kind !== 'chair' && f.kind !== 'tv') out.push(`<text x="${X(f.x)}" y="${Z(f.z) }" font-size="10" text-anchor="middle" fill="#000">${f.kind}</text>`);
  }
  for (const w of plan.walls) {
    const dx = w.bx - w.ax, dz = w.bz - w.az;
    let t = 0;
    const segs: [number, number][] = [];
    for (const [d0, d1] of [...w.doors].sort((a, b) => a[0] - b[0])) { if (d0 > t) segs.push([t, d0]); t = Math.max(t, d1); }
    if (t < 1) segs.push([t, 1]);
    for (const [a, b] of segs) out.push(`<line x1="${X(w.ax + dx * a)}" y1="${Z(w.az + dz * a)}" x2="${X(w.ax + dx * b)}" y2="${Z(w.az + dz * b)}" stroke="#333" stroke-width="4"/>`);
  }
  for (const f of plan.flights) out.push(`<line x1="${X(f.x)}" y1="${Z(f.z)}" x2="${X(f.x + f.dx * f.run)}" y2="${Z(f.z + f.dz * f.run)}" stroke="#888" stroke-width="${f.width * S}" stroke-opacity="0.4"/>`);
  out.push('</svg>');
  return out.join('\n');
}

function main(): void {
  const [seed = 42, size = 0.4, count = 8] = process.argv.slice(2, 5).map(Number);
  const outDir = process.argv[5] ?? 'reports/interiors';
  const floorWanted = Number(process.argv[6] ?? 1);
  mkdirSync(outDir, { recursive: true });

  const terrain = new Terrain(makeProfile({ seed, size }));
  const macro = buildMacroPlan(terrain);
  const c0 = macro.centres[0];
  const cells = macro.cells.slice().sort((a, b) => Math.hypot(a.centroid[0] - c0.x, a.centroid[1] - c0.z) - Math.hypot(b.centroid[0] - c0.x, b.centroid[1] - c0.z));
  let n = 0, ms = 0, storeys = 0;
  const homes = (b: BuildingDesc) => b.use !== 'office' && b.use !== 'industrial' && b.use !== 'parking' && b.style !== 'church';
  for (const c of cells) {
    if (n >= count) break;
    for (const b of planCell(macro, c, terrain).buildings) {
      if (n >= count) break;
      if (!homes(b) || b.floors <= floorWanted) continue;
      const L = buildingLayout(b, terrain, 0);
      const fl = L.floors.find((q) => q.f === floorWanted);
      if (!fl) continue;
      const poly = L.tiers[fl.tier].poly;
      const { lift, stair } = planCores(b, L.tiers[0].poly, Math.max(...L.floors.map((q) => q.y1 - q.y0)), L.door);
      const next = L.floors.find((q) => q.f === fl.f + 1);
      const up = !!stair && !!next && coreFits(stair, poly) && coreFits(stair, L.tiers[next.tier].poly);
      const t0 = performance.now();
      const plan = planFloor(b, poly, fl.f, fl.y0, fl.y1 - fl.y0, shopKindOf(b), lift, stair, up, fl.f > 0 && !!stair && coreFits(stair, poly), fl.f === 0 ? L.door : null);
      ms += performance.now() - t0; storeys++;
      writeFileSync(`${outDir}/plan-${seed}-${n}.svg`, planSvg(plan, poly, `seed ${seed} building ${b.seed} floor ${fl.f} (${b.use}${b.attached ? ', attached' : ''})`));
      n++;
    }
  }
  console.log(`${n} plans written to ${outDir}; ${(ms / Math.max(1, storeys)).toFixed(1)} ms per storey`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
