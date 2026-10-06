// @ts-nocheck -- three's TSL typings infer swizzles and vector widths poorly; this file is checked by rendering it (see docs/WEBGPU_PLAN.md).
/**
 * The sky for the WebGPU renderer: three's SkyMesh (TSL port of `Sky`) with the game's changes
 * from `SkySystem.makeSky` (sun disc and glow, the moon, weather, horizon fog, reversed depth).
 *
 * The uniforms are exposed as `material.uniforms.<name>.value`, exactly like the GLSL `Sky`, so
 * SkySystem drives both the same way.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, float, floor, fract, vec2, vec3, vec4, acos, add, mul, clamp, cos, dot, exp, max, min, mix, modelViewProjection,
  normalize, positionWorld, pow, smoothstep, sub, varyingProperty, uniform, cameraPosition, If, Loop, cross, sqrt, log, select,
} from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export function makeSkyNode(reversed: boolean, env: boolean, sunR: number, moonR: number): THREE.Mesh {
  const material = new THREE.NodeMaterial();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  const U = {
    turbidity: uniform(4), rayleigh: uniform(1.4), mieCoefficient: uniform(0.004), mieDirectionalG: uniform(0.8),
    sunPosition: uniform(new THREE.Vector3()),
    cloudScale: uniform(0.0002), cloudSpeed: uniform(0.00002), cloudCoverage: uniform(0.35), cloudDensity: uniform(0.45), cloudElevation: uniform(0.5),
    showSunDisc: uniform(1), time: uniform(0),
    cloudDark: uniform(0), overcast: uniform(0), flash: uniform(0), flashDir: uniform(new THREE.Vector3(0, 0.5, 1)),
    skyFog: uniform(0), fogCol: uniform(new THREE.Color()),
    sunCosR: uniform(Math.cos(env ? 0.0093 : sunR)), moonDir: uniform(new THREE.Vector3(0, -1, 0)), moonSun: uniform(new THREE.Vector3(0, 1, 0)), moonBright: uniform(0),
  };
  (material as unknown as { uniforms: typeof U }).uniforms = U;

  const vSunDirection = varyingProperty('vec3') as N;
  const vSunE = varyingProperty('float') as N;
  const vBetaR = varyingProperty('vec3') as N;
  const vBetaM = varyingProperty('vec3') as N;

  const vertexNode = Fn(() => {
    const e = float(2.718281828459045);
    const totalRayleigh = vec3(5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5);
    const MieConst = vec3(1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14);
    const cutoffAngle = float(1.6110731556870734);
    const steepness = float(1.5);
    const EE = float(1000.0);
    const sunDirection = normalize(U.sunPosition);
    vSunDirection.assign(sunDirection);
    const zenithAngleCos = clamp(sunDirection.y, -1, 1);
    vSunE.assign(EE.mul(max(0.0, float(1.0).sub(pow(e, cutoffAngle.sub(acos(zenithAngleCos)).div(steepness).negate())))));
    const sunfade = float(1.0).sub(clamp(float(1.0).sub(exp(U.sunPosition.y.div(450000.0))), 0, 1));
    const rayleighCoefficient = U.rayleigh.sub(float(1.0).mul(float(1.0).sub(sunfade)));
    vBetaR.assign(totalRayleigh.mul(rayleighCoefficient));
    const c = float(0.2).mul(U.turbidity).mul(10e-18);
    vBetaM.assign(float(0.434).mul(c).mul(MieConst).mul(U.mieCoefficient));
    const position = modelViewProjection as N;
    // Always at the far plane (z = 0 with a reversed depth buffer).
    if (reversed) position.z.assign(0.0);
    else position.z.assign(position.w);
    return position;
  })();

  const colorNode = Fn(() => {
    const pi = float(3.141592653589793);
    const rayleighZenithLength = float(8.4e3);
    const mieZenithLength = float(1.25e3);
    const THREE_OVER_SIXTEENPI = float(0.05968310365946075);
    const ONE_OVER_FOURPI = float(0.07957747154594767);
    const direction = normalize(positionWorld.sub(cameraPosition)).toVar();
    const zenithAngle = acos(max(0.0, direction.y));
    const inverse = float(1.0).div(cos(zenithAngle).add(float(0.15).mul(pow(float(93.885).sub(zenithAngle.mul(180.0).div(pi)), -1.253))));
    const sR = rayleighZenithLength.mul(inverse);
    const sM = mieZenithLength.mul(inverse);
    const Fex = exp(mul(vBetaR, sR).add(mul(vBetaM, sM)).negate()).toVar();
    const cosTheta = dot(direction, vSunDirection).toVar();
    const cc = cosTheta.mul(0.5).add(0.5);
    const rPhase = THREE_OVER_SIXTEENPI.mul(float(1.0).add(pow(cc, 2.0)));
    const betaRTheta = vBetaR.mul(rPhase);
    const g2 = pow(U.mieDirectionalG, 2.0);
    const inv = float(1.0).div(pow(float(1.0).sub(float(2.0).mul(U.mieDirectionalG).mul(cosTheta)).add(g2), 1.5));
    const mPhase = ONE_OVER_FOURPI.mul(float(1.0).sub(g2)).mul(inv);
    const betaMTheta = vBetaM.mul(mPhase);
    const Lin = pow(vSunE.mul(add(betaRTheta, betaMTheta).div(add(vBetaR, vBetaM))).mul(sub(1.0, Fex)), vec3(1.5)).toVar();
    Lin.mulAssign(mix(vec3(1.0), pow(vSunE.mul(add(betaRTheta, betaMTheta).div(add(vBetaR, vBetaM))).mul(Fex), vec3(1.0 / 2.0)), clamp(pow(sub(1.0, vSunDirection.y), 5.0), 0.0, 1.0)));
    const L0 = vec3(0.1).mul(Fex);

    // Sun disc (sharp, our radius); on screen bright but not blown out, so it keeps its colour.
    const sundisc = smoothstep(U.sunCosR.sub(0.00002), U.sunCosR.add(0.00002), cosTheta).mul(U.showSunDisc);
    const sundiscColor = (env
      ? min(vSunE.mul(Fex), 80.0).mul(760.0).mul(sundisc).mul(sub(1.0, U.overcast))
      : Fex.div(max(max(Fex.r, Fex.g), max(Fex.b, 1e-4))).mul(sundisc).mul(sub(1.0, U.overcast))
        .mul(mix(9.0, 30.0, smoothstep(0.0, 0.35, vSunDirection.y))).mul(smoothstep(0.0, 0.05, vSunE.div(1000.0)))).toVar();

    // The glare around a low sun is compressed on screen (above a soft knee).
    const skyC = add(Lin, L0).mul(0.04).toVar();
    if (!env) {
      const skyL = max(max(skyC.r, skyC.g), skyC.b);
      skyC.assign(select(skyL.greaterThan(1.0), skyC.mul(float(1.0).add(log(skyL)).div(skyL)), skyC));
    }
    const texColor = skyC.add(sundiscColor).add(vec3(0.0, 0.0003, 0.00075)).toVar();
    // A soft glow around the sun.
    const cz = max(cosTheta, 0.0);
    texColor.addAssign(min(vSunE.mul(Fex), 80.0).mul(float(0.05).mul(pow(cz, 6000.0)).add(float(0.003).mul(pow(cz, 400.0))))
      .mul(U.showSunDisc).mul(sub(1.0, U.overcast)).mul(smoothstep(-0.05, 0.02, direction.y)));

    const gradient = Fn(([i]: N[]) => {
      const p = fract(i.xyx.mul(vec3(0.1031, 0.1030, 0.0973))).toVar();
      p.addAssign(dot(p, p.yzx.add(33.33)));
      return fract(p.xx.add(p.yz).mul(p.zy)).mul(2.0).sub(1.0);
    });
    const noise = Fn(([p]: N[]) => {
      const i = floor(p);
      const f = fract(p);
      const u = f.mul(f).mul(f).mul(f.mul(f.mul(6.0).sub(15.0)).add(10.0));
      const a = dot(gradient(i), f);
      const b = dot(gradient(i.add(vec2(1.0, 0.0))), f.sub(vec2(1.0, 0.0)));
      const c = dot(gradient(i.add(vec2(0.0, 1.0))), f.sub(vec2(0.0, 1.0)));
      const d = dot(gradient(i.add(vec2(1.0, 1.0))), f.sub(vec2(1.0, 1.0)));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y).mul(1.6);
    });
    const fbm = Fn(([position, drift]: N[]) => {
      const p = vec2(position).toVar();
      const result = float(0.0).toVar();
      const amplitude = float(1.0).toVar();
      Loop(4, () => {
        result.addAssign(amplitude.mul(noise(p)));
        amplitude.mulAssign(0.5);
        p.mulAssign(2.0).addAssign(drift);
      });
      return result;
    });

    // The moon: a sphere lit from the sun's side (its phase), maria, craters, reddened low down.
    if (!env) {
      const cosM = dot(direction, U.moonDir);
      If(U.moonBright.greaterThan(0.0).and(cosM.greaterThan(Math.cos(moonR * 1.05))), () => {
        const mRight = normalize(cross(U.moonDir, vec3(0.0, 1.0, 0.0)));
        const mUp = cross(mRight, U.moonDir);
        const mp = vec2(dot(direction, mRight), dot(direction, mUp)).div(moonR).toVar();
        const mr2 = dot(mp, mp);
        const mDisc = float(1.0).sub(smoothstep(0.92, 1.0, mr2));
        const mN = mp.x.mul(mRight).add(mp.y.mul(mUp)).sub(sqrt(max(0.0, float(1.0).sub(mr2))).mul(U.moonDir));
        const mLit = smoothstep(-0.04, 0.12, dot(mN, U.moonSun));
        const maria = smoothstep(0.05, 0.45, noise(mp.mul(1.7).add(vec2(3.1, 7.4))).mul(0.7).add(noise(mp.mul(3.9).add(vec2(1.3, 2.9))).mul(0.3)));
        const craters = smoothstep(0.35, 0.7, noise(mp.mul(6.0).add(vec2(5.7, 0.4)))).mul(0.14);
        const mAlb = float(1.0).sub(maria.mul(0.38)).mul(float(1.0).sub(craters));
        const mCol = vec3(0.92, 0.9, 0.85).mul(mAlb).mul(mLit.add(0.006))
          .mul(mix(vec3(1.0, 0.62, 0.38), vec3(1.0), smoothstep(0.0, 0.22, direction.y)));
        texColor.addAssign(mCol.mul(mDisc).mul(U.moonBright).mul(sub(1.0, U.overcast)).mul(smoothstep(-0.01, 0.02, direction.y)));
      });
    }

    If(direction.y.greaterThan(0.0).and(U.cloudCoverage.greaterThan(0.0)), () => {
      const elevation = mix(1.0, 0.1, U.cloudElevation);
      const cloudUV = direction.xz.div(direction.y.mul(elevation)).toVar();
      cloudUV.mulAssign(U.cloudScale);
      cloudUV.addAssign(U.time.mul(U.cloudSpeed));
      const evolve = U.time.mul(U.cloudSpeed).mul(300.0);
      const cloudNoise = fbm(cloudUV.mul(1000.0), evolve).mul(0.7).add(0.5).clamp(0.0, 1.0).toVar();
      const region = noise(cloudUV.mul(300.0)).mul(0.37).add(0.5);
      const cov = clamp(U.cloudCoverage.add(region.sub(0.5).mul(0.6)), 0.0, 1.0);
      const threshold = sub(1.0, cov).toVar();
      const cloudMask = smoothstep(threshold, threshold.add(0.3), cloudNoise).toVar();
      const horizonFade = smoothstep(0.0, add(0.03, mul(0.06, U.cloudElevation)), direction.y);
      cloudMask.mulAssign(horizonFade);
      const dayFactor = smoothstep(-0.08, 0.3, vSunDirection.y);
      const sunColor = vSunE.mul(Fex).mul(0.22).mul(0.04).toVar();
      const skyAmbient = Lin.mul(0.04).add(vec3(0.0, 0.0003, 0.00075));
      const depth = max(0.0, cloudNoise.sub(threshold)).toVar();
      const beer = exp(depth.mul(-4.0)).toVar();
      const powder = sub(1.0, beer.mul(beer));
      const shade = mix(0.45, 1.0, beer.mul(powder).mul(2.6).clamp(0.0, 1.0));
      const silver = float(0.51).div(pow(sub(1.49, cosTheta.mul(1.4)), 1.5)).clamp(0.0, 3.0);
      const edge = cloudMask.mul(sub(1.0, cloudMask)).mul(4.0);
      const cloudColor = skyAmbient.add(sunColor.mul(shade)).toVar();
      cloudColor.addAssign(sunColor.mul(silver).mul(edge).mul(0.6));
      cloudColor.mulAssign(dayFactor.max(0.03));
      // Weather: darker clouds, lightning lighting them.
      cloudColor.mulAssign(sub(1.0, U.cloudDark.mul(0.72)));
      cloudColor.addAssign(vec3(0.75, 0.8, 1.0).mul(U.flash).mul(add(0.25, pow(max(dot(direction, U.flashDir), 0.0), 8.0).mul(2.5))).mul(3.0));
      const alpha = sub(1.0, exp(depth.mul(U.cloudDensity).mul(-12.0))).mul(horizonFade).toVar();
      texColor.subAssign(L0.mul(0.04).mul(alpha));
      const cloudAerial = mix(texColor, cloudColor, Fex);
      texColor.assign(mix(texColor, cloudAerial, alpha));
    });

    // Overcast (grey, no blue), lightning, fog towards the horizon (everywhere in thick fog).
    const skyLum = dot(texColor, vec3(0.2126, 0.7152, 0.0722));
    texColor.assign(mix(texColor, vec3(skyLum).mul(sub(0.72, U.cloudDark.mul(0.4))), U.overcast));
    texColor.addAssign(vec3(0.7, 0.75, 0.9).mul(U.flash).mul(0.5).mul(add(0.3, pow(max(dot(direction, U.flashDir), 0.0), 4.0))));
    const hz = sub(1.0, smoothstep(-0.02, 0.4, direction.y));
    texColor.assign(mix(texColor, U.fogCol, clamp(U.skyFog.mul(mix(hz, 1.0, U.skyFog.mul(U.skyFog))), 0.0, 1.0)));
    return vec4(texColor, 1.0);
  })();

  material.side = THREE.BackSide;
  material.depthWrite = false;
  material.fog = false;
  material.vertexNode = vertexNode;
  material.colorNode = colorNode;
  return mesh;
}
