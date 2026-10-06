// @ts-nocheck -- three's TSL typings infer swizzles and vector widths poorly; checked by rendering (docs/WEBGPU_PLAN.md).
/**
 * Rain streaks (render/Weather.ts RainFx) as a node material. Exposes `material.uniforms.<name>.value`
 * like the ShaderMaterial, so RainFx drives both the same way.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, vec3, vec4, abs, max, mod, length, smoothstep, sub, add, mul, attribute, positionGeometry, uniform, varyingProperty,
  cameraProjectionMatrix, cameraViewMatrix,
} from 'three/tsl';
import { shaderLike } from './fx';

export function createRainNodeMaterial(): THREE.LineBasicNodeMaterial {
  const U = {
    uCam: uniform(new THREE.Vector3()), uBox: uniform(30), uVel: uniform(new THREE.Vector3(0, -9, 0)), uLen: uniform(0.05),
    uT: uniform(0), uAlpha: uniform(0), uCol: uniform(new THREE.Color(0.7, 0.75, 0.8)),
  };
  const aDrop = attribute('aDrop', 'vec4');
  const position = positionGeometry;
  const vA = varyingProperty('float', 'vA');
  const vertex = Fn(() => {
    // Each drop falls at its own speed (90..110 %); wrapped into the box round the camera.
    const vel = U.uVel.mul(add(0.9, mul(0.2, aDrop.w))).toVar();
    const o = U.uCam.sub(vec3(U.uBox.mul(0.5))).toVar();
    const head = o.add(mod(aDrop.xyz.mul(U.uBox).add(vel.mul(U.uT)).sub(o), vec3(U.uBox))).toVar();
    const p = head.sub(vel.mul(U.uLen).mul(position.x));
    // Fade at the box faces (no popping as drops wrap) and right in front of the lens.
    const q = abs(head.sub(U.uCam)).div(U.uBox.mul(0.5));
    const edge = sub(1.0, smoothstep(0.7, 1.0, max(max(q.x, q.y), q.z)));
    const dc = length(head.sub(U.uCam)).div(U.uBox);
    vA.assign(edge.mul(smoothstep(0.015, 0.06, dc)).mul(add(0.55, mul(0.45, aDrop.w))).mul(sub(1.0, mul(0.6, position.x))));
    return cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(p, 1.0));
  })();
  const m = shaderLike({ line: true, vertex, fragment: vec4(U.uCol, vA.mul(U.uAlpha)), transparent: true, depthWrite: false });
  m.uniforms = U;
  return m;
}
