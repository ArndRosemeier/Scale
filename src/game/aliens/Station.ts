/**
 * The Wardens' station (ALIENS_PLAN §2): a vast ship hanging high over the city, a little over a
 * kilometre across, always in the same place. From the streets it reads like a second moon: a pale
 * ghost against the blue by day, a dark body lit by a few slow lights crawling round its rim at
 * night, fading behind thick cloud and fog. It is a real object in the world, so a flying hero who
 * heads for it gets closer, and up close it is a detailed hull (plated, with lit windows, decks,
 * towers and masts on top, ribs and hangar bays underneath) one can land and walk on. It cannot be
 * entered yet.
 *
 * Two levels of detail: the sky version (one light lathe shape, the ghost) and the near version
 * (the full hull), swapped with a short cross-fade a couple of kilometres out. The hull is solid
 * for the hero through Collision.floating (see stationShape) and the obstacles below.
 */
import * as THREE from 'three';
import { Rng, deriveSeed } from '../../core/rng';
import { clamp, lerp, smoothstep } from '../../core/math';
import type { SkySystem } from '../../render/SkySystem';
import type { Obstacle } from '../../world/Collision';
import { PROFILE, DECKS, STATION_R, hullSpan, stationSpot, stationGround, stationCeiling, stationPush, type StationBody } from './stationShape';

/** Camera distance (m, to the hull's centre) where the near hull comes in, and the far one is gone. */
const NEAR_IN = 2700, FAR_OUT = 2100;
/** Plate texture tile (m). */
const TILE = 40;
const LIGHTS = 30;

export class Station {
  readonly group = new THREE.Group();
  /** Direction from the viewer (unit). */
  readonly dir = new THREE.Vector3();
  /** The hull's centre (rim height) in the world, and its radius. */
  readonly body: StationBody;
  /** Distance from the camera to the hull's centre (m), as of the last update. */
  dist = Infinity;
  private far = new THREE.Group();
  private near = new THREE.Group();
  private farMat: THREE.MeshLambertMaterial;
  private nearMats: THREE.MeshStandardMaterial[] = [];
  private litMat!: THREE.MeshStandardMaterial;
  private glowMat!: THREE.MeshStandardMaterial;
  private lightsMat: THREE.PointsMaterial;
  private lights: THREE.Points;
  private spin = 0;
  /** Solid bits on the hull (deck blocks, towers, masts, pods), world coordinates. */
  private solids: Obstacle[] = [];
  private textures: THREE.Texture[] = [];

  /** ground(x, z): terrain height (for the station's height over the land below it). */
  constructor(seed: number, ground: (x: number, z: number) => number) {
    const spot = stationSpot(seed);
    const base = Math.max(ground(0, 0), ground(spot.x, spot.z), 0);
    this.body = { x: spot.x, y: base + 2600, z: spot.z, R: STATION_R };
    const r = new Rng(deriveSeed(seed, 'station', 'hull'));
    this.group.position.set(this.body.x, this.body.y, this.body.z);

    // ---- the sky version: the lathe shape, banded, the ring on its spokes, as one ghostly material
    this.farMat = new THREE.MeshLambertMaterial({ vertexColors: true, fog: false, transparent: true, depthWrite: false, emissive: new THREE.Color(0.012, 0.016, 0.026) });
    const fm = new Mesher();
    for (let i = 0; i + 1 < PROFILE.length; i++) {
      const [r0, y0] = PROFILE[i], [r1, y1] = PROFILE[i + 1];
      fm.band(r0, y0, r1, y1, 64, 1, 0, 1, (s) => (s % 7 === 0 ? 0.8 : 1) * (0.55 + 0.35 * ((i * 5) % 3) / 2));
    }
    fm.torus(1.32, 0.022, 96, 6, 0.62);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + spot.yaw;
      fm.box(Math.cos(a) * 1.16, -0.005, Math.sin(a) * 1.16, Math.cos(a), Math.sin(a), 0.16, 0.009, 0.015, 0.62);
    }
    const farMesh = new THREE.Mesh(fm.build(), this.farMat);
    farMesh.scale.setScalar(STATION_R);
    this.far.add(farMesh);

    // ---- the lights (both versions): round the rim, on the ring, the spindle's tip, the masts
    const lp: number[] = [], lc: number[] = [];
    const light = (x: number, y: number, z: number, c: readonly number[]): void => { lp.push(x / STATION_R, y / STATION_R, z / STATION_R); lc.push(...c); };
    for (let i = 0; i < LIGHTS; i++) {
      const a = (i / LIGHTS) * Math.PI * 2 + r.range(-0.05, 0.05);
      const rr = (i % 3 === 0 ? 1.32 : 0.985) * STATION_R;
      light(Math.cos(a) * rr, (i % 3 === 0 ? -0.02 : -0.03) * STATION_R, Math.sin(a) * rr, i % 5 === 0 ? [2, 1.5, 1.1] : [1.2, 1.7, 2]);
    }
    light(0, -0.63 * STATION_R, 0, [1, 0.3, 0.25]);

    // ---- the near version
    const tex = hullTextures(r);
    this.textures.push(tex.plain, tex.windows, tex.glow, tex.white);
    const mat = (map: THREE.Texture, emissive: THREE.ColorRepresentation, metal: number, rough: number): THREE.MeshStandardMaterial => {
      const m = new THREE.MeshStandardMaterial({ map, emissiveMap: emissive === 0 ? tex.glow : map === tex.windows ? tex.glow : tex.white, emissive, vertexColors: true, metalness: metal, roughness: rough, fog: false });
      this.nearMats.push(m);
      return m;
    };
    // One program for all three (the same maps and flags): plain plates, plates with lit windows, glow strips.
    const plainMat = mat(tex.plain, 0x000000, 0.5, 0.52);
    this.litMat = mat(tex.windows, 0xffffff, 0.5, 0.48);
    this.glowMat = mat(tex.plain, 0x9fe6ff, 0.2, 0.6);
    const plain = new Mesher(), lit = new Mesher(), glow = new Mesher();
    const R = STATION_R;
    // The hull: one band per profile segment, steep ones (the rim, terrace walls, the spindle's
    // flange) windowed.
    let v = 0;
    for (let i = 0; i + 1 < PROFILE.length; i++) {
      const [r0, y0] = PROFILE[i], [r1, y1] = PROFILE[i + 1];
      const len = Math.hypot(r1 - r0, y1 - y0) * R;
      const rm = ((r0 + r1) / 2) * R;
      const reps = Math.max(1, Math.round((2 * Math.PI * rm) / TILE));
      const steep = Math.abs(y1 - y0) > Math.abs(r1 - r0) * 1.5 && len > 8;
      const segs = rm < 60 ? 48 : rm < 200 ? 128 : 256;
      (steep ? lit : plain).band(r0 * R, y0 * R, r1 * R, y1 * R, segs, reps, v / TILE, (v + len) / TILE, () => (i % 2 ? 0.94 : 1));
      v += len;
    }
    // Glowing rings under the belly.
    for (const rr of [0.31, 0.56, 0.81]) {
      const a = rr * R - 1.2, b = rr * R + 1.2;
      const ya = hullSpan(a / R)![0] * R - 0.5, yb = hullSpan(b / R)![0] * R - 0.5;
      glow.band(a, ya, b, yb, 256, 1, 0, 1, () => 1);
    }
    // Ribs under the belly, following its slope.
    const ribs = 48;
    for (let k = 0; k < ribs; k++) {
      const a = (k / ribs) * Math.PI * 2 + spot.yaw;
      const ca = Math.cos(a), sa = Math.sin(a);
      for (let i = 0; i + 1 < PROFILE.length; i++) {
        const [r0, y0] = PROFILE[i], [r1, y1] = PROFILE[i + 1];
        if (r0 < 0.2 || r1 > 0.97 || y1 > -0.02 || r1 <= r0) continue;
        const L = Math.hypot(r1 - r0, y1 - y0) * R;
        const dr = ((r1 - r0) * R) / L, dy = ((y1 - y0) * R) / L;
        // Outward (down) normal in the radial plane: (dy, -dr).
        const nr = dy, ny = -dr;
        const mr = ((r0 + r1) / 2) * R + nr * 1.6, my = ((y0 + y1) / 2) * R + ny * 1.6;
        plain.boxAxes(mr * ca, my, mr * sa, [dr * ca, dy, dr * sa], [-sa, 0, ca], [nr * ca, ny, nr * sa], L / 2 + 0.5, k % 4 === 0 ? 4 : 2.2, 1.8, 0.82);
      }
    }
    // Hangar bays between the ribs: dark recesses framed by light strips.
    for (let k = 0; k < 4; k++) {
      const a = ((k + 0.5) / 4) * Math.PI * 2 + spot.yaw + Math.PI / ribs;
      const ca = Math.cos(a), sa = Math.sin(a);
      const rr = 0.5 * R, y = hullSpan(0.5)![0] * R - 0.6;
      const t: [number, number, number] = [-sa, 0, ca], o: [number, number, number] = [ca, 0, sa], up: [number, number, number] = [0, 1, 0];
      plain.boxAxes(rr * ca, y, rr * sa, o, up, t, 36, 0.4, 26, 0.12);
      for (const s of [-1, 1]) {
        glow.boxAxes((rr + s * 36) * ca, y - 0.3, (rr + s * 36) * sa, o, up, t, 0.8, 0.4, 26, 1);
        glow.boxAxes(rr * ca + t[0] * s * 26, y - 0.3, rr * sa + t[2] * s * 26, o, up, t, 36, 0.4, 0.8, 1);
      }
    }
    // The spindle: collars and fins.
    for (const [yy, rad] of [[-0.3, 0.075], [-0.46, 0.062], [-0.52, 0.06]] as const) plain.torusAt(0, yy * R, 0, rad * R, 3.5, 64, 6, 0.85);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + spot.yaw;
      const ca = Math.cos(a), sa = Math.sin(a);
      plain.boxAxes(0.066 * R * ca, -0.45 * R, 0.066 * R * sa, [ca, 0, sa], [0, 1, 0], [-sa, 0, ca], 9, 0.1 * R, 1.6, 0.8);
    }
    glow.torusAt(0, -0.57 * R, 0, 0.045 * R, 1.2, 48, 6, 1);
    // The outer ring on six spokes (lit windows along the ring).
    lit.torusAt(0, 0, 0, 1.32 * R, 0.022 * R, 320, 12, 0.9);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + spot.yaw;
      const ca = Math.cos(a), sa = Math.sin(a);
      const mid = 1.16 * R, hl = 0.16 * R;
      plain.boxAxes(mid * ca, -0.005 * R, mid * sa, [ca, 0, sa], [0, 1, 0], [-sa, 0, ca], hl, 0.009 * R, 0.015 * R, 0.75);
      this.solid(mid * ca, mid * sa, ca, sa, hl, 0.015 * R, -0.014 * R, 0.004 * R);
    }

    // On top: blocks on the decks (some with windows), radiator fins, pods round the outer slope,
    // the bridge tower on the dome and masts.
    const placeOnRing = (r0: number, r1: number, y: number, minW: number, maxW: number, maxH: number, gap: number): void => {
      const mid = (r0 + r1) / 2;
      let a = r.range(0, 0.2);
      while (a < Math.PI * 2 - 0.05) {
        const w = r.range(minW, maxW);
        const da = (w + gap * r.range(0.6, 2.2)) / mid;
        if (a + da > Math.PI * 2) break;
        if (r.chance(0.82)) {
          const depth = Math.min(r1 - r0 - 8, r.range(minW, maxW * 1.3));
          const off = r.range(-1, 1) * Math.max(0, (r1 - r0 - 8 - depth) / 2);
          const rr = mid + off, ang = a + spot.yaw + da / 2;
          const ca = Math.cos(ang), sa = Math.sin(ang);
          const h = r.chance(0.12) ? r.range(maxH * 0.8, maxH * 1.8) : r.range(3, maxH);
          const x = rr * ca, z = rr * sa;
          const isLit = r.chance(0.45);
          (isLit ? lit : plain).boxAxes(x, y + h / 2, z, [-sa, 0, ca], [0, 1, 0], [-ca, 0, -sa], w / 2, h / 2, depth / 2, r.range(0.78, 1));
          this.solid(x, z, -sa, ca, w / 2, depth / 2, y - 1, y + h);
          // A smaller block on top now and then.
          if (h > 8 && r.chance(0.35)) {
            const h2 = r.range(2, h * 0.6), w2 = w * r.range(0.3, 0.6), d2 = depth * r.range(0.3, 0.6);
            plain.boxAxes(x, y + h + h2 / 2, z, [-sa, 0, ca], [0, 1, 0], [-ca, 0, -sa], w2 / 2, h2 / 2, d2 / 2, 0.9);
            this.solid(x, z, -sa, ca, w2 / 2, d2 / 2, y + h - 0.5, y + h + h2);
          }
          if (r.chance(0.06)) light(x, y + h + 0.5, z, [1.6, 0.4, 0.3]);
        } else if (r.chance(0.5)) {
          // Radiator fins: a row of thin tall plates.
          const n = Math.floor(w / 3);
          for (let k = 0; k < n; k++) {
            const ang = a + spot.yaw + ((k + 0.5) * 3) / mid;
            const ca = Math.cos(ang), sa = Math.sin(ang);
            plain.boxAxes(mid * ca, y + 6, mid * sa, [ca, 0, sa], [0, 1, 0], [-sa, 0, ca], (r1 - r0) * 0.3, 6, 0.3, 0.7);
          }
          const ang = a + spot.yaw + w / 2 / mid;
          this.solid(mid * Math.cos(ang), mid * Math.sin(ang), -Math.sin(ang), Math.cos(ang), w / 2, (r1 - r0) * 0.3, y - 1, y + 12);
        }
        a += da;
      }
    };
    for (const [ri, ro, y] of DECKS) placeOnRing(ri * R + 6, ro * R - 6, y * R, 8, 30, ri > 0.6 ? 16 : 28, 10);
    // Pods round the outer slope.
    for (let k = 0; k < 16; k++) {
      const ang = (k / 16) * Math.PI * 2 + spot.yaw + 0.1;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const rr = 0.9 * R, y = 0.06 * R;
      plain.boxAxes(rr * ca, y, rr * sa, [ca, 0, sa], [0, 1, 0], [-sa, 0, ca], 30, 12, 13, 0.88);
      lit.boxAxes((rr + 30.2) * ca, y, (rr + 30.2) * sa, [ca, 0, sa], [0, 1, 0], [-sa, 0, ca], 0.4, 7, 9, 1);
      this.solid(rr * ca, rr * sa, ca, sa, 30, 13, y - 12, y + 12);
    }
    // The bridge on the crown, masts round it.
    const crown = 0.314 * R;
    lit.cyl(0, crown - 2, 0, 38, 30, 64, 0.95);
    plain.cyl(0, crown + 28, 0, 52, 4, 64, 0.85);
    plain.cyl(0, crown + 32, 0, 20, 10, 32, 0.9);
    this.solids.push(cylSolid(this.body, 0, 0, 52, crown - 2, crown + 42));
    const masts = 7;
    for (let k = 0; k < masts; k++) {
      const ang = (k / masts) * Math.PI * 2 + spot.yaw + 0.3;
      const rr = k % 2 ? 0.27 * R : 0.2 * R;
      const x = rr * Math.cos(ang), z = rr * Math.sin(ang);
      const yb = hullSpan(rr / R)![1] * R;
      const h = r.range(50, 140);
      plain.boxAxes(x, yb + h / 2, z, [1, 0, 0], [0, 1, 0], [0, 0, 1], 1.4, h / 2, 1.4, 0.8);
      for (let c = 1; c <= 3; c++) {
        const cy = yb + (h * c) / 4;
        plain.boxAxes(x, cy, z, [Math.cos(ang), 0, Math.sin(ang)], [0, 1, 0], [-Math.sin(ang), 0, Math.cos(ang)], 6 - c, 0.5, 0.5, 0.8);
      }
      this.solids.push(cylSolid(this.body, x, z, 1.6, yb - 1, yb + h));
      light(x, yb + h + 1.5, z, k % 2 ? [2, 0.35, 0.3] : [1.4, 1.8, 2.2]);
    }

    for (const [m, mt] of [[plain, plainMat], [lit, this.litMat], [glow, this.glowMat]] as const) {
      const mesh = new THREE.Mesh(m.build(), mt);
      this.near.add(mesh);
    }
    this.near.visible = false;

    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    lg.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3));
    this.lightsMat = new THREE.PointsMaterial({ size: 3.2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.lights = new THREE.Points(lg, this.lightsMat);
    this.lights.scale.setScalar(STATION_R);

    this.group.add(this.far, this.near, this.lights);
    // After the sky and stars, before anything transparent nearer by.
    this.far.renderOrder = -990;
    farMesh.renderOrder = -990;
    this.lights.renderOrder = -990;
    for (const o of [farMesh, this.lights]) o.frustumCulled = false;
  }

  /** A small mesh with the near hull's material (for the warm-up to compile its program). */
  warmupObject(): THREE.Object3D {
    return new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.litMat);
  }

  /** The hull as a solid for Collision.floating. */
  readonly solidHull = {
    ground: (x: number, z: number, yRef: number, step: number): number => stationGround(this.body, x, z, yRef, step),
    ceiling: (x: number, z: number, y: number): number => stationCeiling(this.body, x, z, y, 0.4),
    push: (x: number, z: number, y: number, h: number, r: number) => stationPush(this.body, x, z, y, h, r, Math.max(0.35, h * 0.28)),
  };

  /** Is (x, y, z) on or right by the hull (no physics ground there: ragdolls must not start)? */
  onHull(x: number, y: number, z: number): boolean {
    const b = this.body;
    return Math.abs(y - b.y) < b.R && Math.hypot(x - b.x, z - b.z) < b.R * 1.45;
  }

  /** Solid things on the hull overlapping the box (x0,z0)-(x1,z1). */
  obstacles(x0: number, z0: number, x1: number, z1: number, out: (o: Obstacle) => void): void {
    const b = this.body, m = b.R * 1.4;
    if (x1 < b.x - m || x0 > b.x + m || z1 < b.z - m || z0 > b.z + m) return;
    for (const o of this.solids) {
      const e = o.cyl ? o.r : Math.max(o.hx, o.hz);
      if (o.x + e < x0 || o.x - e > x1 || o.z + e < z0 || o.z - e > z1) continue;
      out(o);
    }
  }

  /** A box on the hull, local (x, z) and its long axis (ux, uz), half extents, heights local. */
  private solid(x: number, z: number, ux: number, uz: number, hx: number, hz: number, y0: number, y1: number): void {
    const b = this.body;
    this.solids.push({ cyl: false, x: b.x + x, z: b.z + z, r: 0, hx, hz, ux, uz, y0: b.y + y0, y1: b.y + y1 });
  }

  /** Follow the view: which version shows, haze, cloud and night. */
  update(dt: number, cam: THREE.Camera, sky: SkySystem): void {
    const b = this.body;
    this.dir.set(b.x - cam.position.x, b.y - cam.position.y, b.z - cam.position.z);
    const d = this.dir.length();
    this.dist = d;
    this.dir.multiplyScalar(1 / Math.max(1, d));
    const wx = sky.wx;
    const day = smoothstep(-0.12, 0.15, sky.sunDir.y);
    // Cloud, fog and rain hide it from the streets; close by (in among them) they no longer do.
    // Underground there is no sky.
    const weather = (1 - 0.92 * smoothstep(0.5, 0.95, wx.cover)) * (1 - clamp(wx.fog * 1.4 + wx.rain * 0.3, 0, 1));
    const veil = lerp(weather, 1, 1 - smoothstep(1500, 3500, d)) * (1 - sky.underground);
    this.group.visible = veil > 0.01;
    // By day a pale ghost (the blue shows through), at night a solid dark body against the stars;
    // solid as one gets close, then the near hull takes over.
    const close = 1 - smoothstep(NEAR_IN, 4600, d);
    const fade = smoothstep(FAR_OUT, NEAR_IN, d);
    this.far.visible = fade > 0.01;
    this.farMat.opacity = lerp(lerp(0.97, 0.62, day), 1, close) * veil * fade;
    this.farMat.color.setScalar(lerp(0.55, 1.1, day));
    this.near.visible = d < NEAR_IN && veil > 0.01;
    for (const m of this.nearMats) m.color.setScalar(lerp(0.7, 1, day));
    this.litMat.emissiveIntensity = lerp(1.4, 0.35, day);
    this.glowMat.emissiveIntensity = lerp(2.2, 0.8, day);
    this.lightsMat.opacity = lerp(1, 0.15, day) * veil;
    // The lights crawl round slowly (once in ten minutes) and the tip blinks.
    this.spin += dt;
    this.lightsMat.size = 3.2 + 0.6 * Math.sin(this.spin * 0.7);
  }

  /** Free the GPU side (geometry, materials, textures). */
  dispose(): void {
    this.group.traverse((o) => { if (o instanceof THREE.Mesh || o instanceof THREE.Points) o.geometry.dispose(); });
    for (const m of [this.farMat, this.lightsMat, ...this.nearMats]) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}

function cylSolid(b: StationBody, x: number, z: number, r: number, y0: number, y1: number): Obstacle {
  return { cyl: true, x: b.x + x, z: b.z + z, r, hx: 0, hz: 0, ux: 1, uz: 0, y0: b.y + y0, y1: b.y + y1 };
}

type V3 = readonly [number, number, number];

/** Builds one indexed geometry (position, normal, uv in plate tiles, colour) from simple parts. */
class Mesher {
  private p: number[] = [];
  private n: number[] = [];
  private uv: number[] = [];
  private c: number[] = [];
  private idx: number[] = [];

  private vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, k: number): number {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.uv.push(u, v);
    this.c.push(k * 0.93, k * 0.96, k);
    return this.p.length / 3 - 1;
  }

  /** A lathe band from (r0, y0) to (r1, y1) all round: `reps` plate tiles round, v0..v1 along. */
  band(r0: number, y0: number, r1: number, y1: number, segs: number, reps: number, v0: number, v1: number, shade: (seg: number) => number): void {
    const L = Math.hypot(r1 - r0, y1 - y0) || 1;
    const dr = (r1 - r0) / L, dy = (y1 - y0) / L;
    const base = this.p.length / 3;
    for (let s = 0; s <= segs; s++) {
      const a = (s / segs) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const k = shade(s % segs);
      // Outward normal: (dy·cos, −dr, dy·sin).
      this.vert(r0 * ca, y0, r0 * sa, dy * ca, -dr, dy * sa, (s / segs) * reps, v0, k);
      this.vert(r1 * ca, y1, r1 * sa, dy * ca, -dr, dy * sa, (s / segs) * reps, v1, k);
    }
    for (let s = 0; s < segs; s++) {
      const a = base + s * 2, b = a + 2;
      this.idx.push(a, a + 1, b + 1, a, b + 1, b);
    }
  }

  /** A box: centre, three unit axes (right-handed), half extents along them; plates in metres. */
  boxAxes(cx: number, cy: number, cz: number, ax: V3, ay: V3, az: V3, hx: number, hy: number, hz: number, k: number): void {
    const A = [ax, ay, az], H = [hx, hy, hz];
    // [normal axis, sign, in-plane i, in-plane j] with i × j = ±normal.
    const faces: [number, number, number, number][] = [[0, 1, 1, 2], [0, -1, 2, 1], [1, 1, 2, 0], [1, -1, 0, 2], [2, 1, 0, 1], [2, -1, 1, 0]];
    for (const [f, sg, i, j] of faces) {
      const nv = A[f], iv = A[i], jv = A[j];
      const base = this.p.length / 3;
      for (const [si, sj] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const x = cx + nv[0] * H[f] * sg + iv[0] * H[i] * si + jv[0] * H[j] * sj;
        const y = cy + nv[1] * H[f] * sg + iv[1] * H[i] * si + jv[1] * H[j] * sj;
        const z = cz + nv[2] * H[f] * sg + iv[2] * H[i] * si + jv[2] * H[j] * sj;
        this.vert(x, y, z, nv[0] * sg, nv[1] * sg, nv[2] * sg, (cx + cz + H[i] * si) / TILE, (cy + H[j] * sj) / TILE, k);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  /** A box with its long axis (ux, 0, uz) level (sizes are half extents). */
  box(cx: number, cy: number, cz: number, ux: number, uz: number, hx: number, hy: number, hz: number, k: number): void {
    this.boxAxes(cx, cy, cz, [ux, 0, uz], [0, 1, 0], [-uz, 0, ux], hx, hy, hz, k);
  }

  /** An upright cylinder (base at y) with a top cap. */
  cyl(cx: number, y: number, cz: number, rad: number, h: number, segs: number, k: number): void {
    const reps = Math.max(1, Math.round((2 * Math.PI * rad) / TILE));
    const base = this.p.length / 3;
    for (let s = 0; s <= segs; s++) {
      const a = (s / segs) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      this.vert(cx + rad * ca, y, cz + rad * sa, ca, 0, sa, (s / segs) * reps, y / TILE, k);
      this.vert(cx + rad * ca, y + h, cz + rad * sa, ca, 0, sa, (s / segs) * reps, (y + h) / TILE, k);
    }
    for (let s = 0; s < segs; s++) { const a = base + s * 2, b = a + 2; this.idx.push(a, a + 1, b + 1, a, b + 1, b); }
    const c0 = this.vert(cx, y + h, cz, 0, 1, 0, cx / TILE, cz / TILE, k);
    const ring = this.p.length / 3;
    for (let s = 0; s <= segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      this.vert(cx + rad * Math.cos(a), y + h, cz + rad * Math.sin(a), 0, 1, 0, (cx + rad * Math.cos(a)) / TILE, (cz + rad * Math.sin(a)) / TILE, k);
    }
    for (let s = 0; s < segs; s++) this.idx.push(c0, ring + s + 1, ring + s);
  }

  /** A level torus round (cx, cy, cz). */
  torusAt(cx: number, cy: number, cz: number, R: number, tube: number, segs: number, tubeSegs: number, k: number): void {
    const reps = Math.max(1, Math.round((2 * Math.PI * R) / TILE));
    const base = this.p.length / 3;
    for (let s = 0; s <= segs; s++) {
      const a = (s / segs) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      for (let t = 0; t <= tubeSegs; t++) {
        const b = (t / tubeSegs) * Math.PI * 2, cb = Math.cos(b), sb = Math.sin(b);
        const nx = cb * ca, ny = sb, nz = cb * sa;
        this.vert(cx + (R + tube * cb) * ca, cy + tube * sb, cz + (R + tube * cb) * sa, nx, ny, nz, (s / segs) * reps, (t / tubeSegs) * Math.max(1, (2 * Math.PI * tube) / TILE), k);
      }
    }
    const W = tubeSegs + 1;
    for (let s = 0; s < segs; s++) for (let t = 0; t < tubeSegs; t++) {
      const a = base + s * W + t, b = a + W;
      this.idx.push(a, a + 1, b + 1, a, b + 1, b);
    }
  }

  /** A torus round the origin (the sky version, in hull radii). */
  torus(R: number, tube: number, segs: number, tubeSegs: number, k: number): void { this.torusAt(0, 0, 0, R, tube, segs, tubeSegs, k); }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * The hull's plating, drawn once: plates of slightly different shades with seams, vents and
 * hatches; the same plates with rows of windows (dark glass), and the windows' light (a smaller
 * map: most dark, some warm, most a pale blue-white).
 */
function hullTextures(r: Rng): { plain: THREE.Texture; windows: THREE.Texture; glow: THREE.Texture; white: THREE.Texture } {
  const S = 1024, G = 512, gs = G / S;
  const mk = (n: number): [HTMLCanvasElement, CanvasRenderingContext2D] => {
    const c = document.createElement('canvas');
    c.width = c.height = n;
    return [c, c.getContext('2d')!];
  };
  const [pc, p] = mk(S), [wc, w] = mk(S), [gc, g] = mk(G);
  p.fillStyle = '#7f858c'; p.fillRect(0, 0, S, S);
  g.fillStyle = '#000'; g.fillRect(0, 0, G, G);
  const leaves: [number, number, number, number][] = [];
  const split = (x: number, y: number, ww: number, hh: number, depth: number): void => {
    if (ww <= 64 || hh <= 64 || (depth > 2 && r.chance(0.28))) { leaves.push([x, y, ww, hh]); return; }
    if (ww >= hh) { const s = Math.round((ww * r.range(0.3, 0.7)) / 16) * 16; split(x, y, s, hh, depth + 1); split(x + s, y, ww - s, hh, depth + 1); }
    else { const s = Math.round((hh * r.range(0.3, 0.7)) / 16) * 16; split(x, y, ww, s, depth + 1); split(x, y + s, ww, hh - s, depth + 1); }
  };
  split(0, 0, S, S, 0);
  const rgb = (k: number): string => `rgb(${Math.round(k * 0.93)},${Math.round(k * 0.96)},${Math.round(k)})`;
  const windowRows: [number, number, number, number][] = [];
  for (const [x, y, ww, hh] of leaves) {
    p.fillStyle = rgb(r.range(140, 164)); p.fillRect(x, y, ww, hh);
    // Grime towards the lower edge.
    if (r.chance(0.35)) { const gr = p.createLinearGradient(0, y, 0, y + hh); gr.addColorStop(0, 'rgba(40,40,45,0)'); gr.addColorStop(1, 'rgba(40,40,45,0.18)'); p.fillStyle = gr; p.fillRect(x, y, ww, hh); }
    // Seams: a light edge on top/left, a dark one below/right.
    p.fillStyle = 'rgba(255,255,255,0.12)'; p.fillRect(x, y, ww, 2); p.fillRect(x, y, 2, hh);
    p.fillStyle = 'rgba(25,28,34,0.5)'; p.fillRect(x, y + hh - 3, ww, 3); p.fillRect(x + ww - 3, y, 3, hh);
    const roll = r.float();
    if (roll < 0.12 && ww > 80 && hh > 60) {
      // A vent grille.
      const vw = Math.min(ww - 24, r.range(40, 140)), vh = Math.min(hh - 24, r.range(24, 80));
      const vx = x + (ww - vw) / 2, vy = y + (hh - vh) / 2;
      p.fillStyle = 'rgba(30,33,38,0.85)'; p.fillRect(vx, vy, vw, vh);
      p.fillStyle = 'rgba(150,156,165,0.9)';
      for (let k = vy + 3; k < vy + vh - 2; k += 7) p.fillRect(vx + 2, k, vw - 4, 3);
    } else if (roll < 0.22 && ww > 60 && hh > 60) {
      // A hatch.
      const s = Math.min(ww, hh) * r.range(0.35, 0.6);
      const hx = x + (ww - s) / 2, hy = y + (hh - s) / 2;
      p.strokeStyle = 'rgba(25,28,34,0.8)'; p.lineWidth = 3; p.strokeRect(hx, hy, s, s);
      p.fillStyle = 'rgba(200,170,60,0.55)'; p.fillRect(hx + s * 0.1, hy + s * 0.1, s * 0.15, s * 0.05);
    } else if (roll < 0.62 && hh >= 72 && ww >= 64) windowRows.push([x, y, ww, hh]);
  }
  // Rivet lines along some seams.
  p.fillStyle = 'rgba(40,44,50,0.5)';
  for (const [x, y, ww] of leaves) if (r.chance(0.3)) for (let k = x + 8; k < x + ww - 6; k += 12) p.fillRect(k, y + 6, 2, 2);
  w.drawImage(pc, 0, 0);
  // Windows: rows of dark glass, about 1.9 m tall on ~3.4 m decks (the plates are 40 m a tile).
  const px = S / TILE;
  const winH = Math.round(1.9 * px), deck = Math.round(3.4 * px), winW = Math.round(r.range(0.9, 1.4) * px), gap = Math.round(0.7 * px);
  const tints = ['#e8f4ff', '#cfe8ff', '#a8d8ff', '#ffe2b0', '#d8fff4'];
  for (const [x, y, ww, hh] of windowRows) {
    const rows = Math.floor((hh - 12) / deck);
    const tint = tints[r.int(0, tints.length - 1)];
    const wide = r.chance(0.25);
    for (let row = 0; row < rows; row++) {
      const wy = y + 6 + row * deck + (deck - winH) / 2;
      const lightRow = r.chance(0.8);
      for (let wx = x + 8; wx + winW < x + ww - 8; wx += (wide ? winW * 2 : winW) + gap) {
        const ww2 = wide ? winW * 2 : winW;
        w.fillStyle = '#18202b'; w.fillRect(wx, wy, ww2, winH);
        w.fillStyle = 'rgba(160,190,220,0.25)'; w.fillRect(wx, wy, ww2, 2);
        if (lightRow && r.chance(0.7)) {
          g.globalAlpha = r.range(0.55, 1);
          g.fillStyle = r.chance(0.12) ? tints[3] : tint;
          g.fillRect(wx * gs, wy * gs, Math.max(1, ww2 * gs), Math.max(1, winH * gs));
          g.globalAlpha = 1;
        }
      }
    }
  }
  const tex = (c: HTMLCanvasElement): THREE.CanvasTexture => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  };
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  white.colorSpace = THREE.SRGBColorSpace;
  white.needsUpdate = true;
  return { plain: tex(pc), windows: tex(wc), glow: tex(gc), white };
}
