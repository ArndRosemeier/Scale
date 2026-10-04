/**
 * Skinned bodies of segmented creatures (THREATS_PLAN §4.3): one continuous, closed skin per
 * creature kind (`skin.ts`: the body lofted from snout to tail tip, jaw, legs, feet, plates,
 * built around the rig's bind pose), drawn as a THREE.SkinnedMesh whose bone matrices come straight
 * from the rig (`CreatureRig.boneFrames` × the inverse bind frames), so the GPU deforms it — no
 * gaps between parts in any pose, one draw call (+ its shadow) per creature.
 *
 * ONE material for every creature: dark scaly hide (vertex colours; a generated tileable scale
 * texture for the normal, roughness and crevice occlusion), a paler banded belly; emissive only
 * where the vertex `glow` mask says — the dorsal plates lighting up tail-to-head before the breath,
 * the throat and mouth while charging, the eyes. The per-creature glow levels (and wet skin) ride in
 * bone 0 of its bone texture, so creatures share the material and its program. The meshes are in
 * the scene from the start and a speck of one is drawn during the start-up warm-up, so the program
 * and its skinned shadow-depth variant compile behind the loading screen.
 */
import * as THREE from 'three';
import { CreatureRig, type RigDef } from './CreatureRig';
import { boneLayout, buildCreatureSkin, type BoneLayout } from './skin';

/** Generated scale textures: tangent-space normals, and (R) crevice occlusion / (G) roughness. */
function scaleTextures(): { normal: THREE.DataTexture; orm: THREE.DataTexture } {
  const S = 256, C = 10; // texels, scale cells across the tile
  const h = new Float32Array(S * S);
  // Jittered cell centres (wrapping): each scale is a low dome with a crease round it.
  const pts: number[] = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let j = 0; j < C; j++) for (let i = 0; i < C; i++) pts.push((i + 0.15 + rnd() * 0.7) / C, (j + 0.15 + rnd() * 0.7) / C, 0.75 + rnd() * 0.5);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    const ci = Math.floor(u * C), cj = Math.floor(v * C);
    let d1 = 9, d2 = 9, k1 = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = (ci + di + C) % C, jj = (cj + dj + C) % C, k = (jj * C + ii) * 3;
      // The neighbour's centre, shifted by a whole tile where the index wrapped.
      const px = pts[k] + Math.floor((ci + di) / C), py = pts[k + 1] + Math.floor((cj + dj) / C);
      const d = Math.hypot((px - u) * C, (py - v) * C);
      if (d < d1) { d2 = d1; d1 = d; k1 = k; } else if (d < d2) d2 = d;
    }
    const edge = Math.min(1, (d2 - d1) * 2.2);
    const dome = 1 - Math.min(1, d1 * 0.9) ** 2;
    h[y * S + x] = Math.sqrt(edge) * (0.55 + 0.45 * dome) * pts[k1 + 2];
  }
  const nd = new Uint8Array(S * S * 4), od = new Uint8Array(S * S * 4);
  const at = (x: number, y: number) => h[((y + S) % S) * S + ((x + S) % S)];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * 3.2, dy = (at(x, y + 1) - at(x, y - 1)) * 3.2;
    const l = Math.hypot(dx, dy, 1);
    const o = (y * S + x) * 4;
    nd[o] = Math.round((-dx / l * 0.5 + 0.5) * 255); nd[o + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255); nd[o + 2] = Math.round((1 / l * 0.5 + 0.5) * 255); nd[o + 3] = 255;
    const hv = h[y * S + x];
    od[o] = Math.round((0.45 + 0.55 * Math.min(1, hv * 1.4)) * 255);
    od[o + 1] = Math.round((0.95 - 0.3 * Math.min(1, hv)) * 255);
    od[o + 2] = 0; od[o + 3] = 255;
  }
  const mk = (d: Uint8Array) => {
    const t = new THREE.DataTexture(d, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { normal: mk(nd), orm: mk(od) };
}

/** The shared creature material (opaque, depth-writing, front faces of closed surfaces). */
export function createCreatureMaterial(): THREE.MeshStandardMaterial {
  const tx = scaleTextures();
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 1, metalness: 0, envMapIntensity: 0.45,
    normalMap: tx.normal, normalScale: new THREE.Vector2(1.1, 1.1), roughnessMap: tx.orm, aoMap: tx.orm, aoMapIntensity: 0.9,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 glow;\nvarying vec3 vGlow;\nvarying float vWet;')
      .replace('#include <skinning_vertex>', `#include <skinning_vertex>
      #ifdef USE_SKINNING
      {
        // Bone 0 holds this creature's glow levels: ridge, throat, eyes, wet.
        mat4 gp = getBoneMatrix( 0.0 );
        float ridge = gp[0][0], throat = gp[0][1], eyes = gp[0][2];
        // The ridge lights up as a wave from the tail to the head.
        float gl = clamp( ridge * 1.6 - ( 1.0 - glow.y ) * 0.6, 0.0, 1.0 );
        vGlow = vec3( 0.6, 1.4, 3.2 ) * 4.0 * gl * gl * glow.x + vec3( 0.9, 1.8, 3.6 ) * throat * glow.z + vec3( 3.2, 1.6, 0.3 ) * eyes * glow.w;
        vWet = gp[0][3];
      }
      #else
      vGlow = vec3( 0.0 ); vWet = 0.0;
      #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGlow;\nvarying float vWet;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix( roughnessFactor, roughnessFactor * 0.45, vWet );')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlow;');
  };
  m.customProgramCacheKey = () => 'creature-skin-v1';
  return m;
}

interface Slot { mesh: THREE.SkinnedMesh; skeleton: THREE.Skeleton }
interface Kind { def: RigDef; L: BoneLayout; geo: THREE.BufferGeometry; bindInv: THREE.Matrix4[]; slots: Slot[]; used: number }

const _f = new THREE.Matrix4();

export class CreatureMesh {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private kinds = new Map<RigDef, Kind>();
  private frames = new Float32Array(0);
  /** Vertices per kind (debug). */
  readonly stats: { kind: string; vertices: number; triangles: number }[] = [];

  /** `kinds`: a creature definition and how many of it can be drawn at once. */
  constructor(kinds: { def: RigDef; count: number; name?: string }[]) {
    this.material = createCreatureMaterial();
    this.group.name = 'creatures';
    for (const k of kinds) this.kind(k.def, k.count, k.name ?? 'creature');
  }

  private kind(def: RigDef, count: number, name: string): Kind {
    let K = this.kinds.get(def);
    if (K) return K;
    const L = boneLayout(def);
    // The bind pose: the rig standing still on flat ground at the origin, settled.
    const rig = new CreatureRig(def);
    rig.still = true;
    rig.place();
    for (let i = 0; i < 90; i++) rig.update(0.05, 0);
    const bind = new Float32Array(L.count * 16);
    rig.boneFrames(bind, L);
    const sk = buildCreatureSkin(def, L, { frames: bind, spine: rig.spine, neck: rig.neck, tail: rig.tail, legs: rig.legs });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(sk.position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(sk.normal, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(sk.uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(sk.color, 3));
    geo.setAttribute('glow', new THREE.BufferAttribute(sk.glow, 4));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(sk.skinIndex, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sk.skinWeight, 4));
    geo.setIndex(new THREE.BufferAttribute(sk.index, 1));
    geo.computeBoundingSphere();
    const bindInv: THREE.Matrix4[] = [];
    for (let b = 0; b < L.count; b++) bindInv.push(b === 0 ? new THREE.Matrix4() : new THREE.Matrix4().fromArray(bind, b * 16).invert());
    K = { def, L, geo, bindInv, slots: [], used: 0 };
    for (let i = 0; i < count; i++) {
      const bones: THREE.Bone[] = [];
      for (let b = 0; b < L.count; b++) bones.push(new THREE.Bone());
      const skeleton = new THREE.Skeleton(bones);
      skeleton.computeBoneTexture();
      // Bone matrices are written directly (draw); the renderer's per-frame update only uploads.
      skeleton.update = () => { if (skeleton.boneTexture) skeleton.boneTexture.needsUpdate = true; };
      const mesh = new THREE.SkinnedMesh(geo, this.material);
      mesh.bind(skeleton, new THREE.Matrix4());
      mesh.name = `${name}:${i}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      // Culled against a sphere round the posed body (set in draw); never ray-cast vertex by vertex.
      mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
      mesh.raycast = () => {};
      this.group.add(mesh);
      K.slots.push({ mesh, skeleton });
    }
    this.kinds.set(def, K);
    if (this.frames.length < L.count * 16) this.frames = new Float32Array(L.count * 16);
    this.stats.push({ kind: name, vertices: sk.position.length / 3, triangles: sk.index.length / 3 });
    return K;
  }

  begin(): void { for (const K of this.kinds.values()) K.used = 0; }

  /** Pose a creature (its rig moved this frame) in the next free body of its kind; 0 when none is free. */
  draw(rig: CreatureRig): number {
    const K = this.kinds.get(rig.def) ?? this.kind(rig.def, 2, 'creature');
    if (K.used >= K.slots.length) return 0;
    const slot = K.slots[K.used++];
    const F = this.frames;
    rig.boneFrames(F, K.L);
    this.pose(K, slot, F, rig.ridge, rig.throat, rig.eyes, rig.wet);
    // Cull against the body's capsules (the posed skin stays within them plus the plates and horns).
    const C = rig.caps;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const c of C) {
      x0 = Math.min(x0, c.ax - c.r, c.bx - c.r); y0 = Math.min(y0, c.ay - c.r, c.by - c.r); z0 = Math.min(z0, c.az - c.r, c.bz - c.r);
      x1 = Math.max(x1, c.ax + c.r, c.bx + c.r); y1 = Math.max(y1, c.ay + c.r, c.by + c.r); z1 = Math.max(z1, c.az + c.r, c.bz + c.r);
    }
    for (const L of rig.legs) { y0 = Math.min(y0, L.foot.y); }
    const bs = slot.mesh.boundingSphere!;
    if (C.length) {
      bs.center.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      bs.radius = Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 + 12 * rig.scale;
    } else { bs.center.set(rig.x, 0, rig.z); bs.radius = 1e4; }
    return 1;
  }

  /**
   * During the start-up warm-up: one body, shrunk to a speck at (x, y, z), so the program and its
   * shadow variant compile behind the loading screen.
   */
  warm(x: number, y: number, z: number): void {
    const K = this.kinds.values().next().value;
    if (!K || K.used >= K.slots.length) return;
    const slot = K.slots[K.used++];
    const M = slot.skeleton.boneMatrices!;
    _f.makeScale(1e-3, 1e-3, 1e-3).setPosition(x, y, z);
    for (let b = 1; b < K.L.count; b++) _f.toArray(M, b * 16);
    M.fill(0, 0, 16);
    slot.mesh.visible = true;
    slot.mesh.boundingSphere!.center.set(x, y, z);
    slot.mesh.boundingSphere!.radius = 1;
  }

  private pose(K: Kind, slot: Slot, F: Float32Array, ridge: number, throat: number, eyes: number, wet: number): void {
    const M = slot.skeleton.boneMatrices!;
    for (let b = 1; b < K.L.count; b++) {
      _f.fromArray(F, b * 16).multiply(K.bindInv[b]);
      _f.toArray(M, b * 16);
    }
    M.fill(0, 0, 16);
    M[0] = ridge; M[1] = throat; M[2] = eyes; M[3] = wet;
    slot.mesh.visible = true;
  }

  end(): void {
    for (const K of this.kinds.values()) for (let i = 0; i < K.slots.length; i++) K.slots[i].mesh.visible = i < K.used;
  }

  /** Bodies drawn last frame (debug). */
  get count(): number { let n = 0; for (const K of this.kinds.values()) n += K.used; return n; }
}
