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
  | { type: 'forest'; job: number; x0: number; z0: number; size: number }
  | { type: 'rural'; job: number; x0: number; z0: number; size: number }
  | { type: 'bridges'; job: number }
  | { type: 'landmarks'; job: number }
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
  /** Countryside trees of a tile (FOREST_STRIDE floats per tree, see build/forest). */
  | { type: 'forest'; job: number; trees: Float32Array }
  /** Countryside settlements and roads of a tile (build/rural): meshes (null when empty) and collision boxes. */
  | { type: 'rural'; job: number; ground: MeshData | null; facade: MeshData | null; facadeLod: MeshData | null; obstacles: Float32Array }
  | { type: 'bridges'; job: number; mesh: MeshData | null }
  /** Per landmark (macro.landmarks order): the near mesh and the far one. */
  | { type: 'landmarks'; job: number; meshes: [MeshData, MeshData][] }
  | { type: 'skyline'; job: number; cells: number[]; records: Float32Array; counts: number[]; map: Float32Array; mapOff: Int32Array }
  | { type: 'error'; job: number; message: string };

/**
 * Map data per cell (packed with the skyline records; the planner already ran):
 * items [kind, a, b, n, x0, z0, … (n points)]. Kinds: 0 local street (a = class,
 * b = width), 1 park outline, 2 metro entrance (a = station, b = end; points =
 * centre and long axis), 3 plaza outline.
 */
export const enum MapItem { Street = 0, Park = 1, Entrance = 2, Plaza = 3 }

/** Skyline record per building: cx, cz, hu, hv, yaw, base, height, wall layer, tint r, g, b, floorH, flags, cell. */
export const SKY_STRIDE = 14;
