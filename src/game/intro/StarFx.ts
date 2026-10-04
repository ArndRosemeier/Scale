/**
 * Visual effects of the origin scene, all emissive (additive, HDR — the bloom pass makes them
 * glow) and without scene lights (a light would change every material's program):
 *  - streaks: a glowing head and a tapered trail sampled along its path function,
 *  - glows: camera-facing soft discs (with a minimum angular size, so a far star still shows),
 *  - ground glow and a scorch mark where the shard lies,
 *  - the shard: a cluster of crystals with facets, a fresnel rim and a pulse,
 *  - particles: sparks shed by the star, the impact's spray, motes rising round the shard and
 *    the streams of light that spiral from the shard into the player.
 */
import * as THREE from 'three';

const GLOW_VS = /* glsl */ `
uniform float uSize;
uniform float uMinAng;
varying vec2 vUv;
void main() {
  vUv = uv * 2.0 - 1.0;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float s = max(uSize, -mv.z * uMinAng);
  mv.xy += position.xy * s;
  gl_Position = projectionMatrix * mv;
}`;
const GLOW_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uI;
uniform float uCore;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float halo = pow(1.0 - r, 2.4);
  float core = exp(-r * r * uCore);
  gl_FragColor = vec4(uColor * (halo * 0.55 + core * 1.6) * uI, 1.0);
}`;

const DISC_VS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const DISC_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uI;
uniform float uDark;
uniform float uT;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  if (uDark > 0.5) {
    // Scorch: dark, ragged edge.
    float a = atan(vUv.y, vUv.x);
    float edge = 0.78 + 0.12 * sin(a * 7.0) + 0.06 * sin(a * 13.0 + 1.3);
    float k = 1.0 - smoothstep(edge - 0.25, edge, r);
    gl_FragColor = vec4(vec3(0.025, 0.02, 0.03), k * 0.85 * uI);
  } else {
    float ring = 0.5 + 0.5 * sin(r * 18.0 - uT * 3.0);
    float g = pow(1.0 - r, 2.0) * (0.75 + 0.25 * ring);
    gl_FragColor = vec4(uColor * g * uI, 1.0);
  }
}`;

const TRAIL_VS = /* glsl */ `
attribute float aT;
attribute float aSide;
varying float vT;
varying float vSide;
void main() { vT = aT; vSide = aSide; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const TRAIL_FS = /* glsl */ `
uniform vec3 uHead;
uniform vec3 uTail;
uniform float uI;
varying float vT;
varying float vSide;
void main() {
  float across = 1.0 - vSide * vSide;
  float a = pow(1.0 - vT, 1.6) * across;
  vec3 c = mix(uHead, uTail, smoothstep(0.0, 0.5, vT));
  gl_FragColor = vec4(c * a * uI, 1.0);
}`;

const PART_VS = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
uniform float uScale;
varying vec3 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize <= 0.0 ? 0.0 : clamp(aSize * uScale / max(0.05, -mv.z), 1.5, 64.0);
  gl_Position = projectionMatrix * mv;
}`;
const PART_FS = /* glsl */ `
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float a = pow(1.0 - d, 2.0);
  gl_FragColor = vec4(vColor * a, 1.0);
}`;

export const SHARD_VS = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
varying float vH;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = -mv.xyz;
  vH = position.y;
  gl_Position = projectionMatrix * mv;
}`;
export const SHARD_FS = /* glsl */ `
uniform float uI;
uniform float uT;
varying vec3 vN;
varying vec3 vV;
varying float vH;
void main() {
  vec3 N = normalize(vN), V = normalize(vV);
  float fres = pow(1.0 - abs(dot(N, V)), 2.0);
  float facet = 0.5 + 0.5 * dot(N, normalize(vec3(0.4, 0.8, 0.3)));
  float vein = 0.5 + 0.5 * sin(vH * 14.0 - uT * 4.0);
  vec3 deep = vec3(0.18, 0.08, 0.55), mid = vec3(0.25, 0.75, 1.2), hot = vec3(1.6, 1.5, 1.9);
  vec3 c = mix(deep, mid, facet * 0.8 + vein * 0.2) + hot * fres;
  gl_FragColor = vec4(c * uI, 1.0);
}`;

function additive(vs: string, fs: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({ vertexShader: vs, fragmentShader: fs, uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
}

export class Glow {
  readonly mesh: THREE.Mesh;
  readonly u: { uColor: { value: THREE.Color }; uI: { value: number }; uSize: { value: number }; uMinAng: { value: number }; uCore: { value: number } };
  constructor(geo: THREE.PlaneGeometry, color: THREE.ColorRepresentation, size: number, minAng = 0, core = 9) {
    this.u = { uColor: { value: new THREE.Color(color) }, uI: { value: 1 }, uSize: { value: size }, uMinAng: { value: minAng }, uCore: { value: core } };
    const m = additive(GLOW_VS, GLOW_FS, this.u);
    this.mesh = new THREE.Mesh(geo, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }
  set(p: THREE.Vector3, intensity: number, size?: number): void {
    this.mesh.position.copy(p);
    this.u.uI.value = intensity;
    if (size !== undefined) this.u.uSize.value = size;
    this.mesh.visible = intensity > 0.002;
  }
}

/** A tapered ribbon along samples of a path (head first), facing the camera. */
class Trail {
  readonly mesh: THREE.Mesh;
  readonly u = { uHead: { value: new THREE.Color(2.2, 2.0, 1.7) }, uTail: { value: new THREE.Color(0.9, 0.35, 1.2) }, uI: { value: 1 } };
  private pos: THREE.BufferAttribute;
  constructor(readonly n: number) {
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    const aT = new Float32Array(n * 2), aS = new Float32Array(n * 2);
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      aT[i * 2] = aT[i * 2 + 1] = i / (n - 1);
      aS[i * 2] = -1; aS[i * 2 + 1] = 1;
      if (i < n - 1) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    g.setAttribute('position', this.pos);
    g.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
    g.setAttribute('aSide', new THREE.BufferAttribute(aS, 1));
    g.setIndex(idx);
    const m = additive(TRAIL_VS, TRAIL_FS, this.u);
    m.side = THREE.DoubleSide;
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
  }
  /** pts: head first; width at the head (tapering), camera position for facing. */
  set(pts: THREE.Vector3[], width: number, cam: THREE.Vector3, intensity: number): void {
    const P = this.pos.array as Float32Array;
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const p = pts[Math.min(i, pts.length - 1)];
      const q = pts[Math.min(i + 1, pts.length - 1)], o = pts[Math.max(0, i - 1)];
      _t.subVectors(o, q);
      if (_t.lengthSq() < 1e-8) _t.set(0, 1, 0);
      _c.subVectors(cam, p);
      _s.crossVectors(_t, _c).normalize();
      const w = width * (1 - (i / (n - 1)) * 0.85);
      P[i * 6] = p.x - _s.x * w; P[i * 6 + 1] = p.y - _s.y * w; P[i * 6 + 2] = p.z - _s.z * w;
      P[i * 6 + 3] = p.x + _s.x * w; P[i * 6 + 4] = p.y + _s.y * w; P[i * 6 + 5] = p.z + _s.z * w;
    }
    this.pos.needsUpdate = true;
    this.u.uI.value = intensity;
    this.mesh.visible = intensity > 0.002;
  }
}

const _t = new THREE.Vector3(), _c = new THREE.Vector3(), _s = new THREE.Vector3();

/** A glowing head with a trail, moving along `path(t)` (seconds of scene time) from t0. */
export class Streak {
  readonly head: Glow;
  readonly trail: Trail;
  private pts: THREE.Vector3[];
  constructor(geo: THREE.PlaneGeometry, readonly path: (t: number) => THREE.Vector3, readonly t0: number, readonly span: number, readonly width: number, size: number, n = 40) {
    this.head = new Glow(geo, new THREE.Color(1.0, 0.92, 0.8), size, 0.006, 14);
    this.trail = new Trail(n);
    this.pts = Array.from({ length: n }, () => new THREE.Vector3());
  }
  /** Trail samples cover `span` seconds of path behind the head. */
  update(t: number, cam: THREE.Vector3, intensity: number): THREE.Vector3 {
    const n = this.pts.length;
    for (let i = 0; i < n; i++) this.pts[i].copy(this.path(Math.max(this.t0, t - (i / (n - 1)) * this.span)));
    const head = this.pts[0];
    this.head.set(head, intensity);
    this.trail.set(this.pts, this.width, cam, intensity * 0.9);
    return head;
  }
  hide(): void { this.head.mesh.visible = false; this.trail.mesh.visible = false; }
}

const MAXP = 900;
const enum PK { Spark, Stream, Mote }

/** CPU particles in one Points draw. */
class Particles {
  readonly points: THREE.Points;
  readonly u = { uScale: { value: 400 } };
  private P: THREE.BufferAttribute;
  private C: THREE.BufferAttribute;
  private S: THREE.BufferAttribute;
  private kind = new Uint8Array(MAXP);
  private life = new Float32Array(MAXP);
  private age = new Float32Array(MAXP);
  private vel = new Float32Array(MAXP * 3);
  private col = new Float32Array(MAXP * 3);
  private size = new Float32Array(MAXP);
  private aux = new Float32Array(MAXP * 4);
  private next = 0;
  /** Where the streams go (the player's chest). */
  readonly target = new THREE.Vector3();
  constructor() {
    const g = new THREE.BufferGeometry();
    this.P = new THREE.BufferAttribute(new Float32Array(MAXP * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.C = new THREE.BufferAttribute(new Float32Array(MAXP * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.S = new THREE.BufferAttribute(new Float32Array(MAXP), 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.P);
    g.setAttribute('aColor', this.C);
    g.setAttribute('aSize', this.S);
    this.points = new THREE.Points(g, additive(PART_VS, PART_FS, this.u));
    this.points.frustumCulled = false;
    this.points.renderOrder = 11;
  }
  private alloc(): number {
    const i = this.next;
    this.next = (this.next + 1) % MAXP;
    return i;
  }
  spark(p: THREE.Vector3, vx: number, vy: number, vz: number, life: number, size: number, r: number, g: number, b: number): void {
    const i = this.alloc();
    this.kind[i] = PK.Spark; this.life[i] = life; this.age[i] = 0; this.size[i] = size;
    (this.P.array as Float32Array).set([p.x, p.y, p.z], i * 3);
    this.vel.set([vx, vy, vz], i * 3); this.col.set([r, g, b], i * 3);
  }
  /** A mote of light spiralling from `p` into the target over `life` s. */
  stream(p: THREE.Vector3, life: number, size: number, turn: number): void {
    const i = this.alloc();
    this.kind[i] = PK.Stream; this.life[i] = life; this.age[i] = 0; this.size[i] = size;
    (this.P.array as Float32Array).set([p.x, p.y, p.z], i * 3);
    this.aux.set([p.x, p.y, p.z, turn], i * 4);
    this.col.set([0.6 + Math.random() * 0.6, 1.2 + Math.random() * 0.5, 2.2], i * 3);
  }
  mote(p: THREE.Vector3, life: number, size: number): void {
    const i = this.alloc();
    this.kind[i] = PK.Mote; this.life[i] = life; this.age[i] = 0; this.size[i] = size;
    (this.P.array as Float32Array).set([p.x, p.y, p.z], i * 3);
    this.vel.set([(Math.random() - 0.5) * 0.15, 0.25 + Math.random() * 0.35, (Math.random() - 0.5) * 0.15], i * 3);
    this.aux.set([Math.random() * 6.28, 0, 0, 0], i * 4);
    this.col.set([0.5, 1.0, 1.9], i * 3);
  }
  update(dt: number, t: number): void {
    const P = this.P.array as Float32Array, C = this.C.array as Float32Array, S = this.S.array as Float32Array;
    for (let i = 0; i < MAXP; i++) {
      if (this.life[i] <= 0) { S[i] = 0; continue; }
      this.age[i] += dt;
      const f = this.age[i] / this.life[i];
      if (f >= 1) { this.life[i] = 0; S[i] = 0; continue; }
      const o = i * 3;
      let fade = 1;
      if (this.kind[i] === PK.Spark) {
        this.vel[o + 1] -= 6 * dt;
        const drag = Math.exp(-dt * 1.2);
        for (let k = 0; k < 3; k++) { this.vel[o + k] *= drag; P[o + k] += this.vel[o + k] * dt; }
        fade = (1 - f) ** 1.5;
      } else if (this.kind[i] === PK.Stream) {
        // From the start, rising in a helix round the line, into the target.
        const a = i * 4, sx = this.aux[a], sy = this.aux[a + 1], sz = this.aux[a + 2], turn = this.aux[a + 3];
        const e = f * f * (3 - 2 * f);
        const r = 0.35 * Math.sin(Math.PI * f) * (1 - 0.3 * f);
        const ang = turn + f * 9;
        P[o] = sx + (this.target.x - sx) * e + Math.cos(ang) * r;
        P[o + 1] = sy + (this.target.y - sy) * e + Math.sin(Math.PI * f) * 0.25;
        P[o + 2] = sz + (this.target.z - sz) * e + Math.sin(ang) * r;
        fade = Math.min(1, f * 6) * (1 - f * f);
      } else {
        const a = i * 4;
        P[o] += (this.vel[o] + Math.sin(t * 1.3 + this.aux[a]) * 0.08) * dt;
        P[o + 1] += this.vel[o + 1] * dt;
        P[o + 2] += (this.vel[o + 2] + Math.cos(t * 1.1 + this.aux[a]) * 0.08) * dt;
        fade = Math.sin(Math.PI * f);
      }
      C[o] = this.col[o] * fade; C[o + 1] = this.col[o + 1] * fade; C[o + 2] = this.col[o + 2] * fade;
      S[i] = this.size[i];
    }
    this.P.needsUpdate = this.C.needsUpdate = this.S.needsUpdate = true;
  }
  clear(): void { this.life.fill(0); (this.S.array as Float32Array).fill(0); this.S.needsUpdate = true; }
}

export class StarFx {
  readonly group = new THREE.Group();
  readonly quad = new THREE.PlaneGeometry(2, 2);
  readonly particles = new Particles();
  readonly flash: Glow;
  readonly shardGlow: Glow;
  readonly chestGlow: Glow;
  readonly shard = new THREE.Group();
  readonly shardU = { uI: { value: 1 }, uT: { value: 0 } };
  readonly ground: THREE.Mesh;
  readonly scorch: THREE.Mesh;
  readonly groundU = { uColor: { value: new THREE.Color(0.35, 0.8, 1.6) }, uI: { value: 0 }, uDark: { value: 0 }, uT: { value: 0 } };
  readonly scorchU = { uColor: { value: new THREE.Color(0, 0, 0) }, uI: { value: 0 }, uDark: { value: 1 }, uT: { value: 0 } };
  readonly streaks: Streak[] = [];
  private bufSize = new THREE.Vector2();

  constructor() {
    this.group.name = 'origin-fx';
    this.flash = new Glow(this.quad, new THREE.Color(1.0, 0.95, 1.0), 1, 0, 6);
    this.shardGlow = new Glow(this.quad, new THREE.Color(0.35, 0.75, 1.5), 1.6, 0, 7);
    this.chestGlow = new Glow(this.quad, new THREE.Color(0.5, 0.95, 1.6), 0.6, 0, 8);
    for (const g of [this.flash, this.shardGlow, this.chestGlow]) { g.mesh.visible = false; this.group.add(g.mesh); }
    // The shard: a tall crystal and two smaller ones leaning out of it.
    const sm = new THREE.ShaderMaterial({ vertexShader: SHARD_VS, fragmentShader: SHARD_FS, uniforms: this.shardU, toneMapped: false });
    const parts: [number, number, number, number, number, number][] = [
      // sx, sy, sz, tiltX, tiltZ, offset
      [0.12, 0.44, 0.12, 0.0, 0.0, 0],
      [0.07, 0.25, 0.07, 0.5, 0.35, 0.09],
      [0.055, 0.19, 0.055, -0.45, -0.5, -0.08],
    ];
    for (const [sx, sy, sz, tx, tz, off] of parts) {
      const m = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), sm);
      m.scale.set(sx, sy, sz);
      m.rotation.set(tx, off * 9, tz);
      m.position.set(off, sy * 0.45, off * 0.6);
      this.shard.add(m);
    }
    this.shard.visible = false;
    this.group.add(this.shard);
    const disc = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    this.ground = new THREE.Mesh(disc, additive(DISC_VS, DISC_FS, this.groundU));
    this.ground.renderOrder = 8;
    const sc = new THREE.ShaderMaterial({ vertexShader: DISC_VS, fragmentShader: DISC_FS, uniforms: this.scorchU, transparent: true, depthWrite: false, toneMapped: false });
    this.scorch = new THREE.Mesh(disc, sc);
    this.scorch.renderOrder = 7;
    this.ground.visible = this.scorch.visible = false;
    this.group.add(this.scorch, this.ground, this.particles.points);
  }

  addStreak(path: (t: number) => THREE.Vector3, t0: number, span: number, width: number, size: number): Streak {
    const s = new Streak(this.quad, path, t0, span, width, size);
    s.hide();
    this.group.add(s.trail.mesh, s.head.mesh);
    this.streaks.push(s);
    return s;
  }

  /** The shard and its ground marks at a spot (y = ground). */
  placeShard(x: number, y: number, z: number, yaw: number): void {
    this.shard.position.set(x, y - 0.08, z);
    this.shard.rotation.set(0.32, yaw, 0.12);
    this.ground.position.set(x, y + 0.035, z);
    this.ground.scale.setScalar(2.6);
    this.scorch.position.set(x, y + 0.03, z);
    this.scorch.scale.setScalar(1.25);
  }

  /** Per frame: particle scale from the camera, particles, shard pulse. */
  update(dt: number, t: number, cam: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer): void {
    renderer.getDrawingBufferSize(this.bufSize);
    this.particles.u.uScale.value = (this.bufSize.y * 0.5) / Math.tan((cam.fov * Math.PI) / 360);
    this.particles.update(dt, t);
    this.shardU.uT.value = t;
    this.groundU.uT.value = t;
  }

  /** One of everything visible (for the start-up warm-up: programs and first draws). */
  warmObject(): THREE.Object3D {
    const g = new THREE.Group();
    const s = new Streak(this.quad, () => new THREE.Vector3(), 0, 1, 0.1, 0.1, 4);
    g.add(s.head.mesh, s.trail.mesh);
    const gl = new Glow(this.quad, 0xffffff, 0.1);
    g.add(gl.mesh);
    const sh = this.shard.clone();
    sh.visible = true;
    g.add(sh);
    const gr = this.ground.clone(); gr.visible = true; gr.scale.setScalar(0.1);
    const sc = this.scorch.clone(); sc.visible = true; sc.scale.setScalar(0.1);
    const pts = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)).setAttribute('aColor', new THREE.Float32BufferAttribute([0, 0, 0], 3)).setAttribute('aSize', new THREE.Float32BufferAttribute([1], 1)), this.particles.points.material);
    g.add(gr, sc, pts);
    return g;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && m.geometry !== this.quad) m.geometry.dispose();
      const mat = m.material as THREE.Material | undefined;
      mat?.dispose?.();
    });
    this.quad.dispose();
  }
}
