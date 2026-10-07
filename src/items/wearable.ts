/**
 * Wearable contract between the items module (what an item looks like when
 * worn) and the humanoid module (how it is fitted to a body).
 *
 * Soft garments are *shells*: the humanoid module duplicates body vertices
 * of the listed regions, pushes them out along the normal by `offset`, and
 * skins them with the body's weights, so clothing deforms perfectly with any
 * body shape and animation. Optional skirts/robes extend below the pelvis.
 *
 * Hard parts (helmets, pauldrons, weapons, belts' pouches...) are *rigid*:
 * meshes built by the items module and attached to a bone socket.
 */
import type * as THREE from 'three';
import type { ItemVisual } from './types';

/** Abstract body regions (the humanoid module maps them to skin weights / bones). */
export type BodyRegion =
  | 'scalp' | 'face' | 'neck' | 'chest' | 'belly' | 'back' | 'pelvis' | 'buttocks'
  | 'upperarm.L' | 'upperarm.R' | 'forearm.L' | 'forearm.R' | 'hand.L' | 'hand.R'
  | 'thigh.L' | 'thigh.R' | 'shin.L' | 'shin.R' | 'foot.L' | 'foot.R';

/** Abstract bone sockets for rigid parts. */
export type Socket =
  | 'head' | 'neck' | 'chest' | 'spine' | 'pelvis' | 'back'
  | 'shoulder.L' | 'shoulder.R' | 'upperarm.L' | 'upperarm.R' | 'forearm.L' | 'forearm.R'
  | 'hand.L' | 'hand.R' | 'thigh.L' | 'thigh.R' | 'shin.L' | 'shin.R' | 'foot.L' | 'foot.R'
  | 'hip.L' | 'hip.R';

export interface ShellMaterial {
  /** sRGB 0..1 */
  color: [number, number, number];
  color2: [number, number, number];
  /** Pattern drawn procedurally in the shell shader. */
  pattern: 'plain' | 'stripes' | 'checks' | 'quilted' | 'chainmail' | 'scales' | 'leather' | 'fur' | 'embroidered' | 'patchwork' | 'silk' | 'plates' | 'runes' | 'bones';
  patternScale: number;
  roughness: number;
  metalness: number;
  sheen: number;
  glow: number;
  glowColor: [number, number, number];
  wear: number;
}

export interface ShellLayer {
  kind: 'shell';
  /** Regions covered. `cut` limits coverage along the limb (0 = proximal joint, 1 = distal joint), e.g. short sleeves. */
  regions: { region: BodyRegion; from?: number; to?: number }[];
  /** Push-out distance (m) — inner garments small (0.004), coats larger (0.02). */
  offset: number;
  /** Draw order between layers (higher = outer). */
  layer: number;
  material: ShellMaterial;
  /** Robes/skirts/coat tails hanging below the pelvis. length in m, flare 0..1 */
  skirt?: { length: number; flare: number; slits?: number };
  /** Hood or cowl. */
  hood?: boolean;
  /** Small collar/trim. */
  trim?: { width: number; color: [number, number, number] };
}

export interface RigidPart {
  kind: 'rigid';
  socket: Socket;
  /** Builds the mesh in socket space. Body measures allow fitting (head radius, shoulder width...). */
  build(fit: BodyFit): THREE.Object3D;
  /** Mirror for the other side (pauldrons, gauntlets) is created by the items module as a separate part. */
}

/** Measurements the humanoid module provides so rigid parts fit any body. */
export interface BodyFit {
  height: number;
  headRadius: number;
  neckRadius: number;
  shoulderWidth: number;
  chestDepth: number;
  waistRadius: number;
  upperArmRadius: number;
  forearmRadius: number;
  handLength: number;
  thighRadius: number;
  shinRadius: number;
  footLength: number;
  /** Horns/ears that helmets must leave room for. */
  earPoint: number;
  hasHorns: boolean;
}

export interface WearableSpec {
  layers: (ShellLayer | RigidPart)[];
  /** Hide scalp hair (helmets, hoods up). */
  hideHair?: boolean;
  /** Hide beard (full helms). */
  hideBeard?: boolean;
  /** Hide body regions entirely under rigid armor to avoid poke-through. */
  hideRegions?: BodyRegion[];
}

/** Implemented by the items module. */
export type WearableResolver = (defId: string, visual: ItemVisual) => WearableSpec | null;
