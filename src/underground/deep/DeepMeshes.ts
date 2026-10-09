/**
 * Drawing the deep realm: rock and decor chunks from the deep worker (built nearest first within
 * reach of the camera, dropped far away), and the things that move or shimmer — water, the
 * falls, the Heart, spores drifting in the air, the Lumen lift, the mosaics in the Archive.
 *
 * Materials (all warmed at start through stand-ins): the cave material (lit, plus the light baked
 * into every vertex as emission), an unlit glow material, the falls, the spores and the shard. No lights of its own: the realm glows by itself (and the player's headlamp).
 */
import * as THREE from 'three';
import type { DeepPlan } from './plan';
import type { ChunkData, SkipBox } from './mesher';
import { CHUNK, keyOf } from './mesher';
import { createWaterMaterial } from '../../render/materials/ground';
import { SHARD_VS, SHARD_FS } from '../../game/intro/StarFx';
import { G } from '../../render/materials/globals';
import { WEBGPU, gpuKit } from '../../render/gpuMode';
import { hitch } from '../../debug/HitchLog';

/** Chunks are built within BUILD m of the camera and dropped beyond DROP. */
const BUILD = 230, DROP = 300;

export class DeepMeshes {
  readonly group = new THREE.Group();
  private worker: Worker | null = null;
  private list: [number, number, number][] | null = null;
  private built = new Map<string, THREE.Object3D>();
  private pending = new Set<string>();
  private inFlight = 0;
  readonly caveMat: THREE.MeshStandardMaterial;
  /** Glowing decor: held low (the frame's tone mapping washes bright glows out to pastel). */
  readonly glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, color: new THREE.Color(0.6, 0.6, 0.6) });
  private fallsU = { uT: { value: 0 } };
  private fallsMat: THREE.ShaderMaterial;
  private sporeU = { uT: { value: 0 }, uColor: { value: new THREE.Color(0.3, 1.0, 0.8) }, uScale: { value: 300 } };
  private sporeMat: THREE.ShaderMaterial;
  private shardU = { uI: { value: 1.3 }, uT: { value: 0 } };
  private waterMat = (() => { const m = createWaterMaterial(true); m.envMapIntensity = 0.02; m.roughness = 0.08; m.color.set(0x0b2a2a); return m; })();
  private spores: THREE.Points;
  private lift: THREE.Points;
  private liftOn = 0;
  private heart = new THREE.Group();
  private heartGlow: THREE.Mesh;
  /** Second mosaic (the Lumen's picture of the player): shown once they see the player as kin. */
  private kinMosaic: THREE.Mesh | null = null;
  private time = 0;
  /** Debug / stats. */
  stats = { chunks: 0, verts: 0, ms: 0, built: 0 };
  onError: ((msg: string) => void) | null = null;

  constructor(readonly plan: DeepPlan, skip: SkipBox[]) {
    this.group.name = 'deep';
    const cave = WEBGPU ? gpuKit().deepCaveNodeMaterial() as unknown as THREE.MeshStandardMaterial
      : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0 });
    if (!WEBGPU) cave.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 aGlow;\nvarying vec3 vGlow;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vGlow;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlow * (diffuseColor.rgb * 0.9 + 0.04);');
    };
    cave.customProgramCacheKey = () => 'deep-cave';
    this.caveMat = cave;
    this.fallsMat = WEBGPU ? gpuKit().deepFallsNodeMaterial(this.fallsU) as unknown as THREE.ShaderMaterial : new THREE.ShaderMaterial({
      uniforms: this.fallsU, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uT;
        varying vec2 vUv;
        float h(float n) { return fract(sin(n) * 43758.5453); }
        void main() {
          float col = floor(vUv.x * 40.0);
          float s = fract(vUv.y * 3.0 + uT * (1.2 + h(col) * 0.8) + h(col * 7.0));
          float streak = smoothstep(0.0, 0.3, s) * (1.0 - smoothstep(0.5, 1.0, s));
          float edge = smoothstep(0.0, 0.15, vUv.x) * smoothstep(1.0, 0.85, vUv.x);
          float a = (0.12 + 0.35 * streak) * edge * (0.6 + 0.4 * vUv.y);
          gl_FragColor = vec4(vec3(0.55, 0.8, 0.95) * (0.8 + streak), a);
        }`,
    });
    this.sporeMat = new THREE.ShaderMaterial({
      uniforms: this.sporeU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        uniform float uT;
        uniform float uScale;
        attribute float aSeed;
        varying float vA;
        void main() {
          vec3 p = position;
          p.y += mod(uT * (0.15 + aSeed * 0.25) + aSeed * 40.0, 40.0) - 20.0;
          p.x += sin(uT * 0.3 + aSeed * 30.0) * 0.8;
          p.z += cos(uT * 0.27 + aSeed * 17.0) * 0.8;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          vA = (0.4 + 0.6 * abs(sin(uT * (0.5 + aSeed) + aSeed * 9.0))) * smoothstep(60.0, 10.0, -mv.z);
          gl_PointSize = uScale * (0.035 + aSeed * 0.04) / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = (1.0 - smoothstep(0.2, 1.0, d)) * vA;
          gl_FragColor = vec4(uColor, a);
        }`,
    });
    // Spores: a box of motes round the camera (moved with it in steps).
    {
      const n = 900, P = new Float32Array(n * 3), S = new Float32Array(n);
      for (let i = 0; i < n; i++) { P[i * 3] = (Math.random() - 0.5) * 70; P[i * 3 + 1] = (Math.random() - 0.5) * 40; P[i * 3 + 2] = (Math.random() - 0.5) * 70; S[i] = Math.random(); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(P, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(S, 1));
      this.spores = WEBGPU ? gpuKit().deepMotesNode(P, S, this.sporeU, null) as unknown as THREE.Points : new THREE.Points(g, this.sporeMat);
      this.spores.frustumCulled = false;
      this.spores.renderOrder = 6;
      this.group.add(this.spores);
    }
    // The lift: a column of motes rising up the Throat.
    {
      const L = plan.lift, n = 700, P = new Float32Array(n * 3), S = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * L.r;
        P[i * 3] = Math.cos(a) * r; P[i * 3 + 1] = Math.random() * (L.y1 - L.y0); P[i * 3 + 2] = Math.sin(a) * r; S[i] = Math.random();
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(P, 3));
      g.setAttribute('aSeed', new THREE.BufferAttribute(S, 1));
      const liftU = { uT: { value: 0 }, uColor: { value: new THREE.Color(0.4, 1.0, 0.85) }, uScale: { value: 520 } };
      if (WEBGPU) this.lift = gpuKit().deepMotesNode(P, S, liftU, +(L.y1 - L.y0).toFixed(1)) as unknown as THREE.Points;
      else {
        const m = this.sporeMat.clone();
        m.uniforms = liftU;
        m.vertexShader = m.vertexShader.replace('p.y += mod(uT * (0.15 + aSeed * 0.25) + aSeed * 40.0, 40.0) - 20.0;', `p.y = mod(p.y + uT * (3.0 + aSeed * 3.0), ${(L.y1 - L.y0).toFixed(1)});`)
          .replace('smoothstep(60.0, 10.0, -mv.z)', 'smoothstep(90.0, 10.0, -mv.z)');
        this.lift = new THREE.Points(g, m);
      }
      this.lift.position.set(L.x, L.y0, L.z);
      this.lift.frustumCulled = false;
      this.lift.renderOrder = 6;
      this.lift.visible = false;
      this.group.add(this.lift);
    }
    // Water.
    for (const w of plan.water) {
      const g = new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, this.waterMat);
      m.scale.set(w.rx, 1, w.rz);
      m.rotation.y = -w.yaw;
      m.position.set(w.x, w.y, w.z);
      this.group.add(m);
    }
    // The falls.
    for (const f of plan.falls) {
      const h = f.y1 - f.y0;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(f.w, h), this.fallsMat);
      m.position.set(f.x, f.y0 + h / 2, f.z);
      m.lookAt(f.x + f.nx, f.y0 + h / 2, f.z + f.nz);
      m.renderOrder = 6;
      this.group.add(m);
    }
    // The Heart: a cluster of the star's crystal, big, and its glow.
    {
      const H = plan.heart;
      const sm = WEBGPU ? gpuKit().deepShardNodeMaterial(this.shardU) as unknown as THREE.ShaderMaterial
        : new THREE.ShaderMaterial({ vertexShader: SHARD_VS, fragmentShader: SHARD_FS, uniforms: this.shardU, toneMapped: false });
      const parts: [number, number, number, number, number, number][] = [
        [0.9, 3.4, 0.9, 0.05, 0.0, 0], [0.55, 2.1, 0.55, 0.55, 0.35, 0.7], [0.45, 1.6, 0.45, -0.5, -0.5, -0.6], [0.35, 1.2, 0.35, 0.2, -0.8, 0.4],
      ];
      for (const [sx, sy, sz, tx, tz, off] of parts) {
        const m = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), sm);
        m.scale.set(sx, sy, sz);
        m.rotation.set(tx, off * 9, tz);
        m.position.set(off, sy * 0.4, off * 0.6);
        this.heart.add(m);
      }
      this.heart.position.set(H.x, H.y - 0.3, H.z);
      this.heart.rotation.set(0.18, 0.7, 0.1);
      this.group.add(this.heart);
      const gm = new THREE.SpriteMaterial({ color: new THREE.Color(0.4, 0.8, 1.6), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, map: radialTexture() });
      const sp = new THREE.Sprite(gm);
      sp.scale.set(16, 16, 1);
      sp.position.set(H.x, H.y + 2.6, H.z);
      this.heartGlow = sp as unknown as THREE.Mesh;
      this.group.add(sp);
    }
    // The Archive's mosaics: the star falling and breaking — one shard to the city, one down into the dark;
    // and (later) the one with the shard's light standing among them.
    plan.mosaics.forEach((M, i) => {
      const tex = new THREE.CanvasTexture(mosaicCanvas(i, plan.seed));
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: true });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(M.w, M.h), mat);
      m.position.set(M.x, M.y, M.z);
      m.lookAt(M.x + M.nx, M.y, M.z + M.nz);
      this.group.add(m);
      if (i === 1) { this.kinMosaic = m; m.visible = false; }
    });
    // Stand-ins so the start-up warm-up compiles the cave and glow materials.
    for (const mat of [this.caveMat, this.glowMat]) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1e4, 0, 0, -1e4, 0, 0, -1e4, 0], 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
      g.setAttribute('aGlow', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
      const w = new THREE.Mesh(g, mat);
      w.frustumCulled = false;
      this.group.add(w);
    }
    this.startWorker(skip);
  }

  private startWorker(skip: SkipBox[]): void {
    try {
      const w = new Worker(new URL('./deep.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent) => {
        const m = e.data as { type: string; list?: [number, number, number][]; data?: ChunkData; ms?: number; message?: string };
        if (m.type === 'chunks') this.list = m.list ?? [];
        if (m.type === 'chunks') this.lastPick.set(1e9, 0, 0);
        else if (m.type === 'chunk' && m.data) { this.inFlight--; hitch.measure('deep:chunk', () => this.addChunk(m.data!, m.ms ?? 0)); }
        else if (m.type === 'error') { this.inFlight = Math.max(0, this.inFlight - 1); this.onError?.(m.message ?? 'deep worker'); }
      };
      w.postMessage({ type: 'init', plan: this.plan, skip });
      w.postMessage({ type: 'chunks' });
      this.worker = w;
    } catch (err) { this.onError?.(String(err)); }
  }

  private addChunk(d: ChunkData, ms: number): void {
    this.pending.delete(d.key);
    this.stats.ms = this.stats.ms * 0.9 + ms * 0.1;
    this.stats.built++;
    if (!this.wanted.has(d.key)) return;
    const o = new THREE.Group();
    if (d.idx.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(d.pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(d.nor, 3));
      g.setAttribute('color', new THREE.BufferAttribute(d.col, 3));
      g.setAttribute('aGlow', new THREE.BufferAttribute(d.glow, 3));
      g.setIndex(new THREE.BufferAttribute(d.idx, 1));
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, this.caveMat);
      m.receiveShadow = false;
      o.add(m);
      this.stats.verts += d.pos.length / 3;
    }
    if (d.eidx.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(d.epos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(d.ecol, 3));
      g.setIndex(new THREE.BufferAttribute(d.eidx, 1));
      g.computeBoundingSphere();
      o.add(new THREE.Mesh(g, this.glowMat));
    }
    o.userData.verts = d.pos.length / 3;
    this.built.set(d.key, o);
    this.group.add(o);
    this.stats.chunks = this.built.size;
  }

  private wanted = new Set<string>();
  private lastPick = new THREE.Vector3(1e9, 0, 0);

  /** Is the camera near enough to the realm for any of it to matter? */
  near(p: THREE.Vector3, m = 260): boolean {
    const b = this.bounds;
    return p.x > b[0] - m && p.x < b[3] + m && p.z > b[2] - m && p.z < b[5] + m && p.y < b[4] + 60;
  }
  get bounds(): number[] {
    if (!this.bb) {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (const p of this.plan.prims) {
        const a = p.a;
        const pts = p.t === 'cap' ? [[a[0], a[1], a[2]], [a[3], a[4], a[5]]] : p.t === 'cyl' ? [[a[0], a[2], a[1]], [a[0], a[3], a[1]]] : [[a[0], a[1], a[2]]];
        for (const [x, y, z] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); z0 = Math.min(z0, z); x1 = Math.max(x1, x); y1 = Math.max(y1, y); z1 = Math.max(z1, z); }
      }
      this.bb = [x0 - 60, y0 - 30, z0 - 60, x1 + 60, y1 + 30, z1 + 60];
    }
    return this.bb;
  }
  private bb: number[] | null = null;

  /**
   * Per frame: chunks round the camera, the shimmer; `deep` 0..1 how far the camera is in the
   * Murk's part (spore colour), `lift` whether the Lumen run their lift, `kin` the second mosaic.
   */
  update(dt: number, cam: THREE.Vector3, under: boolean, o: { murk: number; lift: boolean; kin: boolean }): void {
    this.time += dt;
    const show = under && this.near(cam, 200);
    this.group.visible = show || this.inView(cam);
    this.fallsU.uT.value = this.time;
    this.sporeU.uT.value = this.time;
    (this.lift.material as THREE.ShaderMaterial).uniforms.uT.value = this.time;
    this.shardU.uT.value = this.time;
    this.shardU.uI.value = 1.15 + 0.25 * Math.sin(this.time * 1.3) + 0.15 * Math.sin(this.time * 3.1);
    (this.heartGlow as unknown as THREE.Sprite).material.opacity = 0.35 + 0.15 * Math.sin(this.time * 1.3);
    // Spores follow the camera in 10 m steps (no visible jump: they drift and fade by distance).
    this.spores.visible = show;
    this.spores.position.set(Math.round(cam.x / 10) * 10, Math.round(cam.y / 10) * 10, Math.round(cam.z / 10) * 10);
    this.sporeU.uColor.value.setRGB(0.3 + 0.7 * o.murk, 1.0 - 0.75 * o.murk, 0.8 - 0.6 * o.murk);
    this.liftOn += ((o.lift ? 1 : 0) - this.liftOn) * Math.min(1, dt * 0.8);
    this.lift.visible = show && this.liftOn > 0.02;
    (this.lift.material as THREE.ShaderMaterial).uniforms.uColor.value.setRGB(0.4 * this.liftOn, 1.0 * this.liftOn, 0.85 * this.liftOn);
    if (this.kinMosaic) this.kinMosaic.visible = o.kin;
    void G;
    if (!this.worker || !this.list || !this.group.visible) return;
    // Pick chunks when the camera moved a few metres.
    if (cam.distanceToSquared(this.lastPick) > 16) {
      this.lastPick.copy(cam);
      this.wanted.clear();
      const cand: { k: string; d: number; c: [number, number, number] }[] = [];
      for (const c of this.list) {
        const x = (c[0] + 0.5) * CHUNK, y = (c[1] + 0.5) * CHUNK, z = (c[2] + 0.5) * CHUNK;
        const d = Math.hypot(x - cam.x, (y - cam.y) * 1.3, z - cam.z);
        const k = keyOf(c[0], c[1], c[2]);
        if (d < DROP) this.wanted.add(k);
        if (d < BUILD && !this.built.has(k) && !this.pending.has(k)) cand.push({ k, d, c });
      }
      cand.sort((a, b) => a.d - b.d);
      this.queue = cand;
      for (const [k, o] of this.built) {
        if (this.wanted.has(k)) continue;
        this.group.remove(o);
        o.traverse((x) => { const m = x as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
        this.stats.verts -= (o.userData.verts as number) ?? 0;
        this.built.delete(k);
      }
      this.stats.chunks = this.built.size;
    }
    while (this.inFlight < 2 && this.queue.length) {
      const q = this.queue.shift()!;
      if (this.built.has(q.k) || this.pending.has(q.k)) continue;
      this.pending.add(q.k);
      this.inFlight++;
      this.worker.postMessage({ type: 'build', i: q.c[0], j: q.c[1], k: q.c[2] });
    }
  }
  private queue: { k: string; d: number; c: [number, number, number] }[] = [];

  /** From the surface nothing of it shows (the ground is in between): only underground or nearby. */
  private inView(cam: THREE.Vector3): boolean { return this.near(cam, 60) && cam.y < this.bounds[4]; }

  /** How many chunks are still to build near the camera (tests wait for 0). */
  get busy(): number { return this.queue.length + this.inFlight; }

  /** Objects for the start-up warm-up (one of each material, out of sight). */
  warmObjects(): THREE.Object3D[] { return []; }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}

let radial: THREE.Texture | null = null;
function radialTexture(): THREE.Texture {
  if (radial) return radial;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  radial = new THREE.CanvasTexture(c);
  return radial;
}

/**
 * A mosaic of bottle caps and tiles (dots on a dark ground). 0: the city's skyline, a star falling
 * and breaking — one bright shard down to the streets, one plunging under them to a red glow with
 * tendrils. 1: a small figure in the shard's blue light among a ring of round, glowing shapes.
 */
function mosaicCanvas(which: number, seed: number): HTMLCanvasElement {
  const W = 288, H = 192;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d')!;
  let s = seed ^ (which * 7919);
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  x.fillStyle = '#14100e';
  x.fillRect(0, 0, W, H);
  const dot = (px: number, py: number, col: string, r = 3.2) => {
    x.fillStyle = col;
    x.beginPath();
    x.arc(px + (rnd() - 0.5) * 1.2, py + (rnd() - 0.5) * 1.2, r * (0.85 + rnd() * 0.3), 0, Math.PI * 2);
    x.fill();
  };
  // Background tiles: dark earthy dots.
  for (let py = 4; py < H; py += 7) for (let px = 4 + ((py / 7) % 2) * 3.5; px < W; px += 7) dot(px, py, ['#2a221d', '#251e1a', '#30271f', '#1f1a17'][Math.floor(rnd() * 4)], 3);
  const ground = H * 0.55;
  if (which === 0) {
    // Sky above the city: deep blue dots.
    for (let py = 4; py < ground; py += 7) for (let px = 4 + ((py / 7) % 2) * 3.5; px < W; px += 7) if (rnd() < 0.9) dot(px, py, ['#18213a', '#1c2747', '#141b30'][Math.floor(rnd() * 3)], 3);
    // Skyline (grey caps) along the ground line.
    let bx = 0;
    while (bx < W) {
      const bw = 12 + rnd() * 22, bh = 14 + rnd() * 46;
      for (let py = ground - bh; py < ground; py += 6) for (let px = bx + 3; px < bx + bw - 2; px += 6) dot(px, py, rnd() < 0.15 ? '#d9c36a' : '#6e6a66', 2.6);
      bx += bw + 2;
    }
    // The star's trail from the top left, breaking above the city.
    const sx = 40, sy = 14, bx2 = 150, by2 = 52;
    for (let t = 0; t < 1; t += 0.03) dot(sx + (bx2 - sx) * t, sy + (by2 - sy) * t, t > 0.8 ? '#ffffff' : '#f2e3b0', 2 + t * 2.5);
    for (let k = 0; k < 10; k++) { const a = rnd() * Math.PI * 2, r = 4 + rnd() * 10; dot(bx2 + Math.cos(a) * r, by2 + Math.sin(a) * r, '#fff4d0', 1.8); }
    // One shard down to the streets (blue) …
    for (let t = 0; t < 1; t += 0.06) dot(bx2 + (110 - bx2) * t, by2 + (ground - 6 - by2) * t, '#6fc2ff', 2.4);
    dot(110, ground - 4, '#bfe6ff', 4.5);
    // … one plunging under them, to a red glow with tendrils.
    const dx2 = 196, dy2 = H - 26;
    for (let t = 0; t < 1; t += 0.05) dot(bx2 + (dx2 - bx2) * t, by2 + (dy2 - by2) * t, t < 0.45 ? '#6fc2ff' : '#7a6cff', 2.4);
    for (let k = 0; k < 40; k++) { const a = rnd() * Math.PI * 2, r = rnd() * 18; dot(dx2 + Math.cos(a) * r, dy2 + Math.sin(a) * r * 0.6, ['#c2261e', '#8f1a3f', '#e0502a'][Math.floor(rnd() * 3)], 2.8); }
    for (let k = 0; k < 6; k++) {
      const a = Math.PI + (k / 5) * Math.PI;
      for (let t = 0; t < 1; t += 0.1) dot(dx2 + Math.cos(a) * (18 + t * 26), dy2 + Math.sin(a) * (10 + t * 14) * 0.7 - t * 6, '#8f1a3f', 2);
    }
    dot(dx2, dy2, '#9fdcff', 5);
  } else {
    // A ring of glowing round shapes (teal, green, amber) round a small figure in blue light.
    const cx = W / 2, cy = H * 0.6;
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2;
      const px = cx + Math.cos(a) * 92, py = cy + Math.sin(a) * 46;
      const col = ['#29e0b0', '#6be04a', '#e8c25a', '#35a6ff'][k % 4];
      for (let j = 0; j < 7; j++) { const b = rnd() * Math.PI * 2, r = rnd() * 9; dot(px + Math.cos(b) * r, py + Math.sin(b) * r * 0.7, col, 2.8); }
    }
    for (let k = 0; k < 30; k++) { const a = rnd() * Math.PI * 2, r = rnd() * 22; dot(cx + Math.cos(a) * r, cy - 26 + Math.sin(a) * r, '#1f4a7a', 2.6); }
    // The figure: head, body, arms, legs in pale caps.
    dot(cx, cy - 46, '#e9e2d6', 4.2);
    for (let t = 0; t < 1; t += 0.2) dot(cx, cy - 38 + t * 22, '#d8d0c4', 3.4);
    for (const sx of [-1, 1]) { for (let t = 0.2; t <= 1; t += 0.25) dot(cx + sx * t * 11, cy - 34 + t * 8, '#d8d0c4', 2.6); for (let t = 0.2; t <= 1; t += 0.25) dot(cx + sx * t * 6, cy - 14 + t * 18, '#d8d0c4', 2.8); }
    dot(cx, cy - 30, '#8fd4ff', 3.6);
  }
  return c;
}
