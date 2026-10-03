/**
 * Dust and smoke: GPU-animated billboards. Each particle is written once at
 * spawn (position, velocity, birth, life, size, colour); motion, growth,
 * fading and drag are evaluated in the vertex shader from the current time.
 */
import * as THREE from 'three';

const CAP = 3000;

export class Dust {
  readonly mesh: THREE.Mesh;
  private a0: THREE.InstancedBufferAttribute; // pos.xyz, birth
  private a1: THREE.InstancedBufferAttribute; // vel.xyz, life
  private a2: THREE.InstancedBufferAttribute; // size0, size1, rot, alpha
  private a3: THREE.InstancedBufferAttribute; // color rgb, buoyancy
  private next = 0;
  private uTime = { value: 0 };

  constructor() {
    const quad = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.getAttribute('position'));
    g.setAttribute('uv', quad.getAttribute('uv'));
    this.a0 = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4);
    this.a1 = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4);
    this.a2 = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4);
    this.a3 = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4);
    for (const a of [this.a0, this.a1, this.a2, this.a3]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('a0', this.a0);
    g.setAttribute('a1', this.a1);
    g.setAttribute('a2', this.a2);
    g.setAttribute('a3', this.a3);
    g.instanceCount = CAP;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime, fogColor: { value: new THREE.Color() }, uSun: { value: new THREE.Vector3(0.3, 0.8, 0.2) } },
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute vec4 a0; attribute vec4 a1; attribute vec4 a2; attribute vec4 a3;
        uniform float uTime;
        varying vec2 vUv; varying float vAlpha; varying vec3 vCol; varying float vSeed;
        void main() {
          float age = uTime - a0.w;
          float life = a1.w;
          if (life <= 0.0 || age < 0.0 || age > life) { gl_Position = vec4(0.0); return; }
          float t = age / life;
          // Velocity decays with drag; buoyant smoke rises.
          float drag = 1.6;
          vec3 disp = a1.xyz * (1.0 - exp(-drag * age)) / drag + vec3(0.0, a3.w * age * age * 0.3, 0.0);
          vec3 p = a0.xyz + disp;
          float size = mix(a2.x, a2.y, 1.0 - pow(1.0 - t, 2.5));
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float r = a2.z + age * 0.2;
          vec2 c = position.xy;
          c = vec2(c.x * cos(r) - c.y * sin(r), c.x * sin(r) + c.y * cos(r));
          mv.xy += c * size;
          gl_Position = projectionMatrix * mv;
          vUv = uv;
          vAlpha = a2.w * smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.55, 1.0, t));
          vCol = a3.rgb;
          vSeed = a0.w * 13.7 + a0.x;
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying float vAlpha; varying vec3 vCol; varying float vSeed;
        float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1, 0)), u.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), u.x), u.y); }
        void main() {
          vec2 q = vUv - 0.5;
          float d = length(q) * 2.0;
          float puff = n(q * 4.0 + vSeed) * 0.6 + n(q * 9.0 - vSeed) * 0.4;
          float a = smoothstep(1.0, 0.2, d + (puff - 0.5) * 0.6) * vAlpha;
          if (a < 0.003) discard;
          vec3 col = vCol * (0.75 + 0.35 * puff) * (1.0 - 0.25 * d);
          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }

  /** Emit n puffs around (x,y,z) within radius r; vel = base outward speed. */
  burst(x: number, y: number, z: number, n: number, r: number, speed: number, size: number, life: number, color: THREE.Color, buoy = 0.6, alpha = 0.55): void {
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (i + 1) % CAP;
      const a = Math.random() * Math.PI * 2, u = Math.random() * 2 - 1;
      const s = Math.sqrt(1 - u * u);
      const dx = Math.cos(a) * s, dy = Math.abs(u) * 0.6, dz = Math.sin(a) * s;
      const rr = r * Math.cbrt(Math.random());
      this.a0.setXYZW(i, x + dx * rr, y + dy * rr, z + dz * rr, this.uTime.value + Math.random() * 0.15);
      const sp = speed * (0.4 + Math.random() * 0.8);
      this.a1.setXYZW(i, dx * sp, dy * sp * 0.6 + speed * 0.1, dz * sp, life * (0.6 + Math.random() * 0.8));
      this.a2.setXYZW(i, size * (0.3 + Math.random() * 0.4), size * (1.5 + Math.random() * 1.5), Math.random() * 6.28, alpha);
      const v = 0.85 + Math.random() * 0.2;
      this.a3.setXYZW(i, color.r * v, color.g * v, color.b * v, buoy * (0.5 + Math.random()));
    }
    for (const at of [this.a0, this.a1, this.a2, this.a3]) at.needsUpdate = true;
  }

  /**
   * Blow away dust and smoke near (x, y, z) (whirlwind): puffs born within r end now. Approximate
   * (positions drift after birth) but cheap: one pass over the pool.
   */
  clearNear(x: number, y: number, z: number, r: number): number {
    const P = this.a0.array as Float32Array, L = this.a1.array as Float32Array;
    const now = this.uTime.value, r2 = r * r;
    let n = 0;
    for (let i = 0; i < CAP; i++) {
      const o = i * 4;
      const life = L[o + 3];
      if (life <= 0 || now - P[o + 3] > life) continue;
      const age = now - P[o + 3];
      // Rough current position (the shader adds drag-limited drift and buoyancy).
      const k = (1 - Math.exp(-1.6 * age)) / 1.6;
      const dx = P[o] + L[o] * k - x, dy = P[o + 1] + L[o + 1] * k - y, dz = P[o + 2] + L[o + 2] * k - z;
      if (dx * dx + dz * dz > r2 || Math.abs(dy) > r * 2) continue;
      // End it shortly (it fades out over the shader's last stretch).
      L[o + 3] = Math.max(0.01, age + 0.05);
      n++;
    }
    if (n) this.a1.needsUpdate = true;
    return n;
  }

  update(dt: number): void {
    this.uTime.value += dt;
  }
}
