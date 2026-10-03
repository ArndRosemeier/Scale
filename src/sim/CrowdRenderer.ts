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
  private rigs = new Map<number, { rig: HumanoidRig; used: number; agent: PedAgent; ready: 0 | 1 | 2 }>();
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
    const eq = cityOutfit(c.seed, c.gender, c.age, formal, 0.3);
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

  update(dt: number, time: number, agents: PedAgent[], cam: THREE.PerspectiveCamera): void {
    this.rigTime += dt;
    this.frustum.setFromProjectionMatrix(this.mat4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const counts = this.meshes.map(() => 0);
    const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
    // Nearest agents get real rigs.
    const near: { a: PedAgent; d: number }[] = [];
    for (const a of agents) {
      const d = Math.hypot(a.x - cx, a.y - cy, a.z - cz);
      // Frozen people are drawn as (ice-tinted, motionless) crowd instances, not rigs.
      if (d < RIG_RANGE && !((statusOf(a)?.frozen ?? 0) > 0)) near.push({ a, d });
    }
    near.sort((p, q) => p.d - q.d);
    const rigSet = new Set<number>();
    for (const n of near.slice(0, MAX_RIGS)) rigSet.add(n.a.id);
    // Update / create rigs.
    for (const id of rigSet) {
      const a = near.find((n) => n.a.id === id)!.a;
      let r = this.rigs.get(id);
      if (!r) {
        const look = this.lookOf(a);
        const app = randomAppearance('human', a.cit.seed, { gender: a.cit.gender, age: a.cit.age });
        const rig = new HumanoidRig(app, { castShadow: true, ground: this.rigGround, priority: 5 });
        rig.setEquipment(look.eq);
        this.scene.add(rig.object);
        r = { rig, used: this.rigTime, agent: a, ready: 0 };
        this.rigs.set(id, r);
      }
      r.used = this.rigTime;
      r.agent = a;
      // New outfits can need new shader variants: compile them asynchronously first.
      if (r.ready === 0 && r.rig.char) {
        r.ready = 1;
        const rr = r;
        if (this.prepare) this.prepare(r.rig.object).then(() => { rr.ready = 2; }, () => { rr.ready = 2; });
        else r.ready = 2;
      }
      const move = a.state === PState.Sit ? 'sit' : a.state === PState.Sleep ? 'sleep' : a.state === PState.Down ? 'dead' : a.state === PState.Flee ? 'run' : a.speed > 2.4 ? 'run' : a.speed > 0.15 ? 'walk' : 'idle';
      const vx = -Math.sin(a.heading) * a.speed, vz = -Math.cos(a.heading) * a.speed;
      const thanks = a.helped && a.state !== PState.Down && a.stateT < 3;
      const action = a.state === PState.Film ? { id: 'gesture_point', t0: time - 0.3, dur: 10 } : thanks ? { id: 'gesture_wave', t0: time - a.stateT, dur: 3 } : undefined;
      // Powers: shrunk people are small (and squeaky, see Elements); electrocuted ones twitch.
      const st = statusOf(a);
      const twitch = st && st.stunned > 0 ? Math.sin(time * 47 + a.id) * 0.18 : 0;
      r.rig.update({ pos: [a.x, a.y, a.z], vel: [vx, 0, vz], yaw: a.heading + twitch, scale: st ? st.scale : undefined, anim: { move, action, mood: thanks ? 'happy' : a.fear > 0.4 ? 'afraid' : a.state === PState.Gawk ? 'surprised' : 'neutral', lookAt: a.state === PState.Gawk || a.state === PState.Film || (a.glance ?? 0) > 0 ? [a.lookX, a.lookY, a.lookZ] : undefined }, flags: 0 }, dt, time, cam.position);
    }
    // Drop rigs no longer needed (keep a short while to avoid churn).
    for (const [id, r] of this.rigs) {
      if (rigSet.has(id)) continue;
      if (this.rigTime - r.used > 3 || !agents.includes(r.agent)) { r.rig.dispose(); this.rigs.delete(id); }
      else r.rig.setVisible(false);
    }
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
    this.meshes.forEach((m, i) => {
      m.count = counts[i];
      total += counts[i];
      if (counts[i]) {
        m.instanceMatrix.needsUpdate = true;
        this.anim[i].needsUpdate = true;
        for (const c of this.cols[i]) c.needsUpdate = true;
      }
    });
    this.stats.crowd = total;
    this.stats.rigs = rigSet.size;

  }
}

const _up = new THREE.Vector3(0, 1, 0);
