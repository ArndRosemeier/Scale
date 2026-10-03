/**
 * Messages between the main thread and city workers.
 */
import type { MeshData } from '../build/meshBuilder';
import type { CitySettings } from '../world/settings';
import type { MacroPlan } from '../plan/types';
import type { CellPlan } from '../plan/cell';

export type ToWorker =
  | { type: 'init'; settings: CitySettings; sendMacro: boolean }
  | { type: 'cell'; job: number; cell: number }
  | { type: 'terrain'; job: number; x0: number; z0: number; size: number; res: number; skirt: number }
  | { type: 'water'; job: number; x0: number; z0: number; size: number }
  | { type: 'bridges'; job: number }
  | { type: 'skyline'; job: number; cells: number[] };

/** Per building: base y, height, element base, element count, footprint centroid x,z, radius. */
export const BINFO_STRIDE = 8;

export interface CellResult {
  type: 'cell';
  job: number;
  cell: number;
  plan: CellPlan;
  ground: MeshData;
  facade: MeshData;
  /** Simplified facades for distance. */
  facadeLod: MeshData;
  /** Per building record, BINFO_STRIDE floats each. */
  binfo: Float32Array;
  elemCount: number;
  ms: number;
}

export type FromWorker =
  | { type: 'ready'; macro?: MacroPlan; ms: number }
  | CellResult
  | { type: 'terrain'; job: number; mesh: MeshData }
  | { type: 'water'; job: number; mesh: MeshData | null }
  | { type: 'bridges'; job: number; mesh: MeshData | null }
  | { type: 'skyline'; job: number; cells: number[]; records: Float32Array; counts: number[] }
  | { type: 'error'; job: number; message: string };

/** Skyline record per building: cx, cz, hu, hv, yaw, base, height, wall layer, tint r, g, b, floorH, flags, cell. */
export const SKY_STRIDE = 14;
