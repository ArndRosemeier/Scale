/**
 * Plan data types. Pure data: structured-clone / transfer friendly, no three.js.
 */
import type { Poly } from '../core/geom2';

export const enum RoadClass {
  Boulevard = 0,
  Avenue = 1,
  Street = 2,
  Lane = 3,
  Path = 4,
}

export type District =
  | 'downtown'
  | 'commercial'
  | 'oldtown'
  | 'apartments'
  | 'rowhouses'
  | 'suburban'
  | 'industrial'
  | 'port'
  | 'park'
  | 'water';

export const DISTRICTS: District[] = ['downtown', 'commercial', 'oldtown', 'apartments', 'rowhouses', 'suburban', 'industrial', 'port', 'park', 'water'];

export interface Centre {
  x: number;
  z: number;
  /** Relative importance 0..1 (main centre = 1). */
  weight: number;
  /** Influence radius in m. */
  radius: number;
}

export interface ArterialNode {
  x: number;
  z: number;
  /** Neighbouring edge ids. */
  edges: number[];
  /** Bank/coast node kind: 0 normal, 1 river bank, 2 coast. */
  kind: number;
}

export interface ArterialEdge {
  id: number;
  a: number;
  b: number;
  cls: RoadClass;
  /** Carriageway width (curb to curb) in m. */
  width: number;
  /** Sidewalk width on each side in m. */
  sidewalk: number;
  /** Polyline (x,z,...) from node a to node b. */
  pts: number[];
  /** Spans water (bridge deck). */
  bridge: boolean;
  /** Has a central median with trees. */
  median: boolean;
  /** Lanes per direction. */
  lanes: number;
}

export interface CellInfo {
  id: number;
  /** Centerline polygon (CCW) bounded by arterial edges. */
  poly: Poly;
  /** Boundary edge ids in polygon order; edgeDir[i] true if traversed a->b. */
  edges: number[];
  centroid: [number, number];
  area: number;
  district: District;
  /** 0..1 urban density at the centroid. */
  density: number;
  /** Street-grid orientation (radians) for gridded layouts. */
  gridAngle: number;
  /** 0 organic … 1 strict grid. */
  gridness: number;
  /** Era 0 (historic) … 1 (contemporary) bias for building styles. */
  era: number;
  /** Bounding radius around centroid. */
  radius: number;
}

export interface Bridge {
  edge: number;
  /** Deck polyline including approaches. */
  pts: number[];
  width: number;
  /** Deck height above water level at the middle. */
  clearance: number;
  /** Structural style. */
  style: 'arch' | 'girder' | 'truss' | 'suspension' | 'stone';
  /** Water level under the bridge. */
  waterLevel: number;
}

export interface MetroStation {
  id: number;
  x: number;
  z: number;
  /** Platform axis angle. */
  angle: number;
  /** Track depth below ground (m). */
  depth: number;
  lines: number[];
  name: string;
}

export interface MetroLine {
  id: number;
  color: number;
  name: string;
  /** Station ids in order. */
  stations: number[];
  /** Track centerline (x,z,...) passing through station centres. */
  pts: number[];
  /** Arc length of each station along pts. */
  stationS: number[];
  /** Track depth along pts (one per point). */
  depth: number[];
}

export interface SewerTrunk {
  /** Polyline (x,z,...). */
  pts: number[];
  /** Invert depth below street at each point. */
  depth: number[];
  /** Tunnel width. */
  width: number;
}

export interface MacroPlan {
  seed: number;
  centres: Centre[];
  /** Historic core (old town) location. */
  core: [number, number];
  nodes: ArterialNode[];
  edges: ArterialEdge[];
  cells: CellInfo[];
  bridges: Bridge[];
  metroLines: MetroLine[];
  metroStations: MetroStation[];
  sewers: SewerTrunk[];
  /** City boundary radius function samples (64 angles). */
  boundary: number[];
}
