/**
 * The Wardens' station (ALIENS_PLAN §2): a vast shape hanging high over the city in the same part
 * of the sky, like a second moon — a pale ghost against the blue by day (the sky shows through
 * it), a dark body lit by a few slow lights crawling round its rim at night, fading behind thick
 * cloud and fog.
 *
 * Drawn like the sky: a real (low-poly) object kept at a fixed direction and distance from the
 * camera, so it shows no parallax; lit by the scene's sun / moon light, no fog (the haze is its
 * opacity). Buildings in front hide it through the depth test.
 */
import * as THREE from 'three';
import { Rng, deriveSeed } from '../../core/rng';
import { clamp, lerp, smoothstep } from '../../core/math';
import type { SkySystem } from '../../render/SkySystem';

/** Distance from the camera (m) and radius of the body (m): ~12° across. */
const DIST = 20000;
const RADIUS = 2100;
const LIGHTS = 30;

export class Station {
  readonly group = new THREE.Group();
  /** Direction from the viewer (unit). */
  readonly dir = new THREE.Vector3();
  private body: THREE.Mesh;
  private ring: THREE.Mesh;
  private bodyMat: THREE.MeshLambertMaterial;
  private lightsMat: THREE.PointsMaterial;
  private lights: THREE.Points;
  private spin = 0;

  constructor(seed: number) {
    const r = new Rng(deriveSeed(seed, 'station'));
    const az = r.range(0, Math.PI * 2), el = r.range(0.62, 0.86);
    this.dir.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).normalize();

    // The body: a wide flat lens with a stepped upper deck and a spindle hanging below, banded.
    const prof: [number, number, number][] = [
      // [radius, height, shade]
      [0, -0.62, 0.55], [0.06, -0.55, 0.6], [0.13, -0.42, 0.5], [0.2, -0.24, 0.62], [0.3, -0.13, 0.48],
      [0.46, -0.09, 0.66], [0.62, -0.08, 0.52], [0.8, -0.065, 0.68], [0.95, -0.035, 0.56], [1.0, 0, 0.8],
      [0.97, 0.045, 0.72], [0.82, 0.08, 0.86], [0.62, 0.1, 0.7], [0.5, 0.15, 0.82], [0.36, 0.17, 0.68],
      [0.3, 0.24, 0.88], [0.16, 0.28, 0.74], [0, 0.3, 0.9],
    ];
    const lathe = new THREE.LatheGeometry(prof.map(([x, y]) => new THREE.Vector2(x, y)), 56);
    // Shades per profile ring (Lathe lays its vertices out segment by segment, one profile each).
    const n = prof.length, segs = lathe.attributes.position.count / n;
    const col = new Float32Array(lathe.attributes.position.count * 3);
    for (let s = 0; s < segs; s++) for (let i = 0; i < n; i++) {
      // Panels: every seventh segment a little darker.
      const k = prof[i][2] * (s % 7 === 0 ? 0.8 : 1);
      col.set([k * 0.92, k * 0.95, k], (s * n + i) * 3);
    }
    lathe.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.bodyMat = new THREE.MeshLambertMaterial({ vertexColors: true, fog: false, transparent: true, depthWrite: false, emissive: new THREE.Color(0.012, 0.016, 0.026) });
    this.body = new THREE.Mesh(lathe, this.bodyMat);
    // The outer ring on six spokes.
    const ringG = new THREE.TorusGeometry(1.32, 0.022, 6, 96);
    ringG.rotateX(Math.PI / 2);
    const parts: THREE.BufferGeometry[] = [ringG];
    for (let i = 0; i < 6; i++) {
      const sp = new THREE.BoxGeometry(0.36, 0.018, 0.03);
      sp.translate(1.15, -0.01, 0);
      sp.rotateY((i / 6) * Math.PI * 2 + 0.3);
      parts.push(sp);
    }
    const ringAll = mergeSimple(parts);
    this.ring = new THREE.Mesh(ringAll, this.bodyMat);
    // Lights round the rim's underside and at the spindle's tip.
    const lp = new Float32Array((LIGHTS + 1) * 3), lc = new Float32Array((LIGHTS + 1) * 3);
    for (let i = 0; i < LIGHTS; i++) {
      const a = (i / LIGHTS) * Math.PI * 2 + r.range(-0.05, 0.05);
      const rr = i % 3 === 0 ? 1.32 : 0.985;
      lp.set([Math.cos(a) * rr, i % 3 === 0 ? -0.02 : -0.03, Math.sin(a) * rr], i * 3);
      lc.set(i % 5 === 0 ? [2, 1.5, 1.1] : [1.2, 1.7, 2], i * 3);
    }
    lp.set([0, -0.63, 0], LIGHTS * 3);
    lc.set([1, 0.3, 0.25], LIGHTS * 3);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(lp, 3));
    lg.setAttribute('color', new THREE.BufferAttribute(lc, 3));
    this.lightsMat = new THREE.PointsMaterial({ size: 3.2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.lights = new THREE.Points(lg, this.lightsMat);

    const tilt = new THREE.Group();
    tilt.add(this.body, this.ring, this.lights);
    // Turned a touch towards the viewer, so the underside reads.
    tilt.rotation.set(r.range(-0.08, 0.08), r.range(0, Math.PI * 2), r.range(-0.08, 0.08));
    this.group.add(tilt);
    this.group.scale.setScalar(RADIUS);
    // After the sky and stars, before anything transparent nearer by.
    this.group.renderOrder = -990;
    for (const o of [this.body, this.ring, this.lights]) { o.frustumCulled = false; o.renderOrder = -990; }
  }

  /** Follow the camera; haze, cloud and night. */
  update(dt: number, cam: THREE.Camera, sky: SkySystem): void {
    this.group.position.copy(cam.position).addScaledVector(this.dir, DIST);
    const wx = sky.wx;
    const day = smoothstep(-0.12, 0.15, sky.sunDir.y);
    // Cloud, fog and rain hide it; underground there is no sky.
    const veil = (1 - 0.92 * smoothstep(0.5, 0.95, wx.cover)) * (1 - clamp(wx.fog * 1.4 + wx.rain * 0.3, 0, 1)) * (1 - sky.underground);
    this.group.visible = veil > 0.01;
    // By day a pale ghost (the blue shows through), at night a solid dark body against the stars.
    this.bodyMat.opacity = lerp(0.97, 0.62, day) * veil;
    this.bodyMat.color.setScalar(lerp(0.55, 1.1, day));
    this.lightsMat.opacity = lerp(1, 0.15, day) * veil;
    // The lights crawl round slowly (once in ten minutes) and the tip blinks.
    this.spin += dt;
    this.lights.rotation.y = (this.spin / 600) * Math.PI * 2;
    this.lightsMat.size = 3.2 + 0.6 * Math.sin(this.spin * 0.7);
  }
}

/** Merge non-indexed copies of simple geometries (position + normal). */
function mergeSimple(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const ps: number[] = [], ns: number[] = [];
  for (const g of parts) {
    const ng = g.index ? g.toNonIndexed() : g;
    ps.push(...(ng.attributes.position.array as Float32Array));
    ns.push(...(ng.attributes.normal.array as Float32Array));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(ps, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(ns, 3));
  // The ring has no vertex colours: a mid grey.
  out.setAttribute('color', new THREE.Float32BufferAttribute(new Array(ps.length).fill(0.62), 3));
  return out;
}
