/**
 * The picture's look (from MasterWorld's lighting pass): AgX tone mapping with a small colour grade on
 * top (the ASC CDL as Blender's AgX looks apply it: slope, offset, power per channel, then saturation),
 * and a colour key over the day that moves the grade with the sun (golden late light, a cooler dusk,
 * a blue night, neutral by day).
 *
 * The grade runs in the output pass only (WebGL: Renderer's OutputPass, WebGPU: the Post pipeline), so
 * no material shader changes with it, and it is uniforms, so it can follow the sun every frame without a
 * shader build. Pure numbers here; the renderers copy LOOK into their uniforms each frame.
 */
import { gradeAt, type GradeKey } from '@futuremagic/stage/look';

/** The grade now (SkySystem sets slope and saturation from LOOK_KEYS each frame). */
export const LOOK = {
  slope: [1, 1, 1] as [number, number, number],
  offset: [0, 0, 0] as [number, number, number],
  /** Above 1 deepens the darks and gives the mid-tones more bite (AgX alone reads washed out). */
  power: 1.3,
  saturation: 1.25,
  /**
   * The grade's power darkens the mid-tones: SkySystem raises the exposure by this to keep mid-grey near
   * where plain AgX had it (the shade still ends up deeper, which is the point).
   */
  exposure: 1.4,
};

/** The colour key over the day, by sun height (sin of its elevation). */
export const LOOK_KEYS: readonly GradeKey[] = [
  { at: -0.3, slope: [0.9, 0.96, 1.12], saturation: 0.95 },
  { at: -0.08, slope: [0.96, 0.97, 1.08], saturation: 1.1 },
  { at: 0.04, slope: [1.06, 1.0, 0.94], saturation: 1.3 },
  { at: 0.25, slope: [1.03, 1.0, 0.97], saturation: 1.28 },
  { at: 0.6, slope: [1, 1, 1], saturation: 1.25 },
];

/** Set the grade for sun height `sunUp`; `neutral` 0..1 pulls it to the day key (underground, indoors: lamps set the colour). */
export function lookAt(sunUp: number, neutral: number): void {
  const g = gradeAt(LOOK_KEYS, sunUp + (1 - sunUp) * neutral);
  LOOK.slope[0] = g.slope[0]; LOOK.slope[1] = g.slope[1]; LOOK.slope[2] = g.slope[2];
  LOOK.saturation = g.saturation;
}

/**
 * How much of the sun's light gets through the air to the ground, per channel, relative to a sun straight
 * overhead: the sky shader's own extinction (Rayleigh + Mie at the sky's turbidity, Preetham's air mass),
 * so the light's colour matches the sky's. About white at noon, yellow in the afternoon, orange near the
 * horizon, deep red as it sets. (@futuremagic/sky's sunTransmittance.)
 */
export function sunTransmittance(sunUp: number, out: [number, number, number], turbidity = 4, rayleigh = 1.4, mie = 0.004): [number, number, number] {
  const c = 0.2 * turbidity * 10e-18;
  const depth = (up: number, i: number): number => {
    const z = Math.acos(Math.min(1, Math.max(0, up)));
    const inv = 1 / (Math.cos(z) + 0.15 * Math.pow(93.885 - (z * 180) / Math.PI, -1.253));
    return RAY[i]! * rayleigh * 8.4e3 * inv + 0.434 * c * MIE[i]! * mie * 1.25e3 * inv;
  };
  for (let i = 0; i < 3; i++) out[i] = Math.exp(depth(1, i) - depth(Math.max(sunUp, 0), i));
  return out;
}
const RAY = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];

/** GLSL for the WebGL output pass: AgX with LOOK between its curve and its outset (uniforms gradeSlope, gradeOffset, gradePower, gradeSat). */
export const GRADED_AGX_GLSL = /* glsl */ `
uniform vec3 gradeSlope;
uniform vec3 gradeOffset;
uniform float gradePower;
uniform float gradeSat;
vec3 gradedAgXContrast( vec3 x ) {
	vec3 x2 = x * x;
	vec3 x4 = x2 * x2;
	return + 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 GradedAgX( vec3 color ) {
	const mat3 toRec2020 = mat3( vec3( 0.6274, 0.0691, 0.0164 ), vec3( 0.3293, 0.9195, 0.0880 ), vec3( 0.0433, 0.0113, 0.8956 ) );
	const mat3 fromRec2020 = mat3( vec3( 1.6605, - 0.1246, - 0.0182 ), vec3( - 0.5876, 1.1329, - 0.1006 ), vec3( - 0.0728, - 0.0083, 1.1187 ) );
	const mat3 inset = mat3( vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ), vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ), vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 ) );
	const mat3 outset = mat3( vec3( 1.1271005818144368, - 0.1413297634984383, - 0.14132976349843826 ), vec3( - 0.11060664309660323, 1.157823702216272, - 0.11060664309660294 ), vec3( - 0.016493938717834573, - 0.016493938717834257, 1.2519364065950405 ) );
	const float minEv = - 12.47393;
	const float maxEv = 4.026069;
	color *= toneMappingExposure;
	color = inset * ( toRec2020 * color );
	color = clamp( ( log2( max( color, 1e-10 ) ) - minEv ) / ( maxEv - minEv ), 0.0, 1.0 );
	color = gradedAgXContrast( color );
	color = pow( max( color * gradeSlope + gradeOffset, 0.0 ), vec3( gradePower ) );
	float luma = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
	color = mix( vec3( luma ), color, gradeSat );
	color = outset * color;
	color = pow( max( vec3( 0.0 ), color ), vec3( 2.2 ) );
	return clamp( fromRec2020 * color, 0.0, 1.0 );
}
`;
