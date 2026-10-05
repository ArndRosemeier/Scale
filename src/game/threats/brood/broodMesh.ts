/**
 * The Brood's creatures on screen: one small low-poly model (a three-part chitinous body with a
 * ridge of spines, mandibles, two glowing eyes and six two-segment legs), drawn instanced for every
 * creature of every swarm in one draw call, like the birds.
 *
 * Per instance:
 *  - instanceMatrix: position, orientation (on the ground, up a wall, on its back when dead), size,
 *  - iAnim (gait phase, stride, curl, eye glow): the legs swing in a tripod gait in the vertex
 *    shader, the feet lift on the forward stroke; curl 1 folds them in (a dead one on its back),
 *  - iCol (body rgb, frost): frozen ones turn icy.
 *
 * Interpolates the 15 Hz simulation between its steps (BroodSim.alpha).
 */
import * as THREE from 'three';
import { CMode, type BroodSim, type Critter } from './BroodSim';

const BODY = 0, LEG = 1, EYE = 2;

/** Hips (x, y, z) and gait offsets of the six legs: a tripod gait (L1 R2 L3 against R1 L2 R3). */
const HIPS: [number, number, number][] = [[0.11, 0.2, -0.17], [0.13, 0.2, -0.07], [0.12, 0.2, 0.03]];

export function createBroodGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], part: number[] = [], leg: number[] = [], seg: number[] = [];
  const tri = (a: number[], b: number[], c: number[], p: number, L: number[] = [0, 0, 0, 0], s: number[] = [0, 0, 0]) => {
    pos.push(...a, ...b, ...c);
    part.push(p, p, p);
    leg.push(...L, ...L, ...L);
    seg.push(...s);
  };
  // Ellipsoid (centre, radii): 6 around, 4 rings.
  const ellipsoid = (cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, p = BODY) => {
    const U = 6, V = 4, pt = (u: number, v: number) => {
      const th = (u / U) * Math.PI * 2, ph = (v / V) * Math.PI;
      return [cx + Math.cos(th) * Math.sin(ph) * rx, cy + Math.cos(ph) * ry, cz + Math.sin(th) * Math.sin(ph) * rz];
    };
    for (let u = 0; u < U; u++) for (let v = 0; v < V; v++) {
      const a = pt(u, v), b = pt(u + 1, v), c = pt(u + 1, v + 1), d = pt(u, v + 1);
      if (v > 0) tri(a, b, c, p);
      if (v < V - 1) tri(a, c, d, p);
    }
  };
  // Head forward (−Z), thorax, a big abdomen behind.
  ellipsoid(0, 0.21, 0.24, 0.19, 0.14, 0.27);
  ellipsoid(0, 0.22, -0.09, 0.14, 0.11, 0.14);
  ellipsoid(0, 0.19, -0.29, 0.1, 0.085, 0.1);
  // Spines along the back.
  for (let k = 0; k < 5; k++) {
    const z = -0.12 + k * 0.12, y = 0.3 + (k > 1 ? 0.04 : 0) - (k > 3 ? 0.04 : 0), h = 0.08 + (k === 2 ? 0.04 : 0);
    tri([-0.03, y, z - 0.04], [0.03, y, z - 0.04], [0, y + h, z + 0.05], BODY);
    tri([0.03, y, z - 0.04], [0, y, z + 0.05], [0, y + h, z + 0.05], BODY);
    tri([0, y, z + 0.05], [-0.03, y, z - 0.04], [0, y + h, z + 0.05], BODY);
  }
  // Mandibles.
  for (const s of [1, -1]) {
    tri([0.04 * s, 0.17, -0.36], [0.07 * s, 0.15, -0.34], [0.02 * s, 0.13, -0.47], BODY);
    tri([0.04 * s, 0.17, -0.36], [0.02 * s, 0.13, -0.47], [0.07 * s, 0.15, -0.34], BODY);
  }
  // Eyes: two small glowing plates on the front of the head.
  for (const s of [1, -1]) {
    const x = 0.045 * s, y = 0.23, z = -0.37;
    tri([x - 0.025, y - 0.015, z], [x + 0.025, y - 0.015, z], [x + 0.02 * s, y + 0.02, z + 0.02], EYE);
  }
  // Legs: femur up and out to the knee, tibia down to the foot (thin triangular prisms).
  const prism = (a: number[], b: number[], w: number, L: number[], sa: number, sb: number) => {
    const o = [[0, w, 0], [w * 0.87, -w * 0.5, 0], [-w * 0.87, -w * 0.5, 0]];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      const a0 = [a[0] + o[i][0], a[1] + o[i][1], a[2] + o[i][2]], a1 = [a[0] + o[j][0], a[1] + o[j][1], a[2] + o[j][2]];
      const b0 = [b[0] + o[i][0] * 0.6, b[1] + o[i][1] * 0.6, b[2]], b1 = [b[0] + o[j][0] * 0.6, b[1] + o[j][1] * 0.6, b[2]];
      tri(a0, a1, b1, LEG, L, [sa, sa, sb]);
      tri(a0, b1, b0, LEG, L, [sa, sb, sb]);
    }
  };
  HIPS.forEach(([hx, hy, hz], i) => {
    for (const s of [1, -1]) {
      // Tripod: L0 R1 L2 together, R0 L1 R2 half a cycle later.
      const off = ((i + (s > 0 ? 0 : 1)) % 2) * Math.PI;
      const L = [hx * s, hy, hz, off];
      const spread = (i - 1) * 0.16;
      const knee = [0.38 * s, 0.36, hz + spread], foot = [0.56 * s, 0, hz + spread * 1.8];
      prism([hx * s, hy, hz], knee, 0.025, L, 0, 0.5);
      prism(knee, foot, 0.018, L, 0.5, 1);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  g.setAttribute('aLeg', new THREE.Float32BufferAttribute(leg, 4));
  g.setAttribute('aSeg', new THREE.Float32BufferAttribute(seg, 1));
  g.computeVertexNormals();
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

export function createBroodMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide, flatShading: true });
  mat.name = 'brood';
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aPart;
attribute vec4 aLeg;
attribute float aSeg;
attribute vec4 iAnim;
attribute vec4 iCol;
varying vec3 vBroodCol;
varying float vBroodGlow;`)
      .replace('#include <begin_vertex>', `
vec3 transformed = vec3(position);
if (aPart > 0.5 && aPart < 1.5) {
  // Legs: swing about the hip (vertical axis), the foot lifting on the forward stroke; curled in when dead.
  vec3 hip = aLeg.xyz;
  vec3 rel = position - hip;
  float ph = iAnim.x + aLeg.w;
  float sw = iAnim.y * sin(ph) * 0.5;
  float c = cos(sw), s = sin(sw);
  rel.xz = vec2(c * rel.x - s * rel.z, s * rel.x + c * rel.z);
  rel.y += max(0.0, cos(ph)) * iAnim.y * 0.14 * aSeg;
  vec3 curled = vec3(rel.x * 0.3, 0.1 + aSeg * 0.18, rel.z * 0.4 + aSeg * 0.04);
  transformed = hip + mix(rel, curled, iAnim.z);
}
vBroodCol = mix(iCol.rgb, vec3(0.62, 0.78, 0.9), iCol.w * 0.8);
vBroodGlow = aPart > 1.5 ? iAnim.w : 0.0;
if (aPart > 1.5) vBroodCol = vec3(0.2, 0.06, 0.02);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBroodCol;\nvarying float vBroodGlow;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vBroodCol;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(2.6, 0.75, 0.12) * vBroodGlow;');
  };
  mat.customProgramCacheKey = () => 'brood-v1';
  return mat;
}

const _m = new THREE.Matrix4();
const _f = new THREE.Vector3(), _u = new THREE.Vector3(), _x = new THREE.Vector3(), _z = new THREE.Vector3();

/** Every swarm's creatures in one instanced mesh. */
export class BroodMesh {
  readonly mesh: THREE.InstancedMesh;
  private anim: THREE.InstancedBufferAttribute;
  private col: THREE.InstancedBufferAttribute;
  private n = 0;

  constructor(readonly cap = 320) {
    const g = createBroodGeometry();
    this.anim = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.anim.setUsage(THREE.DynamicDrawUsage);
    this.col.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iAnim', this.anim);
    g.setAttribute('iCol', this.col);
    this.mesh = new THREE.InstancedMesh(g, createBroodMaterial(), cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.count = 0;
    this.mesh.name = 'brood';
  }

  begin(): void { this.n = 0; }

  /** A swarm's visible creatures (interpolated within its step). */
  add(sim: BroodSim): void {
    const a = sim.alpha;
    for (const c of sim.list) {
      if (!sim.visible(c) || this.n >= this.cap) continue;
      this.put(c, a);
    }
  }

  /** During the start-up warm-up: a speck of a creature (so the program compiles behind the loading screen). */
  warm(x: number, y: number, z: number): void {
    if (this.n >= this.cap) return;
    _m.makeScale(0.01, 0.01, 0.01).setPosition(x, y, z);
    this.mesh.setMatrixAt(this.n, _m);
    this.anim.setXYZW(this.n, 0, 0, 0, 0);
    this.col.setXYZW(this.n, 0.1, 0.1, 0.1, 0);
    this.n++;
  }

  private put(c: Critter, a: number): void {
    const i = this.n++;
    const x = c.px + (c.x - c.px) * a, y = c.py + (c.y - c.py) * a, z = c.pz + (c.z - c.pz) * a;
    let dy = c.yaw - c.pyaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    const yaw = c.pyaw + dy * a;
    // Orientation: forward and up (up the wall: forward is up, up is the wall's normal).
    if (c.mode === CMode.Wall) { _f.set(0, 1, 0); _u.set(c.nx, 0, c.nz); }
    else { _f.set(-Math.sin(yaw), 0, -Math.cos(yaw)); _u.set(0, 1, 0); }
    _z.copy(_f).negate();
    _x.crossVectors(_u, _z).normalize();
    _u.crossVectors(_z, _x);
    // Dead: rolled onto its back.
    if (c.curl > 0) {
      const r = c.curl * Math.PI, cs = Math.cos(r), sn = Math.sin(r);
      const ux = _u.x, uy = _u.y, uz = _u.z;
      _u.set(ux * cs + _x.x * sn, uy * cs + _x.y * sn, uz * cs + _x.z * sn);
      _x.set(_x.x * cs - ux * sn, _x.y * cs - uy * sn, _x.z * cs - uz * sn);
    }
    const s = c.size * (c.mode === CMode.Dead && c.t > 3.5 ? Math.max(0.01, 1 - (c.t - 3.5) / 1.5) : 1);
    const lift = c.curl > 0.5 ? 0.22 * c.size : 0;
    _m.set(
      _x.x * s, _u.x * s, _z.x * s, x,
      _x.y * s, _u.y * s, _z.y * s, y + lift,
      _x.z * s, _u.z * s, _z.z * s, z,
      0, 0, 0, 1,
    );
    this.mesh.setMatrixAt(i, _m);
    const moving = c.mode === CMode.Run || c.mode === CMode.Leave || c.mode === CMode.Wall;
    const ph = c.pphase + (c.phase - c.pphase) * a;
    this.anim.setXYZW(i, ph, moving || c.air ? 1 : 0.15, c.curl, c.mode === CMode.Dead ? Math.max(0, 1 - c.t * 0.8) : 1);
    const frost = c.mode === CMode.Frozen ? 1 : 0;
    if (c.kind === 1) this.col.setXYZW(i, 0.16, 0.07, 0.05, frost);
    else { const v = (c.id % 7) / 7; this.col.setXYZW(i, 0.07 + v * 0.03, 0.06 + v * 0.015, 0.075 + (1 - v) * 0.03, frost); }
  }

  end(): void {
    this.mesh.count = this.n;
    if (this.n) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.anim.needsUpdate = true;
      this.col.needsUpdate = true;
    }
  }
}
