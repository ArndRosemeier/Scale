/**
 * Pooled effects of the elemental powers. Everything is instanced and immediate-mode where it
 * moves every frame (beams, ice), so an idle frame costs nothing: meshes with no instances
 * are hidden.
 *
 *  - Beams: camera-facing ribbons between two points with a bright core and a coloured glow
 *    (laser, lightning arcs, shrink ray, water jet core, nova ring). Additive. Re-submitted
 *    every frame by their owner.
 *  - Particles: a small CPU particle system (flames, sparks, ice motes, water spray, swirling
 *    dust) in two blend modes: glow (additive) and soft (alpha). Optional swirl around an axis.
 *  - Decals: flat procedural quads on the ground or on walls — scorch marks, ice patches,
 *    puddles, fissure cracks — fading out over their life.
 *  - Ice: crystals on frozen things and the ice-path sheets (instanced, re-submitted).
 */
import * as THREE from 'three';
import { G } from '../../render/materials/globals';

// ---------------------------------------------------------------- beams

export const enum BeamStyle { Laser = 0, Bolt = 1, Shrink = 2, Water = 3, Ring = 4, Fire = 5 }

const BEAM_CAP = 512;

class Beams {
  readonly mesh: THREE.Mesh;
  private a: Float32Array;
  private b: Float32Array;
  private c: Float32Array;
  private ia: THREE.InstancedBufferAttribute;
  private ib: THREE.InstancedBufferAttribute;
  private ic: THREE.InstancedBufferAttribute;
  private geo: THREE.InstancedBufferGeometry;
  n = 0;

  constructor(uTime: { value: number }) {
    const g = new THREE.InstancedBufferGeometry();
    // Quad: along 0..1, across -1..1 (two triangles).
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.a = new Float32Array(BEAM_CAP * 4);
    this.b = new Float32Array(BEAM_CAP * 4);
    this.c = new Float32Array(BEAM_CAP * 4);
    this.ia = new THREE.InstancedBufferAttribute(this.a, 4).setUsage(THREE.DynamicDrawUsage);
    this.ib = new THREE.InstancedBufferAttribute(this.b, 4).setUsage(THREE.DynamicDrawUsage);
    this.ic = new THREE.InstancedBufferAttribute(this.c, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iA', this.ia);
    g.setAttribute('iB', this.ib);
    g.setAttribute('iC', this.ic);
    g.instanceCount = 0;
    this.geo = g;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        attribute vec4 iA; attribute vec4 iB; attribute vec4 iC;
        varying vec2 vQ; varying vec3 vCol; varying float vI; varying float vStyle; varying float vLen;
        void main() {
          vec3 a = iA.xyz, b = iB.xyz;
          vec3 axis = b - a;
          float len = max(length(axis), 1e-4);
          vec3 ad = axis / len;
          vec3 p = mix(a, b, position.x);
          // At least ~3 px wide however far away (a beam must read at 100 m too).
          float w = max(iA.w, distance(cameraPosition, p) * 0.0022);
          p += ad * (position.x * 2.0 - 1.0) * w * 0.5;
          vec3 view = cameraPosition - p;
          vec3 side = cross(ad, view);
          float sl = length(side);
          side = sl > 1e-5 ? side / sl : vec3(0.0, 1.0, 0.0);
          p += side * position.y * w;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
          vQ = vec2(position.x * (len + w), position.y);
          vCol = iC.rgb; vI = iB.w; vStyle = iC.w; vLen = len + w;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec2 vQ; varying vec3 vCol; varying float vI; varying float vStyle; varying float vLen;
        float h(float x) { return fract(sin(x * 91.17) * 43758.5); }
        float n1(float x) { float i = floor(x), f = fract(x); return mix(h(i), h(i + 1.0), f * f * (3.0 - 2.0 * f)); }
        void main() {
          float v = abs(vQ.y);
          float u = vQ.x;
          // Soft rounded ends.
          float endA = smoothstep(0.0, 0.15, min(u, vLen - u) / max(0.05, vLen));
          float core = exp(-v * v * 36.0);
          float glow = exp(-v * v * 3.5) * (1.0 - v);
          float k = 1.0;
          vec3 col;
          int st = int(vStyle + 0.5);
          if (st == 1) {                 // lightning: thin, flickering
            k = 0.65 + 0.35 * n1(uTime * 50.0 + u * 2.0);
            core = exp(-v * v * 60.0);
            col = vCol * glow * 0.9 + vec3(1.0) * core * 2.2;
          } else if (st == 2) {          // shrink ray: travelling rings
            float rings = 0.55 + 0.45 * sin(u * 7.0 - uTime * 26.0);
            col = vCol * glow * (0.5 + rings) + vec3(1.0) * core * 0.9;
          } else if (st == 3) {          // water jet: churning streaks
            float s = n1(u * 3.0 - uTime * 30.0 + floor(vQ.y * 3.0) * 7.0);
            col = vCol * (glow * 0.45 + core * 0.35) * (0.6 + 0.6 * s);
          } else if (st == 4) {          // ring / wave front
            col = vCol * glow * 1.2 + vec3(1.0) * core * 0.6;
          } else if (st == 5) {          // fire tongue
            float s = n1(u * 2.5 - uTime * 14.0);
            col = vCol * glow * (0.6 + 0.8 * s);
          } else {                       // laser
            k = 0.92 + 0.08 * sin(uTime * 90.0 + u * 0.5);
            col = vCol * glow * 1.1 + vec3(1.0, 0.95, 0.9) * core * 2.6;
          }
          gl_FragColor = vec4(col * vI * k * endA, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
  }

  seg(ax: number, ay: number, az: number, bx: number, by: number, bz: number, width: number, r: number, g: number, b: number, intensity: number, style: number): void {
    if (this.n >= BEAM_CAP) return;
    const o = this.n++ * 4;
    this.a[o] = ax; this.a[o + 1] = ay; this.a[o + 2] = az; this.a[o + 3] = width;
    this.b[o] = bx; this.b[o + 1] = by; this.b[o + 2] = bz; this.b[o + 3] = intensity;
    this.c[o] = r; this.c[o + 1] = g; this.c[o + 2] = b; this.c[o + 3] = style;
  }

  flush(): void {
    this.geo.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n) {
      for (const at of [this.ia, this.ib, this.ic]) { at.clearUpdateRanges(); at.addUpdateRange(0, this.n * 4); at.needsUpdate = true; }
    }
    this.n = 0;
  }
}

// ---------------------------------------------------------------- particles

const PART_CAP = 1600;

class Particles {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private iP: Float32Array;
  private iC: Float32Array;
  private aP: THREE.InstancedBufferAttribute;
  private aC: THREE.InstancedBufferAttribute;
  // Simulation (struct of arrays).
  private p = new Float32Array(PART_CAP * 3);
  private v = new Float32Array(PART_CAP * 3);
  private c0 = new Float32Array(PART_CAP * 3);
  private c1 = new Float32Array(PART_CAP * 3);
  /** age, life, size0, size1 */
  private t = new Float32Array(PART_CAP * 4);
  /** alpha, drag, gravity (+ down), swirl rate (rad/s) */
  private k = new Float32Array(PART_CAP * 4);
  /** swirl axis x, z, inward pull */
  private sw = new Float32Array(PART_CAP * 3);
  n = 0;

  constructor(additive: boolean) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.iP = new Float32Array(PART_CAP * 4);
    this.iC = new Float32Array(PART_CAP * 4);
    this.aP = new THREE.InstancedBufferAttribute(this.iP, 4).setUsage(THREE.DynamicDrawUsage);
    this.aC = new THREE.InstancedBufferAttribute(this.iC, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iP', this.aP);
    g.setAttribute('iC', this.aC);
    g.instanceCount = 0;
    this.geo = g;
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute vec4 iP; attribute vec4 iC;
        varying vec2 vUv; varying vec4 vC;
        void main() {
          vec4 mv = viewMatrix * vec4(iP.xyz, 1.0);
          mv.xy += position.xy * iP.w;
          gl_Position = projectionMatrix * mv;
          vUv = position.xy * 2.0; vC = iC;
          // Fade out right at the camera (an ember or a puff of smoke next to the lens would fill the view
          // as a big flat disc): gone within 0.3 m, full from about two sprite sizes away.
          float near = clamp((-mv.z - 0.3) / (1.2 + iP.w * 1.5), 0.0, 1.0);
          vC.a *= near * near;
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying vec4 vC;
        void main() {
          float d = dot(vUv, vUv);
          if (d > 1.0) discard;
          float a = (1.0 - d) * (1.0 - d);
          ${additive ? 'gl_FragColor = vec4(vC.rgb * a * vC.a * (1.0 + 1.5 * exp(-d * 8.0)), 1.0);' : 'gl_FragColor = vec4(vC.rgb, a * vC.a);'}
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 12 : 10;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number,
    r0: number, g0: number, b0: number, r1: number, g1: number, b1: number, alpha: number, drag: number, grav: number): number {
    let i = this.n;
    if (i >= PART_CAP) i = (Math.random() * PART_CAP) | 0; // full: replace a random one
    else this.n++;
    const o3 = i * 3, o4 = i * 4;
    this.p[o3] = x; this.p[o3 + 1] = y; this.p[o3 + 2] = z;
    this.v[o3] = vx; this.v[o3 + 1] = vy; this.v[o3 + 2] = vz;
    this.c0[o3] = r0; this.c0[o3 + 1] = g0; this.c0[o3 + 2] = b0;
    this.c1[o3] = r1; this.c1[o3 + 1] = g1; this.c1[o3 + 2] = b1;
    this.t[o4] = 0; this.t[o4 + 1] = life; this.t[o4 + 2] = s0; this.t[o4 + 3] = s1;
    this.k[o4] = alpha; this.k[o4 + 1] = drag; this.k[o4 + 2] = grav; this.k[o4 + 3] = 0;
    return i;
  }

  /** Make particle i swirl around the vertical axis at (ax, az): rate rad/s, inward pull 1/s. */
  swirl(i: number, ax: number, az: number, rate: number, pull: number): void {
    this.k[i * 4 + 3] = rate;
    this.sw[i * 3] = ax; this.sw[i * 3 + 1] = az; this.sw[i * 3 + 2] = pull;
  }

  update(dt: number): void {
    const P = this.p, V = this.v, T = this.t, K = this.k, S = this.sw, C0 = this.c0, C1 = this.c1;
    let n = this.n;
    for (let i = 0; i < n; i++) {
      const o4 = i * 4;
      T[o4] += dt;
      if (T[o4] >= T[o4 + 1]) {
        // Swap-remove.
        n--;
        if (i !== n) {
          P.copyWithin(i * 3, n * 3, n * 3 + 3); V.copyWithin(i * 3, n * 3, n * 3 + 3);
          C0.copyWithin(i * 3, n * 3, n * 3 + 3); C1.copyWithin(i * 3, n * 3, n * 3 + 3);
          S.copyWithin(i * 3, n * 3, n * 3 + 3);
          T.copyWithin(o4, n * 4, n * 4 + 4); K.copyWithin(o4, n * 4, n * 4 + 4);
          i--;
        }
        continue;
      }
      const o3 = i * 3;
      const drag = Math.exp(-K[o4 + 1] * dt);
      V[o3] *= drag; V[o3 + 1] = V[o3 + 1] * drag - K[o4 + 2] * dt; V[o3 + 2] *= drag;
      const rate = K[o4 + 3];
      if (rate !== 0) {
        // Rotate the position about the axis, pull inward.
        const ax = S[o3], az = S[o3 + 1];
        let dx = P[o3] - ax, dz = P[o3 + 2] - az;
        const a = rate * dt, ca = Math.cos(a), sa = Math.sin(a);
        const nx = dx * ca - dz * sa, nz = dx * sa + dz * ca;
        const pull = Math.max(0, 1 - S[o3 + 2] * dt);
        dx = nx * pull; dz = nz * pull;
        P[o3] = ax + dx; P[o3 + 2] = az + dz;
      }
      P[o3] += V[o3] * dt; P[o3 + 1] += V[o3 + 1] * dt; P[o3 + 2] += V[o3 + 2] * dt;
    }
    this.n = n;
    // Upload.
    const IP = this.iP, IC = this.iC;
    for (let i = 0; i < n; i++) {
      const o3 = i * 3, o4 = i * 4;
      const u = T[o4] / T[o4 + 1];
      IP[o4] = P[o3]; IP[o4 + 1] = P[o3 + 1]; IP[o4 + 2] = P[o3 + 2];
      IP[o4 + 3] = T[o4 + 2] + (T[o4 + 3] - T[o4 + 2]) * u;
      IC[o4] = C0[o3] + (C1[o3] - C0[o3]) * u;
      IC[o4 + 1] = C0[o3 + 1] + (C1[o3 + 1] - C0[o3 + 1]) * u;
      IC[o4 + 2] = C0[o3 + 2] + (C1[o3 + 2] - C0[o3 + 2]) * u;
      // Quick fade in, fade out over the last 40 %.
      IC[o4 + 3] = K[o4] * Math.min(1, u * 12) * Math.min(1, (1 - u) / 0.4);
    }
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n) {
      for (const at of [this.aP, this.aC]) { at.clearUpdateRanges(); at.addUpdateRange(0, n * 4); at.needsUpdate = true; }
    }
  }
}

// ---------------------------------------------------------------- decals

/** Moss: creepers and moss on a rewilded street (the eco-radicals); Grave: churned earth with bone splinters (the necromancers). */
export const enum DecalKind { Scorch = 0, Ice = 1, Puddle = 2, Crack = 3, Frost = 4, Moss = 5, Grave = 6 }

const DECAL_CAP = 240;

class Decals {
  readonly mesh: THREE.InstancedMesh;
  private attr: THREE.InstancedBufferAttribute;
  private next = 0;
  private used = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();
  private uTime: { value: number };
  /** Birth + life per slot (for culling dead ones from the count). */
  private ends = new Float32Array(DECAL_CAP);

  constructor(uTime: { value: number }) {
    this.uTime = uTime;
    const g = new THREE.PlaneGeometry(1, 1);
    this.attr = new THREE.InstancedBufferAttribute(new Float32Array(DECAL_CAP * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iD', this.attr);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime, uNight: G.uNight },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        attribute vec4 iD;
        varying vec2 vUv; varying vec4 vD; varying vec2 vScale;
        void main() {
          vUv = uv; vD = iD;
          vScale = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uNight;
        varying vec2 vUv; varying vec4 vD; varying vec2 vScale;
        float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1, 0)), u.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), u.x), u.y); }
        float fbm(vec2 p) { return n(p) * 0.55 + n(p * 2.1 + 3.1) * 0.3 + n(p * 4.3 - 1.7) * 0.15; }
        void main() {
          int kind = int(vD.x + 0.5);
          float age = uTime - vD.y, life = vD.z, seed = vD.w;
          if (age < 0.0 || age > life) discard;
          float fade = smoothstep(0.0, 0.08, age) * (1.0 - smoothstep(life * 0.75, life, age));
          vec2 q = vUv - 0.5;
          vec2 w = q * vScale;                   // metres
          float lightK = 1.0 - 0.7 * uNight;
          vec3 col; float a;
          if (kind == 3) {                       // fissure: a jagged dark line along u
            float along = w.x;
            float off = (fbm(vec2(along * 0.35, seed)) - 0.5) * vScale.y * 0.55;
            float d = abs(w.y - off);
            float width = vScale.y * (0.06 + 0.08 * n(vec2(along * 1.3, seed + 4.0))) * (1.0 - smoothstep(0.38, 0.5, abs(q.x)));
            float side = 0.0;
            float br = fbm(vec2(along * 0.9 + 11.0, seed));
            if (br > 0.62) side = smoothstep(0.03, 0.0, abs(abs(w.y - off) - (br - 0.62) * vScale.y * 0.9) - 0.0);
            a = max(smoothstep(width, width * 0.4, d), side * 0.7);
            float rim = smoothstep(width * 2.6, width, d) * 0.35;
            col = mix(vec3(0.32, 0.29, 0.26), vec3(0.015), a) * lightK;
            a = max(a, rim) * fade;
          } else {
            float r = length(q) * 2.0;
            float edge = fbm(q * 5.0 + seed) * 0.35;
            float body = 1.0 - smoothstep(0.62 - edge * 0.6, 1.0 - edge * 0.6, r);
            if (kind == 0) {                     // scorch: soot, darkest in the middle
              col = vec3(0.025, 0.02, 0.018) * (0.7 + 0.6 * fbm(w * 3.0));
              a = body * (0.55 + 0.4 * (1.0 - r)) * fade;
              // embers at first
              float hot = exp(-age * 1.5) * (1.0 - r);
              col += vec3(1.2, 0.35, 0.05) * hot * step(0.55, fbm(w * 6.0 + seed));
            } else if (kind == 1 || kind == 4) { // ice: pale, with bright cracks
              float cr = abs(fbm(w * 1.6 + seed) - 0.5);
              float lines = smoothstep(0.03, 0.0, cr);
              col = mix(vec3(0.72, 0.86, 0.96), vec3(1.0), lines * 0.8) * (0.85 + 0.25 * fbm(w * 4.0)) * lightK + vec3(0.04, 0.07, 0.1) * uNight;
              a = body * (kind == 4 ? 0.5 : 0.82) * fade;
            } else if (kind == 5) {              // moss and creepers: patchy green, vines across it
              float m = fbm(w * 1.3 + seed);
              float leaf = step(0.5, fbm(w * 7.0 + seed * 1.7));
              float vine = smoothstep(0.05, 0.0, abs(fbm(w * 0.8 + seed + 7.0) - 0.5));
              col = mix(vec3(0.07, 0.17, 0.04), vec3(0.2, 0.36, 0.08), leaf) * (0.7 + 0.5 * m) * lightK;
              col = mix(col, vec3(0.05, 0.09, 0.03) * lightK, vine * 0.8);
              a = max(body * smoothstep(0.3, 0.55, m + 0.2) * 0.9, vine * body) * fade;
            } else if (kind == 6) {              // grave earth: churned, dark, pale splinters of bone
              col = vec3(0.11, 0.075, 0.05) * (0.6 + 0.6 * fbm(w * 3.0 + seed)) * lightK;
              float bone = step(0.8, fbm(w * 9.0 + seed * 2.3));
              col = mix(col, vec3(0.75, 0.72, 0.62) * lightK, bone);
              a = body * 0.88 * fade;
            } else {                             // puddle: dark, glossy
              col = vec3(0.05, 0.065, 0.08) * lightK + vec3(0.25, 0.3, 0.35) * pow(fbm(w * 0.7 + seed * 0.3), 3.0) * lightK;
              a = body * 0.62 * fade;
            }
          }
          if (a < 0.004) discard;
          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.InstancedMesh(g, mat, DECAL_CAP);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /**
   * A decal at (x, y, z) facing the normal (nx, ny, nz) (ground: 0, 1, 0), `len` × `wid` m,
   * long axis turned by yaw (ground) — lifted a few cm off the surface.
   */
  add(kind: DecalKind, x: number, y: number, z: number, nx: number, ny: number, nz: number, len: number, wid: number, yaw: number, life: number): void {
    const i = this.next;
    this.next = (i + 1) % DECAL_CAP;
    this.used = Math.max(this.used, i + 1);
    const lift = 0.025 + i * 0.00004; // stable order among overlapping decals
    this.p.set(x + nx * lift, y + ny * lift, z + nz * lift);
    // Plane's +Z → normal; local x → the long axis.
    if (ny > 0.9) this.q.setFromEuler(_e.set(-Math.PI / 2, yaw, 0, 'YXZ'));
    else this.q.setFromUnitVectors(_z, _n.set(nx, ny, nz).normalize());
    this.s.set(len, wid, 1);
    this.m.compose(this.p, this.q, this.s);
    this.mesh.setMatrixAt(i, this.m);
    const birth = this.uTime.value;
    this.attr.setXYZW(i, kind, birth, life, Math.random() * 50);
    this.ends[i] = birth + life;
    this.mesh.count = this.used;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.attr.needsUpdate = true;
  }

  update(): void {
    if (!this.used) { this.mesh.visible = false; return; }
    // All expired: stop drawing.
    const now = this.uTime.value;
    let alive = false;
    for (let i = 0; i < this.used; i++) if (this.ends[i] > now) { alive = true; break; }
    if (!alive) { this.used = 0; this.next = 0; this.mesh.count = 0; }
    this.mesh.visible = this.used > 0;
  }
}

const _e = new THREE.Euler();
const _z = new THREE.Vector3(0, 0, 1);
const _n = new THREE.Vector3();

// ---------------------------------------------------------------- ice

const CRYSTAL_CAP = 700;
const SHEET_CAP = 400;

class IceMeshes {
  readonly crystals: THREE.InstancedMesh;
  readonly sheets: THREE.InstancedMesh;
  private nc = 0;
  private ns = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();

  constructor() {
    const mat = new THREE.MeshStandardMaterial({ color: 0xd2ecff, roughness: 0.12, metalness: 0.05, transparent: true, opacity: 0.78, emissive: 0x16303f });
    const cg = new THREE.OctahedronGeometry(1, 0);
    cg.scale(0.35, 1, 0.35);
    cg.translate(0, 0.8, 0);
    this.crystals = new THREE.InstancedMesh(cg, mat, CRYSTAL_CAP);
    const sg = new THREE.BoxGeometry(1, 1, 1);
    sg.translate(0, -0.5, 0); // top face at the instance origin
    this.sheets = new THREE.InstancedMesh(sg, mat, SHEET_CAP);
    for (const m of [this.crystals, this.sheets]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = true;
    }
  }

  /** A crystal standing at (x, y, z), `size` m tall, tilted by (tx, tz) radians, turned by yaw. */
  crystal(x: number, y: number, z: number, size: number, yaw: number, tx: number, tz: number): void {
    if (this.nc >= CRYSTAL_CAP) return;
    _e.set(tx, yaw, tz, 'YXZ');
    this.q.setFromEuler(_e);
    this.m.compose(this.p.set(x, y, z), this.q, this.s.setScalar(size * 0.5));
    this.crystals.setMatrixAt(this.nc++, this.m);
  }

  /** An ice slab: top centre (x, y, z), yaw, pitch (up the slope), length × width × thickness. */
  sheet(x: number, y: number, z: number, yaw: number, pitch: number, len: number, wid: number, thick: number): void {
    if (this.ns >= SHEET_CAP) return;
    _e.set(pitch, yaw, 0, 'YXZ');
    this.q.setFromEuler(_e);
    this.m.compose(this.p.set(x, y, z), this.q, this.s.set(wid, thick, len));
    this.sheets.setMatrixAt(this.ns++, this.m);
  }

  flush(): void {
    for (const [mesh, n] of [[this.crystals, this.nc], [this.sheets, this.ns]] as const) {
      mesh.count = n;
      mesh.visible = n > 0;
      if (n) mesh.instanceMatrix.needsUpdate = true;
    }
    this.nc = 0; this.ns = 0;
  }
}

// ---------------------------------------------------------------- facade

export class ElementFx {
  readonly group = new THREE.Group();
  readonly uTime = { value: 0 };
  private beams: Beams;
  private glowP: Particles;
  private softP: Particles;
  private decals: Decals;
  private ice: IceMeshes;

  constructor() {
    this.beams = new Beams(this.uTime);
    this.glowP = new Particles(true);
    this.softP = new Particles(false);
    this.decals = new Decals(this.uTime);
    this.ice = new IceMeshes();
    this.group.add(this.decals.mesh, this.ice.sheets, this.ice.crystals, this.softP.mesh, this.glowP.mesh, this.beams.mesh);
  }

  /** Beam / arc segment for this frame. */
  seg(ax: number, ay: number, az: number, bx: number, by: number, bz: number, width: number, r: number, g: number, b: number, intensity: number, style: BeamStyle): void {
    this.beams.seg(ax, ay, az, bx, by, bz, width, r, g, b, intensity, style);
  }

  /** Additive particle (flames, sparks, glints); returns its index (for swirl). */
  glow(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number,
    c0: THREE.Color, c1: THREE.Color, alpha = 1, drag = 1, grav = 0): number {
    return this.glowP.emit(x, y, z, vx, vy, vz, life, s0, s1, c0.r, c0.g, c0.b, c1.r, c1.g, c1.b, alpha, drag, grav);
  }

  /** Alpha-blended particle (water, smoke wisps, dust, snow). */
  soft(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number,
    c0: THREE.Color, c1: THREE.Color, alpha = 0.8, drag = 1, grav = 0): number {
    return this.softP.emit(x, y, z, vx, vy, vz, life, s0, s1, c0.r, c0.g, c0.b, c1.r, c1.g, c1.b, alpha, drag, grav);
  }

  swirlSoft(i: number, ax: number, az: number, rate: number, pull: number): void { this.softP.swirl(i, ax, az, rate, pull); }
  swirlGlow(i: number, ax: number, az: number, rate: number, pull: number): void { this.glowP.swirl(i, ax, az, rate, pull); }

  decal(kind: DecalKind, x: number, y: number, z: number, nx: number, ny: number, nz: number, len: number, wid: number, yaw: number, life: number): void {
    this.decals.add(kind, x, y, z, nx, ny, nz, len, wid, yaw, life);
  }

  crystal(x: number, y: number, z: number, size: number, yaw: number, tx: number, tz: number): void { this.ice.crystal(x, y, z, size, yaw, tx, tz); }
  sheet(x: number, y: number, z: number, yaw: number, pitch: number, len: number, wid: number, thick: number): void { this.ice.sheet(x, y, z, yaw, pitch, len, wid, thick); }

  /** Per frame after everything was submitted. */
  update(dt: number): void {
    this.uTime.value += dt;
    this.glowP.update(dt);
    this.softP.update(dt);
    this.beams.flush();
    this.ice.flush();
    this.decals.update();
  }

  get active(): number { return this.glowP.n + this.softP.n; }
}
