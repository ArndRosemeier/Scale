/**
 * Binary asset format of the converted MakeHuman data in
 * `public/assets/human/` (written by `tools/build-human-assets.ts`).
 *
 * Everything lives in one little-endian binary blob (`human.bin`) plus this
 * JSON manifest describing typed-array sections. Coordinates are already in
 * Norgo space: meters, Y up, character facing −Z, base mesh origin at the
 * MakeHuman origin (pelvis); the runtime moves the feet to y = 0 after morphing.
 *
 * Vertex spaces:
 *  - "morph vertices" (N = realVerts + virtualVerts): the MakeHuman vertices we
 *    keep (body, tongue, teeth, eyelashes, eye helpers) followed by virtual
 *    vertices = weighted means of MakeHuman joint helper vertices. Because
 *    morphs are linear, morphing a virtual vertex yields the morphed joint, so
 *    the skeleton is recomputed exactly from any morphed body.
 *  - "render vertices": morph vertices split at UV seams; `renderSrc` maps
 *    each render vertex to its morph vertex.
 */
import type { MacroTargetVars } from './macro';

export type SectionType = 'f32' | 'i16' | 'i8' | 'u16' | 'u8' | 'u32';

export interface Section {
  offset: number;
  length: number;
  type: SectionType;
}

export interface BoneDef {
  name: string;
  /** Parent index (-1 = root). Parents always precede children. */
  parent: number;
  /** Morph (virtual) vertex index of the bone head / tail. */
  head: number;
  tail: number;
}

export interface SubMesh {
  name: 'body' | 'tongue' | 'teeth' | 'lashes';
  /** Range into the `index` section. */
  start: number;
  count: number;
}

export interface LocalTargetDef {
  name: string;
  /** Range into localIdx{bits} / localDelta{bits} (entries, not bytes). */
  start: number;
  count: number;
  /** Dequantization scale (m per quantum). Negative = data shared with the mirrored partner target. */
  scale: number;
  /** Quantization: int8 for small face targets, int16 for large ones. */
  bits: 8 | 16;
}

export interface HumanManifest {
  version: number;
  license: string;
  file: string;
  bytes: number;
  realVerts: number;
  virtualVerts: number;
  morphVerts: number;
  renderVerts: number;
  sections: Record<string, Section>;
  submeshes: SubMesh[];
  /** Index ranges (into `lodIndex`) of the decimated body LODs, finest first. */
  lods: { tris: number; start: number; count: number }[];
  bones: BoneDef[];
  /** Morph vertex ranges [start, count] of helper groups. */
  groups: Record<'eyeL' | 'eyeR' | 'tongue' | 'teeth' | 'lashes', [number, number]>;
  pca: {
    components: number;
    /** The first N components are int16 (pcaBasis16), the rest int8 (pcaBasis8). */
    int16Components: number;
    /** Macro target names (file stems) in projection-row order. */
    targets: string[];
    vars: MacroTargetVars;
    /** Dequantization scale of each basis component and of the mean. */
    scales: number[];
    meanScale: number;
    /** Projection of the mean onto every component (subtracted from coefficients). */
    meanProj: number[];
    /** Reconstruction error stats from the converter (m). */
    error: { rms: number; max: number };
  };
  local: LocalTargetDef[];
  expressions: {
    names: string[];
    /** Number of face vertices (entries in exprVerts). */
    faceVerts: number;
    scale: number;
  };
}

export const HUMAN_ASSET_VERSION = 1;
export const HUMAN_ASSET_DIR = 'assets/human/';

/**
 * `conform.json` + `conform.bin` (tools/avatar/base-bodies/conform.py): the MakeHuman mesh
 * reshaped onto the Woman / Man base bodies. `female` / `male` are per morph-vertex
 * offsets (i16 × offsetScale m) added after the macro morph, blended by gender;
 * `skinIdx` / `skinW` replace MakeHuman's skin weights (taken from the Woman's rig).
 */
export interface ConformManifest {
  version: number;
  file: string;
  morphVerts: number;
  realVerts: number;
  offsetScale: number;
  sections: Record<'female' | 'male' | 'skinIdx' | 'skinW', Section>;
}
