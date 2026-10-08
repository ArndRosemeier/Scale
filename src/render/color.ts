/**
 * Colour conversions. Appearance and prop colours are authored in sRGB (0..1); three.js works in
 * linear light. Use these instead of a local `lin` (see docs/CONVENTIONS.md).
 */
import * as THREE from 'three';

export type RGB = readonly [number, number, number];

/** A three.js colour from an sRGB triple (converted to linear, like `setRGB(…, SRGBColorSpace)`). */
export function srgbColor(c: RGB): THREE.Color {
  return new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
}
