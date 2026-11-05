/**
 * Small meshes carrying the city's own materials (facades, ground, terrain, water, trees, street
 * furniture), built from the same factories the streamers use, for compiling on the start screen
 * (game/Preload). The materials are the same in every city (the seed decides only where things
 * stand), so the programs compiled here are the ones the city's meshes use after Start (WebGL
 * reuses a program by its code; WebGPU its GPU shader modules).
 */
import * as THREE from 'three';
import type { TextureLibrary } from './TextureLibrary';
import { createFacadeMaterial, createElemDepthMaterial } from './materials/facade';
import { createGroundMaterial, createTerrainMaterial, createWaterMaterial } from './materials/ground';
import { createBarkMaterial, createLeafMaterial, createFarTreeMaterial, vegetationWarmup, TREE_SPECIES } from '../props/vegetation';
import { furnitureModel, createFurnitureMaterial } from '../props/furniture';

export function cityWarmup(tex: TextureLibrary): THREE.Group {
  const g = new THREE.Group();
  g.name = 'city-warmup';
  // (A triangle with the attributes of the city's facade and ground meshes, as Rural's warm-up.)
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  for (const [n, s] of [['normal', 3], ['uv', 2], ['aLayer', 1], ['aTint', 3], ['aFacade', 4], ['aSeed', 1], ['aElem', 1]] as const) geo.setAttribute(n, new THREE.BufferAttribute(new Float32Array(3 * s), s));
  const elem = new THREE.DataTexture(new Uint8Array(1024 * 2).fill(255), 1024, 1, THREE.RGFormat, THREE.UnsignedByteType);
  elem.needsUpdate = true;
  const mesh = (mat: THREE.Material, shadow: boolean, depth?: THREE.Material) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadow;
    m.receiveShadow = true;
    if (depth) m.customDepthMaterial = depth;
    g.add(m);
  };
  mesh(createFacadeMaterial(tex.facade, elem, 1024), true, createElemDepthMaterial(elem, 1024));
  mesh(createFacadeMaterial(tex.facade, null), true);
  mesh(createGroundMaterial(tex.ground), false);
  mesh(createTerrainMaterial(tex.ground), false);
  mesh(createWaterMaterial(false), false);
  mesh(createWaterMaterial(true), false);
  g.add(vegetationWarmup(createBarkMaterial(), createFarTreeMaterial(), (sp) => createLeafMaterial(sp), TREE_SPECIES, [createLeafMaterial(undefined)]));
  const fg = furnitureModel('bench', 0).geometry.clone();
  fg.setAttribute('iColor', new THREE.InstancedBufferAttribute(new Float32Array(3), 3));
  fg.setAttribute('iState', new THREE.InstancedBufferAttribute(new Float32Array(4), 4));
  const im = new THREE.InstancedMesh(fg, createFurnitureMaterial(), 1);
  im.castShadow = true;
  g.add(im);
  return g;
}
