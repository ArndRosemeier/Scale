// @ts-nocheck -- three's TSL typings infer swizzles and vector widths poorly; checked by rendering (docs/WEBGPU_PLAN.md).
/**
 * The facade material (render/materials/facade.ts) as a node material: wall textures from the
 * texture arrays, procedural windows, doors, shop fronts and curtain walls with interior mapping
 * and night lighting, destroyed elements collapsed, plastered insides, rain-darkened walls.
 *
 * Kept line by line close to the GLSL so the two can be compared; GLSL early returns became
 * `done` flags.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, float, int, bool, vec2, vec3, vec4, mix, normalize, min, max, abs, fract, exp, floor, fwidth, length, smoothstep, sub, add, mul,
  dot, step, sin, clamp, select, If, attribute, varying, texture, uniformArray, positionWorld, positionView, cameraPosition, normalView, normalWorldGeometry,
  frontFacing, Discard, struct, positionLocal, diffuseColor,
} from 'three/tsl';
import type { MaterialArrays } from '../TextureLibrary';
import { aliveTexture } from '../materials/globals';
import { h11, h21, vnoise, perturbNormalUV, GN, elemState } from './common';

const Surf = struct({
  albedo: 'vec3', rough: 'float', metal: 'float', tn: 'vec2', nStr: 'float', emis: 'vec3', ao: 'float', glass: 'float', door: 'float',
}, 'FacadeSurf');

/** Interior mapping: ray from the window into a box room behind the facade. */
const interiorRoom = Fn(([local, room, id, vt, office]) => {
  const depth = mix(3.5, 7.5, h11(id.mul(3.1)));
  const o = vec3(local, 0.0);
  const d = normalize(vt);
  const tx = select(d.x.greaterThan(0.0), room.x.sub(o.x).div(d.x), o.x.negate().div(min(d.x, -1e-4)));
  const ty = select(d.y.greaterThan(0.0), room.y.sub(o.y).div(d.y), o.y.negate().div(min(d.y, -1e-4)));
  const tz = depth.div(max(d.z, 1e-4));
  const t = min(tx, min(ty, tz)).toVar();
  const hit = o.add(d.mul(t)).toVar();
  const hue = h11(id.mul(7.7));
  const wall = select(office, vec3(0.78, 0.79, 0.8), mix(vec3(0.85, 0.80, 0.70), vec3(0.75, 0.82, 0.86), hue).mul(mix(0.75, 1.0, h11(id.mul(1.3))))).toVar();
  const col = vec3(0).toVar();
  If(t.equal(tz), () => {
    col.assign(wall);
    const fx = hit.x.div(room.x);
    If(office.not().and(hit.y.lessThan(0.9)).and(fx.greaterThan(add(0.15, mul(0.3, h11(id))))).and(fx.lessThan(add(0.55, mul(0.3, h11(id))))), () => {
      col.assign(mix(vec3(0.35, 0.25, 0.18), vec3(0.5, 0.45, 0.4), h11(id.mul(9.0))));
    });
    If(office.not().and(hit.y.greaterThan(1.3)).and(hit.y.lessThan(2.0)).and(abs(fx.sub(0.5)).lessThan(0.12)).and(h11(id.mul(4.0)).greaterThan(0.4)), () => {
      col.assign(mix(vec3(0.6, 0.2, 0.15), vec3(0.2, 0.35, 0.55), h11(id.mul(5.0))));
    });
    If(office.and(hit.y.lessThan(1.1)).and(hit.y.greaterThan(0.72)), () => { col.assign(vec3(0.55, 0.55, 0.57)); });
  }).ElseIf(t.equal(ty), () => {
    If(d.y.greaterThan(0.0), () => {
      col.assign(vec3(0.92));
      If(office.and(fract(hit.z.mul(0.5)).lessThan(0.12)), () => { col.assign(vec3(1.4)); });
    }).Else(() => {
      col.assign(select(office, vec3(0.42, 0.43, 0.46), mix(vec3(0.45, 0.3, 0.18), vec3(0.6, 0.55, 0.48), h11(id.mul(2.2)))));
    });
  }).Else(() => {
    col.assign(wall.mul(0.82));
  });
  col.mulAssign(exp(t.negate().mul(0.07)));
  return col;
}, { local: 'vec2', room: 'vec2', id: 'float', vt: 'vec3', office: 'bool', return: 'vec3' });

export function createFacadeNodeMaterial(arrays: MaterialArrays, elemTex: THREE.Texture | null, elemW = 1, backPlaster = true): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1, metalness: 0, side: THREE.DoubleSide, shadowSide: THREE.DoubleSide });
  const tiles = arrays.tileMeters.slice(0, 24).concat(new Array(Math.max(0, 24 - arrays.tileMeters.length)).fill(2));
  const uTile = uniformArray(tiles, 'float').setName('uTile');
  const albTex = arrays.albedo, nrmTex = arrays.normal;
  const { uNight, uDayLight, uLitFrac, uShopLit, uEatLit, uWet } = GN;

  // Vertex: destroyed elements collapse (all their vertices to one point).
  const el = elemState(elemTex ?? aliveTexture(), elemTex ? elemW : 1);
  mat.positionNode = select(el.alive.lessThan(0.5), vec3(0.0), positionLocal);

  const vMUv = attribute('uv', 'vec2');
  const vLayer = attribute('aLayer', 'float');
  const vTint = attribute('aTint', 'vec3');
  const vFacade = attribute('aFacade', 'vec4');
  const vSeed = attribute('aSeed', 'float');

  const surface = Fn(() => {
    const uv = vMUv;
    const fp = vFacade;
    const flags = int(vFacade.w.add(0.5)).toVar();
    const layerF = vLayer;
    // (vars: evaluated here once, not first inside one of the branches below)
    const nW = normalWorldGeometry.toVar();
    const eyeDirW = normalize(cameraPosition.sub(positionWorld)).toVar();

    const albedo = vec3(0).toVar(), rough = float(0).toVar(), metal = float(0).toVar(), tn = vec2(0).toVar(), nStr = float(1).toVar();
    const emis = vec3(0).toVar(), ao = float(1).toVar(), glass = float(0).toVar(), door = float(0).toVar();
    const done = bool(false).toVar();

    const layer = int(layerF.add(0.5)).toVar();
    const tuv = uv.div(uTile.element(layer));
    const ar = texture(albTex, tuv).depth(layer).toVar();
    const nh = texture(nrmTex, tuv).depth(layer).toVar();
    albedo.assign(ar.rgb.mul(vTint));
    rough.assign(ar.a);
    tn.assign(nh.xy.mul(2.0).sub(1.0));
    ao.assign(mix(1.0, nh.a, 0.8));
    If(layer.equal(10), () => { metal.assign(0.6); });
    // Stained glass: daylight shines through it (a faint glow at night, lit from inside).
    If(flags.bitAnd(4096).notEqual(0), () => {
      emis.assign(albedo.mul(add(0.06, mul(0.5, uDayLight))));
      rough.assign(0.12);
      ao.assign(1.0);
      done.assign(true);
    });
    If(done.not().and(flags.bitAnd(1).equal(0).or(flags.bitAnd(64).notEqual(0))), () => { done.assign(true); });

    If(done.not(), () => {
      const roof = flags.bitAnd(128).notEqual(0);
      const curtain = flags.bitAnd(4).notEqual(0);
      const shop = flags.bitAnd(2).notEqual(0);
      const front = flags.bitAnd(256).notEqual(0);
      const eatery = flags.bitAnd(2048).notEqual(0);
      const arched = flags.bitAnd(8).notEqual(0);
      const shutters = flags.bitAnd(32).notEqual(0);
      const balcony = flags.bitAnd(16).notEqual(0);
      const bay = max(fp.x, 0.5).toVar(), fH = max(fp.y, 2.0).toVar(), gH = max(fp.z, 2.0).toVar();
      const seedB = floor(vSeed.mul(1000.0).add(0.5)).toVar();
      // Pixel footprint: fade the pattern out when windows become sub-pixel (no moiré at distance).
      const px = max(length(fwidth(uv)), 1e-4);
      const detail = sub(1.0, smoothstep(bay.mul(0.12), bay.mul(0.35), px)).toVar();

      const f = float(0).toVar(), ly = float(0).toVar(), fh = float(0).toVar();
      If(roof, () => { f.assign(90.0); ly.assign(uv.y); fh.assign(fH); })
        .ElseIf(uv.y.lessThan(gH), () => { f.assign(0.0); ly.assign(uv.y); fh.assign(gH); })
        .Else(() => { const t = uv.y.sub(gH).div(fH); f.assign(add(1.0, floor(t))); ly.assign(fract(t).mul(fH)); fh.assign(fH); });
      const bi = floor(uv.x.div(bay)).toVar();
      const lx = uv.x.sub(bi.mul(bay)).toVar();
      const winId = h21(vec2(bi.add(seedB), f.add(seedB.mul(0.37)))).toVar();

      // Window rectangle for this floor.
      const ww = float(0).toVar(), wh = float(0).toVar(), wy0 = float(0).toVar();
      const isShopFloor = f.equal(0.0).and(shop).toVar();
      const isDoor = bool(false).toVar();
      If(curtain, () => { ww.assign(bay); wh.assign(fh.sub(0.95)); wy0.assign(0.9); })
        .ElseIf(roof, () => {
          ww.assign(min(1.1, bay.mul(0.5))); wh.assign(1.25); wy0.assign(0.95);
          If(fract(bi.mul(0.5)).greaterThan(0.1), () => { done.assign(true); });
        })
        .ElseIf(isShopFloor, () => { ww.assign(bay.sub(0.35)); wh.assign(fh.sub(1.25)); wy0.assign(0.3); })
        .Else(() => {
          ww.assign(bay.mul(mix(0.42, 0.6, h11(seedB.add(1.0)))));
          wh.assign(fh.mul(mix(0.5, 0.62, h11(seedB.add(2.0)))));
          wy0.assign(fh.mul(0.3));
          If(f.equal(0.0), () => { wy0.assign(max(0.9, fh.sub(wh).sub(0.7))); });
        });

      If(done.not(), () => {
        // Entrance door on the front facade.
        const doorBi = float(flags.shiftRight(9).bitAnd(3));
        If(front.and(f.equal(0.0)).and(bi.equal(doorBi)).and(curtain.not()), () => {
          isDoor.assign(true);
          ww.assign(min(1.3, bay.mul(0.62)));
          wh.assign(min(2.45, fh.sub(0.35)));
          wy0.assign(0.0);
        });
        const wx0 = bay.sub(ww).mul(0.5);
        const p = vec2(lx.sub(wx0), ly.sub(wy0)).toVar();
        const inRect = p.x.greaterThan(0.0).and(p.x.lessThan(ww)).and(p.y.greaterThan(0.0)).and(p.y.lessThan(wh)).toVar();
        If(isDoor.and(inRect), () => { door.assign(1.0); });
        If(arched.and(isDoor.not()).and(curtain.not()).and(inRect), () => {
          const r = ww.mul(0.5);
          If(p.y.greaterThan(wh.sub(r)), () => { inRect.assign(length(p.sub(vec2(r, wh.sub(r)))).lessThan(r)); });
        });

        // Curtain wall: glass everywhere except spandrels and mullions.
        If(curtain, () => {
          const mull = 0.06;
          const spandrel = ly.lessThan(wy0).or(ly.greaterThan(fh.sub(0.05)));
          const mullion = lx.lessThan(mull * 0.5).or(lx.greaterThan(bay.sub(mull * 0.5)));
          If(mullion.or(spandrel), () => {
            albedo.assign(select(spandrel, vTint.mul(0.25).add(0.05), vec3(0.5, 0.52, 0.55)));
            metal.assign(select(mullion, 0.8, 0.4));
            rough.assign(select(mullion, 0.35, 0.25));
            tn.assign(vec2(0.0));
          }).Else(() => {
            const T = normalize(vec3(nW.z.negate(), 0.0, nW.x));
            const vt = vec3(dot(eyeDirW.negate(), T), dot(eyeDirW.negate(), vec3(0, 1, 0)), dot(eyeDirW.negate(), nW.negate()));
            const room = interiorRoom(vec2(lx, ly), vec2(bay.mul(2.0), fh), winId, vt, bool(true));
            const lit = h11(winId.mul(13.0)).lessThan(uLitFrac.mul(1.4));
            const inside = room.mul(select(lit, vec3(1.0, 0.97, 0.9).mul(1.2), vec3(uDayLight.mul(0.1).add(0.01))));
            albedo.assign(mix(vec3(0.02), vTint.mul(0.12), 0.5));
            metal.assign(0.55);
            rough.assign(0.04);
            tn.assign(vec2(0.0));
            emis.assign(inside.mul(0.45).mul(detail).add(select(lit, vec3(0.35, 0.33, 0.3).mul(sub(1.0, detail)).mul(0.4), vec3(0.0))));
            glass.assign(1.0);
          });
        }).ElseIf(inRect.not(), () => {
          If(detail.greaterThan(0.01), () => {
            // Sill below and lintel above the opening.
            const inX = p.x.greaterThan(-0.1).and(p.x.lessThan(ww.add(0.1)));
            If(isDoor.not().and(isShopFloor.not()).and(inX).and(p.y.lessThan(0.0)).and(p.y.greaterThan(-0.11)), () => {
              albedo.assign(mix(albedo, vec3(0.78, 0.76, 0.72), detail.mul(0.75)));
              tn.assign(mix(tn, vec2(0.0, -0.6), detail));
              rough.assign(0.6);
            }).ElseIf(isShopFloor.not().and(inX).and(p.y.greaterThan(wh)).and(p.y.lessThan(wh.add(0.22))).and(arched.not()), () => {
              albedo.assign(mix(albedo, albedo.mul(1.08), detail));
              tn.assign(mix(tn, vec2(0.0, select(p.y.greaterThan(wh.add(0.18)), 0.5, 0.0)), detail));
            });
            // Shutters beside the window.
            If(shutters.and(isShopFloor.not()).and(isDoor.not()).and(f.greaterThan(0.0)).and(p.y.greaterThan(0.0)).and(p.y.lessThan(wh))
              .and(p.x.lessThan(0.0).and(p.x.greaterThan(ww.mul(-0.5))).or(p.x.greaterThan(ww).and(p.x.lessThan(ww.mul(1.5))))), () => {
              const sc = mix(mix(vec3(0.25, 0.4, 0.3), vec3(0.45, 0.25, 0.2), h11(seedB.add(9.0))), vec3(0.3, 0.42, 0.55), step(0.66, h11(seedB.add(8.0))));
              const slat = fract(p.y.mul(10.0));
              albedo.assign(mix(albedo, sc.mul(add(0.8, mul(0.2, slat))), detail));
              tn.assign(mix(tn, vec2(0.0, slat.sub(0.5).mul(0.8)), detail));
              rough.assign(0.7);
            });
            // Shop sign band above the display windows.
            If(isShopFloor.and(eatery.not()).and(ly.greaterThan(wy0.add(wh).add(0.15))).and(ly.lessThan(fh.sub(0.15))), () => {
              const sid = h11(seedB.add(21.0));
              const sc = add(0.15, mul(0.7, vec3(h11(sid.mul(3.0)), h11(sid.mul(5.0)), h11(sid.mul(7.0)))));
              const letters = step(0.45, vnoise(vec2(uv.x.mul(3.0), ly.mul(6.0)).add(sid.mul(10.0))))
                .mul(step(abs(ly.sub(wy0.add(wh).add(0.15).add(fh).sub(0.15).mul(0.5))), 0.18));
              albedo.assign(mix(albedo, mix(sc, vec3(0.95), letters), detail));
              rough.assign(0.4);
              emis.addAssign(uShopLit.mul(uNight).mul(sc.mul(0.3).add(letters.mul(vec3(1.0, 0.9, 0.7)))).mul(1.2));
            });
            // Wrought iron balcony rail across the lower part of tall windows (floors 2 and 5).
            If(balcony.and(f.equal(2.0).or(f.equal(5.0))).and(ly.greaterThan(wy0.sub(0.15))).and(ly.lessThan(wy0.add(0.95))), () => {
              const bar = min(1.0, step(0.85, fract(uv.x.mul(8.0))).add(step(abs(ly.sub(wy0).sub(0.9)), 0.04)).add(step(abs(ly.sub(wy0).sub(0.05)), 0.04)));
              albedo.assign(mix(albedo, vec3(0.06), bar.mul(detail)));
              metal.assign(mix(metal, 0.6, bar.mul(detail)));
            });
            // Reveal shading just outside the opening.
            const outside = max(max(p.x.negate(), p.x.sub(ww)), max(p.y.negate(), p.y.sub(wh)));
            ao.mulAssign(mix(1.0, add(0.75, mul(0.25, smoothstep(0.0, 0.08, outside))), detail));
          });
        }).Else(() => {
          // Inside the opening.
          const frW = select(isShopFloor, 0.08, 0.065);
          const ex = min(p.x, ww.sub(p.x)), ey = min(p.y, wh.sub(p.y));
          const edge = min(ex, ey);
          const reveal = 0.07;
          const frameCol = mix(vec3(0.93, 0.92, 0.9), mix(vec3(0.15, 0.15, 0.16), vec3(0.35, 0.22, 0.14), h11(seedB.add(3.0))), step(0.55, h11(seedB.add(4.0))));
          If(edge.lessThan(reveal), () => {
            // Recess: inner reveal (wall return) visible as a darker band.
            albedo.assign(mix(albedo, albedo.mul(0.55), detail));
            tn.assign(mix(tn, select(ex.lessThan(ey), vec2(select(p.x.lessThan(ww.mul(0.5)), 0.7, -0.7), 0.0), vec2(0.0, select(p.y.lessThan(wh.mul(0.5)), 0.7, -0.7))), detail.mul(0.7)));
          }).Else(() => {
            const q = p.sub(reveal).toVar();
            const qs = vec2(ww, wh).sub(2.0 * reveal).toVar();
            const qe = min(min(q.x, qs.x.sub(q.x)), min(q.y, qs.y.sub(q.y))).toVar();
            const muntin = bool(false).toVar();
            const doorPanel = bool(false).toVar();
            If(isDoor, () => {
              const glassPart = q.y.greaterThan(qs.y.mul(0.62)).and(qe.greaterThan(0.12));
              If(glassPart.not(), () => {
                doorPanel.assign(true);
                const dc = mix(vec3(0.28, 0.16, 0.09), mix(vec3(0.08, 0.2, 0.15), vec3(0.45, 0.08, 0.06), h11(seedB.add(11.0))), step(0.5, h11(seedB.add(12.0))));
                const panel = step(0.12, min(min(q.x, qs.x.sub(q.x)), abs(q.y.sub(qs.y.mul(0.3)))));
                albedo.assign(mix(albedo, dc.mul(add(0.85, mul(0.15, panel))), detail));
                tn.assign(mix(tn, select(panel.greaterThan(0.5), vec2(0.0), vec2(0.3, 0.3)), detail));
                rough.assign(0.5);
                // knob
                If(length(q.sub(vec2(qs.x.mul(0.85), qs.y.mul(0.45)))).lessThan(0.035), () => { albedo.assign(vec3(0.7, 0.6, 0.35)); metal.assign(1.0); rough.assign(0.3); });
              });
            }).ElseIf(isShopFloor.not().and(roof.not()), () => {
              const panesX = select(ww.greaterThan(1.0), 2.0, 1.0);
              const panesY = select(h11(seedB.add(6.0)).lessThan(0.5), 2.0, 3.0);
              const g = q.div(qs).mul(vec2(panesX, panesY));
              const gd = min(fract(g), sub(1.0, fract(g))).mul(qs).div(vec2(panesX, panesY));
              muntin.assign(h11(seedB.add(7.0)).lessThan(0.6).and(min(gd.x, gd.y).lessThan(0.022)));
            });
            If(doorPanel.not(), () => {
              If(qe.lessThan(frW).or(muntin), () => {
                albedo.assign(mix(albedo, frameCol, detail));
                rough.assign(0.45);
                metal.assign(0.0);
                tn.assign(mix(tn, vec2(0.0), detail));
                ao.mulAssign(0.9);
              }).Else(() => {
                // Glass with the room behind it.
                const T = normalize(vec3(nW.z.negate(), 0.0, nW.x));
                const vt = vec3(dot(eyeDirW.negate(), T), dot(eyeDirW.negate(), vec3(0, 1, 0)), dot(eyeDirW.negate(), nW.negate()));
                const office = flags.bitAnd(4).notEqual(0);
                const room = interiorRoom(vec2(lx, ly), vec2(bay.mul(select(isShopFloor, 2.0, 1.6)), fh), winId.add(f.mul(0.13)), vt, office.or(isShopFloor.and(eatery.not()))).toVar();
                // Blinds / curtains: per window fraction drawn down from the top.
                const b0 = h11(winId.mul(17.0));
                const blind = select(b0.lessThan(0.45), 0.0, b0.sub(0.45).mul(1.4));
                If(isShopFloor.not().and(q.y.greaterThan(qs.y.mul(sub(1.0, blind)))), () => {
                  const bc = mix(vec3(0.92, 0.9, 0.85), vec3(0.75, 0.62, 0.5), h11(winId.mul(19.0)));
                  const stripe = add(0.5, mul(0.5, sin(q.y.mul(140.0))));
                  const saa = clamp(sub(1.0, fwidth(q.y).mul(30.0)), 0.0, 1.0);
                  room.assign(bc.mul(add(0.82, mul(0.18, mix(0.5, stripe, saa)))));
                });
                const lit = bool(false).toVar();
                const lightCol = vec3(0).toVar();
                If(eatery.and(isShopFloor.or(isDoor)), () => {
                  lit.assign(h11(winId.mul(5.0)).lessThan(uEatLit));
                  lightCol.assign(vec3(1.0, 0.64, 0.34).mul(add(1.2, mul(0.3, uNight))));
                }).ElseIf(isShopFloor.or(isDoor), () => {
                  lit.assign(h11(winId.mul(5.0)).lessThan(uShopLit));
                  lightCol.assign(vec3(1.0, 0.92, 0.78).mul(1.6));
                }).Else(() => {
                  lit.assign(h11(winId.mul(13.0)).lessThan(uLitFrac));
                  lightCol.assign(mix(vec3(1.0, 0.82, 0.58), vec3(0.85, 0.9, 1.0), step(0.8, h11(winId.mul(23.0)))).mul(1.3));
                });
                const inside = room.mul(select(lit, lightCol, vec3(uDayLight.mul(0.13).add(0.004))));
                albedo.assign(mix(albedo, vec3(0.015), detail));
                rough.assign(mix(rough, 0.05, detail));
                metal.assign(mix(metal, 0.0, detail));
                tn.assign(mix(tn, vec2(0.0), detail));
                ao.assign(1.0);
                emis.assign(inside.mul(detail).mul(0.9).add(select(lit, lightCol.mul(0.12).mul(sub(1.0, detail)), vec3(0.0))));
                glass.assign(select(isDoor, 0.0, 1.0));
              });
            });
          });
        });
      });
    });

    // Open elements (glass, doors) are real openings.
    If(glass.greaterThan(0.5).or(door.greaterThan(0.5)).and(el.open.greaterThan(0.5)), () => { Discard(); });
    if (backPlaster) {
      // Inside of the shell: plastered interior walls; glass seen from inside is dark (or open).
      If(frontFacing.not(), () => {
        If(glass.greaterThan(0.5), () => { albedo.assign(vec3(0.03)); emis.assign(vec3(0.25, 0.3, 0.35).mul(uDayLight)); })
          .Else(() => { albedo.assign(vec3(0.82, 0.8, 0.76).mul(add(0.9, mul(0.1, vnoise(uv.mul(2.0)))))); emis.assign(vec3(0.0)); });
        tn.assign(vec2(0.0)); rough.assign(0.9); metal.assign(0.0); ao.assign(0.8);
      });
    }
    If(uWet.greaterThan(0.001).and(frontFacing).and(glass.lessThan(0.5)), () => {
      // Rain-darkened walls, in streaks and patches.
      const wW = uWet.mul(add(0.55, mul(0.45, vnoise(vec2(positionWorld.x.add(positionWorld.z), positionWorld.y.mul(0.25)).mul(0.6)))));
      albedo.mulAssign(sub(1.0, mul(0.25, wW)));
      rough.mulAssign(sub(1.0, mul(0.35, wW)));
    });
    return Surf(albedo, rough, metal, tn, nStr, emis, ao, glass, door);
  });

  const S = surface().toVar('facadeS');
  // Albedo goes in through setupDiffuseColor rather than colorNode: the shadow pass evaluates
  // colorNode for alpha, which would run the whole facade (and its discards) for every shadow map.
  const base = mat.setupDiffuseColor;
  mat.setupDiffuseColor = function (builder) {
    base.call(this, builder);
    diffuseColor.assign(vec4(S.get('albedo').mul(S.get('ao')), 1.0));
  };
  mat.roughnessNode = S.get('rough');
  mat.metalnessNode = S.get('metal');
  mat.emissiveNode = S.get('emis');
  mat.aoNode = S.get('ao');
  const layer = int(vLayer.add(0.5));
  mat.normalNode = perturbNormalUV(positionView, normalView, vMUv.div(uTile.element(layer)), S.get('tn'), S.get('nStr'));
  return mat;
}
