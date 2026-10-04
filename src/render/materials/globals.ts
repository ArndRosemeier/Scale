/** Uniform objects shared by every city material (same object references). */
import * as THREE from 'three';

export const G = {
  uTime: { value: 0 },
  /** 0 day … 1 full night. */
  uNight: { value: 0 },
  /** Outdoor light level 0..1 (used for interior brightness seen through windows). */
  uDayLight: { value: 1 },
  /** Fraction of windows lit (depends on hour). */
  uLitFrac: { value: 0.1 },
  /** Fraction of shop windows lit. */
  uShopLit: { value: 1 },
  /** Fraction of café / restaurant windows lit (opening hours, warm light). */
  uEatLit: { value: 1 },
  uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2) },
  /** Street light emission strength (0 day, 1 night). */
  uLampOn: { value: 0 },
  /** Wet ground and walls after rain 0..1 (render/Weather): darker, glossier streets, puddles. */
  uWet: { value: 0 },
};

/** A 1×1 "everything alive" element texture for meshes without destruction state. */
let aliveTex: THREE.DataTexture | null = null;
export function aliveTexture(): THREE.DataTexture {
  if (!aliveTex) {
    aliveTex = new THREE.DataTexture(new Uint8Array([255, 255]), 1, 1, THREE.RGFormat);
    aliveTex.needsUpdate = true;
  }
  return aliveTex;
}
