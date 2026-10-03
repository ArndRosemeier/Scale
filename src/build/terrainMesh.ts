/**
 * Terrain tiles (regular grid with skirts) and water surfaces.
 */
import type { Terrain } from '../world/terrain';
import { MeshBuilder } from './meshBuilder';
import { riverChunks } from '../plan/water';
import { intersection, shapesToPolys } from '../core/clip';
import { drapeShape } from './ground';
import { newLandSample, type LandUse } from '../world/landuse';

/** Natural terrain sits slightly below the urban ground meshes so it never pokes through. */
export const TERRAIN_DROP = 0.35;

/**
 * A terrain tile. With `land`, every vertex carries aLand = (forest, field, meadow, bank), each
 * premultiplied by the countryside weight (all zero in the city), for the terrain shader.
 */
export function buildTerrainTile(terrain: Terrain, x0: number, z0: number, size: number, res: number, skirt: number, land?: LandUse): MeshBuilder {
  const mb = new MeshBuilder(land ? [{ name: 'uv', size: 2 }, { name: 'aLand', size: 4, type: 'u8n' }] : [{ name: 'uv', size: 2 }]);
  const ls = newLandSample();
  const setLand = (x: number, z: number, slope: number) => {
    if (!land) return;
    land.sample(x, z, ls, slope);
    mb.set('aLand', ls.rural * ls.forest, ls.rural * ls.field, ls.rural * ls.meadow, ls.rural * ls.bank);
  };
  mb.setOrigin(x0 + size / 2, 0, z0 + size / 2);
  const n = res + 1;
  const h = new Float32Array(n * n);
  const step = size / res;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = terrain.height(x0 + i * step, z0 + j * step) - TERRAIN_DROP;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = x0 + i * step, z = z0 + j * step;
      const hl = h[j * n + Math.max(0, i - 1)], hr = h[j * n + Math.min(n - 1, i + 1)];
      const hd = h[Math.max(0, j - 1) * n + i], hu = h[Math.min(n - 1, j + 1) * n + i];
      const dx = (hr - hl) / ((Math.min(n - 1, i + 1) - Math.max(0, i - 1)) * step);
      const dz = (hu - hd) / ((Math.min(n - 1, j + 1) - Math.max(0, j - 1)) * step);
      const l = Math.hypot(dx, 1, dz);
      setLand(x, z, Math.hypot(dx, dz));
      mb.v(x, h[j * n + i], z, -dx / l, 1 / l, -dz / l, x, z);
    }
  }
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const a = j * n + i, b = a + 1, c = a + n + 1, d = a + n;
      // Face +y: (a, d, c) and (a, c, b) given x right, z down the rows.
      mb.tri(a, d, c);
      mb.tri(a, c, b);
    }
  }
  // Skirts hide cracks between LOD levels.
  if (skirt > 0) {
    const edge = (idx: (k: number) => number, nx: number, nz: number, flip: boolean) => {
      const base = mb.vcount;
      for (let k = 0; k < n; k++) {
        const vi = idx(k);
        const i = vi % n, j = Math.floor(vi / n);
        const x = x0 + i * step, z = z0 + j * step;
        setLand(x, z, 0);
        mb.v(x, h[vi], z, nx, 0, nz, x, z);
        mb.v(x, h[vi] - skirt, z, nx, 0, nz, x, z);
      }
      for (let k = 0; k < n - 1; k++) {
        const a = base + k * 2, b = a + 2;
        if (flip) { mb.tri(a, a + 1, b + 1); mb.tri(a, b + 1, b); }
        else { mb.tri(a, b + 1, a + 1); mb.tri(a, b, b + 1); }
      }
    };
    edge((k) => k, 0, -1, false); // z0 row
    edge((k) => (n - 1) * n + k, 0, 1, true); // z1 row
    edge((k) => k * n, -1, 0, true); // x0 column
    edge((k) => k * n + n - 1, 1, 0, false); // x1 column
  }
  return mb;
}

/** Water surfaces (river + sea) clipped to a square tile. */
export function buildWaterTile(terrain: Terrain, x0: number, z0: number, size: number, chunks: ReturnType<typeof riverChunks>, sea: number[] | null): MeshBuilder | null {
  const mb = new MeshBuilder([{ name: 'uv', size: 2 }, { name: 'aLayer', size: 1 }]);
  mb.setOrigin(x0 + size / 2, 0, z0 + size / 2);
  const tile = [x0, z0, x0 + size, z0, x0 + size, z0 + size, x0, z0 + size];
  const polys: number[][] = [];
  for (const ch of chunks) {
    if (ch.bounds[0] > x0 + size || ch.bounds[2] < x0 || ch.bounds[1] > z0 + size || ch.bounds[3] < z0) continue;
    for (const s of ch.shapes) polys.push(s.outer);
  }
  if (sea) polys.push(sea);
  if (!polys.length) return null;
  const clipped = intersection(polys, [tile]);
  if (!clipped.length) return null;
  // Water level: sea → 0; river → the level at each vertex (rivers slope gently).
  const level = (x: number, z: number) => {
    const w = terrain.water(x, z);
    if (terrain.profile.coastal && terrain.coastDistance(x, z) < 0 && (w.river < 0 || w.d > w.halfWidth + 5)) return 0;
    return w.river >= 0 ? w.level : 0;
  };
  for (const s of clipped) drapeShape(mb, s, terrain, 0, 0, level, Math.max(30, size / 24));
  void shapesToPolys;
  return mb.empty ? null : mb;
}
