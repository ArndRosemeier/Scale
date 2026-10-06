// @ts-nocheck -- three's TSL typings infer swizzles and vector widths poorly; checked by rendering (docs/WEBGPU_PLAN.md).
/**
 * The humanoid materials as node materials: procedural skin with expressions and wrap/translucent
 * subsurface look (humanoid/client/skinMaterial.ts), garments (garmentMaterial.ts), fur-shell
 * hair (hairShells.ts), and eyes, strand-card hair with Kajiya–Kay highlights, horns, lashes,
 * teeth/tongue (partMaterials.ts). All with sky occlusion ('uniform').
 *
 * Kept line by line close to the GLSL. Vertex displacements that the GLSL applies to `transformed`
 * before skinning (expressions, shell offsets) go in through `setupPosition` ahead of three's
 * skinning (r186 applies `positionNode` *after* skinning). Like the WebGL depth material, the
 * shadow pass does not see them. Lighting replacements (skin SSS diffuse, hair Kajiya–Kay) wrap
 * the material's PhysicalLightingModel (see `onLightingModel`).
 */
import * as THREE from 'three/webgpu';
import {
  Fn, float, int, ivec2, vec2, vec3, vec4, mix, normalize, max, min, abs, fract, floor, fwidth, length, smoothstep, sub, add, mul, dot,
  step, sin, clamp, pow, select, If, Loop, attribute, texture, textureLoad, uniform, uniformArray, positionGeometry, normalGeometry,
  positionLocal, positionView, normalView, faceDirection, diffuseColor, struct, mod, exp2, atan, sign, saturate, sqrt, log2, uv,
  materialOpacity, materialEmissive, materialRoughness, tangentView, positionViewDirection, diffuseContribution, specularColor, specularF90,
  BRDF_Lambert, F_Schlick, Discard,
} from 'three/tsl';
import type { SkinUniforms, SkinMaterialHandle } from '../../humanoid/client/skinMaterial';
import type { GarmentHandle } from '../../humanoid/client/garmentMaterial';
import type { ShellSpec, ShellLayerHandle } from '../../humanoid/client/hairShells';
import type { PatchedMaterial, EyeUniforms, HairUniforms, HornUniforms } from '../../humanoid/client/partMaterials';
import type { ShellMaterial } from '../../items/wearable';
import { poreTexture, strandTexture, leafTexture } from '../../humanoid/client/textures';
import { setDiffuse } from './ground';
import { patchSkyOcclusionNode, onLightingModel, follow } from './skyOcclusion';
import {
  h_hash12, h_noise2, h_noise3, h_fbm2, h_fbm3, h_voronoi2, h_voronoi3, h_beardCoverage, h_scalpCoverage, h_brow, h_bumpNormal,
} from './peopleNoise';

/** A node for one of the materials' `{ value }` uniforms (objects by reference, numbers followed). */
function U(u: { value: unknown }) {
  return typeof u.value === 'number' ? follow(u as { value: number }) : uniform(u.value);
}

/** `totalEmissiveRadiance += x` (on top of the material's emissive colour). */
const addEmissive = (x) => materialEmissive.add(x);

/** Adds `delta` (bind space) to the vertex position ahead of skinning (GLSL `transformed += ...` in begin_vertex). */
function displaceBeforeSkinning(mat: THREE.NodeMaterial, delta: () => unknown): void {
  const base = mat.setupPosition;
  mat.setupPosition = function (builder) {
    positionLocal.addAssign(delta());
    return base.call(this, builder);
  };
}

// ------------------------------------------------------------------ skin

const SkinSurf = struct({ albedo: 'vec3', rough: 'float', height: 'float', emit: 'vec3', thin: 'float' }, 'SkinSurf');

const h_bit = (bits, i: number) => mod(floor(bits.div(Math.pow(2, i))), 2.0);
const h_seg = Fn(([p, a, b]) => {
  const pa = p.sub(a).toVar(), ba = b.sub(a).toVar();
  const t = clamp(dot(pa, ba).div(dot(ba, ba)), 0.0, 1.0);
  return length(pa.sub(ba.mul(t)));
}, { p: 'vec2', a: 'vec2', b: 'vec2', return: 'float' });

export function createSkinNodeMaterial(opts: { expr: boolean; exprTex: THREE.Texture | null; exprUnits: number; lod: number }, u: SkinUniforms): SkinMaterialHandle {
  const material = new THREE.MeshPhysicalNodeMaterial({
    roughness: 0.5,
    metalness: 0,
    ior: 1.4,
    specularIntensity: 0.45,
    sheen: 0.18,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color(0.32, 0.26, 0.24),
  });
  u.sheenTarget = material.sheenColor;
  const uTone = U(u.uTone), uAccent = U(u.uAccent), uHair = U(u.uHair), uPattern = U(u.uPattern), uLook = U(u.uLook);
  const uBrow = U(u.uBrow), uBeard = U(u.uBeard), uMarks = U(u.uMarks);

  // Vertex: facial expressions (expression-unit deltas from the shared texture).
  const units = Math.max(1, opts.exprUnits);
  if (opts.expr && opts.exprTex) {
    const exprTex = opts.exprTex;
    const uExprW = uniformArray(u.uExprW.value, 'float');
    const uFaceScale = U(u.uFaceScale);
    const aExpr = attribute('aExpr', 'float');
    displaceBeforeSkinning(material, () => Fn(() => {
      const ed = vec3(0.0).toVar();
      If(aExpr.greaterThanEqual(0.0), () => {
        const ei = int(aExpr.add(0.5)).toVar();
        Loop(units, ({ i }) => {
          const w = uExprW.element(i).toVar();
          If(w.notEqual(0.0), () => { ed.addAssign(textureLoad(exprTex, ivec2(ei, i)).xyz.mul(w)); });
        });
      });
      return ed.mul(uFaceScale);
    })());
  }

  const vMaskA = attribute('aMaskA', 'vec4');
  const vMaskB = attribute('aMaskB', 'vec4');
  const vFace = attribute('aFace', 'vec3');
  const vSkinUv = uv();
  const pores = poreTexture();

  const skinEval = Fn(() => {
    const vBind = positionGeometry.toVar();
    const tone = uTone;
    const seed = uPattern.z.toVar();
    const f = vFace.toVar();
    const age = uLook.x, male = uLook.y;
    const lips = vMaskA.x.toVar(), cheeks = vMaskA.y.toVar(), socket = vMaskA.z, nose = vMaskA.w.toVar();
    const ears = vMaskB.x.toVar(), ageZ = vMaskB.y, laugh = vMaskB.z, nails = vMaskB.w.toVar();
    const lumT = dot(tone, vec3(0.2126, 0.7152, 0.0722));
    const fair = smoothstep(0.03, 0.4, lumT).toVar(); // how visible redness is

    // ---- broad tone variation (blood, sun, melanin unevenness)
    const lowN = h_fbm3(vBind.mul(4.0).add(seed.mul(31.0)));
    const midN = h_noise3(vBind.mul(23.0).add(seed.mul(7.0)));
    const c = tone.mul(add(0.9, mul(0.2, lowN))).mul(add(0.97, mul(0.06, midN))).toVar();
    // Living skin is never one flat colour: blotchy red (capillaries) vs. yellow
    // (fat/melanin) hue shifts at a few centimetres, scaled down on dark skin.
    const hueN = h_fbm3(vBind.mul(9.0).add(seed.mul(17.0)));
    c.mulAssign(mix(vec3(1.0), mix(vec3(1.05, 0.95, 0.93), vec3(1.0, 1.0, 0.92), smoothstep(0.35, 0.65, hueN)), add(0.3, mul(0.7, fair))));
    // Faint bluish veins where skin is thin (inner forearms, temples, chest).
    const veinN = abs(h_noise3(vBind.mul(vec3(22.0, 9.0, 22.0)).add(3.0)).sub(0.5));
    c.assign(mix(c, c.mul(vec3(0.9, 0.93, 1.06)), sub(1.0, smoothstep(0.0, 0.04, veinN)).mul(0.35).mul(fair)));
    // Warmer, redder extremities & face; slightly darker back of hands, lighter palms/soles via height.
    const blood = vec3(1.08, 0.86, 0.84);
    c.assign(mix(c, c.mul(blood), mul(0.5, fair).mul(cheeks.mul(add(0.55, uLook.z)).add(nose.mul(0.6)).add(ears.mul(0.5)))));
    // Lips: darker, redder; tint toward hair/accent for fantasy tones.
    const lipCol = c.mul(mix(vec3(0.82, 0.55, 0.56), vec3(0.75, 0.62, 0.7), sub(1.0, fair))).mul(add(0.9, mul(0.1, male))).toVar();
    lipCol.assign(mix(lipCol, uAccent.mul(0.8), uBeard.w));
    c.assign(mix(c, lipCol, lips.mul(0.85)));
    // Eye sockets: thinner, slightly violet skin.
    c.assign(mix(c, c.mul(vec3(0.84, 0.8, 0.86)), socket.mul(add(0.45, age.mul(0.4)))));
    // Nails: pinkish-white, glossy.
    c.assign(mix(c, mix(c, vec3(0.86, 0.72, 0.68), 0.55), nails));
    // Age spots.
    const spots = smoothstep(0.62, 0.8, h_noise3(vBind.mul(38.0).add(seed.mul(3.0)))).mul(smoothstep(0.62, 0.9, age));
    c.assign(mix(c, c.mul(vec3(0.78, 0.68, 0.58)), spots.mul(0.6)));

    // Specular breakup: oily T-zone, drier cheeks/limbs, mid-frequency variation.
    const tzone = sub(1.0, smoothstep(0.25, 0.6, abs(f.x))).mul(smoothstep(-1.0, -0.6, f.y)).mul(sub(1.0, smoothstep(1.4, 1.9, f.y))).mul(smoothstep(-0.4, 0.0, f.z));
    const rough = float(0.56).sub(mul(0.12, lips)).add(mul(0.06, age)).sub(mul(0.1, tzone)).sub(mul(0.18, nails))
      .add(h_noise3(vBind.mul(60.0).add(5.0)).sub(0.5).mul(0.14)).toVar();
    const height = float(0.0).toVar();
    const emit = vec3(0.0).toVar();

    // ---- micro detail: pores (stronger on nose & cheeks) and micro-wrinkles
    const pt = texture(pores, vSkinUv.mul(28.0)).toVar();
    // Fade micro detail once a pixel covers more than ~0.4 mm (avoids sparkling aliasing).
    const px = length(fwidth(vBind));
    const micro = sub(1.0, smoothstep(0.00025, 0.0009, px)).toVar();
    const poreAmt = add(0.3, mul(0.7, max(nose, cheeks))).mul(micro);
    height.addAssign(pt.r.sub(0.78).mul(0.0002).mul(poreAmt).mul(sub(1.0, lips)).mul(sub(1.0, nails)));
    height.addAssign(pt.g.sub(0.86).mul(0.00022).mul(add(0.3, age)).mul(sub(1.0, lips)).mul(micro));
    height.addAssign(h_noise3(vBind.mul(900.0)).sub(0.5).mul(0.00012).mul(lips));

    // ---- age wrinkles: forehead lines, crow's feet, nasolabial folds, neck
    const wr = smoothstep(0.45, 0.95, age).toVar();
    If(wr.greaterThan(0.0), () => {
      const fh = sub(1.0, smoothstep(0.05, 0.18, abs(f.y.sub(0.95)).sub(0.25))).mul(sub(1.0, smoothstep(0.55, 0.9, abs(f.x))));
      height.subAssign(wr.mul(fh).mul(0.0005).mul(smoothstep(0.35, 1.0, add(0.5, mul(0.5, sin(f.y.mul(36.0).add(h_noise2(f.xy.mul(3.0)).mul(3.0))))))));
      const crow = smoothstep(0.35, 0.0, length(vec2(abs(f.x).sub(1.02), f.y.add(0.02))).sub(0.05));
      const rays = add(0.5, mul(0.5, sin(atan(f.y.add(0.02), abs(f.x).sub(0.95)).mul(18.0).add(h_noise2(f.xy.mul(9.0)).mul(2.0)))));
      height.subAssign(wr.mul(crow).mul(0.0004).mul(smoothstep(0.5, 1.0, rays)));
      height.subAssign(wr.mul(laugh).mul(0.0012));
      height.subAssign(wr.mul(ageZ).mul(0.0003).mul(h_noise3(vBind.mul(160.0))));
      c.assign(mix(c, c.mul(0.92), wr.mul(laugh).mul(0.4)));
    });

    // ---- painted hair: stubble, shaved scalp, eyebrows
    const hairC = uHair;
    const hairDot = smoothstep(0.35, 0.75, h_noise2(vSkinUv.mul(2600.0).add(seed))).toVar();
    const stub = h_beardCoverage(uBeard.x, f).mul(uBeard.y).toVar();
    c.assign(mix(c, mix(c, hairC.mul(0.85), 0.75), stub.mul(add(0.25, mul(0.55, hairDot)))));
    rough.addAssign(stub.mul(0.15));
    const scalp = h_scalpCoverage(f, uBeard.z).mul(uLook.w);
    c.assign(mix(c, mix(c, hairC.mul(0.8), 0.8), scalp.mul(add(0.35, mul(0.5, hairDot)))));
    const brow = h_brow(f, uBrow).toVar();
    If(brow.x.greaterThan(0.001), () => {
      const strokes = h_noise2(vec2(brow.y.mul(140.0).add(f.y.mul(60.0).mul(sign(f.x))), f.y.sub(0.43).mul(420.0).add(seed.mul(9.0))));
      const bm = brow.x.mul(add(0.5, mul(0.5, smoothstep(0.3, 0.7, strokes.add(mul(0.2, uBrow.w)))))).mul(uBrow.w).mul(0.92).toVar();
      c.assign(mix(c, hairC.mul(0.55), clamp(bm, 0.0, 1.0)));
      height.addAssign(bm.mul(0.00012));
      rough.addAssign(bm.mul(0.1));
    });

    // ---- race pattern (3D bind space, seamless)
    const pid = uPattern.x.toVar(), ps = uPattern.y.toVar();
    const acc = uAccent;
    const faceZone = smoothstep(-0.6, 0.0, f.z).mul(sub(1.0, smoothstep(1.8, 2.2, f.y))).mul(step(-2.6, f.y)).toVar();
    If(pid.greaterThan(0.5).and(ps.greaterThan(0.0)), () => {
      If(pid.lessThan(1.5), () => {
        // Freckles: dense on face & shoulders.
        const v = h_voronoi3(vBind.mul(260.0).add(seed.mul(13.0))).toVar();
        const zone = max(faceZone.mul(smoothstep(-0.6, 0.2, f.y)).mul(sub(1.0, smoothstep(0.8, 1.5, f.y))), smoothstep(1.1, 1.5, vBind.y.div(max(0.2, uLook.z.add(1.0)))).mul(0.0)).toVar();
        zone.assign(max(zone, smoothstep(0.55, 0.8, h_noise3(vBind.mul(3.0))).mul(0.6)));
        const fr = sub(1.0, smoothstep(0.12, 0.3, v.x)).mul(step(0.45, v.z)).mul(zone);
        c.assign(mix(c, c.mul(vec3(0.78, 0.6, 0.48)), fr.mul(ps)));
      }).ElseIf(pid.lessThan(2.5), () => {
        // Scales: Voronoi plates, finer on the face, absent on palms/lips.
        const sc = mix(48.0, 95.0, faceZone).toVar();
        const v = h_voronoi3(vBind.mul(sc).add(seed.mul(5.0))).toVar();
        // Fade plate edges once a cell spans only a few pixels (no shimmering at distance).
        const aa = sub(1.0, smoothstep(0.08, 0.35, length(fwidth(vBind.mul(sc))))).toVar();
        const edge = mix(0.75, smoothstep(0.0, 0.18, v.y.sub(v.x)), aa).toVar();
        const dome = sub(1.0, v.x).mul(aa);
        const mask = ps.mul(sub(1.0, lips)).mul(sub(1.0, nails)).toVar();
        const plate = mix(acc, c, add(0.45, mul(0.45, mix(0.5, v.z, aa)))).toVar();
        const belly = smoothstep(0.0, -0.06, vBind.z).mul(smoothstep(0.6, 1.2, vBind.y)).mul(sub(1.0, smoothstep(1.35, 1.5, vBind.y))).mul(sub(1.0, faceZone));
        plate.assign(mix(plate, mix(c, acc, 0.5).mul(1.15), belly.mul(0.6)));
        c.assign(mix(c, mix(plate.mul(0.55), plate, edge), mask));
        height.addAssign(mask.mul(dome.mul(0.0009).add(edge.mul(0.0004))));
        rough.assign(mix(rough, add(0.32, mul(0.2, v.z)), mask));
      }).ElseIf(pid.lessThan(3.5), () => {
        // Bark: vertical ridged furrows warped by noise; moss in the grooves.
        const q = vBind.mul(vec3(28.0, 6.0, 28.0)).add(seed.mul(3.0)).toVar();
        const warp = h_fbm3(q.mul(0.5)).mul(2.0);
        const ridge = abs(sin(vBind.x.mul(70.0).add(vBind.z.mul(55.0)).add(warp.mul(3.0)).add(h_noise3(q).mul(2.0)))).toVar();
        const groove = sub(1.0, smoothstep(0.0, 0.35, ridge)).toVar();
        const m = ps.mul(sub(1.0, faceZone.mul(0.55))).mul(sub(1.0, lips)).toVar();
        const knots = smoothstep(0.75, 0.9, h_noise3(vBind.mul(12.0).add(4.0))).toVar();
        c.assign(mix(c, acc, m.mul(max(groove.mul(0.85), knots.mul(0.5)))));
        const moss = smoothstep(0.55, 0.75, h_fbm3(vBind.mul(9.0).add(9.0))).mul(groove);
        c.assign(mix(c, vec3(0.13, 0.2, 0.06), m.mul(moss).mul(0.6)));
        height.addAssign(m.mul(ridge.mul(0.0016).sub(knots.mul(0.001))));
        rough.assign(mix(rough, 0.82, m));
      }).ElseIf(pid.lessThan(4.5), () => {
        // Spots: irregular blotches (orc/goblin/giantkin).
        const n = h_fbm3(vBind.mul(7.0).add(seed.mul(11.0)));
        const sp = smoothstep(0.55, 0.62, n);
        c.assign(mix(c, mix(c, acc, 0.75), sp.mul(ps).mul(sub(1.0, lips))));
      }).ElseIf(pid.lessThan(5.5), () => {
        // Tattoos: crisp tribal bands on arms, shoulders, face sides.
        const bands = abs(sin(vBind.y.mul(34.0).add(h_fbm3(vBind.mul(5.0).add(seed)).mul(6.0))));
        const zone = smoothstep(0.35, 0.6, h_noise3(vBind.mul(2.2).add(seed.mul(2.0)))).mul(sub(1.0, lips));
        const ink = sub(1.0, smoothstep(0.15, 0.22, bands)).mul(zone);
        c.assign(mix(c, c.mul(mix(vec3(0.18, 0.22, 0.32), acc.mul(0.6), 0.3)), ink.mul(ps)));
      }).ElseIf(pid.lessThan(6.5), () => {
        // Veins: branching glowing lines.
        const v1 = abs(h_fbm3(vBind.mul(14.0).add(seed)).sub(0.5));
        const v2 = abs(h_fbm3(vBind.mul(31.0).add(seed.mul(2.0))).sub(0.5));
        const vein = sub(1.0, smoothstep(0.0, 0.025, v1)).add(mul(0.5, sub(1.0, smoothstep(0.0, 0.018, v2)))).toVar();
        vein.mulAssign(ps.mul(sub(1.0, lips)).mul(add(0.6, mul(0.4, sub(1.0, faceZone.mul(0.5))))));
        c.assign(mix(c, acc.mul(0.7), clamp(vein, 0.0, 1.0).mul(0.7)));
        emit.addAssign(acc.mul(vein).mul(uPattern.w).mul(0.8));
        height.addAssign(vein.mul(0.0002));
      }).ElseIf(pid.lessThan(7.5), () => {
        // Stripes: warped bands around the body.
        const s = sin(vBind.y.mul(26.0).add(h_fbm3(vBind.mul(4.0).add(seed)).mul(7.0)).add(vBind.x.mul(4.0)));
        const st = smoothstep(0.55, 0.75, s).mul(smoothstep(0.3, 0.6, h_noise3(vBind.mul(3.0).add(2.0))));
        c.assign(mix(c, acc, st.mul(ps).mul(sub(1.0, lips)).mul(sub(1.0, faceZone.mul(0.4)))));
      }).Else(() => {
        // Crystals: faceted mineral patches with glints.
        const v = h_voronoi3(vBind.mul(60.0).add(seed.mul(3.0))).toVar();
        const patchM = smoothstep(0.58, 0.68, h_fbm3(vBind.mul(5.0).add(seed.mul(8.0)))).mul(ps).mul(sub(1.0, lips)).toVar();
        const facet = add(0.6, mul(0.4, v.z));
        c.assign(mix(c, acc.mul(facet), patchM));
        height.addAssign(patchM.mul(mul(0.0012, sub(1.0, v.x)).add(mul(0.0006, v.z))));
        rough.assign(mix(rough, 0.18, patchM));
        emit.addAssign(acc.mul(patchM).mul(uPattern.w).mul(0.3));
      });
    });

    // ---- marks: scars, warpaint, face tattoo, freckle patch (face coordinates)
    const side = select(fract(seed.mul(7.13)).lessThan(0.5), -1.0, 1.0);
    const fp = vec2(f.x.mul(side), f.y).toVar();
    If(uMarks.greaterThan(0.5), () => {
      const scar = float(0.0).toVar();
      If(h_bit(uMarks, 0).greaterThan(0.5), () => { scar.assign(max(scar, sub(1.0, smoothstep(0.012, 0.035, h_seg(fp, vec2(0.55, -0.35), vec2(1.0, -1.15)))))); });
      If(h_bit(uMarks, 1).greaterThan(0.5), () => { scar.assign(max(scar, sub(1.0, smoothstep(0.012, 0.03, h_seg(fp, vec2(0.62, 0.75), vec2(0.5, 0.2)))))); });
      If(h_bit(uMarks, 2).greaterThan(0.5), () => { scar.assign(max(scar, sub(1.0, smoothstep(0.01, 0.025, h_seg(fp, vec2(0.12, -0.95), vec2(0.2, -1.35)))))); });
      If(h_bit(uMarks, 3).greaterThan(0.5), () => {
        scar.assign(max(scar, sub(1.0, smoothstep(0.012, 0.03, h_seg(fp, vec2(0.45, 0.75), vec2(0.58, -0.55)))).mul(smoothstep(0.08, 0.16, length(fp.sub(vec2(0.5, 0.0)))))));
      });
      If(h_bit(uMarks, 4).greaterThan(0.5), () => { scar.assign(max(scar, sub(1.0, smoothstep(0.012, 0.03, h_seg(fp, vec2(-0.15, -1.75), vec2(0.25, -1.95)))))); });
      scar.mulAssign(smoothstep(-0.7, -0.3, f.z));
      c.assign(mix(c, c.mul(vec3(1.12, 0.92, 0.92)).add(0.03), scar.mul(0.85)));
      height.addAssign(scar.mul(0.0006));
      rough.subAssign(scar.mul(0.12));
      If(h_bit(uMarks, 5).greaterThan(0.5), () => {
        // Face tattoo: curling lines on one side of the face.
        // Bold curved bands sweeping from the temple down over the cheekbone, plus chin lines.
        const q = fp.sub(vec2(1.25, 0.35)).toVar();
        const r = length(q).toVar();
        const ang = atan(q.y, q.x).toVar();
        const arcs = abs(fract(r.mul(4.2).add(mul(0.08, sin(ang.mul(3.0))))).sub(0.5));
        const sweep = smoothstep(-2.9, -2.5, ang).mul(sub(1.0, smoothstep(-1.75, -1.45, ang)));
        const ink = sub(1.0, smoothstep(0.12, 0.2, arcs)).mul(sweep).mul(smoothstep(0.35, 0.45, r)).mul(sub(1.0, smoothstep(0.95, 1.05, r))).toVar();
        const chinL = sub(1.0, smoothstep(0.02, 0.035, abs(fract(f.x.mul(3.0).add(0.5)).sub(0.5)).mul(0.33))).mul(smoothstep(-1.55, -1.5, f.y))
          .mul(sub(1.0, smoothstep(-1.95, -1.9, f.y))).mul(sub(1.0, smoothstep(0.35, 0.4, abs(f.x))));
        ink.assign(max(ink, chinL));
        ink.mulAssign(smoothstep(-0.5, -0.2, f.z).mul(sub(1.0, lips)));
        c.assign(mix(c, c.mul(vec3(0.15, 0.2, 0.32)), ink.mul(0.85)));
      });
      If(h_bit(uMarks, 6).greaterThan(0.5), () => {
        // Warpaint stripes: three diagonal bars across the cheeks.
        const bars = step(0.5, fract(f.y.mul(1.6).sub(abs(f.x).mul(0.8)).mul(3.0))).mul(smoothstep(0.25, 0.4, abs(f.x))).mul(sub(1.0, smoothstep(1.0, 1.15, abs(f.x)))).toVar();
        bars.mulAssign(smoothstep(-0.95, -0.85, f.y).mul(sub(1.0, smoothstep(-0.15, -0.05, f.y))).mul(smoothstep(-0.6, -0.3, f.z)));
        c.assign(mix(c, uAccent.mul(0.35).add(vec3(0.25, 0.02, 0.02)), bars.mul(0.85)));
      });
      If(h_bit(uMarks, 7).greaterThan(0.5), () => {
        // Warpaint mask band across the eyes.
        const band = sub(1.0, smoothstep(0.18, 0.24, abs(f.y.add(0.02)))).mul(sub(1.0, smoothstep(1.05, 1.2, abs(f.x)))).mul(smoothstep(-0.7, -0.4, f.z));
        c.assign(mix(c, vec3(0.02, 0.02, 0.025), band.mul(0.9)));
      });
      If(h_bit(uMarks, 8).greaterThan(0.5), () => {
        const v = h_voronoi3(vBind.mul(300.0).add(seed.mul(13.0))).toVar();
        const zone = sub(1.0, smoothstep(0.6, 1.0, length(vec2(f.x, f.y.add(0.45).mul(1.6))))).mul(smoothstep(-0.4, -0.1, f.z));
        c.assign(mix(c, c.mul(vec3(0.75, 0.58, 0.46)), sub(1.0, smoothstep(0.1, 0.28, v.x)).mul(step(0.35, v.z)).mul(zone)));
      });
    });

    const thin = ears.mul(0.9).add(nose.mul(0.25)).add(lips.mul(0.2));
    return SkinSurf(c, clamp(rough, 0.18, 0.9), height, emit, thin);
  });

  const S = skinEval().toVar('skinS');
  setDiffuse(material, () => S.get('albedo'));
  material.roughnessNode = S.get('rough');
  material.normalNode = h_bumpNormal(positionView, normalView, S.get('height').mul(1.0), faceDirection);
  material.emissiveNode = addEmissive(S.get('emit'));

  // Per-channel wrap lighting + back translucency replacing the diffuse term of the direct light.
  onLightingModel(material, (lm) => {
    const direct = lm.direct.bind(lm);
    lm.direct = (data, builder) => {
      const { lightDirection, lightColor, reflectedLight } = data;
      // Everything but the diffuse term as usual (specular, sheen).
      const plainDiffuse = vec3(0.0).toVar();
      direct({ ...data, reflectedLight: { ...reflectedLight, directDiffuse: plainDiffuse } }, builder);
      const nlRaw = dot(normalView, lightDirection);
      const wrapK = vec3(0.55, 0.24, 0.15);
      const wrapped = clamp(vec3(nlRaw).add(wrapK).div(wrapK.add(1.0)), 0.0, 1.0).toVar();
      wrapped.mulAssign(wrapped);
      const sssIrr = wrapped.mul(lightColor).toVar();
      const back = pow(saturate(dot(positionViewDirection, lightDirection.negate())), 3.0).mul(S.get('thin'));
      sssIrr.addAssign(lightColor.mul(vec3(0.9, 0.25, 0.12)).mul(back).mul(0.6));
      const halfDir = normalize(lightDirection.add(positionViewDirection));
      const dotVH = saturate(dot(positionViewDirection, halfDir));
      const F = F_Schlick({ f0: specularColor, f90: specularF90, dotVH });
      reflectedLight.directDiffuse.addAssign(sssIrr.mul(BRDF_Lambert({ diffuseColor: diffuseContribution })).mul(F.oneMinus()));
    };
  });
  // Sky occlusion wraps the hook above.
  const sky = patchSkyOcclusionNode(material, 'uniform');
  return { material, uniforms: u, sky } as unknown as SkinMaterialHandle;
}

// ------------------------------------------------------------------ garments

const GarmentSurf = struct({ c: 'vec3', h: 'float', r: 'float', m: 'float', e: 'vec3' }, 'GarmentSurf');

/** One 2D pattern sample: returns color mix (x), height (y), roughness delta (z), metal (w) */
const g_pat = Fn(([q, id]) => {
  const res = vec4(0.0).toVar();
  If(id.lessThan(0.5), () => { // plain weave
    const w = sin(q.x.mul(160.0)).mul(sin(q.y.mul(160.0)));
    res.assign(vec4(0.0, w.mul(0.00008), 0.0, 0.0));
  }).ElseIf(id.lessThan(1.5), () => { // stripes
    const s = step(0.5, fract(q.y.mul(3.0)));
    res.assign(vec4(s, sin(q.x.mul(140.0)).mul(0.00006), 0.0, 0.0));
  }).ElseIf(id.lessThan(2.5), () => { // checks / tartan
    const f = step(0.5, fract(q.mul(3.0))).toVar();
    const s = abs(f.x.sub(f.y)).mul(0.7).add(step(0.9, fract(q.x.mul(6.0))).mul(0.3));
    res.assign(vec4(s, sin(q.x.add(q.y).mul(200.0)).mul(0.00006), 0.0, 0.0));
  }).ElseIf(id.lessThan(3.5), () => { // quilted diamonds
    const d = abs(fract(vec2(q.x.add(q.y), q.x.sub(q.y)).mul(3.0)).sub(0.5)).toVar();
    const seam = sub(1.0, smoothstep(0.0, 0.06, min(d.x, d.y))).toVar();
    const puff = sub(0.5, max(d.x, d.y)).mul(0.004);
    res.assign(vec4(seam.mul(0.6), puff.sub(seam.mul(0.0015)), 0.05, 0.0));
  }).ElseIf(id.lessThan(4.5), () => { // chainmail rings
    const g = q.mul(55.0).toVar();
    g.assign(vec2(g.x.add(step(1.0, mod(floor(g.y), 2.0)).mul(0.5)), g.y));
    const f = fract(g).sub(0.5);
    const r = length(f);
    const ring = sub(1.0, smoothstep(0.05, 0.12, abs(r.sub(0.33)))).toVar();
    res.assign(vec4(0.0, ring.mul(0.0012).sub(0.0006), ring.mul(-0.25), 1.0));
  }).ElseIf(id.lessThan(5.5), () => { // scales
    const g = q.mul(vec2(14.0, 20.0)).toVar();
    g.assign(vec2(g.x.add(step(1.0, mod(floor(g.y), 2.0)).mul(0.5)), g.y));
    const f = fract(g).sub(vec2(0.5, 0.15)).toVar();
    const d = length(f.mul(vec2(1.0, 0.8)));
    const sc = smoothstep(0.62, 0.45, d).toVar();
    res.assign(vec4(sub(1.0, sc), sc.mul(0.0016).mul(sub(1.0, f.y)), -0.2, 0.8));
  }).ElseIf(id.lessThan(6.5), () => { // leather grain
    const n = h_fbm2(q.mul(30.0)).toVar();
    const cr = smoothstep(0.62, 0.7, h_noise2(q.mul(70.0))).toVar();
    res.assign(vec4(n.mul(0.35), n.sub(0.5).mul(0.00045).sub(cr.mul(0.0002)), add(-0.05, cr.mul(0.1)), 0.0));
  }).ElseIf(id.lessThan(7.5), () => { // fur
    const f = h_noise2(q.mul(vec2(90.0, 25.0))).toVar();
    res.assign(vec4(f.mul(0.6), f.mul(0.0025), 0.3, 0.0));
  }).ElseIf(id.lessThan(8.5), () => { // embroidery: vines along bands
    const band = smoothstep(0.08, 0.0, abs(fract(q.y.mul(1.5)).sub(0.5)).sub(0.12));
    const vine = smoothstep(0.03, 0.0, abs(sin(q.x.mul(12.0)).mul(0.08).sub(fract(q.y.mul(1.5)).sub(0.5)))).toVar();
    res.assign(vec4(max(band.mul(0.25), vine), vine.mul(0.0004).add(sin(q.x.mul(160.0)).mul(0.00005)), vine.mul(-0.1), 0.0));
  }).ElseIf(id.lessThan(9.5), () => { // patchwork
    const v = h_voronoi2(q.mul(3.0)).toVar();
    const seam = sub(1.0, smoothstep(0.0, 0.05, v.y.sub(v.x))).toVar();
    res.assign(vec4(v.z, seam.negate().mul(0.0008).add(sin(q.x.mul(150.0)).mul(0.00005)), seam.mul(0.1), 0.0));
  }).ElseIf(id.lessThan(10.5), () => { // silk sheen
    res.assign(vec4(add(0.5, mul(0.5, sin(q.y.mul(6.0).add(h_noise2(q.mul(2.0)).mul(3.0))))), 0.0, -0.3, 0.0));
  }).ElseIf(id.lessThan(11.5), () => { // plates
    const row = fract(q.y.mul(5.0)).toVar();
    const edge = smoothstep(0.9, 1.0, row);
    const rivet = smoothstep(0.035, 0.0, length(vec2(fract(q.x.mul(6.0)).sub(0.5), row.sub(0.85)).mul(vec2(1.0, 3.0))));
    res.assign(vec4(edge.mul(0.4), sub(1.0, row).mul(0.002).add(rivet.mul(0.001)), -0.3, 1.0));
  }).Else(() => {
    // runes: dark cloth with glowing glyph rows
    const cell = floor(q.mul(vec2(9.0, 4.0))).toVar();
    const f = fract(q.mul(vec2(9.0, 4.0))).toVar();
    const glyph = step(0.5, h_hash12(floor(f.mul(3.0)).add(cell.mul(3.0)))).mul(step(0.2, f.x)).mul(step(f.x, 0.8)).mul(step(0.2, f.y)).mul(step(f.y, 0.8));
    const rowMask = step(0.6, fract(cell.y.mul(0.5).add(0.25)));
    const gr = glyph.mul(rowMask).toVar();
    res.assign(vec4(gr, gr.mul(0.0002), 0.0, -1.0));
  });
  return res;
}, { q: 'vec2', id: 'float', return: 'vec4' });

export interface GarmentNodeUniforms {
  gColor: { value: THREE.Color };
  gColor2: { value: THREE.Color };
  gTrim: { value: THREE.Color };
  gParams: { value: THREE.Vector4 };
  gGlow: { value: THREE.Color };
  gMetal: { value: number };
}

export function createGarmentNodeMaterial(m: ShellMaterial, u: GarmentNodeUniforms): GarmentHandle {
  const lin = (c: [number, number, number]) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
  const material = new THREE.MeshPhysicalNodeMaterial({
    roughness: m.roughness,
    metalness: 0,
    sheen: m.sheen,
    sheenRoughness: 0.6,
    sheenColor: lin(m.color).multiplyScalar(0.6),
    emissive: lin(m.glowColor),
    emissiveIntensity: m.glow * 0.6,
    side: THREE.FrontSide,
  });
  const gColor = U(u.gColor), gColor2 = U(u.gColor2), gTrim = U(u.gTrim), gParams = U(u.gParams), gGlow = U(u.gGlow), gMetal = U(u.gMetal);
  const vGEdge = attribute('aEdge', 'float');

  const garmentEval = Fn(() => {
    const vGBind = positionGeometry.toVar();
    const vGNrm = normalGeometry.toVar();
    const id = gParams.x.toVar();
    const sc = gParams.y;
    const n = normalize(vGNrm);
    const w = pow(abs(n), vec3(4.0)).toVar();
    w.divAssign(w.x.add(w.y).add(w.z));
    const p = vGBind.mul(sc).toVar();
    const a = g_pat(p.zy, id).mul(w.x).add(g_pat(p.xz, id).mul(w.y)).add(g_pat(p.xy, id).mul(w.z)).toVar();
    const c = mix(gColor, gColor2, clamp(a.x, 0.0, 1.0)).toVar();
    const big = h_fbm3(vGBind.mul(6.0).add(gParams.w));
    c.mulAssign(add(0.9, mul(0.2, big)));
    // Wear: dirt toward the hem, scuffs and fading.
    const wear = gParams.z;
    const dirt = smoothstep(0.9, 0.2, vGBind.y).mul(wear);
    c.assign(mix(c, c.mul(vec3(0.55, 0.5, 0.42)), dirt.mul(0.6).mul(smoothstep(0.35, 0.7, h_fbm3(vGBind.mul(9.0))))));
    c.assign(mix(c, c.mul(1.15).add(0.03), wear.mul(0.3).mul(smoothstep(0.6, 0.8, h_noise3(vGBind.mul(25.0))))));
    // Trim along the garment edges.
    const trim = smoothstep(0.35, 0.75, vGEdge).toVar();
    c.assign(mix(c, gTrim, trim));
    const h = a.y.mul(sub(1.0, trim)).add(trim.mul(0.0006));
    const e = select(a.w.lessThan(-0.5), gGlow.mul(a.x).mul(3.0), vec3(0.0)).toVar();
    // A glowing garment lights its trim most (a villain lieutenant's lit seams).
    e.addAssign(gGlow.mul(trim).mul(2.5));
    return GarmentSurf(c, h, a.z, a.w, e);
  });
  const S = garmentEval().toVar('garmentS');
  setDiffuse(material, () => S.get('c'));
  material.roughnessNode = clamp(materialRoughness.add(S.get('r')), 0.08, 1.0);
  material.metalnessNode = select(S.get('m').greaterThan(0.5), gMetal, gMetal.mul(0.25));
  material.normalNode = h_bumpNormal(positionView, normalView, S.get('h'), faceDirection);
  material.emissiveNode = addEmissive(S.get('e'));
  const sky = patchSkyOcclusionNode(material, 'uniform');
  return { material, sky } as unknown as GarmentHandle;
}

// ------------------------------------------------------------------ fur shells

export function createShellNodeMaterial(spec: ShellSpec, layer: number, color: THREE.Color): ShellLayerHandle {
  const t = (layer + 1) / spec.layers;
  const material = new THREE.MeshPhysicalNodeMaterial({
    roughness: 0.62, metalness: 0, specularIntensity: 0.25, envMapIntensity: 0.15,
    sheen: 0.35, sheenRoughness: 0.4, sheenColor: color.clone().multiplyScalar(0.8),
    transparent: true, depthWrite: false,
  });
  const uniforms = {
    hsColor: { value: color.clone() },
    hsParams: { value: new THREE.Vector4(t, spec.density, spec.kind === 'beard' ? 1 : 0, spec.beardStyle) },
    hsLimits: { value: new THREE.Vector4(spec.recede, spec.maxAbsX ?? 99, spec.minY ?? -99, 0) },
    hsOffset: { value: spec.length * t },
  };
  const hsColor = U(uniforms.hsColor), hsParams = U(uniforms.hsParams), hsLimits = U(uniforms.hsLimits), hsOffset = U(uniforms.hsOffset);
  // Strands lean downward/backward with height (combed), lifting off the surface.
  displaceBeforeSkinning(material, () => normalGeometry.mul(hsOffset).add(vec3(0.0, -1.0, 0.6).mul(hsOffset).mul(0.35)));
  const vHsFace = attribute('aFace', 'vec3');
  const base = material.setupDiffuseColor;
  material.setupDiffuseColor = function (builder) {
    base.call(this, builder);
    {
      const F = vHsFace.toVar();
      const cov = select(hsParams.z.greaterThan(0.5), h_beardCoverage(hsParams.w, F), h_scalpCoverage(F, hsLimits.x)).toVar();
      If(abs(F.x).greaterThan(hsLimits.y).or(F.y.lessThan(hsLimits.z)), () => { cov.assign(0.0); });
      // Streaks along the flow (narrow across, long along), anti-aliased toward their mean.
      const q = vec2(F.x.mul(46.0).add(F.z.mul(26.0)), F.y.mul(7.0).sub(F.z.mul(4.0))).toVar();
      const n = h_noise2(q).mul(0.65).add(h_noise2(q.mul(vec2(2.1, 1.6)).add(7.3)).mul(0.35)).toVar();
      const aa = sub(1.0, smoothstep(0.3, 1.2, length(fwidth(q))));
      n.assign(mix(0.5, n, aa));
      const lay = hsParams.x;
      const alpha = cov.mul(clamp(n.add(0.62).sub(lay.mul(0.9)).mul(2.4), 0.0, 1.0)).mul(mix(1.0, 0.75, lay)).mul(add(0.55, mul(0.45, hsParams.y))).toVar();
      If(alpha.lessThan(0.01), () => { Discard(); });
      // Darker roots (self-shadowing inside the coat), lighter, varied tips.
      diffuseColor.assign(vec4(hsColor.mul(mix(0.45, 1.05, lay)).mul(add(0.82, mul(0.36, n))), diffuseColor.a.mul(alpha)));
    }
  };
  const sky = patchSkyOcclusionNode(material, 'uniform');
  return { material, sky } as unknown as ShellLayerHandle;
}

// ------------------------------------------------------------------ eyes

const EyeSurf = struct({ albedo: 'vec3', emit: 'vec3', rough: 'float' }, 'EyeSurf');

export function createEyeNodeMaterial(): PatchedMaterial<EyeUniforms> {
  const material = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.03, ior: 1.376, specularIntensity: 0.6 });
  const uniforms: EyeUniforms = {
    uIris: { value: new THREE.Color(0.2, 0.12, 0.05) },
    uPupil: { value: new THREE.Vector4(0, 0.5, 0, 0.3) },
    uScleraTint: { value: new THREE.Color(1, 1, 1) },
  };
  const uIris = U(uniforms.uIris), uPupil = U(uniforms.uPupil), uScleraTint = U(uniforms.uScleraTint);
  const eyeEval = Fn(() => {
    const p = normalize(positionGeometry).toVar();
    // Forward is −Z. Parallax: the iris sits behind the cornea, shift by view direction.
    const vdir = normalize(positionView.negate()).toVar();
    const q = p.xy.sub(vdir.xy.mul(0.035).mul(smoothstep(0.7, 0.95, p.z.negate()))).toVar();
    const r = length(q).toVar();
    const ang = atan(q.y, q.x).toVar();
    const irisR = 0.47;
    const iris = sub(1.0, smoothstep(irisR - 0.015, irisR + 0.01, r)).mul(step(0.0, p.z.negate())).toVar();
    const pr = add(0.16, uPupil.y.mul(0.08)).toVar();
    const pupil = select(uPupil.x.lessThan(0.5), sub(1.0, smoothstep(pr.sub(0.012), pr.add(0.008), r)),
      select(uPupil.x.lessThan(1.5), sub(1.0, smoothstep(0.9, 1.05, length(vec2(q.x.div(pr.mul(0.28)), q.y.div(pr.mul(2.2)))))),
        select(uPupil.x.lessThan(2.5), sub(1.0, smoothstep(0.9, 1.05, abs(q.x).div(pr.mul(1.7)))).mul(sub(1.0, smoothstep(0.9, 1.05, abs(q.y).div(pr.mul(0.45))))), 0.0))).toVar();
    // Iris fibres, crypts, collarette and limbal ring.
    const fib = h_noise2(vec2(ang.mul(9.0), r.mul(12.0)).add(uPupil.w.mul(10.0))).mul(0.6).add(h_noise2(vec2(ang.mul(40.0), r.mul(3.0))).mul(0.4)).toVar();
    const crypt = smoothstep(0.55, 0.7, h_noise2(vec2(ang.mul(6.0), r.mul(20.0)).add(3.0)));
    const collar = smoothstep(0.03, 0.0, abs(r.sub(pr.mul(1.9)))).mul(0.5);
    const ic = uIris.mul(add(0.55, mul(0.75, fib))).mul(sub(1.0, mul(0.35, crypt))).toVar();
    ic.assign(mix(ic, uIris.mul(1.6).add(0.05), collar));
    ic.assign(mix(ic, ic.mul(0.55).add(uIris.mul(0.2).mul(vec3(0.9, 0.8, 0.6))), smoothstep(pr.mul(2.6), pr.mul(1.2), r).mul(0.25)));
    const limbal = smoothstep(irisR - 0.12, irisR, r);
    ic.mulAssign(sub(1.0, mul(0.65, limbal)));
    // Sclera: off-white, veins toward the corners, darker at the back.
    const veins = smoothstep(0.62, 0.68, h_noise3(p.mul(14.0).add(uPupil.w))).mul(smoothstep(0.3, 0.9, length(p.xy))).mul(0.5);
    const sc = uScleraTint.mul(mix(vec3(0.82, 0.8, 0.78), vec3(0.75, 0.38, 0.35), veins)).toVar();
    sc.mulAssign(mix(1.0, 0.55, smoothstep(0.3, 0.95, length(p.xy))));
    const col = mix(sc, ic, iris).toVar();
    col.assign(mix(col, vec3(0.006), pupil.mul(iris)));
    // Upper lid shadow & ambient occlusion in the socket.
    col.mulAssign(mix(1.0, 0.45, smoothstep(0.15, 0.6, p.y)));
    col.mulAssign(mix(1.0, 0.75, smoothstep(0.6, 1.0, abs(p.x))));
    const emit = uIris.mul(iris).mul(sub(1.0, pupil)).mul(uPupil.z).mul(add(0.6, mul(0.8, fib))).mul(2.5);
    return EyeSurf(col, emit, mix(0.35, 0.2, iris));
  });
  const S = eyeEval().toVar('eyeS');
  setDiffuse(material, () => S.get('albedo'));
  material.roughnessNode = S.get('rough');
  material.emissiveNode = addEmissive(S.get('emit'));
  const sky = patchSkyOcclusionNode(material, 'uniform');
  return { material, uniforms, sky } as unknown as PatchedMaterial<EyeUniforms>;
}

// ------------------------------------------------------------------ hair cards

const HairSurf = struct({ col: 'vec3', hairT: 'vec3', shift: 'float' }, 'HairSurf');

/**
 * Strand-card hair. The card tangent comes in as the geometry's `tangent` attribute (Character
 * adds it on WebGPU from `hairTangent`) so three's skinning rotates it like the GLSL did with
 * skinMatrix.
 */
export function createHairNodeMaterial(leaf: boolean): PatchedMaterial<HairUniforms> {
  const tex = leaf ? leafTexture() : strandTexture();
  // (No alphaMap: three r186 node materials read an alphaMap's red channel; the strand coverage is
  // in green, as three's WebGL alphaMap reads it. The coverage goes in through opacityNode, and
  // maskShadowNode alpha-tests the shadow like the WebGL depth material did.)
  const material = new THREE.MeshPhysicalNodeMaterial({
    roughness: 0.55,
    metalness: 0,
    side: THREE.DoubleSide,
    alphaTest: leaf ? 0.5 : 0.38,
    specularIntensity: leaf ? 0.4 : 0,
    sheen: leaf ? 0.2 : 0,
    envMapIntensity: leaf ? 0.5 : 0.15,
  });
  const uniforms: HairUniforms = {
    uColor: { value: new THREE.Color(0.1, 0.07, 0.05) },
    uTip: { value: new THREE.Color(0.14, 0.1, 0.07) },
    uSpec: { value: new THREE.Vector4(0.45, 0.6, 0, leaf ? 1 : 0) },
  };
  const uColor = U(uniforms.uColor), uTip = U(uniforms.uTip), uSpec = U(uniforms.uSpec);
  const vHairAux = attribute('hairAux', 'vec2');
  const vUv = uv();
  // Mip-aware alpha boost: thin strands average out in lower mips and would
  // fall below the alpha test (cards thinning/sparkling with distance).
  material.opacityNode = Fn(() => {
    const dd = fwidth(vUv.mul(vec2(256.0, 512.0))).toVar();
    const mipLevel = max(0.0, log2(max(max(dd.x, dd.y), 1e-4)));
    return materialOpacity.mul(texture(tex, vUv).g).mul(add(1.0, mipLevel.mul(0.3)));
  })();
  material.maskShadowNode = texture(tex, vUv).g.greaterThanEqual(material.alphaTest);
  const hairEval = Fn(() => {
    const st = texture(tex, vUv).toVar();
    const hairT = leaf ? vec3(0.0, 0.0, 1.0) : normalize(tangentView);
    const hairShift = st.b.sub(0.5).mul(0.25);
    const col = vec3(0.0).toVar();
    if (leaf) {
      // Leaves: per-leaf hue jitter, darker veins, autumn tint toward the tips.
      const c = mix(uColor, uTip, st.b.mul(0.6).add(vHairAux.y.mul(0.3)));
      col.assign(c.mul(add(0.55, mul(0.6, st.r))).mul(add(0.8, mul(0.4, vHairAux.x))));
    } else {
      const rootDark = mix(0.5, 1.0, smoothstep(0.0, 0.35, vHairAux.y));
      const c = mix(uColor, uTip, smoothstep(0.3, 1.0, vHairAux.y));
      col.assign(c.mul(add(0.82, mul(0.3, st.r))).mul(add(0.9, mul(0.2, vHairAux.x))).mul(rootDark));
    }
    return HairSurf(col, hairT, hairShift);
  });
  const S = hairEval().toVar('hairS');
  setDiffuse(material, () => S.get('col'));
  if (!leaf) {
    onLightingModel(material, (lm) => {
      lm.direct = ({ lightDirection, lightColor, reflectedLight }) => {
        const N = normalView;
        const hairT = S.get('hairT'), hairShift = S.get('shift');
        // Kajiya–Kay: primary (white, shifted to the root) and secondary (tinted, shifted to the tip) lobes.
        const Hh = normalize(lightDirection.add(positionViewDirection)).toVar();
        const tA = dot(normalize(hairT.add(N.mul(add(0.12, hairShift)))), Hh).toVar();
        const tB = dot(normalize(hairT.sub(N.mul(sub(0.18, hairShift)))), Hh).toVar();
        const s1 = pow(max(0.0, sqrt(max(0.0, sub(1.0, tA.mul(tA))))), 90.0).mul(uSpec.x);
        const s2 = pow(max(0.0, sqrt(max(0.0, sub(1.0, tB.mul(tB))))), 22.0).mul(uSpec.y);
        const nl = saturate(dot(N, lightDirection).mul(0.5).add(0.5));
        reflectedLight.directSpecular.addAssign(lightColor.mul(nl).mul(vec3(s1).add(s2.mul(diffuseContribution).mul(2.0))));
        // Softer, wrapped diffuse for hair volumes.
        reflectedLight.directDiffuse.addAssign(lightColor.mul(saturate(dot(N, lightDirection).add(0.35).div(1.35))).mul(BRDF_Lambert({ diffuseColor: diffuseContribution })));
      };
    });
  }
  const sky = patchSkyOcclusionNode(material, 'uniform');
  return { material, uniforms, sky } as unknown as PatchedMaterial<HairUniforms>;
}

// ------------------------------------------------------------------ horns / tusks / fins

export function createHornNodeMaterial(): PatchedMaterial<HornUniforms> {
  const material = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.45, clearcoat: 0.3, clearcoatRoughness: 0.4 });
  const uniforms: HornUniforms = {
    uBase: { value: new THREE.Color(0.3, 0.26, 0.2) },
    uTipC: { value: new THREE.Color(0.85, 0.8, 0.7) },
    uRidge: { value: 1 },
  };
  const uBase = U(uniforms.uBase), uTipC = U(uniforms.uTipC), uRidge = U(uniforms.uRidge);
  const vHornUv = uv();
  setDiffuse(material, () => {
    const t = vHornUv.y;
    const streak = h_noise2(vec2(vHornUv.x.mul(30.0), t.mul(4.0))).toVar();
    const rings = add(0.5, mul(0.5, sin(t.mul(70.0).mul(uRidge).add(streak.mul(2.0)))));
    return mix(uBase, uTipC, smoothstep(0.1, 0.95, t)).mul(add(0.8, mul(0.25, streak))).mul(add(0.9, mul(0.1, rings)));
  });
  const hgt = sin(vHornUv.y.mul(70.0).mul(uRidge)).mul(0.00025).mul(uRidge);
  material.normalNode = h_bumpNormal(positionView, normalView, hgt, faceDirection);
  const sky = patchSkyOcclusionNode(material, 'uniform');
  return { material, uniforms, sky } as unknown as PatchedMaterial<HornUniforms>;
}

export function simpleNodeMaterial(color: THREE.ColorRepresentation, opts: Record<string, unknown> = {}): PatchedMaterial<Record<string, never>> {
  const material = new THREE.MeshPhysicalNodeMaterial({ color, ...opts });
  const sky = patchSkyOcclusionNode(material, 'uniform');
  return { material, uniforms: {}, sky } as unknown as PatchedMaterial<Record<string, never>>;
}

/** Eyelash cards: strand texture along the lid. */
export function createLashNodeMaterial(): PatchedMaterial<{ uColor: { value: THREE.Color } }> {
  const tex = strandTexture();
  // (Strand coverage from the green channel through opacityNode, see createHairNodeMaterial.)
  const material = new THREE.MeshStandardNodeMaterial({ color: 0x0a0806, roughness: 0.6, side: THREE.DoubleSide, alphaTest: 0.55, envMapIntensity: 0 });
  // Lower lashes (negative u = below the eye centre) are sparser and shorter.
  const vLashUv = uv();
  const a = materialOpacity.mul(texture(tex, vLashUv).g);
  material.opacityNode = select(vLashUv.x.lessThan(0.0), a.mul(0.55).mul(sub(1.0, smoothstep(0.5, 0.9, vLashUv.y))), a);
  material.maskShadowNode = texture(tex, vLashUv).g.greaterThanEqual(material.alphaTest);
  const sky = patchSkyOcclusionNode(material, 'uniform');
  return { material, uniforms: { uColor: { value: material.color } }, sky } as unknown as PatchedMaterial<{ uColor: { value: THREE.Color } }>;
}
