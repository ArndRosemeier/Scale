/**
 * Instanced parts of segmented creatures (THREATS_PLAN §4.3): a handful of procedural shapes —
 * a spindle (torso, neck, tail and limb segments), a dorsal plate, a head, a jaw and a clawed
 * foot — each one InstancedMesh in ONE shared material, so every creature (the Strider now, later
 * the Burrower, tentacles, tripod legs) costs a few draw calls and no new shader program.
 *
 * Vertex attributes: colour (dark hide, paler belly, bone plates: baked with a little noise) and
 * `aGlow` (where a part can glow: eyes, the throat under the jaw and neck, plate crests). Instance
 * attribute `iGlow` (linear RGB): the glow's colour × strength for that part this frame — throat
 * charging, ridge lighting up before the breath, eyes. Owners fill the batch every frame (begin →
 * push → end); the meshes live in the scene from the start, so the warm-up compiles the program.
 */
import * as THREE from 'three';

export const enum Shape { Spindle = 0, Plate = 1, Head = 2, Jaw = 3, Foot = 4 }
export const SHAPES = 5;

const HIDE = new THREE.Color(0.016, 0.019, 0.017), HIDE2 = new THREE.Color(0.032, 0.03, 0.022), BELLY = new THREE.Color(0.09, 0.075, 0.055);
const BONE = new THREE.Color(0.09, 0.085, 0.075), CLAW = new THREE.Color(0.02, 0.018, 0.016), EYE = new THREE.Color(0.9, 0.55, 0.12);

/** Cheap hash noise for baked colour variation. */
function hn(x: number, y: number, z: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

/** Write colour and glow attributes from a per-vertex function. */
function paint(g: THREE.BufferGeometry, fn: (x: number, y: number, z: number, nx: number, ny: number, nz: number, c: THREE.Color) => number): THREE.BufferGeometry {
  const P = g.getAttribute('position'), N = g.getAttribute('normal');
  const col = new Float32Array(P.count * 3), glow = new Float32Array(P.count);
  const c = new THREE.Color();
  for (let i = 0; i < P.count; i++) {
    glow[i] = fn(P.getX(i), P.getY(i), P.getZ(i), N.getX(i), N.getY(i), N.getZ(i), c);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aGlow', new THREE.BufferAttribute(glow, 1));
  return g;
}

/**
 * Spindle along +Y from 0 to 1, radius 1 in X and Z at its fattest (blunt ends overlap the next
 * segment). +Z is the creature's back (dark, ridged), −Z its belly (pale; the throat can glow there).
 */
function spindle(): THREE.BufferGeometry {
  const prof: THREE.Vector2[] = [];
  const n = 10;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // Nearly cylindrical, rounded at the ends: chained segments read as one body, not beads.
    const r = 0.3 + 0.7 * Math.pow(Math.sin(Math.PI * (0.04 + 0.92 * t)), 0.3);
    prof.push(new THREE.Vector2(r, t * 1.1 - 0.05));
  }
  const g = new THREE.LatheGeometry(prof, 12);
  g.computeVertexNormals();
  return paint(g, (x, y, z, _nx, _ny, nz, c) => {
    const n1 = hn(Math.round(x * 6), Math.round(y * 9), Math.round(z * 6));
    // Back: dark with faint bands; belly: paler, in segments.
    const belly = Math.max(0, Math.min(1, (-nz - 0.15) * 2));
    c.copy(HIDE).lerp(HIDE2, n1 * 0.6 + 0.2 * Math.sin(y * 18) ** 2).lerp(BELLY, belly * (0.8 + 0.2 * Math.sin(y * 24)));
    return belly;
  });
}

/** Dorsal plate: a thick leaf in the YZ plane (Y up from its root at 0 to the tip at 1, Z along the spine). */
function plate(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.5, 0);
  s.quadraticCurveTo(-0.45, 0.55, -0.08, 1);
  s.quadraticCurveTo(0.25, 0.6, 0.5, 0);
  s.lineTo(-0.5, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.1, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.03, bevelSegments: 1, curveSegments: 6 });
  // Shape x → Z (along the spine), y → Y, extrusion → X (thickness), centred.
  g.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, -0.05, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1));
  g.computeVertexNormals();
  return paint(g, (x, y, z, _nx, _ny, _nz, c) => {
    c.copy(BONE).lerp(HIDE, 0.5 - y * 0.4).multiplyScalar(0.85 + 0.3 * hn(Math.round(z * 8), Math.round(y * 8), x));
    // The crest glows (edges and the upper half).
    return Math.max(0, Math.min(1, (y - 0.3) * 1.6));
  });
}

/**
 * Head: from the back of the skull at z = 0 to the snout at z = 1 (+Z forward), about 0.5 wide and
 * 0.4 high (scaled per instance), flat-topped with brow ridges; two glowing eyes.
 */
function head(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(0.5, 16, 12);
  g.translate(0, 0, 0.5);
  const P = g.getAttribute('position');
  for (let i = 0; i < P.count; i++) {
    let x = P.getX(i), y = P.getY(i);
    const z = P.getZ(i);
    // Taper towards the snout, flatter on top, a heavy brow over the eyes.
    const taper = 1 - 0.55 * Math.max(0, z - 0.35) / 0.65;
    x *= taper * 1.0; y *= taper * (y > 0 ? 0.62 : 0.5);
    if (y > 0) y += 0.06 * Math.exp(-((z - 0.42) ** 2) / 0.01) * Math.min(1, Math.abs(x) * 6);
    P.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  const eyes: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    const e = new THREE.SphereGeometry(0.055, 8, 6);
    e.translate(sx * 0.2, 0.12, 0.4);
    eyes.push(e);
  }
  const base = paint(g, (x, y, z, _nx, _ny, _nz, c) => {
    c.copy(HIDE).lerp(HIDE2, hn(Math.round(x * 14), Math.round(y * 14), Math.round(z * 14)) * 0.7).lerp(BELLY, Math.max(0, -y * 3) * 0.6);
    return 0;
  });
  const parts = [base, ...eyes.map((e) => paint(e, (_x, _y, _z, _a, _b, _c, c) => { c.copy(EYE); return 1; }))];
  return merge(parts);
}

/** Lower jaw: hinge at z = 0, forward to z = 0.9; its underside (the throat) can glow. */
function jaw(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(0.5, 14, 8, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5);
  g.translate(0, 0, 0.5);
  const P = g.getAttribute('position');
  for (let i = 0; i < P.count; i++) {
    const z = P.getZ(i);
    const taper = 1 - 0.6 * Math.max(0, z - 0.3) / 0.7;
    P.setXYZ(i, P.getX(i) * taper * 0.9, P.getY(i) * taper * 0.55, z * 0.9);
  }
  g.computeVertexNormals();
  return paint(g, (x, y, z, _nx, ny, _nz, c) => {
    c.copy(BELLY).lerp(HIDE, 0.4 + 0.3 * hn(Math.round(x * 10), Math.round(y * 10), Math.round(z * 10)));
    return Math.max(0, Math.min(1, -ny * 1.4)) * Math.max(0, 1 - z * 0.9);
  });
}

/** Foot: a flat pad from the heel (z = 0) forward to z = 1 with three claws (+Z forward, Y up from the sole). */
function foot(): THREE.BufferGeometry {
  const pad = new THREE.SphereGeometry(0.5, 12, 8);
  pad.scale(1, 0.55, 1);
  pad.translate(0, 0.27, 0.45);
  const parts: THREE.BufferGeometry[] = [paint(pad, (x, y, z, _a, _b, _c, c) => { c.copy(HIDE).lerp(HIDE2, hn(Math.round(x * 9), Math.round(y * 9), Math.round(z * 9)) * 0.6); return 0; })];
  for (const sx of [-0.32, 0, 0.32]) {
    const cl = new THREE.ConeGeometry(0.09, 0.42, 6);
    cl.rotateX(Math.PI / 2 + 0.35);
    cl.translate(sx, 0.12, 0.98);
    parts.push(paint(cl, (_x, _y, _z, _a, _b, _c, c) => { c.copy(CLAW); return 0; }));
  }
  return merge(parts);
}

/** Merge non-indexed copies (attributes position, normal, color, aGlow). */
function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = list.map((g) => (g.index ? g.toNonIndexed() : g));
  let n = 0;
  for (const g of flat) n += g.getAttribute('position').count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3), glo = new Float32Array(n);
  let o = 0;
  for (const g of flat) {
    const c = g.getAttribute('position').count;
    pos.set(g.getAttribute('position').array as Float32Array, o * 3);
    nor.set(g.getAttribute('normal').array as Float32Array, o * 3);
    col.set(g.getAttribute('color').array as Float32Array, o * 3);
    glo.set(g.getAttribute('aGlow').array as Float32Array, o);
    o += c;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aGlow', new THREE.BufferAttribute(glo, 1));
  return g;
}

/** The shared creature material: vertex-coloured hide, emissive where aGlow × iGlow. */
export function createCreatureMaterial(): THREE.MeshStandardMaterial {
  // A dark, matte hide: little sky reflection, so the silhouette stays dark against the sky.
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.0, envMapIntensity: 0.35 });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nattribute vec3 iGlow;\nvarying vec3 vGlow;\nvarying float vRidge;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = iGlow * aGlow;\nvRidge = position.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGlow;\nvarying float vRidge;')
      // Wet, scaly sheen: rougher in the folds.
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor - 0.12 * fract(vRidge * 37.0), 0.3, 1.0);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlow;');
  };
  m.customProgramCacheKey = () => 'creature-v1';
  return m;
}

export class CreatureMesh {
  readonly group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private glow: THREE.InstancedBufferAttribute[] = [];
  private n = new Int32Array(SHAPES);
  readonly material: THREE.MeshStandardMaterial;

  /** `cap`: instances per shape (all creatures together). */
  constructor(cap: number[]) {
    this.material = createCreatureMaterial();
    const geos = [spindle(), plate(), head(), jaw(), foot()];
    for (let s = 0; s < SHAPES; s++) {
      const g = geos[s];
      g.computeBoundingSphere();
      const ga = new THREE.InstancedBufferAttribute(new Float32Array(cap[s] * 3), 3).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('iGlow', ga);
      const m = new THREE.InstancedMesh(g, this.material, cap[s]);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = true;
      m.receiveShadow = true;
      m.name = `creature:${s}`;
      this.meshes.push(m);
      this.glow.push(ga);
      this.group.add(m);
    }
  }

  begin(): void { this.n.fill(0); }

  /** One part this frame; false when that shape's batch is full. */
  push(shape: Shape, m: THREE.Matrix4, gr = 0, gg = 0, gb = 0): boolean {
    const mesh = this.meshes[shape], i = this.n[shape];
    if (i >= mesh.instanceMatrix.count) return false;
    mesh.setMatrixAt(i, m);
    this.glow[shape].setXYZ(i, gr, gg, gb);
    this.n[shape] = i + 1;
    return true;
  }

  end(): void {
    for (let s = 0; s < SHAPES; s++) {
      const mesh = this.meshes[s], n = this.n[s];
      mesh.count = n;
      if (n) { mesh.instanceMatrix.needsUpdate = true; this.glow[s].needsUpdate = true; }
    }
  }

  /** Parts drawn last frame (debug). */
  get count(): number { let n = 0; for (let s = 0; s < SHAPES; s++) n += this.n[s]; return n; }
}
