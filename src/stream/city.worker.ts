/// <reference lib="webworker" />
/**
 * City worker: owns a deterministic copy of the world (terrain + macro plan)
 * and builds cell plans and meshes on request.
 */
import { makeProfile } from '../world/settings';
import { Terrain } from '../world/terrain';
import { buildMacroPlan } from '../plan/macro';
import { planCell, type CellPlan } from '../plan/cell';
import type { MacroPlan } from '../plan/types';
import { buildGround } from '../build/ground';
import { MeshBuilder, meshTransferables, type MeshData } from '../build/meshBuilder';
import { buildBuildingShell, facadeSpecs } from '../build/buildingShell';
import { buildTerrainTile, buildWaterTile } from '../build/terrainMesh';
import { riverChunks, seaPolygon } from '../plan/water';
import { polyCentroid, polyBounds } from '../core/geom2';
import { BINFO_STRIDE, SKY_STRIDE, MapItem, type FromWorker, type ToWorker } from './protocol';
import { minAreaRect } from '../core/geom2';
import { buildingBase, buildingHeight } from '../build/buildingLayout';
import { buildBridges } from '../build/bridges';
import { buildLandmarkMeshes } from '../build/landmarks';
import { LandUse } from '../world/landuse';
import { ForestGen } from '../build/forest';
import { RuralPlan } from '../world/rural';
import { buildRuralTile } from '../build/rural';

declare const self: DedicatedWorkerGlobalScope;

let terrain: Terrain | null = null;
let macro: MacroPlan | null = null;
let water: ReturnType<typeof riverChunks> | null = null;
let sea: number[] | null = null;
let lakes: { poly: number[]; bounds: number[] }[] = [];
let land: LandUse | null = null;
let forest: ForestGen | null = null;

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      const t0 = performance.now();
      terrain = new Terrain(makeProfile(m.settings));
      macro = buildMacroPlan(terrain);
      land = new LandUse(terrain);
      // Villages, farms and roads: planned from the land use, then clearing it.
      land.settle = new RuralPlan(terrain, land, macro);
      water = riverChunks(terrain, 0.0);
      // The sea surface reaches along the whole coast of the streamed world.
      sea = seaPolygon(terrain, 0, 40, terrain.worldExtent * 1.1);
      lakes = terrain.lakes.map((_, k) => { const poly = terrain!.lakePolygon(k); return { poly, bounds: polyBounds(poly) }; });
      post({ type: 'ready', macro: m.sendMacro ? macro : undefined, ms: performance.now() - t0 });
      return;
    }
    if (!terrain || !macro) throw new Error('worker not initialised');
    if (m.type === 'cell') {
      const t0 = performance.now();
      const cell = macro.cells[m.cell];
      const plan = planCell(macro, cell, terrain);
      const origin: [number, number, number] = [Math.round(cell.centroid[0]), 0, Math.round(cell.centroid[1])];
      const ground = buildGround(plan, terrain, origin).build();
      const fb = new MeshBuilder(facadeSpecs());
      fb.setOrigin(...origin);
      const binfo = new Float32Array(plan.buildings.length * BINFO_STRIDE);
      let elem = 0;
      plan.buildings.forEach((b, i) => {
        // Storey slabs are built on demand when a building gets damaged (Destruction.ensureSlabs).
        const info = buildBuildingShell(fb, b, elem, terrain!, 0, 'shell');
        const c = polyCentroid(b.poly);
        let rad = 0;
        for (let k = 0; k < b.poly.length; k += 2) rad = Math.max(rad, Math.hypot(b.poly[k] - c[0], b.poly[k + 1] - c[1]));
        binfo.set([info.base, info.height, elem, info.elemCount, c[0], c[1], rad, info.low], i * BINFO_STRIDE);
        elem += info.elemCount;
      });
      const facade = fb.build();
      const fl = new MeshBuilder(facadeSpecs());
      fl.setOrigin(...origin);
      let e2 = 0;
      for (const b of plan.buildings) e2 += buildBuildingShell(fl, b, e2, terrain!, 1).elemCount;
      const facadeLod = fl.build();
      const transfer = [...meshTransferables(ground), ...meshTransferables(facade), ...meshTransferables(facadeLod), binfo.buffer];
      post({ type: 'cell', job: m.job, cell: m.cell, plan, ground, facade, facadeLod, binfo, elemCount: elem, ms: performance.now() - t0 }, transfer);
      return;
    }
    if (m.type === 'terrain') {
      const mesh = buildTerrainTile(terrain, m.x0, m.z0, m.size, m.res, m.skirt, land!).build();
      post({ type: 'terrain', job: m.job, mesh }, meshTransferables(mesh));
      return;
    }
    if (m.type === 'water') {
      const mb = buildWaterTile(terrain, m.x0, m.z0, m.size, water!, sea, lakes);
      const mesh: MeshData | null = mb ? mb.build() : null;
      post({ type: 'water', job: m.job, mesh }, mesh ? meshTransferables(mesh) : []);
      return;
    }
    if (m.type === 'forest') {
      forest ??= new ForestGen(land!, macro);
      const trees = forest.tile(m.x0, m.z0, m.size);
      post({ type: 'forest', job: m.job, trees }, [trees.buffer]);
      return;
    }
    if (m.type === 'rural') {
      const t = buildRuralTile(land!.settle!, terrain, m.x0, m.z0, m.size);
      const ground = t.ground?.build() ?? null, facade = t.facade?.build() ?? null, facadeLod = t.facadeLod?.build() ?? null;
      const transfer = [...(ground ? meshTransferables(ground) : []), ...(facade ? meshTransferables(facade) : []), ...(facadeLod ? meshTransferables(facadeLod) : []), t.obstacles.buffer];
      post({ type: 'rural', job: m.job, ground, facade, facadeLod, obstacles: t.obstacles }, transfer as Transferable[]);
      return;
    }
    if (m.type === 'skyline') {
      const out: number[] = [];
      const counts: number[] = [];
      const map: number[] = [];
      const mapOff: number[] = [];
      for (const id of m.cells) {
        const cell = macro.cells[id];
        const plan = planCell(macro, cell, terrain);
        mapOff.push(map.length);
        packMapItems(plan, map);
        let n = 0;
        for (const b of plan.buildings) {
          const o = minAreaRect(b.poly);
          const { base } = buildingBase(b, terrain);
          let h = buildingHeight(b);
          if (b.roof === 'gable' || b.roof === 'hip') h += Math.min(o.hu, o.hv) * b.pitch * 0.5;
          if (b.roof === 'mansard') h += 2.5;
          const tint = b.wall === 6 || b.wall === 7 ? [0.92, 0.85, 0.75] : b.wall === 14 ? [0.85, 0.85, 0.82] : [1, 1, 1];
          const flags = (b.style === 'glass' ? 1 : 0) | (b.floors <= 2 ? 2 : 0);
          out.push(o.cx, o.cz, o.hu, o.hv, o.angle, base, h, b.wall, tint[0], tint[1], tint[2], b.floorH, flags, id);
          n++;
        }
        counts.push(n);
      }
      mapOff.push(map.length);
      const records = Float32Array.from(out);
      const mapData = Float32Array.from(map);
      void SKY_STRIDE;
      post({ type: 'skyline', job: m.job, cells: m.cells, records, counts, map: mapData, mapOff: Int32Array.from(mapOff) }, [records.buffer, mapData.buffer]);
      return;
    }
    if (m.type === 'landmarks') {
      const built = macro.landmarks.map((lm) => buildLandmarkMeshes(lm, terrain!));
      const meshes = built.map((b) => [b.near.build(), b.far.build()] as [MeshData, MeshData]);
      const glass = built.map((b) => (b.glass ? [b.glass[0].build(), b.glass[1].build()] as [MeshData, MeshData] : null));
      const inner = built.map((b) => (b.inner ? b.inner.map((x) => (x.empty ? null : x.build())) as [MeshData | null, MeshData | null] : null));
      const wreck = built.map((b) => (b.pieces && b.grid ? { pieces: b.pieces, grid: b.grid } : null));
      const all = [...meshes, ...glass.filter((g): g is [MeshData, MeshData] => !!g)];
      post({ type: 'landmarks', job: m.job, meshes, glass, inner, wreck }, [
        ...all.flatMap(([a, b]) => [...meshTransferables(a), ...meshTransferables(b)]),
        ...inner.flatMap((p) => (p ? p.flatMap((x) => (x ? meshTransferables(x) : [])) : [])),
        ...wreck.flatMap((w) => (w ? [w.pieces.buffer as ArrayBuffer] : [])),
      ]);
      return;
    }
    if (m.type === 'bridges') {
      const mb = buildBridges(macro, terrain);
      const mesh = mb.empty ? null : mb.build();
      post({ type: 'bridges', job: m.job, mesh }, mesh ? meshTransferables(mesh) : []);
      return;
    }
  } catch (e) {
    post({ type: 'error', job: (m as { job?: number }).job ?? -1, message: String((e as Error)?.stack ?? e) });
  }
};

/** Local streets, parks, plazas and metro entrances of a cell for the in-game map. */
function packMapItems(plan: CellPlan, out: number[]): void {
  const poly = (kind: MapItem, a: number, b: number, pts: ArrayLike<number>) => {
    out.push(kind, a, b, pts.length >> 1);
    for (let i = 0; i < pts.length; i++) out.push(pts[i]);
  };
  for (const s of plan.streets) if (s.arterial < 0) poly(MapItem.Street, s.cls, s.width, s.pts);
  for (const p of plan.parks) poly(MapItem.Park, 0, 0, p.outer);
  for (const p of plan.plazas) poly(MapItem.Plaza, 0, 0, p.outer);
  const E = plan.entrances;
  for (let i = 0; i < E.length; i += 6) poly(MapItem.Entrance, E[i + 4], E[i + 5], [E[i], E[i + 1], E[i + 2], E[i + 3]]);
}
