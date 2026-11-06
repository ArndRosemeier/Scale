// @ts-nocheck -- TSL node math; checked by rendering it.
/**
 * AgX with the look (render/look.ts) for the WebGPU post pipeline: @futuremagic/stage's gradedAgX, built
 * inline instead of as a laid-out function. (A laid-out Fn keeps the code of its first build, and its
 * uniforms' names from that shader: once Post rebuilt its pipeline (bloom or SMAA switched by the
 * graphics settings), the grade read the bloom's texture as its slope and failed to compile.)
 */
import { Vector3 } from 'three/webgpu';
import { clamp, dot, float, log2, mat3, max, mix, mul, pow, uniform, vec3 } from 'three/tsl';
import { LOOK } from '../look';

export const GRADE_U = {
  slope: uniform(new Vector3(1, 1, 1)),
  offset: uniform(new Vector3(0, 0, 0)),
  power: uniform(1),
  saturation: uniform(1),
};

/** Copy LOOK into the uniforms (once per frame). */
export function syncGrade(): void {
  GRADE_U.slope.value.fromArray(LOOK.slope);
  GRADE_U.offset.value.fromArray(LOOK.offset);
  GRADE_U.power.value = LOOK.power;
  GRADE_U.saturation.value = LOOK.saturation;
}

const MIN_EV = -12.47393, MAX_EV = 4.026069;

/** Linear HDR colour (vec3) times `exposure` → display-linear colour, AgX with the look. */
export function gradedAgX(color, exposure) {
  const SRGB_TO_REC2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
  const REC2020_TO_SRGB = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
  const INSET = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const OUTSET = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  let c = INSET.mul(SRGB_TO_REC2020.mul(vec3(color).mul(exposure)));
  c = clamp(log2(max(c, 1e-10)).sub(MIN_EV).div(MAX_EV - MIN_EV), 0.0, 1.0).toVar();
  const x2 = c.mul(c).toVar();
  const x4 = x2.mul(x2).toVar();
  c = float(15.5).mul(x4.mul(x2)).sub(mul(40.14, x4.mul(c))).add(mul(31.96, x4).sub(mul(6.868, x2.mul(c))).add(mul(0.4298, x2).add(mul(0.1191, c).sub(0.00232))));
  // The look.
  c = pow(max(c.mul(GRADE_U.slope).add(GRADE_U.offset), 0.0), vec3(GRADE_U.power)).toVar();
  c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, GRADE_U.saturation);
  c = pow(max(vec3(0.0), OUTSET.mul(c)), vec3(2.2));
  return clamp(REC2020_TO_SRGB.mul(c), 0.0, 1.0);
}
