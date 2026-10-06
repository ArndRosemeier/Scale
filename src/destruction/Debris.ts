/**
 * Debris: convex fragments (instanced, textured with the facade material
 * arrays by triplanar mapping) driven by Rapier while moving, then frozen into
 * static rubble. Small chips and glass shards are cheap ballistic particles.
 * Everything is pooled: the cost stays bounded no matter how much breaks.
 */
import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import type RAPIER from '@dimforge/rapier3d-compat';
import { GROUPS, type Physics } from '../physics/Physics';
import type { MaterialArrays } from '../render/TextureLibrary';
import { Rng } from '../core/rng';
import { GLSL_COMMON } from '../render/materials/glsl';
import { WEBGPU, gpuKit } from '../render/gpuMode';

const TEMPLATES = 8;
const CAP = 1600;          // instances per template (moving + frozen)
const MAX_BODIES = 350;    // simultaneous rigid bodies
const SPAWN_PER_FRAME = 24; // new rigid bodies per frame (the rest become ballistic chips)
/**
 * New rigid bodies per second on average (a token bucket of BODY_BURST): a monster or a long
 * fight breaking panel after panel would otherwise keep the physics pool full of tumbling
 * hulls; beyond it fragments fly as ballistic chips (they bounce and fade the same way).
 */
const BODY_RATE = 40;
const BODY_BURST = 60;
const CHIP_CAP = 4000;

interface Frag {
  tpl: number;
  inst: number;
  body: RAPIER.RigidBody | null;
  sx: number; sy: number; sz: number;
  /** Last pose (kept for frozen fragments, so they can be dropped when their support goes). */
  x: number; y: number; z: number;
  q: THREE.Quaternion;
  /** Falling without physics (support removed): vertical speed and landing height. */
  fallV: number;
  fallTo: number;
  born: number;
  still: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();

export class Debris {
  readonly group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private hulls: Float32Array[] = [];
  private layerAttr: THREE.InstancedBufferAttribute[] = [];
  private next: number[] = [];
  private slots: (Frag | null)[][] = [];
  private active: Frag[] = [];
  private t = 0;
  // chips
  private chips: THREE.InstancedMesh;
  private chipData = new Float32Array(CHIP_CAP * 8); // x y z vx vy vz born life
  private chipNext = 0;
  private chipGround = new Float32Array(CHIP_CAP);

  constructor(private physics: Physics, arrays: MaterialArrays, private groundFn: (x: number, z: number, y?: number) => number) {
    const rng = new Rng(4242);
    const mat = debrisMaterial(arrays);
    for (let t = 0; t < TEMPLATES; t++) {
      const pts: THREE.Vector3[] = [];
      const n = 9 + rng.int(0, 6);
      for (let i = 0; i < n; i++) pts.push(new THREE.Vector3(rng.range(-0.5, 0.5), rng.range(-0.5, 0.5), rng.range(-0.5, 0.5)));
      // Make sure the hull spans the unit box roughly.
      pts.push(new THREE.Vector3(-0.5, rng.range(-0.3, 0.3), rng.range(-0.3, 0.3)), new THREE.Vector3(0.5, rng.range(-0.3, 0.3), rng.range(-0.3, 0.3)));
      const geo = new ConvexGeometry(pts);
      geo.computeVertexNormals();
      const flatPts = new Float32Array(pts.length * 3);
      pts.forEach((p, i) => flatPts.set([p.x, p.y, p.z], i * 3));
      this.hulls.push(flatPts);
      const layer = new THREE.InstancedBufferAttribute(new Float32Array(CAP), 1);
      geo.setAttribute('iLayer', layer);
      this.layerAttr.push(layer);
      const im = new THREE.InstancedMesh(geo, mat, CAP);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.setColorAt(0, new THREE.Color(1, 1, 1));
      im.count = 0;
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      this.meshes.push(im);
      this.group.add(im);
      this.next.push(0);
      this.slots.push(new Array(CAP).fill(null));
    }
    // Chips: tiny tetra-ish shards rendered as instanced boxes.
    const chipGeo = new THREE.TetrahedronGeometry(0.5);
    this.chips = new THREE.InstancedMesh(chipGeo, new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 0.6, metalness: 0.1 }), CHIP_CAP);
    this.chips.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.chips.setColorAt(0, new THREE.Color(1, 1, 1));
    this.chips.count = CHIP_CAP;
    this.chips.frustumCulled = false;
    for (let i = 0; i < CHIP_CAP; i++) { _m.makeScale(0, 0, 0); this.chips.setMatrixAt(i, _m); this.chipData[i * 8 + 7] = 0; }
    this.group.add(this.chips);
  }

  /** Spawn one fragment. size = full extents in m. */
  spawn(x: number, y: number, z: number, sx: number, sy: number, sz: number, vx: number, vy: number, vz: number, layer: number, tint: THREE.Color, spin = 2, physics = true): void {
    // Budget: big bursts become cheap ballistic chips beyond a few rigid bodies per frame.
    if (physics && (this.spawnedThisFrame >= SPAWN_PER_FRAME || this.bodyTokens < 1)) {
      const sp = Math.max(1.5, Math.hypot(vx, vy, vz));
      this.chipBurst(x, y, z, 2, sp, vx / sp, vy / sp, vz / sp, tint, Math.min(0.45, Math.max(sx, sy, sz) * 0.35), 4);
      return;
    }
    if (physics) { this.spawnedThisFrame++; this.bodyTokens--; }
    const tpl = (Math.random() * TEMPLATES) | 0;
    const im = this.meshes[tpl];
    const inst = this.next[tpl];
    this.next[tpl] = (inst + 1) % CAP;
    const old = this.slots[tpl][inst];
    if (old?.body) this.removeBody(old);
    if (im.count < CAP) im.count = Math.max(im.count, inst + 1);
    const f: Frag = { tpl, inst, body: null, sx, sy, sz, born: this.t, still: 0, x, y, z, q: new THREE.Quaternion(), fallV: 0, fallTo: NaN };
    this.slots[tpl][inst] = f;
    this.layerAttr[tpl].setX(inst, layer);
    mark(this.layerAttr[tpl], inst, 1);
    im.setColorAt(inst, tint);
    if (im.instanceColor) mark(im.instanceColor, inst, 1);
    _q.setFromEuler(_e.set(Math.random() * 6, Math.random() * 6, Math.random() * 6));
    f.q.copy(_q);
    _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
    im.setMatrixAt(inst, _m);
    mark(im.instanceMatrix, inst, 1);
    if (!physics) return;
    if (this.active.length >= MAX_BODIES) {
      // Retire a body that is at rest; if all are still moving, this piece flies ballistically
      // instead (freezing a falling body would leave it hanging in the air).
      const rest = this.active.find((a) => a.still > 0.3);
      if (rest) this.freeze(rest);
      else {
        im.count = Math.max(im.count, inst + 1);
        _m.makeScale(0, 0, 0);
        im.setMatrixAt(inst, _m);
        this.slots[tpl][inst] = undefined as unknown as Frag;
        const sp = Math.max(1.5, Math.hypot(vx, vy, vz));
        this.chipBurst(x, y, z, 2, sp, vx / sp, vy / sp, vz / sp, tint, Math.min(0.45, Math.max(sx, sy, sz) * 0.35), 4);
        return;
      }
    }
    const R = this.physics.R;
    const hull = this.hulls[tpl];
    const pts = new Float32Array(hull.length);
    for (let i = 0; i < hull.length; i += 3) { pts[i] = hull[i] * sx; pts[i + 1] = hull[i + 1] * sy; pts[i + 2] = hull[i + 2] * sz; }
    const desc = R.ColliderDesc.convexHull(pts);
    if (!desc) return;
    desc.setDensity(1800).setFriction(0.8).setRestitution(0.15).setCollisionGroups(GROUPS.debris);
    const body = this.physics.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(x, y, z).setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
        .setLinvel(vx, vy, vz).setAngvel({ x: (Math.random() - 0.5) * spin, y: (Math.random() - 0.5) * spin, z: (Math.random() - 0.5) * spin })
        .setLinearDamping(0.05).setAngularDamping(0.3).setCcdEnabled(Math.max(sx, sy, sz) < 0.6),
    );
    this.physics.world.createCollider(desc, body);
    f.body = body;
    this.active.push(f);
    this.physics.ensureGround(x, z, 20 + Math.hypot(vx, vz) * 2);
  }

  /** Ballistic chip/shard particles (glass, plaster bits). */
  chipBurst(x: number, y: number, z: number, n: number, speed: number, dirX: number, dirY: number, dirZ: number, color: THREE.Color, size = 0.06, life = 3): void {
    // One ground query per burst (it is not cheap: buildings, rubble, bridges).
    const ground = this.groundFn(x, z);
    for (let k = 0; k < n; k++) {
      const i = this.chipNext;
      this.chipNext = (i + 1) % CHIP_CAP;
      const o = i * 8;
      const s = speed * (0.3 + Math.random());
      this.chipData[o] = x + (Math.random() - 0.5) * 0.5;
      this.chipData[o + 1] = y + (Math.random() - 0.5) * 0.5;
      this.chipData[o + 2] = z + (Math.random() - 0.5) * 0.5;
      this.chipData[o + 3] = dirX * s + (Math.random() - 0.5) * speed;
      this.chipData[o + 4] = dirY * s + Math.random() * speed * 0.6;
      this.chipData[o + 5] = dirZ * s + (Math.random() - 0.5) * speed;
      this.chipData[o + 6] = this.t;
      this.chipData[o + 7] = life * (0.6 + Math.random() * 0.8);
      this.chipGround[i] = ground;
      this.chips.setColorAt(i, color);
      _s.setScalar(size * (0.5 + Math.random()));
      this.chipScale[i] = _s.x;
    }
    if (this.chips.instanceColor) {
      // The burst's slots (contiguous unless it wrapped round the ring).
      const end = this.chipNext, start = (end - n + CHIP_CAP * 4) % CHIP_CAP;
      if (n >= CHIP_CAP || start >= end) this.chips.instanceColor.needsUpdate = true;
      else mark(this.chips.instanceColor, start, end - start);
    }
  }
  private chipScale = new Float32Array(CHIP_CAP);

  private spawnedThisFrame = 0;
  private bodyTokens = BODY_BURST;
  /** Instances moved this frame per template: lowest and highest index (uploaded as one range). */
  private lo = new Int32Array(TEMPLATES);
  private hi = new Int32Array(TEMPLATES);
  private releases: [number, number, number, number, number, number][] = [];
  private falling: Frag[] = [];

  /**
   * A support disappeared in this box (x0, z0, x1, z1, y0, y1): resting fragments in it
   * drop to the next surface below (batched, processed once per frame).
   */
  release(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number): void {
    this.releases.push([x0, z0, x1, z1, y0, y1]);
  }

  /** The ground itself changed here (collapse): refresh physics ground and drop resting debris. */
  groundChanged(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number): void {
    this.physics.invalidateGround(x0, z0, x1, z1);
    for (const f of this.active) f.body!.wakeUp();
    this.release(x0, z0, x1, z1, y0, y1);
  }

  update(dt: number): void {
    this.t += dt;
    this.spawnedThisFrame = 0;
    this.bodyTokens = Math.min(BODY_BURST, this.bodyTokens + dt * BODY_RATE);
    // Sync moving fragments.
    const lo = this.lo, hi = this.hi;
    lo.fill(CAP); hi.fill(-1);
    for (let k = this.active.length - 1; k >= 0; k--) {
      const f = this.active[k];
      const b = f.body!;
      const tr = b.translation(), rot = b.rotation();
      f.x = tr.x; f.y = tr.y; f.z = tr.z;
      f.q.set(rot.x, rot.y, rot.z, rot.w);
      _m.compose(_p.set(tr.x, tr.y, tr.z), _q.set(rot.x, rot.y, rot.z, rot.w), _s.set(f.sx, f.sy, f.sz));
      this.meshes[f.tpl].setMatrixAt(f.inst, _m);
      if (f.inst < lo[f.tpl]) lo[f.tpl] = f.inst;
      if (f.inst > hi[f.tpl]) hi[f.tpl] = f.inst;
      const v = b.linvel();
      const sp = Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z);
      f.still = sp < 0.15 ? f.still + dt : 0;
      if (b.isSleeping() || f.still > 1.5 || this.t - f.born > 20 || tr.y < -200) this.freeze(f);
    }
    // Supports that disappeared (broken floors, collapsed buildings): resting debris above falls.
    if (this.releases.length) {
      const R = this.releases;
      this.releases = [];
      for (const slots of this.slots) for (const f of slots) {
        if (!f || f.body || !Number.isNaN(f.fallTo)) continue;
        for (const r of R) {
          if (f.x < r[0] || f.x > r[2] || f.z < r[1] || f.z > r[3] || f.y < r[4] || f.y > r[5]) continue;
          const g = this.groundFn(f.x, f.z, f.y - 0.3) + f.sy * 0.35;
          if (g < f.y - 0.05) { f.fallTo = g; f.fallV = 0; this.falling.push(f); }
          break;
        }
      }
    }
    for (let k = this.falling.length - 1; k >= 0; k--) {
      const f = this.falling[k];
      if (this.slots[f.tpl][f.inst] !== f) { this.falling.splice(k, 1); continue; }
      f.fallV += 9.81 * dt;
      f.y -= f.fallV * dt;
      if (f.y <= f.fallTo) { f.y = f.fallTo; f.fallTo = NaN; this.falling.splice(k, 1); }
      _m.compose(_p.set(f.x, f.y, f.z), f.q, _s.set(f.sx, f.sy, f.sz));
      this.meshes[f.tpl].setMatrixAt(f.inst, _m);
      if (f.inst < lo[f.tpl]) lo[f.tpl] = f.inst;
      if (f.inst > hi[f.tpl]) hi[f.tpl] = f.inst;
    }
    for (let t = 0; t < TEMPLATES; t++) if (hi[t] >= 0) mark(this.meshes[t].instanceMatrix, lo[t], hi[t] - lo[t] + 1);
    // Chips (uploaded as the span of live ones).
    let any = false, c0 = CHIP_CAP, c1 = -1;
    for (let i = 0; i < CHIP_CAP; i++) {
      const o = i * 8;
      const life = this.chipData[o + 7];
      if (life <= 0) continue;
      const age = this.t - this.chipData[o + 6];
      if (age > life) {
        this.chipData[o + 7] = 0;
        _m.makeScale(0, 0, 0);
        this.chips.setMatrixAt(i, _m);
        any = true;
        if (i < c0) c0 = i;
        c1 = i;
        continue;
      }
      // integrate
      this.chipData[o + 4] -= 9.81 * dt;
      let x = this.chipData[o] + this.chipData[o + 3] * dt;
      let y = this.chipData[o + 1] + this.chipData[o + 4] * dt;
      let z = this.chipData[o + 2] + this.chipData[o + 5] * dt;
      if (y < this.chipGround[i]) {
        y = this.chipGround[i];
        this.chipData[o + 4] *= -0.25;
        this.chipData[o + 3] *= 0.5;
        this.chipData[o + 5] *= 0.5;
      }
      this.chipData[o] = x; this.chipData[o + 1] = y; this.chipData[o + 2] = z;
      _q.setFromEuler(_e.set(age * 7 + i, age * 5, 0));
      const sc = this.chipScale[i] * Math.min(1, (life - age) * 2);
      _m.compose(_p.set(x, y, z), _q, _s.setScalar(sc));
      this.chips.setMatrixAt(i, _m);
      any = true;
      if (i < c0) c0 = i;
      c1 = i;
      void x; void z;
    }
    if (any) mark(this.chips.instanceMatrix, c0, c1 - c0 + 1);
  }

  private freeze(f: Frag): void {
    this.removeBody(f);
  }

  private removeBody(f: Frag): void {
    if (!f.body) return;
    this.physics.world.removeRigidBody(f.body);
    f.body = null;
    const i = this.active.indexOf(f);
    if (i >= 0) this.active.splice(i, 1);
  }

  get activeCount(): number { return this.active.length; }

  /**
   * Wind (whirlwind): moving fragments and flying chips within r of the axis through (x, z)
   * are spun round it at `spin` m/s, lifted at `lift` m/s and drawn in a little.
   */
  vortex(x: number, y: number, z: number, r: number, spin: number, lift: number): number {
    let n = 0;
    for (const f of this.active) {
      const b = f.body!;
      const t = b.translation();
      const dx = t.x - x, dz = t.z - z, d = Math.hypot(dx, dz);
      if (d > r || t.y < y - 2 || t.y > y + r * 3) continue;
      const k = 1 - d / r;
      const m = b.mass();
      const v = b.linvel();
      const tx = d > 1e-3 ? -dz / d : 0, tz = d > 1e-3 ? dx / d : 0;
      const wantX = tx * spin * k - (d > 1e-3 ? dx / d : 0) * spin * 0.2, wantZ = tz * spin * k - (d > 1e-3 ? dz / d : 0) * spin * 0.2;
      b.applyImpulse({ x: (wantX - v.x) * m * 0.2, y: Math.max(0, lift * k - v.y) * m * 0.25, z: (wantZ - v.z) * m * 0.2 }, true);
      n++;
    }
    for (let i = 0; i < CHIP_CAP; i++) {
      const o = i * 8;
      if (this.chipData[o + 7] <= 0) continue;
      const dx = this.chipData[o] - x, dz = this.chipData[o + 2] - z, d = Math.hypot(dx, dz);
      if (d > r || d < 1e-3) continue;
      const k = 1 - d / r;
      this.chipData[o + 3] = -dz / d * spin * k;
      this.chipData[o + 5] = dx / d * spin * k;
      this.chipData[o + 4] = Math.max(this.chipData[o + 4], lift * k);
      this.chipData[o + 7] = Math.max(this.chipData[o + 7], this.t - this.chipData[o + 6] + 1);
    }
    return n;
  }
}

function debrisMaterial(arrays: MaterialArrays): THREE.MeshStandardMaterial {
  if (WEBGPU) return gpuKit().createDebrisNodeMaterial(arrays) as unknown as THREE.MeshStandardMaterial;
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  const uniforms = { uAlb: { value: arrays.albedo }, uNrm: { value: arrays.normal } };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float iLayer; varying float vLayer; varying vec3 vObj; varying vec3 vObjN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLayer = iLayer; vObj = position * vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz)); vObjN = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform sampler2DArray uAlb; uniform sampler2DArray uNrm; varying float vLayer; varying vec3 vObj; varying vec3 vObjN;\n${GLSL_COMMON}`)
      .replace(
        '#include <map_fragment>',
        `vec3 w = abs(normalize(vObjN)); w /= (w.x + w.y + w.z);
vec4 a = texture(uAlb, vec3(vObj.yz * 0.5, vLayer)) * w.x + texture(uAlb, vec3(vObj.xz * 0.5, vLayer)) * w.y + texture(uAlb, vec3(vObj.xy * 0.5, vLayer)) * w.z;
// Broken faces: mix in fresh concrete/brick core colour on faces pointing "inward" of the original wall.
float core = smoothstep(0.3, 0.7, h21(floor(vObj.xy * 3.0)));
diffuseColor.rgb *= mix(a.rgb, a.rgb * 0.8 + vec3(0.06), core * 0.3);`,
      );
  };
  mat.customProgramCacheKey = () => 'debris-v1';
  return mat;
}

/** Add instances [i, i + n) of an instanced attribute to its next upload. */
function mark(a: THREE.BufferAttribute, i: number, n: number): void {
  a.addUpdateRange(i * a.itemSize, n * a.itemSize);
  a.needsUpdate = true;
}
