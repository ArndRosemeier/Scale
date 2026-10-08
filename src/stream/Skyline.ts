/**
 * Far skyline: every building of every cell as an instanced oriented box with
 * a procedural facade (window grid, lit windows at night, reflective curtain
 * walls). Cells that are loaded in detail are masked out on the GPU.
 */
import * as THREE from 'three';
import type { MacroPlan } from '../plan/types';
import type { WorkerPool } from './WorkerPool';
import { SKY_STRIDE, type FromWorker } from './protocol';
import type { MaterialArrays } from '../render/TextureLibrary';
import { G } from '../render/materials/globals';
import { GLSL_COMMON } from '../render/materials/glsl';
import { hitch } from '../debug/HitchLog';
import { WEBGPU, gpuKit } from '../render/gpuMode';

export class Skyline {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh | null = null;
  private cap = 0;
  private n = 0;
  private mask: THREE.DataTexture;
  private maskData: Uint8Array;
  private maskW = 256;
  private mat: THREE.MeshStandardMaterial;
  /**
   * Levelled districts (the last resort's strike, src/game/aftermath): far buildings within z m of
   * (x, y) are not drawn (w > 0: on). Up to four.
   */
  readonly ruins = [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()];
  private requested = false;
  private pendingJobs = 0;
  loaded = 0;
  /** Every finished batch (records per cell in order, plus the cells' map items), e.g. for the map. */
  onBatch?: (cells: number[], records: Float32Array, counts: number[], map: Float32Array, mapOff: Int32Array) => void;

  constructor(private macro: MacroPlan, private pool: WorkerPool, arrays: MaterialArrays) {
    const h = Math.ceil(Math.max(1, macro.cells.length) / this.maskW);
    this.maskData = new Uint8Array(this.maskW * h).fill(255);
    this.mask = new THREE.DataTexture(this.maskData, this.maskW, h, THREE.RedFormat, THREE.UnsignedByteType);
    this.mask.needsUpdate = true;
    this.mat = skylineMaterial(arrays, this.mask, this.maskW, this.ruins);
  }

  /** Request skyline records for all cells (nearest first) in the background. */
  start(cx: number, cz: number): void {
    if (this.requested) return;
    this.requested = true;
    const ids = this.macro.cells.map((c) => c.id).sort((a, b) => {
      const A = this.macro.cells[a].centroid, B = this.macro.cells[b].centroid;
      return Math.hypot(A[0] - cx, A[1] - cz) - Math.hypot(B[0] - cx, B[1] - cz);
    });
    for (let i = 0; i < ids.length; i += 6) {
      const batch = ids.slice(i, i + 6);
      this.pendingJobs++;
      this.pool.run<Extract<FromWorker, { type: 'skyline' }>>({ type: 'skyline', job: 0, cells: batch }, 1000 + i).then((r) => {
        this.pendingJobs--;
        hitch.measure('skyline:apply', () => this.add(r.records));
        this.onBatch?.(r.cells, r.records, r.counts, r.map, r.mapOff);
      }, () => { this.pendingJobs--; });
    }
  }

  private add(rec: Float32Array): void {
    const k = rec.length / SKY_STRIDE;
    if (!k) return;
    if (this.n + k > this.cap) this.grow(this.n + k);
    const mesh = this.mesh!, g = mesh.geometry as THREE.InstancedBufferGeometry;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    const iA = g.getAttribute('iA') as THREE.InstancedBufferAttribute, iB = g.getAttribute('iB') as THREE.InstancedBufferAttribute;
    const iS = g.getAttribute('iS') as THREE.InstancedBufferAttribute | undefined, iP = g.getAttribute('iP') as THREE.InstancedBufferAttribute | undefined;
    const start = this.n;
    for (let j = 0; j < k; j++) {
      const R = rec, o = j * SKY_STRIDE, i = this.n++;
      q.setFromAxisAngle(_up, -R[o + 4]);
      m.compose(p.set(R[o], R[o + 5] - 1, R[o + 1]), q, s.set(R[o + 2] * 2, R[o + 6] + 1, R[o + 3] * 2));
      mesh.setMatrixAt(i, m);
      iA.setXYZW(i, R[o + 7], R[o + 11], R[o + 12], R[o + 13]); // layer, floorH, flags, cell
      iB.setXYZW(i, R[o + 8], R[o + 9], R[o + 10], (i * 0.618) % 1);
      iS?.setXYZW(i, s.x, s.y, s.z, 0);
      iP?.setXYZW(i, p.x, p.z, 0, 0);
    }
    // (Upload only what was added.)
    for (const a of [mesh.instanceMatrix, iA, iB, iS, iP]) {
      if (!a) continue;
      a.addUpdateRange(start * a.itemSize, k * a.itemSize);
      a.needsUpdate = true;
    }
    mesh.count = this.n;
    g.instanceCount = this.n;
    this.loaded += k;
  }

  /**
   * All far buildings are one instanced mesh, grown in big steps. (It was one per 1.5 km tile,
   * rebuilt whenever a tile got more buildings: on WebGPU every new instanced mesh builds its
   * shaders again, about a thousand times while the city streamed in.) Static buffers: on WebGPU a
   * dynamic one is uploaded whole every frame.
   */
  private grow(need: number): void {
    let cap = Math.max(this.cap, 4096);
    while (cap < need * 1.25) cap *= 2;
    const old = this.mesh;
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const g = new THREE.InstancedBufferGeometry();
    g.index = box.index;
    for (const k of ['position', 'normal', 'uv']) g.setAttribute(k, box.getAttribute(k));
    // The node material reads scale and centre from attributes rather than the instance matrix.
    const names = WEBGPU ? ['iA', 'iB', 'iS', 'iP'] : ['iA', 'iB'];
    for (const k of names) {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      const prev = old?.geometry.getAttribute(k);
      if (prev) a.array.set(prev.array as Float32Array);
      g.setAttribute(k, a);
    }
    const mesh = new THREE.InstancedMesh(g, this.mat, cap);
    if (old) mesh.instanceMatrix.array.set(old.instanceMatrix.array);
    mesh.count = this.n;
    g.instanceCount = this.n; // (InstancedBufferGeometry defaults to Infinity: WebGPU draws that count)
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    if (old) { this.group.remove(old); old.geometry.dispose(); old.dispose(); }
    this.mesh = mesh;
    this.cap = cap;
    this.group.add(mesh);
  }

  /** Mask out cells currently shown in detail. */
  setLoaded(cellIds: Iterable<number>): void {
    this.maskData.fill(255);
    for (const id of cellIds) if (id < this.maskData.length) this.maskData[id] = 0;
    this.mask.needsUpdate = true;
  }

  get busy(): boolean { return this.pendingJobs > 0; }
}

const _up = new THREE.Vector3(0, 1, 0);

function skylineMaterial(arrays: MaterialArrays, mask: THREE.Texture, maskW: number, ruins: THREE.Vector4[]): THREE.MeshStandardMaterial {
  if (WEBGPU) return gpuKit().skylineNodeMaterial(arrays, mask, maskW, ruins) as unknown as THREE.MeshStandardMaterial;
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
  const uniforms = {
    uAlb: { value: arrays.albedo },
    uTile: { value: arrays.tileMeters.slice(0, 24) },
    uMask: { value: mask },
    uMaskW: { value: maskW },
    uNight: G.uNight,
    uLitFrac: G.uLitFrac,
    uDayLight: G.uDayLight,
    uRuin: { value: ruins },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 iA; attribute vec4 iB;
uniform sampler2D uMask; uniform int uMaskW; uniform vec4 uRuin[4];
varying vec2 vFUv; varying vec4 vA; varying vec4 vB; varying vec3 vObjN; varying float vTop;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
vObjN = normal;
vTop = step(0.5, normal.y);
// facade uv in metres: along the face and up
vFUv = abs(normal.x) > 0.5 ? vec2((position.z + 0.5) * sc.z, position.y * sc.y) : vec2((position.x + 0.5) * sc.x, position.y * sc.y);
vA = iA; vB = iB;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
{ int c = int(iA.w + 0.5); if (texelFetch(uMask, ivec2(c % uMaskW, c / uMaskW), 0).r < 0.5) gl_Position = vec4(0.0); }
{ vec2 ic = instanceMatrix[3].xz; for (int i = 0; i < 4; i++) if (uRuin[i].w > 0.5 && distance(ic, uRuin[i].xy) < uRuin[i].z) gl_Position = vec4(0.0); }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2DArray uAlb; uniform float uTile[24]; uniform float uNight; uniform float uLitFrac; uniform float uDayLight;
varying vec2 vFUv; varying vec4 vA; varying vec4 vB; varying vec3 vObjN; varying float vTop;
${GLSL_COMMON}
float gRough; float gMetal; vec3 gEmis;`)
      .replace('#include <map_fragment>', `int layer = int(vA.x + 0.5);
vec3 wall = texture(uAlb, vec3(vFUv / uTile[layer], vA.x)).rgb * vB.rgb;
gRough = 0.85; gMetal = 0.0; gEmis = vec3(0.0);
bool glass = mod(vA.z, 2.0) > 0.5;
vec3 col = wall;
if (vTop > 0.5) { col = vec3(0.32, 0.31, 0.3); }
else {
  float fh = max(vA.y, 2.6);
  vec2 cell = vec2(vFUv.x / (glass ? 1.6 : 2.6), vFUv.y / fh);
  vec2 f = fract(cell);
  vec2 id = floor(cell);
  float px = length(fwidth(cell));
  bool win = glass ? (f.y > 0.25) : (f.x > 0.22 && f.x < 0.78 && f.y > 0.3 && f.y < 0.85);
  float aa = 1.0 - smoothstep(0.25, 0.6, px);
  float lit = step(h21(id + vB.w * 91.0), uLitFrac);
  if (win) {
    col = mix(col, glass ? vec3(0.08, 0.12, 0.16) : vec3(0.06, 0.07, 0.08), aa * (glass ? 0.95 : 0.85));
    gRough = mix(0.85, 0.08, aa); gMetal = glass ? 0.6 * aa : 0.0;
    gEmis = lit * vec3(1.0, 0.82, 0.55) * 1.2 * uNight;
  } else if (glass) { col = mix(col, vec3(0.2, 0.22, 0.25), 0.8); gMetal = 0.4; gRough = 0.3; }
  // distant average of the pattern so nothing shimmers
  vec3 avg = mix(wall, glass ? vec3(0.1, 0.14, 0.18) : wall * 0.7, glass ? 0.85 : 0.35);
  col = mix(avg, col, aa);
  gEmis += (1.0 - aa) * uNight * uLitFrac * vec3(1.0, 0.8, 0.55) * 0.6;
}
diffuseColor.rgb = col;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = gMetal;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gEmis;');
  };
  mat.customProgramCacheKey = () => 'skyline-v2';
  return mat;
}
