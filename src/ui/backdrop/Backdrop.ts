/**
 * The start screen's moving backdrop: a made-up city at dusk (see layout.ts) seen from a camera
 * that circles downtown, leaning a little with the mouse. Plain WebGL 2 with four small shaders
 * and four draw calls, so it is up within a frame or two, long before the game itself has loaded;
 * it lives in its own small script (see index.html) for that reason. It stops and frees its GPU
 * context when the city starts. Without WebGL 2 the old still picture shows instead.
 */
import { buildSkyline, BOX_FLOATS, LIGHT_FLOATS, PITCH, BLOCK_HALF, REACH, ORBIT_R, type Skyline } from './layout';
import * as S from './shaders';

type Vec3 = [number, number, number];

/** The sun just under the western horizon. */
const SUN: Vec3 = norm([-0.94, -0.04, 0.34]);
/** Seconds per full circle of the camera. */
const ORBIT_TIME = 420;

const urlSeed = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('seed');
const pickedSeed = urlSeed ?? String(Math.floor(Math.random() * 1e6));

/** The seed the start screen opens with (the URL's, or a random one picked once per page). */
export function menuSeedText(): string {
  return pickedSeed;
}

let current: Backdrop | null = null;

/** Start the backdrop in `host` (the start screen's background layer). */
export function startBackdrop(host: HTMLElement, seed: number): void {
  if (current) return;
  current = new Backdrop(host, seed);
}

/** Show the skyline of another seed (a short fade, debounced while the seed is being typed). */
export function setBackdropSeed(seed: number): void {
  current?.setSeed(seed);
}

/** Pause while something covers the whole start screen (the character creator). */
export function holdBackdrop(on: boolean): void {
  current?.hold(on);
}

/** Stop for good and give the GPU context back (the city is starting). */
export function stopBackdrop(): void {
  current?.dispose();
  current = null;
}

class Backdrop {
  private canvas = document.createElement('canvas');
  private gl: WebGL2RenderingContext | null;
  private progs: Record<'sky' | 'ground' | 'bld' | 'light', { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }> | null = null;
  private vaos: WebGLVertexArrayObject[] = [];
  private bufs: WebGLBuffer[] = [];
  private boxBuf: WebGLBuffer | null = null;
  private lightBuf: WebGLBuffer | null = null;
  private sky: Skyline;
  private seed: number;
  private nextSeed: number | null = null;
  private seedTimer = 0;
  private raf = 0;
  private held = false;
  private last = 0;
  private time: number;
  private fade = 0;
  private fadeTo = 1;
  private scale = 1;
  private slow = 0;
  private frames = 0;
  private mouse = [0, 0];
  private lean = [0, 0];
  private still = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  private onMove = (e: PointerEvent): void => { this.mouse = [e.clientX / innerWidth * 2 - 1, e.clientY / innerHeight * 2 - 1]; };
  private onResize = (): void => { if (this.still) this.draw(); };

  constructor(private host: HTMLElement, seed: number) {
    this.seed = seed;
    this.time = 40 + (seed % 1000) * 0.37;
    this.sky = buildSkyline(seed);
    this.canvas.className = 'menu-3d';
    this.gl = this.canvas.getContext('webgl2', { antialias: true, alpha: false, depth: true, powerPreference: 'default' });
    if (!this.gl || !this.init()) { this.fallback(); return; }
    host.appendChild(this.canvas);
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.fallback(); });
    addEventListener('pointermove', this.onMove);
    addEventListener('resize', this.onResize);
    this.raf = requestAnimationFrame(this.frame);
  }

  private fallback(): void {
    cancelAnimationFrame(this.raf);
    this.host.classList.add('still');
    this.canvas.remove();
    this.gl = null;
  }

  private init(): boolean {
    const gl = this.gl!;
    const sky = program(gl, S.SKY_VS, S.SKY_FS);
    const ground = program(gl, S.GROUND_VS, S.GROUND_FS(PITCH, BLOCK_HALF, REACH));
    const bld = program(gl, S.BUILDING_VS, S.BUILDING_FS);
    const light = program(gl, S.LIGHT_VS, S.LIGHT_FS);
    if (!sky || !ground || !bld || !light) return false;
    const names = ['u_time', 'u_cam', 'u_sun', 'u_fade', 'u_viewProj', 'u_fwd', 'u_right', 'u_up', 'u_pxScale'];
    const wrap = (p: WebGLProgram) => ({ p, u: Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)])) });
    this.progs = { sky: wrap(sky), ground: wrap(ground), bld: wrap(bld), light: wrap(light) };

    // Sky: no vertex data (the shader makes its triangle from the vertex index).
    this.vaos.push(gl.createVertexArray()!);
    // Ground: one big square.
    const gv = gl.createVertexArray()!;
    gl.bindVertexArray(gv);
    const G = 6000;
    this.buffer(new Float32Array([-G, -G, -G, G, G, -G, G, G]));
    this.attrib(ground, 'a_pos', 2, 8, 0);
    this.vaos.push(gv);
    // Buildings: a box without a floor, one instance per box.
    const bv = gl.createVertexArray()!;
    gl.bindVertexArray(bv);
    this.buffer(boxMesh());
    this.attrib(bld, 'a_pos', 3, 24, 0);
    this.attrib(bld, 'a_norm', 3, 24, 12);
    this.boxBuf = this.buffer(this.sky.boxes);
    this.attrib(bld, 'a_box', 4, BOX_FLOATS * 4, 0, 1);
    this.attrib(bld, 'a_box2', 4, BOX_FLOATS * 4, 16, 1);
    this.vaos.push(bv);
    // Lights: points, moved by the shader.
    const lv = gl.createVertexArray()!;
    gl.bindVertexArray(lv);
    this.lightBuf = this.buffer(this.sky.lights);
    this.attrib(light, 'a_p', 4, LIGHT_FLOATS * 4, 0);
    this.attrib(light, 'a_q', 4, LIGHT_FLOATS * 4, 16);
    this.vaos.push(lv);
    gl.bindVertexArray(null);
    return true;
  }

  private buffer(data: Float32Array): WebGLBuffer {
    const gl = this.gl!;
    const b = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.bufs.push(b);
    return b;
  }

  private attrib(p: WebGLProgram, name: string, size: number, stride: number, offset: number, divisor = 0): void {
    const gl = this.gl!;
    const loc = gl.getAttribLocation(p, name);
    if (loc < 0) return;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
    gl.vertexAttribDivisor(loc, divisor);
  }

  setSeed(seed: number): void {
    if (!this.gl || seed === (this.nextSeed ?? this.seed)) return;
    this.nextSeed = seed;
    clearTimeout(this.seedTimer);
    this.seedTimer = window.setTimeout(() => { this.fadeTo = 0; if (this.still) this.swapSeed(); }, 280);
  }

  private swapSeed(): void {
    const gl = this.gl;
    if (!gl || this.nextSeed === null) return;
    this.seed = this.nextSeed;
    this.nextSeed = null;
    this.sky = buildSkyline(this.seed);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.boxBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.sky.boxes, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lightBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.sky.lights, gl.STATIC_DRAW);
    this.fadeTo = 1;
    if (this.still) { this.fade = 1; this.draw(); }
  }

  hold(on: boolean): void {
    if (!this.gl || on === this.held) return;
    this.held = on;
    cancelAnimationFrame(this.raf);
    if (!on) { this.last = 0; this.raf = requestAnimationFrame(this.frame); }
  }

  private frame = (now: number): void => {
    if (!this.gl || this.held) return;
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.1) : 0;
    this.last = now;
    if (!this.still) this.time += dt;
    // Fades: out when the seed changes, swap the city at black, back in.
    const rate = this.fadeTo > this.fade ? 1.6 : 4;
    this.fade = this.still ? this.fadeTo : this.fade + Math.sign(this.fadeTo - this.fade) * Math.min(Math.abs(this.fadeTo - this.fade), rate * dt);
    if (this.fadeTo === 0 && this.fade === 0) this.swapSeed();
    // A slow graphics card: render fewer pixels rather than stutter (judged after the start-up frames).
    if (dt > 0 && ++this.frames > 30) {
      this.slow = this.slow * 0.95 + (dt > 1 / 40 ? 1 : 0) * 0.05;
      if (this.slow > 0.6 && this.scale > 0.5) { this.scale *= 0.8; this.slow = 0; }
    }
    this.draw();
    if (this.frames === 2) this.canvas.classList.add('shown');
    if (!this.still || this.fade !== this.fadeTo) this.raf = requestAnimationFrame(this.frame);
  };

  private draw(): void {
    const gl = this.gl!;
    const P = this.progs!;
    const dpr = Math.min(devicePixelRatio || 1, 1.5) * this.scale;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr)), h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.viewport(0, 0, w, h);

    // Camera: circling downtown, rising and sinking a little, leaning towards the mouse.
    const t = this.time;
    for (let i = 0; i < 2; i++) this.lean[i] += (this.mouse[i] - this.lean[i]) * Math.min(1, 0.025 * (this.still ? 40 : 1));
    const a = (t / ORBIT_TIME) * Math.PI * 2 + this.lean[0] * 0.05;
    const r = ORBIT_R + Math.sin(t * 0.031) * 40;
    const eye: Vec3 = [Math.cos(a) * r, 150 + Math.sin(t * 0.047) * 30 - this.lean[1] * 10, Math.sin(a) * r];
    const look: Vec3 = [Math.cos(a + 2.5) * 90, 55 + Math.sin(t * 0.06) * 12 - this.lean[1] * 30, Math.sin(a + 2.5) * 90];
    const aspect = w / h;
    // Portrait screens see a wider angle so the towers still fit.
    const fovY = (aspect < 1 ? 62 : 48) * Math.PI / 180;
    const fwd = norm(sub(look, eye));
    const right = norm(cross(fwd, [0, 1, 0]));
    const up = cross(right, fwd);
    const ty = Math.tan(fovY / 2), tx = ty * aspect;
    const viewProj = mul(perspective(fovY, aspect, 3, 7000), lookAt(eye, right, up, fwd));

    const set = (p: { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }): void => {
      gl.useProgram(p.p);
      gl.uniform1f(p.u.u_time, t);
      gl.uniform3fv(p.u.u_cam, eye);
      gl.uniform3fv(p.u.u_sun, SUN);
      gl.uniform1f(p.u.u_fade, this.fade);
      gl.uniformMatrix4fv(p.u.u_viewProj, false, viewProj);
    };

    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(true);
    set(P.sky);
    gl.uniform3fv(P.sky.u.u_fwd, fwd);
    gl.uniform3fv(P.sky.u.u_right, right.map((x) => x * tx));
    gl.uniform3fv(P.sky.u.u_up, up.map((x) => x * ty));
    gl.bindVertexArray(this.vaos[0]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    set(P.ground);
    gl.bindVertexArray(this.vaos[1]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    set(P.bld);
    gl.bindVertexArray(this.vaos[2]);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 30, this.sky.boxCount);

    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    set(P.light);
    gl.uniform1f(P.light.u.u_pxScale, h / (2 * ty));
    gl.bindVertexArray(this.vaos[3]);
    gl.drawArrays(gl.POINTS, 0, this.sky.lightCount);
    gl.depthMask(true);
    gl.bindVertexArray(null);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.seedTimer);
    removeEventListener('pointermove', this.onMove);
    removeEventListener('resize', this.onResize);
    const gl = this.gl;
    if (gl) {
      for (const v of this.vaos) gl.deleteVertexArray(v);
      for (const b of this.bufs) gl.deleteBuffer(b);
      if (this.progs) for (const p of Object.values(this.progs)) gl.deleteProgram(p.p);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.gl = null;
    this.canvas.remove();
  }
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram | null {
  const p = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    gl.attachShader(p, s);
    gl.deleteShader(s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.warn('[backdrop] shader:', gl.getProgramInfoLog(p));
    return null;
  }
  return p;
}

/** Unit box (x, z in ±0.5, y in 0..1) without its floor, as position + normal per vertex. */
function boxMesh(): Float32Array {
  const out: number[] = [];
  const quad = (n: Vec3, c: Vec3[]): void => {
    for (const i of [0, 1, 2, 0, 2, 3]) out.push(...c[i], ...n);
  };
  quad([0, 0, 1], [[-0.5, 0, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5]]);
  quad([0, 0, -1], [[0.5, 0, -0.5], [-0.5, 0, -0.5], [-0.5, 1, -0.5], [0.5, 1, -0.5]]);
  quad([1, 0, 0], [[0.5, 0, 0.5], [0.5, 0, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5]]);
  quad([-1, 0, 0], [[-0.5, 0, -0.5], [-0.5, 0, 0.5], [-0.5, 1, 0.5], [-0.5, 1, -0.5]]);
  quad([0, 1, 0], [[-0.5, 1, 0.5], [0.5, 1, 0.5], [0.5, 1, -0.5], [-0.5, 1, -0.5]]);
  return new Float32Array(out);
}

function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a: Vec3, b: Vec3): Vec3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a: Vec3): Vec3 { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

function perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

/** View matrix from the camera's position and its (orthonormal) right, up and forward axes. */
function lookAt(eye: Vec3, r: Vec3, u: Vec3, f: Vec3): Float32Array {
  const d = (a: Vec3): number => a[0] * eye[0] + a[1] * eye[1] + a[2] * eye[2];
  return new Float32Array([r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0, -d(r), -d(u), d(f), 1]);
}

/** Column-major a × b. */
function mul(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
