/** What the near-future systems need from the game (kept narrow so they stay testable). */
import type { MacroPlan } from '../plan/types';
import type { Terrain } from '../world/terrain';
import type { WorldIndex } from '../world/WorldIndex';
import type { CityStreamer } from '../stream/CityStreamer';
import type { Pedestrians } from '../sim/Pedestrians';
import type { Traffic } from '../sim/Traffic';
import type { RoadNet } from '../sim/RoadNet';
import type { Physics } from '../physics/Physics';
import type { Debris } from '../destruction/Debris';
import type { Dust } from '../destruction/Dust';
import type { Destruction } from '../destruction/Destruction';

export interface FutureCtx {
  seed: number;
  macro: MacroPlan;
  terrain: Terrain;
  world: WorldIndex;
  streamer: CityStreamer;
  peds: Pedestrians;
  traffic: Traffic;
  /** Road graph (junctions, signals) for the service robots' posts. */
  net: RoadNet;
  physics: Physics;
  debris: Debris;
  dust: Dust;
  destruction: Destruction;
  /** Spatial one-shot (id from public/sounds/manifest.json). */
  sound: (id: string, x: number, y: number, z: number, gain: number, pitch: number, refDist: number) => void;
}

/** The player's body this frame (inactive in the free camera). */
export interface PlayerProbe {
  active: boolean;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  height: number;
  radius: number;
  mass: number;
}

/** Fleet colours (sRGB) of the fictional delivery services. */
export const FLEETS: [number, number, number][] = [
  [0.04, 0.6, 0.55],  // teal
  [0.9, 0.36, 0.1],   // orange
  [0.16, 0.36, 0.85], // blue
  [0.5, 0.74, 0.12],  // lime
];
