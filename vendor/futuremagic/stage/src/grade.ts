// @ts-nocheck -- TSL node math; checked by rendering it.
/**
 * AgX tone mapping with a look (a small colour grade) on top, in the output pass: no material shader
 * changes with it, and the look is uniforms, so a game can change it every frame (by time of day,
 * weather, place) without a shader build.
 *
 * AgX (Troy Sobotka; three.js's TSL port, MIT) keeps the hue of bright light: sunlit colours, fire and
 * the sky do not drift yellow or cyan as they do with ACES. The look is the ASC CDL as Blender's AgX
 * looks apply it (slope, offset, power per channel, then saturation), between AgX's curve and its outset,
 * so "Punchy" is power 1.35 and saturation 1.4.
 */
import { Vector3 } from 'three/webgpu';
import { Fn, clamp, dot, float, log2, mat3, max, mix, mul, pow, uniform, vec3 } from 'three/tsl';

/**
 * The look's uniforms; defaults are a mild punch (between AgX's base and its Punchy look). With them, an
 * exposure about 1.5x the one used with ACES keeps mid-grey where it was.
 */
export const GRADE = {
  slope: uniform(new Vector3(1, 1, 1)),
  offset: uniform(new Vector3(0, 0, 0)),
  power: uniform(new Vector3(1.2, 1.2, 1.2)),
  saturation: uniform(1.15),
};

const SRGB_TO_REC2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
const REC2020_TO_SRGB = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
const INSET = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
const OUTSET = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
const MIN_EV = -12.47393, MAX_EV = 4.026069;

const contrast = Fn(([x0]) => {
  const x = vec3(x0).toVar();
  const x2 = x.mul(x).toVar();
  const x4 = x2.mul(x2).toVar();
  return float(15.5).mul(x4.mul(x2)).sub(mul(40.14, x4.mul(x))).add(mul(31.96, x4).sub(mul(6.868, x2.mul(x))).add(mul(0.4298, x2).add(mul(0.1191, x).sub(0.00232))));
});

/** For `renderer.library.addToneMapping(gradedAgX, CustomToneMapping)`. */
export const gradedAgX = Fn(([color, exposure]) => {
  const c = vec3(color).mul(exposure).toVar();
  c.assign(INSET.mul(SRGB_TO_REC2020.mul(c)));
  c.assign(clamp(log2(max(c, 1e-10)).sub(MIN_EV).div(MAX_EV - MIN_EV), 0.0, 1.0));
  c.assign(contrast(c));
  // The look.
  c.assign(pow(max(c.mul(GRADE.slope).add(GRADE.offset), 0.0), GRADE.power));
  const luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c.assign(mix(vec3(luma), c, GRADE.saturation));
  c.assign(OUTSET.mul(c));
  c.assign(pow(max(vec3(0.0), c), vec3(2.2)));
  return clamp(REC2020_TO_SRGB.mul(c), 0.0, 1.0);
}).setLayout({ name: 'gradedAgX', type: 'vec3', inputs: [{ name: 'color', type: 'vec3' }, { name: 'exposure', type: 'float' }] });
