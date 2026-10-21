/**
 * A renderable person: an Actors character (body, skin, eyes, hair, beard, race add-ons and
 * fitted garments, with its own detail levels) under Scale's proxy skeleton (see
 * actors/rig.ts), with sockets for equipment and the hooks the game uses (sky visibility,
 * face, hiding).
 *
 * The proxy's rest frames carry no rotation (translation only, aligned with the model axes:
 * +Y up, the character faces −Z, its left is −X), which keeps procedural animation and IK
 * simple; the Actors skeleton follows it every frame (`sync`).
 */
import * as THREE from 'three';
import type { Character as ActorCharacter, CharacterPatch } from '@actors/generator';
import { EXPRESSIONS } from '@actors/human';
import { actors } from '../actors/service';
import { RigBridge, SCALE_BONES, actorBind, proxyRest } from '../actors/rig';
import { measureBody, type BodyData } from '../actors/body';
import { GAME_PATCH, appearancePatch, isActorLook, lookTraits, type Look, type LookTraits } from '../actors/config';
import { dressPlan, type DressPlan } from '../actors/outfit';
import type { EquipmentVisuals } from '../../items/types';
import { patchSkyOcclusion, type SkyVisPatch } from '../../render/skyOcclusion';
import { WEBGPU, gpuKit } from '../../render/gpuMode';

export type { BodyData };

/** Moods the animator shows (face units per mood; same unit names as Actors' expressions). */
export const MOODS: Record<string, [string, number][]> = {
  neutral: [],
  happy: [['mouth-corner-puller', 0.75], ['mouth-upward-retraction', 0.15], ['eye-left-slit', 0.25], ['eye-right-slit', 0.25], ['eyebrows-left-up', 0.1], ['eyebrows-right-up', 0.1]],
  angry: [['eyebrows-left-down', 0.9], ['eyebrows-right-down', 0.9], ['nose-left-elevation', 0.35], ['nose-right-elevation', 0.35], ['mouth-compression', 0.45], ['eye-left-slit', 0.25], ['eye-right-slit', 0.25], ['neck-platysma', 0.2]],
  sad: [['eyebrows-left-inner-up', 0.9], ['eyebrows-right-inner-up', 0.9], ['mouth-depression', 0.6], ['eye-left-slit', 0.15], ['eye-right-slit', 0.15], ['mouth-pursing', 0.1]],
  afraid: [['eyebrows-left-inner-up', 0.7], ['eyebrows-right-inner-up', 0.7], ['eyebrows-left-up', 0.45], ['eyebrows-right-up', 0.45], ['eye-left-opened-up', 0.7], ['eye-right-opened-up', 0.7], ['mouth-retraction', 0.45], ['mouth-open', 0.15], ['neck-platysma', 0.35]],
  surprised: [['eyebrows-left-up', 1], ['eyebrows-right-up', 1], ['eye-left-opened-up', 0.85], ['eye-right-opened-up', 0.85], ['mouth-open', 0.45]],
  disgusted: [['nose-left-elevation', 0.8], ['nose-right-elevation', 0.8], ['mouth-upward-retraction', 0.5], ['eyebrows-left-down', 0.4], ['eyebrows-right-down', 0.4], ['eye-left-slit', 0.3], ['eye-right-slit', 0.3], ['mouth-depression', 0.2]],
  focused: [['eyebrows-left-down', 0.35], ['eyebrows-right-down', 0.35], ['eye-left-slit', 0.2], ['eye-right-slit', 0.2], ['mouth-compression', 0.2]],
  pain: [['eye-left-closure', 0.55], ['eye-right-closure', 0.55], ['eyebrows-left-down', 0.5], ['eyebrows-right-down', 0.5], ['eyebrows-left-inner-up', 0.4], ['eyebrows-right-inner-up', 0.4], ['mouth-retraction', 0.7], ['mouth-open', 0.2], ['nose-left-elevation', 0.4], ['nose-right-elevation', 0.4], ['neck-platysma', 0.5]],
};
/** Mouth shape of a syllable (talking flaps the expression channel's weight). */
const TALK: [string, number][] = [['mouth-open', 0.5], ['mouth-pursing', 0.1], ['eyebrows-left-up', 0.1], ['eyebrows-right-up', 0.1]];
// Scale's faces as Actors expressions ("scale:<mood>" and "scale:<mood>:talk").
for (const [m, units] of Object.entries(MOODS)) {
  EXPRESSIONS[`scale:${m}`] = Object.fromEntries(units);
  EXPRESSIONS[`scale:${m}:talk`] = Object.fromEntries([...units, ...TALK].map(([n, w]) => [n, Math.min(1, w + (units.find((u) => u[0] === n)?.[1] ?? 0))]));
}

export interface CharacterOptions {
  castShadow?: boolean;
  /** Build priority (lower = sooner). */
  priority?: number;
  /** Renderer for the photographic skin (the hero; city people use a procedural skin). */
  renderer?: unknown;
}

const _m = new THREE.Matrix4(), _inv = new THREE.Matrix4();
/**
 * Garment layering on a reversed float depth buffer. Actors lifts each clothing layer above the
 * one below with a polygon offset; with Scale's reversed-Z float depth the slope term of that
 * offset loses fragments of thin seam triangles (pinholes through which the street shows). The
 * garment is instead pulled toward the camera in view space by a fixed distance at the same
 * screen position: `LAYER_PULL` metres per rank of `garmentRank` (underwear lowest, then socks,
 * shoes, trousers, tops, then hats and glasses). The rank follows what the garment covers, not
 * Actors' layer number (which put trousers above T-shirts, so waistbands poked through shirt
 * hems), and the pull is a fixed distance, not a fraction of it (that grew to centimetres for
 * people a few dozen metres away).
 */
const LAYER_PULL = 0.001;
const RANK: Record<string, number> = { briefs: 1, bra: 1, legwear: 1, socks: 2, shoes: 3, top: 4, gloves: 5, bottom: 14, hat: 15, glasses: 15, mask: 15 };

/** Pull rank of a garment by what it covers (its highest layer); unknown meshes keep Actors' layer. */
function garmentRank(occupies: string[] | undefined, actorsLayer: number): number {
  if (!occupies?.length) return actorsLayer;
  return Math.max(...occupies.map((o) => RANK[o] ?? actorsLayer));
}

const layered = new WeakSet<THREE.Material>();

function viewSpaceLayer(m: THREE.Material, occupies: string[] | undefined): void {
  if (layered.has(m) || !m.polygonOffset || m.polygonOffsetFactor >= 0) return;
  layered.add(m);
  const pull = (garmentRank(occupies, -m.polygonOffsetFactor / 2) * LAYER_PULL).toFixed(6);
  // Node materials (WebGPU): the same through their clip-space output (webgpu/garmentLayers.ts).
  if (WEBGPU && (m as { isNodeMaterial?: boolean }).isNodeMaterial) { gpuKit().viewSpaceLayerNode(m, +pull); return; }
  m.polygonOffset = false;
  const prev = m.onBeforeCompile.bind(m);
  m.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>\ngl_Position = projectionMatrix * vec4( mvPosition.xyz * max( 1.0 - ${pull} / max( length( mvPosition.xyz ), 1e-3 ), 0.5 ), 1.0 );`);
  };
  const prevKey = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${prevKey()}|pull${pull}`;
  m.needsUpdate = true;
}

/** Skeletons whose bone matrices are already model-relative (see prepareMeshes). */
const relativeSkeletons = new WeakSet<THREE.Skeleton>();

/**
 * The Actors settings for a look and an outfit. A look from the generator (the hero) keeps its
 * own clothes unless the outfit brings clothes of its own (a costume); city people wear the outfit.
 */
export function lookPatch(look: Look, plan: DressPlan, hair: Set<string> | null, extra: { hideHair?: boolean; hideBeard?: boolean } = {}): CharacterPatch {
  const own = isActorLook(look);
  const base: CharacterPatch = own ? { ...look.actor } : appearancePatch(look, hair);
  const keep = own && !plan.soft;
  const p: CharacterPatch = {
    ...base, ...GAME_PATCH,
    outfit: keep ? base.outfit ?? [] : plan.garments,
    garmentColors: keep ? base.garmentColors ?? {} : { ...(base.garmentColors ?? {}), ...plan.colors },
  };
  if (extra.hideHair) p.hair = null;
  if (extra.hideBeard) p.beard = 'none';
  return p;
}

export class Character {
  readonly object = new THREE.Group();
  /** Inner group: animation root offsets (lean, hit recoil) are applied here. */
  readonly model = new THREE.Group();
  /** Scale's proxy skeleton (see actors/rig.ts). */
  readonly bones: THREE.Bone[] = [];
  readonly boneIndex = new Map<string, number>();
  readonly skeleton: THREE.Skeleton;
  readonly sockets = new Map<string, THREE.Object3D>();
  /** Eye pivots (children of the head bone, at the eyeballs' centres). */
  readonly eyes: THREE.Object3D[] = [];
  /** Rest-pose bone heads (model space). */
  readonly rest: THREE.Vector3[] = [];
  readonly body: BodyData;
  readonly traits: LookTraits;
  lod = 0;
  /** Half turn between Scale's facing (−Z) and the actor's (+Z). */
  private readonly flip = new THREE.Group();
  private bridge: RigBridge;
  private readonly skyPatches: SkyVisPatch[] = [];
  private readonly patched = new WeakSet<THREE.Material>();
  private skyVis = 1;
  private castShadow: boolean;
  private face = { key: 'scale:neutral', pending: false };
  private disposed = false;

  /** Builds a character for a look (and outfit); resolves once it is shaped and dressed. */
  static async load(look: Look, eq: EquipmentVisuals | undefined, opts: CharacterOptions = {}): Promise<Character> {
    const catalog = await actors.catalog();
    const traits = lookTraits(look);
    const avail = new Set(catalog.garments.map((g) => g.id));
    const plan = dressPlan(eq, traits.gender < 0.5, avail);
    const hair = new Set(catalog.hair.filter((h) => !h.credit).map((h) => h.id));
    const patch = lookPatch(look, plan, hair);
    const hero = isActorLook(look);
    const actor = await actors.character(patch, opts.priority ?? 0, hero ? { renderer: opts.renderer, catalog: (c) => c } : {});
    return new Character(actor, look, opts);
  }

  constructor(readonly actor: ActorCharacter, readonly look: Look, opts: CharacterOptions = {}) {
    this.traits = lookTraits(look);
    this.castShadow = opts.castShadow !== false;
    this.object.name = 'humanoid';
    this.object.add(this.model);
    this.flip.rotation.y = Math.PI;
    this.flip.add(actor.object);
    this.model.add(this.flip);
    actor.object.matrixWorldAutoUpdate = false;

    // ---- proxy skeleton on the actor's joints
    const skel = actor.actor.skeleton!;
    const ground = actor.object.position.y;
    const bind = actorBind(skel);
    const { heads, tails, extra } = proxyRest(skel, bind, ground);
    const all = [...SCALE_BONES.map(([name, parent], i) => ({ name, parent, head: heads[i] })), ...extra];
    all.forEach((d, i) => {
      const b = new THREE.Bone();
      b.name = d.name;
      const p = d.parent ? this.boneIndex.get(d.parent) ?? -1 : -1;
      const ph = p >= 0 ? all[p].head : new THREE.Vector3();
      b.position.copy(d.head).sub(ph);
      (p >= 0 ? this.bones[p] : this.model).add(b);
      this.bones.push(b);
      this.boneIndex.set(d.name, i);
      this.rest.push(d.head.clone());
    });
    this.skeleton = new THREE.Skeleton(this.bones);
    this.bridge = new RigBridge(this.bones, this.rest, skel, bind, () => this.actor.object.position.y);

    // ---- measurements and sockets
    const meshes = actor.actor.meshes;
    const bodyMesh = meshes.get('body') ?? meshes.get('body-low');
    if (!bodyMesh) throw new Error('actors: character has no body mesh');
    const app = isActorLook(look) ? null : look;
    this.body = measureBody(bodyMesh, meshes.get('eyes'), heads, tails, ground, {
      earPoint: app ? Math.max(0, app.face.earPoint) : 0,
      hasHorns: actor.config.horns !== 'none' && actor.config.hornSize > 0.05,
    });
    const headI = this.boneIndex.get('head')!;
    const e = this.body.eyes;
    for (let k = 0; k < 2; k++) {
      const pivot = new THREE.Object3D();
      pivot.position.set(e[k * 4] - this.rest[headI].x, e[k * 4 + 1] - this.rest[headI].y, e[k * 4 + 2] - this.rest[headI].z);
      this.bones[headI].add(pivot);
      this.eyes.push(pivot);
    }
    for (const [name, s] of Object.entries(this.body.sockets)) {
      const o = new THREE.Object3D();
      o.name = `socket:${name}`;
      const b = s.bone;
      o.position.set(s.pos[0] - this.rest[b].x, s.pos[1] - this.rest[b].y, s.pos[2] - this.rest[b].z);
      const B = s.basis;
      const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(B[0], B[1], B[2]), new THREE.Vector3(B[3], B[4], B[5]), new THREE.Vector3(B[6], B[7], B[8]));
      if (m.determinant() < 0) {
        // Reflection (see items' socket convention): rotation × scale(-1,1,1).
        m.makeBasis(new THREE.Vector3(-B[0], -B[1], -B[2]), new THREE.Vector3(B[3], B[4], B[5]), new THREE.Vector3(B[6], B[7], B[8]));
        o.scale.x = -1;
      }
      o.quaternion.setFromRotationMatrix(m);
      this.bones[b].add(o);
      this.sockets.set(name, o);
    }
    this.prepareMeshes();
    // Whatever moved the proxy (animator, ragdoll, IK) reaches the actor whenever matrices update.
    const model = this.model, self = this;
    model.updateMatrixWorld = function (force?: boolean) {
      THREE.Object3D.prototype.updateMatrixWorld.call(this, force);
      self.sync();
    };
    this.model.updateMatrixWorld(true);
  }

  /** Proxy bone by name. */
  bone(name: string): THREE.Bone {
    return this.bones[this.boneIndex.get(name)!];
  }

  /** The proxy pose onto the actor's bones (also run by every matrix update of the model). */
  sync(): void {
    if (this.disposed) return;
    const skel = this.actor.actor.skeleton;
    if (skel && skel !== this.bridge.skeleton) this.rebridge(skel);
    this.bridge.sync();
    const obj = this.actor.object;
    obj.updateMatrix();
    obj.matrixWorld.multiplyMatrices(this.flip.matrixWorld, obj.matrix);
    for (const c of obj.children) c.updateMatrixWorld(true);
  }

  /** Parts that add bones (a tail) replace the actor's skeleton: follow it. */
  private rebridge(skel: THREE.Skeleton): void {
    const bind = actorBind(skel);
    this.bridge = new RigBridge(this.bones, this.rest, skel, bind, () => this.actor.object.position.y);
    this.prepareMeshes();
  }

  /**
   * Per-frame actor work after the pose: pending visibility, crowd mesh, skirt colliders, and
   * newly made meshes (an outfit change) get the game's material patches.
   */
  update(dt: number): void {
    this.actor.actor.update(dt);
    this.prepareMeshes();
  }

  /**
   * Every actor mesh: model-relative bone matrices (three uploads them as 32-bit floats;
   * kilometres from the origin that made hands shimmer), sky visibility, shadows.
   */
  private occupiesBy: Map<string, string[]> | null = null;
  /** What each garment covers (catalog), by garment id. */
  private occupies(): Map<string, string[]> {
    return this.occupiesBy ??= new Map(this.actor.catalog.garments.map((g) => [g.id, g.occupies]));
  }

  private prepareMeshes(): void {
    const actorObj = this.actor.object;
    const skel = this.actor.actor.skeleton;
    if (skel && !relativeSkeletons.has(skel)) {
      relativeSkeletons.add(skel);
      skel.update = () => {
        _inv.copy(actorObj.matrixWorld).invert();
        for (let i = 0; i < skel.bones.length; i++) {
          _m.multiplyMatrices(_inv, skel.bones[i].matrixWorld).multiply(skel.boneInverses[i]);
          _m.toArray(skel.boneMatrices!, i * 16);
        }
        if (skel.boneTexture) skel.boneTexture.needsUpdate = true;
      };
    }
    for (const o of actorObj.children) {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) continue;
      if (!mesh.userData.modelRelative) {
        mesh.userData.modelRelative = true;
        mesh.updateMatrixWorld = function (force?: boolean) {
          THREE.Mesh.prototype.updateMatrixWorld.call(this, force);
          this.bindMatrixInverse.copy(this.matrixWorld).invert().multiply(actorObj.matrixWorld);
        };
        mesh.castShadow = this.castShadow && !(mesh.material as THREE.Material).transparent;
      }
      const occupies = this.occupies().get(mesh.name);
      for (const m of ([] as THREE.Material[]).concat(mesh.material)) {
        viewSpaceLayer(m, occupies);
        if (this.patched.has(m)) continue;
        this.patched.add(m);
        const p = patchSkyOcclusion(m, 'uniform', this.skyVis);
        this.skyPatches.push(p);
        m.needsUpdate = true;
      }
    }
  }

  /** Detail level: 0 full, 1 medium, 2 crowd (Actors' levels). */
  setLod(l: number): void {
    if (l === this.lod) return;
    this.lod = l;
    this.actor.setLod(l);
    for (const e of this.eyes) e.visible = l === 0;
    this.prepareMeshes();
  }

  setSkyVis(v: number): void {
    this.skyVis = v;
    for (const p of this.skyPatches) if (p.uniform) p.uniform.value = v;
  }

  /** Register an extra sky patch (equipment materials) so setSkyVis reaches it. */
  addSkyPatch(p: SkyVisPatch): void {
    this.skyPatches.push(p);
  }
  removeSkyPatch(p: SkyVisPatch): void {
    const i = this.skyPatches.indexOf(p);
    if (i >= 0) this.skyPatches.splice(i, 1);
  }

  /** The body itself hidden (the raised dead show only their bones). */
  setBodyHidden(hidden: boolean): void {
    this.flip.visible = !hidden;
  }

  /** A hero's eye mask (sRGB colour) or none. Not drawn on Actors skins yet. */
  setEyeMask(_color: [number, number, number] | null, _under = false): void {}

  /**
   * Puts on an outfit (Actors garments; see outfit.ts). Resolves once it shows. `hideHair`:
   * a helmet or hood over the hair.
   */
  async dress(plan: DressPlan, hideHair = false, hideBeard = false): Promise<void> {
    const catalog = this.actor.catalog;
    const hair = new Set(catalog.hair.map((h) => h.id));
    const p = lookPatch(this.look, plan, hair, { hideHair, hideBeard });
    // Only what changed (a new shape is only made for garments the last one left out).
    const cur = this.actor.config;
    const patch: CharacterPatch = { outfit: p.outfit, garmentColors: p.garmentColors };
    if ((p.hair ?? null) !== cur.hair) patch.hair = p.hair ?? null;
    if (p.beard && p.beard !== cur.beard) patch.beard = p.beard;
    await this.actor.set(patch);
    this.prepareMeshes();
  }

  /**
   * Face: a mood ("happy", "pain", …; see MOODS) at `w` (0..1), a talking syllable (0..1,
   * flaps the mouth) and the eyelids (0 open … 1 shut). Moods and talking share the expression
   * channel (each new combination is computed once, off the frame).
   */
  setFace(mood: string, w: number, talking: boolean, syllable: number, blink: number): void {
    const a = this.actor.actor;
    a.setMorphWeight('blink', blink);
    const key = `scale:${MOODS[mood] ? mood : 'neutral'}${talking ? ':talk' : ''}`;
    if (key !== this.face.key && !this.face.pending) {
      this.face.pending = true;
      void this.actor.set({ expression: key, expressionIntensity: 0 }).finally(() => {
        this.face.key = key;
        this.face.pending = false;
      });
    }
    if (this.face.key !== key) {
      a.setMorphWeight('expression', 0);
      return;
    }
    const weight = talking ? (mood === 'neutral' ? syllable : 0.65 * w + 0.35 * syllable) : mood === 'neutral' ? 0 : w;
    a.setMorphWeight('expression', weight);
  }

  /** Tallest point of the body above its feet (m). */
  get height(): number {
    return this.body.height;
  }

  dispose(): void {
    this.disposed = true;
    this.object.removeFromParent();
    this.actor.dispose();
    this.skeleton.dispose();
  }
}
