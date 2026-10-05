/**
 * Clear glass of the landmarks (the glazed walkway of a helix tower, glass orbs, domes and
 * balustrades): transparent and glossy, reflecting the environment, a faint tint and a little
 * glow at night (lit insides behind it). One material shared by all of them.
 */
import * as THREE from 'three';
import { G } from './globals';

let mat: THREE.MeshPhysicalMaterial | null = null;

export function clearGlassMaterial(): THREE.MeshPhysicalMaterial {
  if (mat) return mat;
  mat = new THREE.MeshPhysicalMaterial({
    color: 0xcfe6f0, roughness: 0.06, metalness: 0.05, transparent: true, opacity: 0.22,
    side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 1.4, specularIntensity: 1,
    emissive: new THREE.Color(0xffe2b0), emissiveIntensity: 0,
  });
  const m = mat;
  // Warm glow at night (G.uNight is shared by every city material).
  m.onBeforeRender = () => { m.emissiveIntensity = G.uNight.value * 0.12; };
  return m;
}
