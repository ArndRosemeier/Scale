/**
 * Long-range smoke columns (THREATS_PLAN §2 "Show, don't tell", §4.9): every burning or collapsed
 * building sends up a column of smoke that is seen from across the city, leaning with the wind;
 * a struck district smokes for a day; the last resort's mushroom cloud is one of them, too.
 *
 * Cheap by construction: one instanced quad mesh, ONE draw call, its own small shader (compiled
 * during the start-up warm-up). Every puff is a camera-facing billboard whose rise, drift, growth
 * and fade are computed in the vertex shader from the column's few numbers and the time — the CPU
 * only rewrites the instance data when a column comes or goes (≤ MAX_COLUMNS columns × PUFFS puffs,
 * plus a mushroom cloud). Puffs right at the camera fade out (no fill-rate wall when standing in
 * one); no real lights (a burning base glows by itself).
 */
import * as THREE from 'three';
import { G } from '../../render/materials/globals';
import { WEBGPU, gpuKit } from '../../render/gpuMode';

/** A column of smoke: where it rises from, how tall / wide / dense, burning at its base. */
export interface SmokeColumn {
  x: number; y: number; z: number;
  /** Height (m) the puffs rise to, the puffs' width (m) and density (0..1). */
  height: number;
  width: number;
  density: number;
  /** A fire at its base (an orange glow low down, darker smoke). */
  fire: number;
  /** 0 column, 1 mushroom cloud (a stem and a rolling cap), with its growth 0..1. */
  mushroom: number;
  growth: number;
  /** Seed (puff phases differ per column). */
  seed: number;
}

export const SMOKE = {
  /** Columns drawn at once (the nearest / strongest), puffs per column, the mushroom's puffs. */
  maxColumns: 24, puffs: 14, mushroomPuffs: 72,
  /** Rise speed (m/s) of a puff, drawn out to this distance (m). */
  rise: 7, drawR: 6000,
};

const CAP = SMOKE.maxColumns * SMOKE.puffs + SMOKE.mushroomPuffs;

export class SmokeColumns {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private aA: THREE.InstancedBufferAttribute;
  private aB: THREE.InstancedBufferAttribute;
  private aC: THREE.InstancedBufferAttribute;
  private uniforms = {
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector3(1, 0, 0.3) },
    uNight: G.uNight,
    uDay: G.uDayLight,
  };
  private dirty = true;
  private cols: SmokeColumn[] = [];
  stats = { columns: 0, puffs: 0 };

  constructor() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.aA = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aB = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aC = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iA', this.aA);
    g.setAttribute('iB', this.aB);
    g.setAttribute('iC', this.aC);
    g.instanceCount = 0;
    this.geo = g;
    const mat = WEBGPU ? gpuKit().createSmokeColumnNodeMaterial(this.uniforms, SMOKE.rise) as unknown as THREE.ShaderMaterial : new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]),
      vertexShader: /* glsl */ `
        attribute vec4 iA; attribute vec4 iB; attribute vec4 iC;
        uniform float uTime; uniform vec3 uWind; uniform float uNight; uniform float uDay;
        varying vec2 vUv; varying vec4 vC; varying float vGlow; varying float vSeed;
        #include <fog_pars_vertex>
        float h1(float x) { return fract(sin(x * 91.7) * 43758.5453); }
        void main() {
          // iA: base x, y, z, puff key (column seed + k / n) · iB: height, width, density, fire
          // iC: mode (0 column, 1 mushroom), growth, puff index share k / n, unused
          float key = iA.w, k = iC.z, H = iB.x, W = iB.y;
          float rise = ${SMOKE.rise.toFixed(1)};
          vec3 p = iA.xyz;
          float size, a, dark;
          vGlow = 0.0;
          if (iC.x < 0.5) {
            // A column: puffs rise, swell and drift downwind (more the higher), fading at the top.
            float ph = fract(uTime * rise / max(20.0, H) + key);
            float sway = sin(uTime * 0.21 + key * 37.0) * 0.12;
            p.y += ph * H;
            p.xz += (uWind.xz + vec2(sway, -sway)) * ph * ph * H * 0.45 * uWind.y;
            p.xz += (vec2(h1(key * 13.0), h1(key * 29.0)) - 0.5) * W * 0.5 * (0.4 + ph);
            size = W * (0.6 + 2.4 * ph);
            a = iB.z * smoothstep(0.0, 0.05, ph) * (1.0 - smoothstep(0.6, 1.0, ph));
            dark = mix(0.09, 0.34, ph);
            vGlow = iB.w * (1.0 - smoothstep(0.0, 0.12, ph));
          } else {
            // The mushroom cloud: a stem rising into a rolling cap that spreads as it grows.
            float gr = iC.y, top = H * (0.25 + 0.75 * gr);
            float roll = uTime * 0.05 + key * 6.283;
            if (k < 0.32) {
              float t = k / 0.32;
              p.y += t * top * 0.92;
              p.xz += vec2(cos(roll * 3.0), sin(roll * 3.0)) * W * 0.05;
              size = W * (0.22 + 0.16 * t) * (0.6 + 0.4 * gr);
              dark = mix(0.16, 0.3, t);
            } else {
              float t = (k - 0.32) / 0.68;
              float ang = t * 6.283 * 3.0 + roll, rad = W * (0.25 + 0.5 * fract(t * 3.0)) * (0.5 + 0.5 * gr);
              p.y += top + W * 0.22 * sin(t * 18.0 + roll) - W * 0.1 * fract(t * 3.0);
              p.xz += vec2(cos(ang), sin(ang)) * rad;
              size = W * (0.32 + 0.14 * h1(key * 7.0)) * (0.55 + 0.45 * gr);
              dark = mix(0.3, 0.45, h1(key * 3.0));
            }
            p.xz += uWind.xz * gr * gr * H * 0.12 * uWind.y;
            a = iB.z;
            vGlow = iB.w;
          }
          vec4 mv = viewMatrix * vec4(p, 1.0);
          // Fade puffs at the camera (standing inside a column is not a grey wall).
          float dc = length(mv.xyz);
          a *= smoothstep(size * 0.35, size * 1.4, dc);
          mv.xy += position.xy * size;
          gl_Position = projectionMatrix * mv;
          vUv = position.xy * 2.0;
          // Lit by the day: grey by daylight, dark at night (a burning base lights it from below).
          float lit = mix(0.12, 1.0, uDay) * (1.0 - 0.6 * uNight);
          vC = vec4(vec3(dark) * lit, a);
          vSeed = key;
          vec4 mvPosition = mv;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying vec4 vC; varying float vGlow; varying float vSeed;
        #include <fog_pars_fragment>
        float hh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hh(i), hh(i + vec2(1, 0)), f.x), mix(hh(i + vec2(0, 1)), hh(i + vec2(1, 1)), f.x), f.y); }
        void main() {
          float d = dot(vUv, vUv);
          if (d > 1.0) discard;
          float n = vn(vUv * 2.3 + vSeed * 17.0) * 0.6 + vn(vUv * 5.1 - vSeed * 9.0) * 0.4;
          float a = pow(1.0 - d, 1.5) * (0.6 + 0.8 * n) * vC.a;
          if (a < 0.004) discard;
          // Shade: the top of a puff a little lighter than its underside.
          vec3 c = vC.rgb * (0.82 + 0.3 * vUv.y + 0.15 * n);
          c += vec3(2.2, 0.9, 0.25) * vGlow * (1.0 - d) * (0.6 + 0.4 * n);
          gl_FragColor = vec4(c, min(1.0, a));
          #include <fog_fragment>
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    if (!WEBGPU) Object.assign(mat.uniforms, this.uniforms);
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
    this.mesh.name = 'smokeColumns';
  }

  /** The columns to draw (the caller keeps the list; call `changed()` after editing it). */
  set(cols: SmokeColumn[]): void { this.cols = cols; this.dirty = true; }
  changed(): void { this.dirty = true; }

  /** Wind direction (radians, as render/Weather's) and strength (0 calm … 1 gale). */
  wind(dir: number, strength: number): void {
    this.uniforms.uWind.value.set(Math.cos(dir), 0.35 + strength * 0.9, Math.sin(dir));
  }

  update(dt: number, cam: THREE.Vector3): void {
    this.uniforms.uTime.value += dt;
    if (!this.dirty) return;
    this.dirty = false;
    // The nearest / strongest columns within reach; the mushroom cloud always.
    const list = this.cols.filter((c) => c.mushroom === 0 && Math.hypot(c.x - cam.x, c.z - cam.z) < SMOKE.drawR)
      .sort((a, b) => Math.hypot(a.x - cam.x, a.z - cam.z) / (0.3 + a.density) - Math.hypot(b.x - cam.x, b.z - cam.z) / (0.3 + b.density))
      .slice(0, SMOKE.maxColumns);
    const A = this.aA.array as Float32Array, B = this.aB.array as Float32Array, C = this.aC.array as Float32Array;
    let n = 0;
    const put = (c: SmokeColumn, k: number, of: number) => {
      const o = n * 4, s = (c.seed % 997) / 997;
      A[o] = c.x; A[o + 1] = c.y; A[o + 2] = c.z; A[o + 3] = s + k / of;
      B[o] = c.height; B[o + 1] = c.width; B[o + 2] = c.density; B[o + 3] = c.fire;
      C[o] = c.mushroom; C[o + 1] = c.growth; C[o + 2] = k / of; C[o + 3] = 0;
      n++;
    };
    for (const c of list) for (let k = 0; k < SMOKE.puffs; k++) put(c, k, SMOKE.puffs);
    const m = this.cols.find((c) => c.mushroom > 0);
    if (m) for (let k = 0; k < SMOKE.mushroomPuffs; k++) put(m, k, SMOKE.mushroomPuffs);
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    for (const at of [this.aA, this.aB, this.aC]) { at.clearUpdateRanges(); at.addUpdateRange(0, Math.max(1, n) * 4); at.needsUpdate = true; }
    this.stats.columns = list.length + (m ? 1 : 0);
    this.stats.puffs = n;
  }

  /** The mushroom's growth changes every frame: only its instances are rewritten. */
  grow(c: SmokeColumn): void {
    if (!c.mushroom) return;
    this.dirty = true;
  }

  /** Start-up warm-up: one puff far below the player so the program compiles behind the loading screen. */
  warm(x: number, y: number, z: number): void {
    const A = this.aA.array as Float32Array, B = this.aB.array as Float32Array, C = this.aC.array as Float32Array;
    A.set([x, y, z, 0], 0); B.set([1, 0.01, 0.01, 0], 0); C.set([0, 0, 0, 0], 0);
    this.geo.instanceCount = 1;
    this.mesh.visible = true;
    for (const at of [this.aA, this.aB, this.aC]) at.needsUpdate = true;
    this.dirty = true;
  }
}
