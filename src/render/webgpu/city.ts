// @ts-nocheck -- three's TSL typings infer swizzles and vector widths poorly; checked by rendering (docs/WEBGPU_PLAN.md).
/**
 * The rest of the city group: clear landmark glass (render/materials/clearGlass.ts) and the far
 * skyline boxes (stream/Skyline.ts) as node materials.
 */
import * as THREE from 'three/webgpu';
import {
  float, int, ivec2, vec2, vec3, mix, abs, fract, floor, fwidth, length, smoothstep, sub, step, select, max, distance,
  attribute, varying, texture, textureLoad, uniformArray, positionLocal, normalGeometry, uniform, Fn, If, Loop, mod, struct,
} from 'three/tsl';
import type { MaterialArrays } from '../TextureLibrary';
import { h21, GN, elemState } from './common';
import { setDiffuse } from './ground';

function glass(): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial({
    color: 0xcfe6f0, roughness: 0.06, metalness: 0.05, transparent: true, opacity: 0.22,
    side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 1.4, specularIntensity: 1,
  });
  // Warm glow at night (lit insides behind it).
  m.emissiveNode = vec3(new THREE.Color(0xffe2b0)).mul(GN.uNight.mul(0.12));
  return m;
}

let shared: THREE.MeshPhysicalNodeMaterial | null = null;
export function clearGlassNodeMaterial(): THREE.MeshPhysicalNodeMaterial { return (shared ??= glass()); }

export function clearGlassElemNodeMaterial(elemTex: THREE.Texture, elemW: number): THREE.MeshPhysicalNodeMaterial {
  const m = glass();
  const el = elemState(elemTex, elemW);
  m.positionNode = select(el.alive.lessThan(0.5), vec3(0.0), positionLocal);
  return m;
}

const SkySurf = struct({ col: 'vec3', rough: 'float', metal: 'float', emis: 'vec3' }, 'SkylineSurf');

/**
 * Far skyline boxes. On WebGPU the geometry carries `iS` (instance scale xyz) and `iP` (instance
 * centre xz) since the node material does not read the instance matrix columns.
 */
export function skylineNodeMaterial(arrays: MaterialArrays, mask: THREE.Texture, maskW: number, ruins: THREE.Vector4[]): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
  const uTile = uniformArray(arrays.tileMeters.slice(0, 24).concat(new Array(Math.max(0, 24 - arrays.tileMeters.length)).fill(2)), 'float');
  const uRuin = uniformArray(ruins, 'vec4');
  const { uNight, uLitFrac } = GN;
  const iA = attribute('iA', 'vec4'), iB = attribute('iB', 'vec4'), iS = attribute('iS', 'vec4'), iP = attribute('iP', 'vec4');

  mat.positionNode = Fn(() => {
    const hide = float(0).toVar();
    const c = int(iA.w.add(0.5));
    const W = int(maskW);
    If(textureLoad(mask, ivec2(c.mod(W), c.div(W))).r.lessThan(0.5), () => { hide.assign(1.0); });
    Loop(4, ({ i }) => {
      const r = uRuin.element(i);
      If(r.w.greaterThan(0.5).and(distance(iP.xy, r.xy).lessThan(r.z)), () => { hide.assign(1.0); });
    });
    return select(hide.greaterThan(0.5), vec3(0.0), positionLocal);
  })();

  const n = normalGeometry, p = attribute('position', 'vec3');
  // Facade uv in metres: along the face and up.
  const vFUv = varying(select(abs(n.x).greaterThan(0.5), vec2(p.z.add(0.5).mul(iS.z), p.y.mul(iS.y)), vec2(p.x.add(0.5).mul(iS.x), p.y.mul(iS.y))), 'vFUv');
  const vTop = varying(step(0.5, n.y), 'vTop');

  const surf = Fn(() => {
    const layer = int(iA.x.add(0.5)).toVar();
    const wall = texture(arrays.albedo, vFUv.div(uTile.element(layer))).depth(layer).rgb.mul(iB.rgb).toVar();
    const rough = float(0.85).toVar(), metal = float(0.0).toVar(), emis = vec3(0.0).toVar();
    const isGlass = mod(iA.z, 2.0).greaterThan(0.5);
    const col = wall.toVar();
    If(vTop.greaterThan(0.5), () => { col.assign(vec3(0.32, 0.31, 0.3)); }).Else(() => {
      const fh = max(iA.y, 2.6);
      const cell = vec2(vFUv.x.div(select(isGlass, 1.6, 2.6)), vFUv.y.div(fh));
      const f = fract(cell);
      const id = floor(cell);
      const px = length(fwidth(cell));
      const win = select(isGlass, f.y.greaterThan(0.25), f.x.greaterThan(0.22).and(f.x.lessThan(0.78)).and(f.y.greaterThan(0.3)).and(f.y.lessThan(0.85)));
      const aa = sub(1.0, smoothstep(0.25, 0.6, px)).toVar();
      const lit = step(h21(id.add(iB.w.mul(91.0))), uLitFrac);
      If(win, () => {
        col.assign(mix(col, select(isGlass, vec3(0.08, 0.12, 0.16), vec3(0.06, 0.07, 0.08)), aa.mul(select(isGlass, 0.95, 0.85))));
        rough.assign(mix(0.85, 0.08, aa)); metal.assign(select(isGlass, aa.mul(0.6), 0.0));
        emis.assign(vec3(1.0, 0.82, 0.55).mul(lit.mul(1.2).mul(uNight)));
      }).ElseIf(isGlass, () => { col.assign(mix(col, vec3(0.2, 0.22, 0.25), 0.8)); metal.assign(0.4); rough.assign(0.3); });
      // Distant average of the pattern so nothing shimmers.
      const avg = mix(wall, select(isGlass, vec3(0.1, 0.14, 0.18), wall.mul(0.7)), select(isGlass, 0.85, 0.35));
      col.assign(mix(avg, col, aa));
      emis.addAssign(vec3(1.0, 0.8, 0.55).mul(sub(1.0, aa).mul(uNight).mul(uLitFrac).mul(0.6)));
    });
    return SkySurf(col, rough, metal, emis);
  });
  const S = surf().toVar('skylineS');
  setDiffuse(mat, () => S.get('col'));
  mat.roughnessNode = S.get('rough');
  mat.metalnessNode = S.get('metal');
  mat.emissiveNode = S.get('emis');
  return mat;
}
