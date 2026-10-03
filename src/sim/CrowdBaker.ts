/**
 * Bakes Norgo characters into vertex-animation textures (VAT) for instanced
 * crowds: per template the far-LOD body + garment shells are compacted into
 * one mesh; walk / run / idle / film / down are sampled from the real
 * animator into position + normal float textures.
 */
import * as THREE from 'three';
import { HumanoidRig } from '../humanoid/client/HumanoidRig';
import { randomAppearance } from '../humanoid/appearance';
import type { EquipmentVisuals, ItemVisual } from '../items/types';
import { frameWork } from '../core/frameWork';
import { BODY_REGIONS } from '../humanoid/client/staticData';

export const enum Slot { Skin = 0, Hair = 1, Top = 2, Bottom = 3, Shoes = 4, Outer = 5 }

export interface ClipInfo { start: number; frames: number; /** metres per loop (0 = time based) */ cycleDist: number; /** seconds per loop for time-based clips */ cycleTime: number }

export interface CrowdTemplate {
  geometry: THREE.BufferGeometry;   // attributes: position (unused rest), aVid, aSlot
  pos: THREE.DataTexture;           // RGBA32F width = verts, height = frames
  nrm: THREE.DataTexture;
  verts: number;
  frames: number;
  clips: { walk: ClipInfo; run: ClipInfo; idle: ClipInfo; film: ClipInfo; down: ClipInfo };
  height: number;
  female: boolean;
  outfit: string;
}

const C3 = (r: number, g: number, b: number): [number, number, number] => [r, g, b];
function vis(primary: [number, number, number], material = 'plain'): ItemVisual {
  return { shape: 'cloth', seed: 1, primary, secondary: primary, accent: primary, material, glow: 0 } as unknown as ItemVisual;
}

/** Template outfits (colours are irrelevant: instances recolour by slot). */
export const TEMPLATE_DEFS: { female: boolean; outfit: string; eq: EquipmentVisuals }[] = [
  { female: false, outfit: 'casual', eq: { chest: { defId: 'tshirt', visual: vis(C3(1, 1, 1)) }, legs: { defId: 'jeans', visual: vis(C3(1, 1, 1)) }, feet: { defId: 'sneakers', visual: vis(C3(1, 1, 1)) } } },
  { female: false, outfit: 'suit', eq: { chest: { defId: 'shirt', visual: vis(C3(1, 1, 1)) }, back: { defId: 'suitjacket', visual: vis(C3(1, 1, 1)) }, legs: { defId: 'trousers', visual: vis(C3(1, 1, 1)) }, feet: { defId: 'shoes', visual: vis(C3(1, 1, 1)) } } },
  { female: false, outfit: 'jacket', eq: { chest: { defId: 'shirt', visual: vis(C3(1, 1, 1)) }, back: { defId: 'jacket', visual: vis(C3(1, 1, 1)) }, legs: { defId: 'jeans', visual: vis(C3(1, 1, 1)) }, feet: { defId: 'boots', visual: vis(C3(1, 1, 1)) } } },
  { female: false, outfit: 'coat', eq: { chest: { defId: 'sweater', visual: vis(C3(1, 1, 1)) }, back: { defId: 'coat', visual: vis(C3(1, 1, 1)) }, legs: { defId: 'trousers', visual: vis(C3(1, 1, 1)) }, feet: { defId: 'shoes', visual: vis(C3(1, 1, 1)) } } },
  { female: true, outfit: 'casual', eq: { chest: { defId: 'tshirt', visual: vis(C3(1, 1, 1)) }, legs: { defId: 'jeans', visual: vis(C3(1, 1, 1)) }, feet: { defId: 'sneakers', visual: vis(C3(1, 1, 1)) } } },
  { female: true, outfit: 'dress', eq: { chest: { defId: 'dress', visual: vis(C3(1, 1, 1)) }, feet: { defId: 'shoes', visual: vis(C3(1, 1, 1)) } } },
  { female: true, outfit: 'skirt', eq: { chest: { defId: 'shirt', visual: vis(C3(1, 1, 1)) }, legs: { defId: 'skirt', visual: vis(C3(1, 1, 1)) }, feet: { defId: 'shoes', visual: vis(C3(1, 1, 1)) } } },
  { female: true, outfit: 'coat', eq: { chest: { defId: 'sweater', visual: vis(C3(1, 1, 1)) }, back: { defId: 'coat', visual: vis(C3(1, 1, 1)) }, legs: { defId: 'trousers', visual: vis(C3(1, 1, 1)) }, feet: { defId: 'boots', visual: vis(C3(1, 1, 1)) } } },
];

const SLOT_OF: Record<string, Slot> = { chest: Slot.Top, legs: Slot.Bottom, feet: Slot.Shoes, back: Slot.Outer, under: Slot.Bottom };

/** Yield to the event loop without timer throttling (works in background tabs). */
function yieldNow(): Promise<void> {
  return new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
}

export async function bakeCrowdTemplates(onProgress?: (f: number) => void): Promise<CrowdTemplate[]> {
  const out: CrowdTemplate[] = [];
  let i = 0;
  for (const def of TEMPLATE_DEFS) {
    // A body that is not ready in time (busy machine) is retried once, then left out: the crowd
    // uses the nearest remaining template rather than failing the start.
    const t = (await bakeOne(def, 9100 + i * 17)) ?? (await bakeOne(def, 9100 + i * 17));
    if (t) out.push(t);
    else console.warn('[crowd] template skipped (body not ready):', def);
    onProgress?.(++i / TEMPLATE_DEFS.length);
  }
  return out;
}

async function bakeOne(def: (typeof TEMPLATE_DEFS)[number], seed: number): Promise<CrowdTemplate | null> {
  const app = randomAppearance('human', seed, { gender: def.female ? 0.05 : 0.95, age: 0.35 });
  app.scale = 1;
  const rig = new HumanoidRig(app, { castShadow: false, fixedLod: 2, priority: -100 });
  rig.setEquipment(def.eq);
  let done = false;
  void rig.ready.then(() => { done = true; });
  // Waits are timed, not counted: a yield takes microseconds, so a count expired after a second or
  // two and a slow body build (busy machine) then crashed the start on a missing character.
  const t0 = performance.now();
  while (!done && performance.now() - t0 < 60000) { frameWork.pump(); await yieldNow(); }
  // Wait until dressed (garments are built in budgeted jobs).
  const t1 = performance.now();
  while (!rig.char?.object.visible && performance.now() - t1 < 20000) { frameWork.pump(); await yieldNow(); }
  if (!rig.char || !rig.animator) { rig.dispose(); return null; }
  const ch = rig.char;
  const an = rig.animator!;
  ch.setLod(2);
  const root = rig.object;
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  root.updateMatrixWorld(true);
  // Collect LOD2 skinned meshes and their referenced vertices.
  const meshes: { mesh: THREE.SkinnedMesh; verts: number[]; slot: Slot | -1 }[] = [];
  ch.lods[2].traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || !m.visible) return;
    const idx = m.geometry.getIndex();
    if (!idx) return;
    const set = new Set<number>();
    for (let k = 0; k < idx.count; k++) set.add(idx.getX(k));
    const slotName = m.userData.slot as string | undefined;
    meshes.push({ mesh: m, verts: [...set].sort((a, b) => a - b), slot: slotName ? (SLOT_OF[slotName] ?? Slot.Top) : -1 });
  });
  // Body vertices under a garment take its slot (the outermost one wins): the decimated far-LOD
  // shells have gaps where large triangles cross a garment edge, and the body showed through
  // as skin — crowds looked half naked.
  const st = ch.geo.st;
  const coverSlot = new Map<number, { slot: Slot; order: number }>();
  for (const M of meshes) {
    const covers = M.mesh.userData.covers as number[] | undefined;
    if (M.slot < 0 || !covers) continue;
    const order = (M.mesh.userData.order as number | undefined) ?? 0;
    for (const v of covers) {
      const c = coverSlot.get(v);
      if (!c || c.order < order) coverSlot.set(v, { slot: M.slot as Slot, order });
    }
  }
  // Compact vertex table.
  const scalp = BODY_REGIONS.indexOf('scalp');
  const vertRefs: { m: number; v: number; slot: Slot }[] = [];
  const remap: Map<number, number>[] = [];
  meshes.forEach((M, mi) => {
    const map = new Map<number, number>();
    for (const v of M.verts) {
      map.set(v, vertRefs.length);
      const slot = M.slot >= 0 ? (M.slot as Slot) : coverSlot.get(v)?.slot ?? (st.region[v] === scalp ? Slot.Hair : Slot.Skin);
      vertRefs.push({ m: mi, v, slot });
    }
    remap.push(map);
  });
  const nv = vertRefs.length;
  const index: number[] = [];
  meshes.forEach((M, mi) => {
    const idx = M.mesh.geometry.getIndex()!;
    for (let k = 0; k < idx.count; k++) index.push(remap[mi].get(idx.getX(k))!);
  });
  // Clips to bake.
  const clipsSpec: { name: keyof CrowdTemplate['clips']; move: 'walk' | 'run' | 'idle' | 'dead'; speed: number; frames: number; film?: boolean; still?: boolean }[] = [
    { name: 'walk', move: 'walk', speed: 1.35, frames: 24 },
    { name: 'run', move: 'run', speed: 4.2, frames: 18 },
    { name: 'idle', move: 'idle', speed: 0, frames: 20 },
    { name: 'film', move: 'idle', speed: 0, frames: 10, film: true },
    { name: 'down', move: 'dead', speed: 0, frames: 1, still: true },
  ];
  const totalFrames = clipsSpec.reduce((a, c) => a + c.frames, 0);
  const posData = new Float32Array(nv * totalFrames * 4);
  const nrmData = new Float32Array(nv * totalFrames * 4);
  const clips = {} as CrowdTemplate['clips'];
  const tmp = new THREE.Vector3();
  const geoTmp = new THREE.BufferGeometry();
  const posArr = new Float32Array(nv * 3);
  geoTmp.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  geoTmp.setIndex(index);
  let row = 0;
  let time = 0;
  const step = (move: string, speed: number, dt: number, film: boolean) => {
    time += dt;
    an.update({ anim: { move: move as 'walk' }, vel: [0, 0, -speed], yaw: 0, time, main: 'none', off: 'none', combat: false, sneaking: false }, dt, 1, null);
    if (film) {
      const set = (name: string, x: number, y: number, z: number) => {
        const bi = ch.boneIndex.get(name);
        if (bi === undefined) return;
        ch.bones[bi].quaternion.setFromEuler(new THREE.Euler(x, y, z, 'XZY'));
      };
      set('upperarm01.R', 1.25, 0.2, 0.25);
      set('lowerarm01.R', 1.35, 0, 0);
      set('upperarm01.L', 1.0, -0.3, -0.4);
      set('lowerarm01.L', 1.5, 0, 0);
      set('neck01', -0.1, 0, 0);
    }
    root.updateMatrixWorld(true);
  };
  const capture = (r: number) => {
    for (let k = 0; k < nv; k++) {
      const ref = vertRefs[k];
      const m = meshes[ref.m].mesh;
      m.getVertexPosition(ref.v, tmp);
      tmp.applyMatrix4(m.matrixWorld);
      posArr[k * 3] = tmp.x; posArr[k * 3 + 1] = tmp.y; posArr[k * 3 + 2] = tmp.z;
      const o = (r * nv + k) * 4;
      posData[o] = tmp.x; posData[o + 1] = tmp.y; posData[o + 2] = tmp.z; posData[o + 3] = 1;
    }
    geoTmp.getAttribute('position').needsUpdate = true;
    geoTmp.computeVertexNormals();
    const na = geoTmp.getAttribute('normal');
    for (let k = 0; k < nv; k++) {
      const o = (r * nv + k) * 4;
      nrmData[o] = na.getX(k); nrmData[o + 1] = na.getY(k); nrmData[o + 2] = na.getZ(k); nrmData[o + 3] = 0;
    }
  };
  for (const c of clipsSpec) {
    // Warm up the gait / settle the pose.
    for (let k = 0; k < 150; k++) step(c.move, c.speed, 1 / 60, !!c.film);
    let period = 2.5;
    if (c.speed > 0) {
      // Detect the gait period from the left thigh swing (autocorrelation).
      const thigh = ch.bones[ch.boneIndex.get('upperleg01.L')!];
      const samples: number[] = [];
      for (let k = 0; k < 240; k++) { step(c.move, c.speed, 1 / 120, false); samples.push(thigh.quaternion.x); }
      let best = 0, bestLag = 120;
      for (let lag = 40; lag < 230; lag++) {
        let s = 0;
        for (let k = 0; k + lag < samples.length; k++) s += samples[k] * samples[k + lag];
        s /= samples.length - lag;
        if (s > best) { best = s; bestLag = lag; }
      }
      period = bestLag / 120;
    } else if (c.still) {
      for (let k = 0; k < 240; k++) step(c.move, 0, 1 / 60, false);
    }
    const start = row;
    for (let f = 0; f < c.frames; f++) {
      if (f > 0 && !c.still) step(c.move, c.speed, period / c.frames, !!c.film);
      capture(row++);
    }
    clips[c.name] = { start, frames: c.frames, cycleDist: c.speed * period, cycleTime: period };
  }
  // Instance geometry: rest positions (frame 0 of idle) + vertex id + slot.
  const g = new THREE.BufferGeometry();
  const rest = new Float32Array(nv * 3);
  const vid = new Float32Array(nv);
  const slot = new Float32Array(nv);
  for (let k = 0; k < nv; k++) {
    const o = (clips.idle.start * nv + k) * 4;
    rest[k * 3] = posData[o]; rest[k * 3 + 1] = posData[o + 1]; rest[k * 3 + 2] = posData[o + 2];
    vid[k] = k;
    slot[k] = vertRefs[k].slot;
  }
  g.setAttribute('position', new THREE.BufferAttribute(rest, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nv * 3).fill(0), 3));
  g.setAttribute('aVid', new THREE.BufferAttribute(vid, 1));
  g.setAttribute('aSlot', new THREE.BufferAttribute(slot, 1));
  g.setIndex(index);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.6);
  const mk = (d: Float32Array) => {
    const t = new THREE.DataTexture(d, nv, totalFrames, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    return t;
  };
  const height = rig.height;
  rig.dispose();
  return { geometry: g, pos: mk(posData), nrm: mk(nrmData), verts: nv, frames: totalFrames, clips, height, female: def.female, outfit: def.outfit };
}
