/**
 * Procedural PBR texture synthesis for facades, roofs and ground surfaces.
 *
 * Pure TypeScript (no DOM, no three.js): runs in a Web Worker and in Node.
 * Every layer tiles seamlessly in u and v and is fully deterministic.
 *
 * ## Orientation convention
 * - Texel row 0 is v = 0 and is the BOTTOM of the tile (three.js DataArrayTexture with
 *   flipY = false puts row 0 at v = 0). Increasing row index = increasing v = "up" on a wall
 *   (and "up-slope" on a pitched roof). Column 0 is u = 0, increasing u = +x (right).
 * - Layouts that have a "down" (soot streaks, dirt bands, wet bottom of the quay wall, lap
 *   siding / shingles / roof tiles overlapping downward) assume +v is up.
 * - Normals are tangent space, OpenGL style: +x = +u (right), +y = +v (up), z out of the
 *   surface. Shader: n = vec3(rg * 2 - 1, 0); n.z = sqrt(max(0, 1 - dot(n.xy, n.xy))).
 *
 * ## Channels
 * - albedo RGBA8: rgb = sRGB albedo, a = roughness (linear 0..1 * 255).
 * - normal RGBA8: rg = normal xy, b = height (normalized per layer to 0..255; 0 = deepest),
 *   a = ambient occlusion (255 = unoccluded).
 * - Tintable layers (keep near-neutral light albedo, multiply by building color in the shader):
 *   facade 6 Plaster, 7 Stucco, 14 WoodSiding (and 15 BrickWhite can be tinted lightly too).
 *
 * ## Physical scale
 * FACADE_TILE_METERS / GROUND_TILE_METERS give the square size (u and v) of one tile in meters;
 * world UVs should be meters / TILE_METERS[layer]. Normals are derived from a height field in
 * meters, so the encoded slopes are physically scaled (normalScale ~1 in the shader).
 */
import { Tex, TexLayer, finish } from './core';
import { FACADE_WALLS } from './facade';
import { ROOFS } from './roof';
import { GROUNDS } from './ground';

export type { TexLayer } from './core';

export const TEX_SIZE = 512;
export const FACADE_LAYER_COUNT = 24;
export const GROUND_LAYER_COUNT = 13;

const FACADE_DEFS = [...FACADE_WALLS, ...ROOFS];

/** Physical size in meters covered by one texture tile (u and v), per layer. */
export const FACADE_TILE_METERS: number[] = FACADE_DEFS.map((d) => d.W);
/** Physical size in meters covered by one texture tile (u and v), per layer. */
export const GROUND_TILE_METERS: number[] = GROUNDS.map((d) => d.W);

type Def = (typeof FACADE_DEFS)[number];

function run(def: Def, size: number): TexLayer {
  const t = new Tex(size, def.W);
  def.gen(t);
  return finish(t, { normal: def.normal, aoK: def.aoK, aoR: def.aoR });
}

export function generateFacadeLayer(index: number, size: number = TEX_SIZE): TexLayer {
  const def = FACADE_DEFS[index];
  if (!def) throw new Error(`texgen: facade layer ${index} out of range`);
  return run(def, size);
}

export function generateGroundLayer(index: number, size: number = TEX_SIZE): TexLayer {
  const def = GROUNDS[index];
  if (!def) throw new Error(`texgen: ground layer ${index} out of range`);
  return run(def, size);
}
