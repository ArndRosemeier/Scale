/// <reference lib="webworker" />
/**
 * City worker: owns a deterministic copy of the world (terrain + macro plan)
 * and builds cell plans and meshes on request.
 */
import { makeProfile } from '../world/settings';
import { Terrain } from '../world/terrain';
import { buildMacroPlan } from '../plan/macro';
import { planCell } from '../plan/cell';
import type { MacroPlan } from '../plan/types';
import { buildGround } from '../build/ground';
import { MeshBuilder, meshTransferables, type MeshData } from '../build/meshBuilder';
import { buildBuildingShell, facadeSpecs } from '../build/buildingShell';
import { buildTerrainTile, buildWaterTile } from '../build/terrainMesh';
import { riverChunks, seaPolygon } from '../plan/water';
import { polyCentroid } from '../core/geom2';
import { BINFO_STRIDE, SKY_STRIDE, type FromWorker, type ToWorker } from './protocol';
import { minAreaRect } from '../core/geom2';
import { buildingBase, buildingHeight } from '../build/buildingLayout';
import { buildBridges } from '../build/bridges';

declare const self: DedicatedWorkerGlobalScope;

let terrain: Terrain | null = null;
let macro: MacroPlan | null = null;
let water: ReturnType<typeof riverChunks> | null = null;
let sea: number[] | null = null;

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
      water = riverChunks(terrain, 0.0);
      sea = seaPolygon(terrain, 0);
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
        const info = buildBuildingShell(fb, b, elem, terrain!);
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
      const mesh = buildTerrainTile(terrain, m.x0, m.z0, m.size, m.res, m.skirt).build();
      post({ type: 'terrain', job: m.job, mesh }, meshTransferables(mesh));
      return;
    }
    if (m.type === 'water') {
      const mb = buildWaterTile(terrain, m.x0, m.z0, m.size, water!, sea);
      const mesh: MeshData | null = mb ? mb.build() : null;
      post({ type: 'water', job: m.job, mesh }, mesh ? meshTransferables(mesh) : []);
      return;
    }
    if (m.type === 'skyline') {
      const out: number[] = [];
      const counts: number[] = [];
      for (const id of m.cells) {
        const cell = macro.cells[id];
        const plan = planCell(macro, cell, terrain);
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
      const records = Float32Array.from(out);
      void SKY_STRIDE;
      post({ type: 'skyline', job: m.job, cells: m.cells, records, counts }, [records.buffer]);
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
