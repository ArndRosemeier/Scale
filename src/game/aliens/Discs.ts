/**
 * The Wardens' discs (ALIENS_PLAN §2): smooth, seamless saucers crossing the sky over the city.
 * They drift on long straight legs high over the towers, now and then come down to hang over a
 * street and sweep a pale scan cone over it, gather high over an incident and watch it to the end
 * (never helping), hang over a landmark for hours, turn a cone on a hero doing something
 * spectacular, set walkers down on squares and pick them up again, and leave by climbing back up
 * towards the station. In a swarm a hundred or more drift about slowly with festive lights.
 *
 * Only the sky round the camera is simulated (a few kilometres: a 20 m disc is a speck beyond).
 * Kinematic flight: arrival steering with an acceleration limit, an altitude kept over whatever is
 * below and ahead (towers, the marvels' spires), a tilt into the acceleration.
 *
 * Drawn as instanced batches: the hull (metal, reflecting the sky), a glowing ring and core on the
 * underside, the scan cones (additive), and a point per disc that keeps them visible as lights at
 * night from far away.
 */
import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../../core/math';

export type DiscMode = 'cruise' | 'hover' | 'watch' | 'stare' | 'leave' | 'courier';

export interface Disc {
  id: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Radius (m). */
  r: number;
  mode: DiscMode;
  /** Where it is going (x, z) and the altitude it wants above the ground. */
  tx: number; tz: number;
  alt: number;
  /** Seconds left in this mode (hover, look). */
  t: number;
  maxV: number;
  /** Scan cone: strength 0..1 (fades), on or not, sweep centre and phase. */
  cone: number;
  coneOn: boolean;
  cx: number; cz: number; cr: number; ph: number;
  /** Where the cone points (filled while it is on). */
  aimX: number; aimY: number; aimZ: number;
  /** A cone on the hero for a few seconds. */
  lookT: number;
  /** Swarm member (festive, slow) and its hue. */
  swarm: boolean;
  hue: number;
  /** Kept by a task (watching an incident, staring, a walker's courier): not counted among the free discs. */
  task: string | null;
  /** Ground and the highest thing below / ahead (m), refreshed now and then. */
  ground: number;
  top: number;
  probeT: number;
  spin: number;
  gone: boolean;
  /** May come down close over the roofs (a parent disc dropping on its runaway saucer). */
  low?: boolean;
}

export interface DiscWorld {
  /** Terrain height (no buildings). */
  ground(x: number, z: number): number;
  /** The highest walkable top at a point: roofs, the marvels, terrain. */
  top(x: number, z: number): number;
}

/** Most discs at once (the biggest swarm plus the dedicated ones). */
export const MAX_DISCS = 190;
/** Radius round the camera the sky is simulated in (m); discs beyond it leave. */
export const SKY_R = 2400;
/** Clearance kept over roofs and spires (m). */
const CLEAR = 45;
const ACC = 7;
const VUP = 9;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _d = new THREE.Vector3();
const _Y = new THREE.Vector3(0, -1, 0);
const _c = new THREE.Color();

export class Discs {
  readonly group = new THREE.Group();
  readonly list: Disc[] = [];
  private hull: THREE.InstancedMesh;
  private glow: THREE.InstancedMesh;
  private cones: THREE.InstancedMesh;
  private dots: THREE.Points;
  private dotPos: THREE.BufferAttribute;
  private dotCol: THREE.BufferAttribute;
  private dotMat: THREE.PointsMaterial;
  private coneMat: THREE.MeshBasicMaterial;
  private nextId = 1;
  private time = 0;
  /** Called when a cone comes on (a sound, people looking up). */
  onScan: ((d: Disc) => void) | null = null;

  constructor(private w: DiscWorld) {
    this.hull = new THREE.InstancedMesh(hullGeometry(), new THREE.MeshStandardMaterial({ color: 0xc8cdd5, metalness: 0.88, roughness: 0.26 }), MAX_DISCS);
    this.glow = new THREE.InstancedMesh(glowGeometry(), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), MAX_DISCS);
    this.coneMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    this.cones = new THREE.InstancedMesh(coneGeometry(), this.coneMat, MAX_DISCS);
    for (const m of [this.hull, this.glow, this.cones]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
    }
    this.hull.castShadow = false;
    this.glow.setColorAt(0, _c.setRGB(1, 1, 1));
    this.cones.setColorAt(0, _c.setRGB(1, 1, 1));
    const pg = new THREE.BufferGeometry();
    this.dotPos = new THREE.BufferAttribute(new Float32Array(MAX_DISCS * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.dotCol = new THREE.BufferAttribute(new Float32Array(MAX_DISCS * 3), 3).setUsage(THREE.DynamicDrawUsage);
    pg.setAttribute('position', this.dotPos);
    pg.setAttribute('color', this.dotCol);
    pg.setDrawRange(0, 0);
    this.dotMat = new THREE.PointsMaterial({ size: 3.5, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.dots = new THREE.Points(pg, this.dotMat);
    this.dots.frustumCulled = false;
    this.group.add(this.hull, this.glow, this.cones, this.dots);
  }

  /** Free discs: not kept by a task, not on their way out. */
  free(): Disc[] { return this.list.filter((d) => !d.task && d.mode !== 'leave'); }

  /**
   * A new disc. `from`: 'edge' crosses in from the rim of the simulated sky towards (tx, tz);
   * 'above' comes down from high up (from the station) over (tx, tz).
   */
  spawn(fx: number, fz: number, tx: number, tz: number, from: 'edge' | 'above', swarm: boolean, rnd: () => number): Disc | null {
    if (this.list.length >= MAX_DISCS) return null;
    let x: number, z: number, y: number;
    if (from === 'edge') {
      const a = Math.atan2(tz - fz, tx - fx) + Math.PI + (rnd() - 0.5) * 1.2;
      x = fx + Math.cos(a) * SKY_R * 0.97; z = fz + Math.sin(a) * SKY_R * 0.97;
      y = this.w.ground(x, z) + 300 + rnd() * 160;
    } else {
      x = tx + (rnd() - 0.5) * 300; z = tz + (rnd() - 0.5) * 300;
      y = this.w.ground(x, z) + 1300 + rnd() * 400;
    }
    const g = this.w.ground(x, z);
    const d: Disc = {
      id: this.nextId++, x, y, z, vx: 0, vy: from === 'above' ? -18 : 0, vz: 0, r: 7 + rnd() * 5, mode: 'cruise', tx, tz,
      alt: swarm ? 220 + rnd() * 480 : 260 + rnd() * 170, t: 0, maxV: swarm ? 7 + rnd() * 9 : 20 + rnd() * 22,
      cone: 0, coneOn: false, cx: tx, cz: tz, cr: 0, ph: rnd() * 6.28, aimX: x, aimY: g, aimZ: z, lookT: 0,
      swarm, hue: rnd(), task: null, ground: g, top: g, probeT: 0, spin: rnd() * 6.28, gone: false,
    };
    if (from === 'edge') { const L = Math.hypot(tx - x, tz - z) || 1; d.vx = ((tx - x) / L) * d.maxV; d.vz = ((tz - z) / L) * d.maxV; }
    this.list.push(d);
    return d;
  }

  /** Send a disc away: it climbs back towards the station and is gone. */
  leave(d: Disc): void {
    d.mode = 'leave'; d.task = null; d.coneOn = false; d.lookT = 0;
  }

  /** Hang over a street for a while and sweep a scan cone over it. */
  hover(d: Disc, x: number, z: number, secs: number, low: number, rnd: () => number): void {
    d.mode = 'hover'; d.tx = x; d.tz = z; d.t = secs; d.alt = low;
    d.cx = x; d.cz = z; d.cr = 12 + rnd() * 34; d.coneOn = false;
  }

  /** Turn the cone on someone (the hero) for a few seconds. */
  look(d: Disc, x: number, y: number, z: number, secs: number): void {
    d.lookT = secs; d.aimX = x; d.aimY = y; d.aimZ = z;
    if (!d.coneOn) { d.coneOn = true; this.onScan?.(d); }
  }

  /** Is a point inside a disc's scan cone (lit at least halfway)? */
  inCone(d: Disc, x: number, y: number, z: number): boolean {
    if (d.cone < 0.5) return false;
    const ay = d.y - d.r * 0.15;
    _d.set(d.aimX - d.x, d.aimY - ay, d.aimZ - d.z);
    const L = _d.length();
    if (L < 1) return false;
    _d.divideScalar(L);
    const px = x - d.x, py = y - ay, pz = z - d.z;
    const t = px * _d.x + py * _d.y + pz * _d.z;
    if (t < 0 || t > L) return false;
    const perp = Math.hypot(px - _d.x * t, py - _d.y * t, pz - _d.z * t);
    return perp < Math.max(d.r * 0.5, L * 0.16) * (t / L) + 1.5;
  }

  update(dt: number, fx: number, fz: number, rnd: () => number): void {
    this.time += dt;
    for (const d of this.list) this.step(d, dt, fx, fz, rnd);
    for (let i = this.list.length - 1; i >= 0; i--) if (this.list[i].gone) this.list.splice(i, 1);
  }

  private step(d: Disc, dt: number, fx: number, fz: number, rnd: () => number): void {
    // What is below and ahead (towers, spires, hills): kept CLEAR over it.
    d.probeT -= dt;
    if (d.probeT <= 0) {
      d.probeT = 0.3 + rnd() * 0.2;
      d.ground = this.w.ground(d.x, d.z);
      let top = this.w.top(d.x, d.z);
      for (const k of [1.5, 3.5]) top = Math.max(top, this.w.top(d.x + d.vx * k, d.z + d.vz * k));
      for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2; top = Math.max(top, this.w.top(d.x + Math.cos(a) * d.r * 1.6, d.z + Math.sin(a) * d.r * 1.6)); }
      d.top = top;
    }
    let maxV = d.maxV, wantY = d.ground + d.alt;
    switch (d.mode) {
      case 'cruise': {
        const L = Math.hypot(d.tx - d.x, d.tz - d.z);
        if (L < 60) {
          // On to another point across the sky (or out of it).
          const a = rnd() * Math.PI * 2, rr = d.swarm ? 300 + rnd() * 1500 : 400 + rnd() * 1800;
          d.tx = fx + Math.cos(a) * rr; d.tz = fz + Math.sin(a) * rr;
        }
        if (Math.hypot(d.x - fx, d.z - fz) > SKY_R * 1.08) { d.gone = true; return; }
        break;
      }
      case 'hover': {
        maxV = 14;
        const L = Math.hypot(d.tx - d.x, d.tz - d.z);
        if (L < 20) {
          d.t -= dt;
          if (!d.coneOn && d.t > 4) { d.coneOn = true; this.onScan?.(d); }
          if (d.t < 2.5) d.coneOn = false;
          if (d.t <= 0) {
            d.mode = 'cruise'; d.alt = d.swarm ? 220 + rnd() * 480 : 260 + rnd() * 170;
            const a = rnd() * Math.PI * 2;
            d.tx = fx + Math.cos(a) * 1500; d.tz = fz + Math.sin(a) * 1500;
          }
        }
        break;
      }
      case 'watch': case 'stare': case 'courier':
        // Set by the task each frame (tx, tz, alt, coneOn).
        maxV = d.mode === 'courier' ? 30 : 22;
        break;
      case 'leave':
        wantY = d.y + 200;
        maxV = 25;
        if (d.y - d.ground > 1400) { d.gone = true; return; }
        break;
    }
    if (d.mode !== 'leave') wantY = Math.max(wantY, d.top + (d.low ? d.r * 0.4 + 8 : CLEAR));
    // Steering: arrive at (tx, tz).
    let ax = 0, az = 0;
    if (d.mode !== 'leave') {
      const ex = d.tx - d.x, ez = d.tz - d.z, L = Math.hypot(ex, ez);
      const want = Math.min(maxV, Math.sqrt(2 * ACC * 0.6 * L));
      const dvx = (L > 1e-3 ? (ex / L) * want : 0) - d.vx, dvz = (L > 1e-3 ? (ez / L) * want : 0) - d.vz;
      const dv = Math.hypot(dvx, dvz), k = Math.min(1, (ACC * dt) / Math.max(1e-6, dv));
      ax = dvx * k; az = dvz * k;
    } else { ax = -d.vx * Math.min(1, dt * 0.5); az = -d.vz * Math.min(1, dt * 0.5); }
    d.vx += ax; d.vz += az;
    // (Coming down from high up, fast; the last stretch slow.)
    const wantVy = clamp((wantY - d.y) * 0.6, -clamp((d.y - wantY) * 0.3, VUP * 0.8, 45), d.mode === 'leave' ? 40 : VUP);
    d.vy += clamp(wantVy - d.vy, -ACC * dt, ACC * dt * (d.y < d.top + CLEAR * 0.5 ? 4 : 1));
    d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
    // Never into a roof.
    if (d.y < d.top + d.r * 0.4 + 6) { d.y = d.top + d.r * 0.4 + 6; d.vy = Math.max(0, d.vy); }
    d.spin += dt * (0.3 + (d.swarm ? 0.4 : 0));
    // The cone: fades in and out; sweeps round its centre, or holds on whoever it looks at.
    if (d.lookT > 0) { d.lookT -= dt; if (d.lookT <= 0 && d.mode !== 'hover' && d.mode !== 'stare' && d.mode !== 'courier') d.coneOn = false; }
    d.cone = clamp(d.cone + (d.coneOn ? dt / 1.2 : -dt / 0.8), 0, 1);
    if (d.cone > 0 && d.lookT <= 0 && d.mode !== 'courier') {
      d.ph += dt * 0.35;
      d.aimX = d.cx + Math.cos(d.ph) * d.cr; d.aimZ = d.cz + Math.sin(d.ph * 1.37) * d.cr;
      d.aimY = this.w.top(d.aimX, d.aimZ);
    }
  }

  /** Fill the batches (day 0..1 for how bright the lights are). */
  draw(day: number, cam: THREE.Vector3): void {
    let nh = 0, nc = 0, np = 0;
    const night = 1 - day;
    const pos = this.dotPos.array as Float32Array, col = this.dotCol.array as Float32Array;
    for (const d of this.list) {
      // Hull: tilted into its acceleration-ish (velocity change shows as a lean), turning slowly.
      _e.set(clamp(d.vz * 0.006, -0.18, 0.18), d.spin, clamp(-d.vx * 0.006, -0.18, 0.18));
      _q.setFromEuler(_e);
      _p.set(d.x, d.y, d.z);
      _s.setScalar(d.r);
      _m.compose(_p, _q, _s);
      this.hull.setMatrixAt(nh, _m);
      this.glow.setMatrixAt(nh, _m);
      // Glow: pale blue-white, brighter at night; a swarm wears festive colours that change.
      const pulse = 0.85 + 0.15 * Math.sin(this.time * 1.7 + d.id);
      if (d.swarm) _c.setHSL((d.hue + this.time * 0.02) % 1, 0.75, 0.6);
      else _c.setRGB(0.6, 0.86, 1);
      _c.multiplyScalar(lerp(1.1, 3, night) * pulse);
      this.glow.setColorAt(nh, _c);
      nh++;
      // A point of light for the far ones at night.
      pos[np * 3] = d.x; pos[np * 3 + 1] = d.y - d.r * 0.12; pos[np * 3 + 2] = d.z;
      const far = smoothstep(150, 500, Math.hypot(d.x - cam.x, d.y - cam.y, d.z - cam.z));
      col[np * 3] = _c.r * 0.6 * far; col[np * 3 + 1] = _c.g * 0.6 * far; col[np * 3 + 2] = _c.b * 0.6 * far;
      np++;
      if (d.cone > 0.01) {
        _d.set(d.aimX - d.x, d.aimY - (d.y - d.r * 0.15), d.aimZ - d.z);
        const L = _d.length();
        if (L > 1) {
          _d.divideScalar(L);
          _q2.setFromUnitVectors(_Y, _d);
          _p.set(d.x, d.y - d.r * 0.15, d.z);
          const rr = Math.max(d.r * 0.5, L * 0.16);
          _s.set(rr, L, rr);
          _m.compose(_p, _q2, _s);
          this.cones.setMatrixAt(nc, _m);
          const k = d.cone * lerp(0.16, 0.24, night);
          this.cones.setColorAt(nc, _c.setRGB(0.55 * k, 0.8 * k, k));
          nc++;
        }
      }
    }
    this.hull.count = this.glow.count = nh;
    this.cones.count = nc;
    for (const m of [this.hull, this.glow, this.cones]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    this.dots.geometry.setDrawRange(0, np);
    this.dotPos.needsUpdate = true;
    this.dotCol.needsUpdate = true;
    this.dotMat.opacity = smoothstep(0.2, 0.8, night);
  }
}

/** The hull (radius 1): a smooth lens with a low dome, flat underneath. */
export function hullGeometry(): THREE.BufferGeometry {
  const pts = [
    [0, -0.13], [0.3, -0.13], [0.62, -0.12], [0.86, -0.09], [0.97, -0.05], [1, 0], [0.96, 0.05], [0.8, 0.1],
    [0.55, 0.15], [0.38, 0.2], [0.3, 0.29], [0.2, 0.34], [0.1, 0.36], [0, 0.365],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const g = new THREE.LatheGeometry(pts, 40);
  g.computeVertexNormals();
  return g;
}

/** The underside's glow (radius 1 hull): a ring and a core, facing down. */
function glowGeometry(): THREE.BufferGeometry {
  const ring = new THREE.RingGeometry(0.66, 0.8, 40, 1);
  const core = new THREE.CircleGeometry(0.17, 24);
  const parts = [ring, core].map((g) => { g.rotateX(Math.PI / 2); g.translate(0, -0.134, 0); return g.toNonIndexed(); });
  const ps = [...parts[0].attributes.position.array, ...parts[1].attributes.position.array];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(ps, 3));
  return g;
}

/** The scan cone: apex at the origin, pointing down (-y), length 1, radius 1 at the end; bright at the apex. */
function coneGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.05, 1, 1, 28, 6, true);
  g.translate(0, -0.5, 0);
  const p = g.attributes.position, c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const t = -p.getY(i);
    const k = 0.15 + 0.85 * Math.pow(1 - t, 1.6);
    c.set([k, k, k], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}
