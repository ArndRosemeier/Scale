/**
 * Draws pedestrians: GPU-instanced vertex-animation crowds at mid range and
 * full Norgo rigs (with the citizen's own appearance and outfit) up close.
 */
import * as THREE from 'three';
import type { CrowdTemplate } from './CrowdBaker';

import { PState, type PedAgent } from './Pedestrians';
import { cityOutfit, heldItem } from '../humanoid/client/wardrobe';
import { HumanoidRig } from '../humanoid/client/HumanoidRig';
import { randomAppearance } from '../humanoid/appearance';
import type { EquipmentVisuals } from '../items/types';
import { Role } from './Population';
import { statusOf } from '../shared/status';

const CAP = 1400;          // instances per template
const CROWD_RANGE = 380;
const RIG_RANGE = 20;
const MAX_RIGS = 22;
/** Ragdolled people get a full rig out to here (see forceRig). */
const FORCE_RANGE = 50;
/** Actors (crimes, police, deeds) get priority rigs out to here, at most ACTOR_RIGS of them. */
const ACTOR_RIG_RANGE = 60;
const ACTOR_RIGS = 8;
/**
 * New full rigs per frame (building one — body, clothes, hair, a shader check — costs ~1–3 ms):
 * in a stampede the nearest people come and go faster than that; the rest stay crowd instances
 * a few frames longer. Ragdolls (forced) are never held back.
 */
const NEW_RIGS_PER_FRAME = 2;
/**
 * Full rigs cast shadows only this close (m; hysteresis ±2): every rig's shadow is several more
 * draw calls (body, garments, hair), and a stampede or a monster's ragdolls bring dozens of rigs
 * out to FORCE_RANGE, where a person's own shadow is a few pixels.
 */
const RIG_SHADOW_RANGE = 24;
/** Foot-IK ground queries are reused within a 0.2 m cell for this long (s). */
const GROUND_CACHE_T = 0.25;

interface Near { a: PedAgent; d: number }

interface Look {
  template: number;
  colors: number[]; // 6 × rgb linear
  eq: EquipmentVisuals;
  scale: number;
}

const VAT_DECL = /* glsl */ `
attribute float aVid; attribute float aSlot;
attribute vec4 iAnim;           // clip start row, frames, phase 0..1, blend to idle (unused)
attribute vec3 iC0; attribute vec3 iC1; attribute vec3 iC2; attribute vec3 iC3; attribute vec3 iC4; attribute vec3 iC5;
uniform sampler2D uVatPos; uniform sampler2D uVatNrm;
varying vec3 vCrowdCol;
vec3 gVatPos;
void vatSample() {
  float frames = max(iAnim.y, 1.0);
  float fr = fract(iAnim.z) * frames;
  float f0 = floor(fr);
  float f1 = mod(f0 + 1.0, frames);
  float w = fr - f0;
  int v = int(aVid + 0.5);
  vec3 p0 = texelFetch(uVatPos, ivec2(v, int(iAnim.x + f0)), 0).xyz;
  vec3 p1 = texelFetch(uVatPos, ivec2(v, int(iAnim.x + f1)), 0).xyz;
  gVatPos = mix(p0, p1, w);
}
vec3 vatNormal() {
  float frames = max(iAnim.y, 1.0);
  float fr = fract(iAnim.z) * frames;
  float f0 = floor(fr);
  float f1 = mod(f0 + 1.0, frames);
  int v = int(aVid + 0.5);
  vec3 n0 = texelFetch(uVatNrm, ivec2(v, int(iAnim.x + f0)), 0).xyz;
  vec3 n1 = texelFetch(uVatNrm, ivec2(v, int(iAnim.x + f1)), 0).xyz;
  return normalize(mix(n0, n1, fr - f0) + 1e-5);
}
`;

function patchVat(shader: THREE.WebGLProgramParametersWithUniforms, withNormal: boolean): void {
  shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${VAT_DECL}`);
  if (withNormal) {
    shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', 'vatSample();\nvec3 objectNormal = vatNormal();\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3(1.0, 0.0, 0.0);\n#endif');
  }
  shader.vertexShader = shader.vertexShader.replace(
    '#include <begin_vertex>',
    `${withNormal ? '' : 'vatSample();'}
vec3 transformed = gVatPos;
int sl = int(aSlot + 0.5);
vCrowdCol = sl == 0 ? iC0 : sl == 1 ? iC1 : sl == 2 ? iC2 : sl == 3 ? iC3 : sl == 4 ? iC4 : iC5;`,
  );
}

export class CrowdRenderer {
  readonly group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private anim: THREE.InstancedBufferAttribute[] = [];
  private cols: THREE.InstancedBufferAttribute[][] = [];
  private looks = new Map<number, Look>();
  private rigs = new Map<number, { rig: HumanoidRig; used: number; agent: PedAgent; ready: 0 | 1 | 2; held?: string | null; shadow?: boolean; shadowT?: number }>();
  /** Compile a new object's shaders off the critical path (set by the game); rigs show once ready. */
  prepare: ((o: THREE.Object3D) => Promise<unknown>) | null = null;
  private rigTime = 0;
  private frustum = new THREE.Frustum();
  private mat4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();
  private sphere = new THREE.Sphere();
  rigGround: ((x: number, y: number, z: number) => number | null) | null = null;
  /** rigGround through a short-lived cache (planted feet ask the same spot every frame). */
  private groundCache = new Map<number, number>();
  private groundCacheT = 0;
  private readonly cachedGround = (x: number, y: number, z: number): number | null => {
    const f = this.rigGround;
    if (!f) return null;
    const key = ((Math.round(x * 5) & 0xfffff) * 1048576 + (Math.round(z * 5) & 0xfffff)) * 64 + (Math.round(y) & 63);
    const c = this.groundCache.get(key);
    if (c !== undefined) return Number.isNaN(c) ? null : c;
    const g = f(x, y, z);
    this.groundCache.set(key, g === null ? NaN : g);
    return g;
  };
  // Per-frame scratch (no garbage): candidates for rigs, the chosen ones, agents present.
  private near: Near[] = [];
  private actors: Near[] = [];
  private nearPool: Near[] = [];
  private nearUsed = 0;
  private rigSet = new Set<number>();
  private present = new Set<PedAgent>();
  private counts: number[] = [];
  /** People who need a full rig first and out to FORCE_RANGE (ragdolls: physics/ragdoll). */
  forceRig: ((a: PedAgent) => boolean) | null = null;
  /** What a person holds (not actors: they say it themselves): an item id, null for nothing, undefined to keep their own (sim/Terraces: a cup at the café). */
  heldFor: ((a: PedAgent) => string | null | undefined) | null = null;
  /** Seated people chatting (sim/Terraces). */
  talking: ((a: PedAgent, time: number) => boolean) | null = null;
  stats = { crowd: 0, rigs: 0 };

  constructor(private templates: CrowdTemplate[], private scene: THREE.Object3D) {
    templates.forEach((t) => {
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
      const uniforms = { uVatPos: { value: t.pos }, uVatNrm: { value: t.nrm } };
      mat.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, uniforms);
        patchVat(sh, true);
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vCrowdCol;')
          .replace('#include <map_fragment>', 'diffuseColor.rgb = vCrowdCol;');
      };
      mat.customProgramCacheKey = () => 'crowd-vat-v1';
      const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
      depth.onBeforeCompile = (sh) => { Object.assign(sh.uniforms, uniforms); patchVat(sh, false); };
      depth.customProgramCacheKey = () => 'crowd-vat-depth-v1';
      const g = t.geometry.clone();
      const anim = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 4), 4).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('iAnim', anim);
      const cols: THREE.InstancedBufferAttribute[] = [];
      for (let c = 0; c < 6; c++) {
        const a = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3).setUsage(THREE.DynamicDrawUsage);
        g.setAttribute('iC' + c, a);
        cols.push(a);
      }
      const im = new THREE.InstancedMesh(g, mat, CAP);
      im.customDepthMaterial = depth;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.count = 0;
      im.frustumCulled = false;
      im.castShadow = true;
      im.receiveShadow = true;
      this.meshes.push(im);
      this.anim.push(anim);
      this.cols.push(cols);
      this.group.add(im);
    });
  }

  lookOf(a: PedAgent): Look {
    let l = this.looks.get(a.cit.id);
    if (l) return l;
    const c = a.cit;
    const female = c.gender < 0.5;
    const formal = c.role === Role.Worker ? 0.45 : 0.08;
    // Actors may wear a uniform (police).
    const eq = a.actor?.outfit ?? cityOutfit(c.seed, c.gender, c.age, formal, 0.3);
    const held = heldItem(c.seed);
    if (held) eq.mainhand = held;
    const kind = eq.back?.defId === 'suitjacket' ? 'suit' : eq.back?.defId === 'coat' ? 'coat' : eq.chest?.defId === 'dress' ? 'dress' : eq.legs?.defId === 'skirt' ? 'skirt' : eq.back?.defId === 'jacket' ? 'jacket' : 'casual';
    let ti = this.templates.findIndex((t) => t.female === female && t.outfit === kind);
    if (ti < 0) ti = this.templates.findIndex((t) => t.female === female && t.outfit === 'casual');
    if (ti < 0) ti = Math.max(0, this.templates.findIndex((t) => t.female === female));
    const app = randomAppearance('human', c.seed, { gender: c.gender, age: c.age });
    const col = (rgb: [number, number, number] | undefined, fb: [number, number, number]) => {
      const cc = new THREE.Color().setRGB(...(rgb ?? fb), THREE.SRGBColorSpace);
      return [cc.r, cc.g, cc.b];
    };
    const skin = col(app.skinTone as [number, number, number], [0.8, 0.6, 0.5]);
    const hair = col(app.hairColor as [number, number, number], [0.2, 0.15, 0.1]);
    const top = col(eq.chest?.visual.primary, [0.5, 0.5, 0.5]);
    const bottom = col(eq.legs?.visual.primary ?? eq.chest?.visual.primary, [0.2, 0.2, 0.25]);
    const shoes = col(eq.feet?.visual.primary, [0.1, 0.1, 0.1]);
    const outer = col(eq.back?.visual.primary ?? eq.chest?.visual.primary, [0.3, 0.3, 0.3]);
    const ageScale = c.role === Role.Child ? 0.55 + c.age * 2.2 : 1;
    l = { template: Math.max(0, ti), colors: [...skin, ...hair, ...top, ...bottom, ...shoes, ...outer], eq, scale: (0.93 + (c.seed % 100) / 100 * 0.14) * ageScale };
    this.looks.set(c.id, l);
    if (this.looks.size > 20000) this.looks.clear();
    return l;
  }

  /** The person's full rig when one is shown (built, dressed, visible), else null. */
  rigFor(id: number): HumanoidRig | null {
    const r = this.rigs.get(id);
    return r && r.ready === 2 && r.rig.char && r.rig.char.object.visible && r.rig.object.visible ? r.rig : null;
  }

  private entry(a: PedAgent, d: number): Near {
    const e = this.nearPool[this.nearUsed] ?? (this.nearPool[this.nearUsed] = { a, d });
    this.nearUsed++;
    e.a = a; e.d = d;
    return e;
  }

  update(dt: number, time: number, agents: PedAgent[], cam: THREE.PerspectiveCamera): void {
    this.rigTime += dt;
    if (this.rigTime - this.groundCacheT > GROUND_CACHE_T) { this.groundCache.clear(); this.groundCacheT = this.rigTime; }
    this.frustum.setFromProjectionMatrix(this.mat4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const counts = this.counts;
    counts.length = this.meshes.length;
    counts.fill(0);
    const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
    // Nearest agents get real rigs.
    const near = this.near, actors = this.actors;
    near.length = 0; actors.length = 0; this.nearUsed = 0;
    for (const a of agents) {
      const d = Math.hypot(a.x - cx, a.y - cy, a.z - cz);
      // Frozen people are drawn as (ice-tinted, motionless) crowd instances, not rigs.
      const forced = d < FORCE_RANGE && this.forceRig !== null && this.forceRig(a);
      if ((statusOf(a)?.frozen ?? 0) > 0) continue;
      if (!forced && a.actor && d < ACTOR_RIG_RANGE && d >= RIG_RANGE) { actors.push(this.entry(a, d)); continue; }
      if (d < RIG_RANGE || forced) near.push(this.entry(a, forced ? d - 1000 : a.actor ? d - 500 : d));
    }
    // Actors farther out: the nearest few get rigs before ordinary people.
    actors.sort(byD);
    for (let k = 0; k < actors.length && k < ACTOR_RIGS; k++) { actors[k].d -= 500; near.push(actors[k]); }
    near.sort(byD);
    const rigSet = this.rigSet;
    rigSet.clear();
    // Update / create rigs (a few new ones a frame; see NEW_RIGS_PER_FRAME).
    let fresh = 0;
    for (let k = 0; k < near.length && k < MAX_RIGS; k++) {
      const a = near[k].a, id = a.id;
      let r = this.rigs.get(id);
      if (!r) {
        if (fresh >= NEW_RIGS_PER_FRAME && near[k].d > -500) continue;
        fresh++;
        const look = this.lookOf(a);
        const app = randomAppearance('human', a.cit.seed, { gender: a.cit.gender, age: a.cit.age });
        const rig = new HumanoidRig(app, { castShadow: true, ground: this.rigGround ? this.cachedGround : null, priority: 5 });
        rig.setEquipment(look.eq);
        this.scene.add(rig.object);
        r = { rig, used: this.rigTime, agent: a, ready: 0 };
        this.rigs.set(id, r);
      }
      rigSet.add(id);
      r.used = this.rigTime;
      r.agent = a;
      // New outfits can need new shader variants: compile them asynchronously first.
      if (r.ready === 0 && r.rig.char) {
        r.ready = 1;
        const rr = r;
        if (this.prepare) this.prepare(r.rig.object).then(() => { rr.ready = 2; }, () => { rr.ready = 2; });
        else r.ready = 2;
      }
      const act = a.actor;
      // Actors: the item in hand can change (a snatched bag, a knife drawn).
      const held = act ? act.held : this.heldFor?.(a);
      if (held !== undefined && held !== r.held) {
        r.held = held;
        const look = this.lookOf(a);
        r.rig.setEquipment({ ...look.eq, mainhand: held ? { defId: held, visual: (look.eq.mainhand?.visual ?? look.eq.chest?.visual)! } : undefined });
      }
      const move = act?.move ?? (a.state === PState.Sit ? 'sit' : a.state === PState.Sleep ? 'sleep' : a.state === PState.Down ? (act && act.state === 'down' ? 'knockdown' : 'dead') : a.state === PState.Flee ? 'run' : a.speed > 2.4 ? 'run' : a.speed > 0.15 ? 'walk' : 'idle');
      const vx = -Math.sin(a.heading) * a.speed, vz = -Math.cos(a.heading) * a.speed;
      const thanks = a.helped && a.state !== PState.Down && a.stateT < 3;
      const action = act ? (act.action && a.state !== PState.Down ? { id: act.action.id, t0: time - act.action.age, dur: act.action.dur } : undefined)
        : a.state === PState.Film ? { id: 'gesture_point', t0: time - 0.3, dur: 10 } : thanks ? { id: 'gesture_wave', t0: time - a.stateT, dur: 3 } : undefined;
      // Powers: shrunk people are small (and squeaky, see Elements); electrocuted ones twitch.
      const st = statusOf(a);
      const twitch = st && st.stunned > 0 ? Math.sin(time * 47 + a.id) * 0.18 : 0;
      const mood = act ? act.mood : thanks ? 'happy' : a.fear > 0.4 ? 'afraid' : a.state === PState.Gawk ? 'surprised' : 'neutral';
      const lookAt: [number, number, number] | undefined = act ? (act.face ? [act.face.x, act.face.y, act.face.z] : undefined) : a.state === PState.Gawk || a.state === PState.Film || (a.glance ?? 0) > 0 ? [a.lookX, a.lookY, a.lookZ] : undefined;
      const talking = !act && a.state === PState.Sit && !!this.talking?.(a, time);
      r.rig.update({ pos: [a.x, a.y, a.z], vel: [vx, 0, vz], yaw: a.heading + twitch, scale: st ? st.scale : undefined, anim: { move, action, mood, lookAt, talking }, flags: 0 }, dt, time, cam.position);
      // Shadows only up close (re-applied now and then: clothes and held items come and go).
      const dc = Math.hypot(a.x - cx, a.y - cy, a.z - cz);
      const sh = r.shadow === undefined ? dc < RIG_SHADOW_RANGE : r.shadow ? dc < RIG_SHADOW_RANGE + 2 : dc < RIG_SHADOW_RANGE - 2;
      r.shadowT = (r.shadowT ?? 0) - dt;
      if (sh !== r.shadow || r.shadowT <= 0) {
        r.shadow = sh;
        r.shadowT = 0.5;
        r.rig.object.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = sh; });
      }
    }
    // Drop rigs no longer needed (keep a short while to avoid churn).
    const present = this.present;
    present.clear();
    for (const [id, r] of this.rigs) {
      if (rigSet.has(id)) continue;
      if (this.rigTime - r.used <= 3 && !present.size) for (const a of agents) present.add(a);
      if (this.rigTime - r.used > 3 || !present.has(r.agent)) { r.rig.dispose(); this.rigs.delete(id); }
      else r.rig.setVisible(false);
    }
    present.clear();
    for (const id of rigSet) {
      const r = this.rigs.get(id);
      if (r) r.rig.setVisible(r.ready === 2);
    }
    // Crowd instances.
    for (const a of agents) {
      const d = Math.hypot(a.x - cx, a.y - cy, a.z - cz);
      if (d > CROWD_RANGE) continue;
      const rr = this.rigs.get(a.id);
      if (rigSet.has(a.id) && rr && rr.ready === 2 && rr.rig.char && rr.rig.char.object.visible) continue;
      this.sphere.center.set(a.x, a.y + 0.9, a.z);
      this.sphere.radius = 1.2;
      if (!this.frustum.intersectsSphere(this.sphere)) continue;
      const look = this.lookOf(a);
      const st = statusOf(a);
      const ti = look.template;
      const k = counts[ti];
      if (k >= CAP) continue;
      counts[ti]++;
      const t = this.templates[ti];
      // Animation clip and phase.
      let clip = t.clips.idle;
      if (a.state === PState.Down) clip = t.clips.down;
      else if (a.state === PState.Film) clip = t.clips.film;
      else if (a.state === PState.Sit) clip = t.clips.sit ?? t.clips.idle;
      else if (a.speed > 2.4 || a.state === PState.Flee) clip = t.clips.run;
      else if (a.speed > 0.15) clip = t.clips.walk;
      let phase = clip.cycleDist > 0 ? a.phase / (clip.cycleDist * look.scale) : (time + (a.look % 97)) / clip.cycleTime;
      const frozen = !!st && st.frozen > 0;
      if (frozen) {
        // Held mid-stride (or mid-breath): no animation.
        if (st.saved?.walk && a.state !== PState.Down) clip = t.clips.walk;
        phase = clip.cycleDist > 0 ? st.hphase / (clip.cycleDist * look.scale) : (a.look % 97) / 97;
      }
      this.anim[ti].setXYZW(k, clip.start, clip.frames, phase, 0);
      if (frozen) for (let c = 0; c < 6; c++) this.cols[ti][c].setXYZ(k, look.colors[c * 3] * 0.35 + 0.5, look.colors[c * 3 + 1] * 0.35 + 0.58, look.colors[c * 3 + 2] * 0.35 + 0.66);
      else for (let c = 0; c < 6; c++) this.cols[ti][c].setXYZ(k, look.colors[c * 3], look.colors[c * 3 + 1], look.colors[c * 3 + 2]);
      this.q.setFromAxisAngle(_up, a.heading + (st && st.stunned > 0 ? Math.sin(time * 47 + a.id) * 0.18 : 0));
      this.mat4.compose(this.p.set(a.x, a.y, a.z), this.q, this.s.setScalar(look.scale * (st ? st.scale : 1)));
      this.meshes[ti].setMatrixAt(k, this.mat4);
    }
    let total = 0;
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i], n = counts[i];
      m.count = n;
      total += n;
      // Upload only the instances in use (the buffers hold CAP).
      if (n) {
        upload(m.instanceMatrix, n);
        upload(this.anim[i], n);
        for (const c of this.cols[i]) upload(c, n);
      }
    }
    this.stats.crowd = total;
    this.stats.rigs = rigSet.size;

  }
}

const _up = new THREE.Vector3(0, 1, 0);
const byD = (p: Near, q: Near) => p.d - q.d;

/** Mark the first n instances of an instanced attribute for upload. */
function upload(a: THREE.InstancedBufferAttribute | THREE.InstancedInterleavedBuffer | THREE.BufferAttribute, n: number): void {
  a.clearUpdateRanges();
  a.addUpdateRange(0, n * (a as THREE.BufferAttribute).itemSize);
  a.needsUpdate = true;
}
