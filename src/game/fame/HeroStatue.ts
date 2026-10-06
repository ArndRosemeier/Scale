/**
 * The hero's statue in front of the town hall (fame; the rules: fameRules.ts `StatueClock`).
 *
 *  - Voted (the reputation held at FAME.statueAt): a fenced building site on the town hall's square,
 *    scaffolding round a stone plinth and a figure under a tarp; a toast says so.
 *  - Unveiled (FAME.buildT s later): the fence, the scaffolding and the tarp go, a bronze statue of
 *    the hero stands on the plinth — the hero's own body and clothes, one fist raised, 1.6 times life
 *    size — with a plaque; a fanfare and confetti when the hero is near, a toast when not.
 *  - Pulled down (the reputation below 0 for a while): the statue lies on the paving in front of
 *    the plinth, the plaque sprayed over.
 *
 * The statue is the hero's own rig (humanoid/client/HumanoidRig), posed once (hero_pose) and its
 * materials turned to bronze in the shader (their own look kept underneath for the shading of folds).
 * The state is kept per city in localStorage (as the reputation) and in saves.
 */
import * as THREE from 'three';
import { WEBGPU, gpuKit } from '../../render/gpuMode';
import type { Game } from '../Game';
import type { Landmark } from '../../plan/landmarks';
import type { Obstacle } from '../../world/Collision';
import { HumanoidRig } from '../../humanoid/client/HumanoidRig';
import { cityName } from '../../plan/names';
import { FAME, StatueClock, type StatueSignal, type StatueState } from './fameRules';

/** Statue scale (× the hero) and the plinth (m). */
const SCALE = 1.6;
const PLINTH = { step: 3.4, stepH: 0.35, w: 2.3, h: 2.1, cap: 2.6, capH: 0.22 };
const BRONZE = new THREE.Color(0.36, 0.24, 0.12);

export class HeroStatue {
  readonly clock = new StatueClock();
  readonly group = new THREE.Group();
  /** Where it stands (null: the city has no town hall square). */
  readonly site: { x: number; z: number; y: number; yaw: number; name: string } | null;
  private plinth: THREE.Group | null = null;
  private works: THREE.Group | null = null;
  private rig: HumanoidRig | null = null;
  private posed = 0;
  private bronzed = false;
  private sprayed: THREE.Mesh | null = null;
  private readonly key: string;
  private devDone = false;
  /** Unveiled / pulled down here and now (Fame: the crowd). */
  onSignal: ((s: StatueSignal) => void) | null = null;

  constructor(private g: Game) {
    this.key = `scale.statue.v1.${g.mode}.${g.settings.seed}.${g.settings.size.toFixed(2)}`;
    const lm = (g.macro.landmarks ?? []).find((l) => l.kind === 'townhall');
    this.site = lm ? siteOf(lm, g) : null;
    g.renderer.scene.add(this.group);
    try {
      const o = JSON.parse(localStorage.getItem(this.key) ?? 'null');
      if (o) this.clock.restore(o);
    } catch { /* storage unavailable */ }
    g.collision.obstacleProviders.push((x0, z0, x1, z1, out) => this.obstacles(x0, z0, x1, z1, out));
    this.show();
  }

  get state(): StatueState { return this.clock.state; }

  update(dt: number, rep: number): void {
    if (!this.site) return;
    const sig = this.clock.step(dt, rep);
    if (sig) this.signal(sig);
    this.pose(dt);
  }

  private signal(sig: StatueSignal): void {
    const g = this.g, S = this.site!, H = g.powerHud, p = g.player.pos;
    const near = Math.hypot(p.x - S.x, p.z - S.z) < 160;
    this.save();
    this.show();
    switch (sig) {
      case 'voted': H.toast(`<b>The city council votes for a statue of you</b> in front of ${S.name} — it is being built now`, 'info', 7000); break;
      case 'unveiled':
        H.toast(near ? `<b>Your statue is unveiled</b> in front of ${S.name}!` : `<b>Your statue has been unveiled</b> in front of ${S.name} — go and have a look`, 'info', 7000);
        if (near) {
          g.audio.play('fanfare', S.x, S.y + 3, S.z, 1, 1, 30, g.renderer.camera.position);
          g.audio.play('crowd_cheer', S.x, S.y + 2, S.z, 0.9, 1, 20, g.renderer.camera.position);
          this.confetti();
        }
        break;
      case 'cancelled': H.toast(`The city has stopped building your statue in front of ${S.name}`, 'warn', 6000); break;
      case 'toppled': H.toast(`<b>Protesters have pulled down your statue</b> in front of ${S.name}`, 'warn', 7000); break;
    }
    this.onSignal?.(sig);
  }

  // ================================================================== the look

  /** Build what the state wants (the plinth, the building site, the statue standing or lying). */
  private show(): void {
    const st = this.clock.state;
    if (!this.site) return;
    if (st === 'none') { this.clear(); return; }
    if (!this.plinth) { this.plinth = makePlinth(this.site.name, cityName(this.g.settings.seed)); this.group.add(this.plinth); }
    this.place();
    // The building site.
    if (st === 'building' && !this.works) { this.works = makeWorks(); this.group.add(this.works); }
    if (st !== 'building' && this.works) { disposeTree(this.works); this.works = null; }
    // The statue (not while under the tarp).
    if (st === 'building') { this.dropRig(); }
    else if (!this.rig) this.makeRig();
    this.layRig();
    // The plaque sprayed over once it has been pulled down.
    if (st === 'toppled' && !this.sprayed) {
      this.sprayed = new THREE.Mesh(new THREE.PlaneGeometry(PLINTH.w * 0.95, 1.1), new THREE.MeshStandardMaterial({ map: sprayTexture(), transparent: true, roughness: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
      this.sprayed.position.set(0, PLINTH.stepH + PLINTH.h * 0.55, -PLINTH.w / 2 - 0.012);
      this.sprayed.rotation.y = Math.PI;
      this.plinth.add(this.sprayed);
    }
    if (st !== 'toppled' && this.sprayed) { this.sprayed.removeFromParent(); this.sprayed.geometry.dispose(); (this.sprayed.material as THREE.Material).dispose(); this.sprayed = null; }
  }

  private place(): void {
    const S = this.site!;
    this.group.position.set(S.x, S.y, S.z);
    this.group.rotation.y = S.yaw;
  }

  private clear(): void {
    if (this.works) { disposeTree(this.works); this.works = null; }
    if (this.plinth) { disposeTree(this.plinth); this.plinth = null; this.sprayed = null; }
    this.dropRig();
  }

  private makeRig(): void {
    const P = this.g.player;
    this.rig = new HumanoidRig(structuredClone(P.app), { fixedLod: 0, alwaysDrawn: true, castShadow: true, priority: 6 });
    this.rig.setEquipment(P.rig.outfit);
    this.posed = 0;
    this.bronzed = false;
    this.rig.object.visible = false;
    this.group.add(this.rig.object);
  }

  private dropRig(): void {
    if (!this.rig) return;
    this.rig.dispose();
    this.rig = null;
  }

  /** Standing on the plinth, or lying in front of it. */
  private layRig(): void {
    const r = this.rig;
    if (!r) return;
    const o = r.object;
    o.scale.setScalar(SCALE);
    if (this.clock.state === 'toppled') {
      // Fallen forwards off the plinth: face down on the paving, the feet towards it.
      o.position.set(0.3, 0.32, -PLINTH.step / 2 - 0.4);
      o.rotation.set(-Math.PI / 2 + 0.05, 0, 0.12);
    } else {
      o.position.set(0, PLINTH.stepH + PLINTH.h + PLINTH.capH, 0);
      o.rotation.set(0, 0, 0);
    }
  }

  /** Pose the rig once it is dressed (a few frames of the hero pose), then bronze it and leave it be. */
  private pose(dt: number): void {
    const r = this.rig;
    if (!r || this.posed > 0.6 || !r.dressed) return;
    this.posed += Math.max(dt, 0.05);
    const yaw = 0;
    r.update({ pos: [0, 0, 0], vel: [0, 0, 0], yaw, anim: { move: 'idle', action: { id: 'hero_pose', t0: -30, dur: 60 }, mood: 'happy' }, flags: 0 }, 0.1, 30 + this.posed, this.g.renderer.camera.position);
    this.layRig();
    if (!this.bronzed) { bronze(r.object); this.bronzed = true; }
    r.object.visible = true;
  }

  private confetti(): void {
    const S = this.site!, D = this.g.dust;
    const cols = [0xffd23f, 0xff4f6d, 0x3fa7ff, 0x6ee06e, 0xffffff];
    for (let i = 0; i < cols.length; i++) D.burst(S.x, S.y + 6, S.z, 14, 1.5, 4, 0.18, 4.5, new THREE.Color(cols[i]).multiplyScalar(1.6), -0.25, 0.95);
  }

  // ================================================================== solid

  private obstacles(x0: number, z0: number, x1: number, z1: number, out: (o: Obstacle) => void): void {
    const S = this.site;
    if (!S || this.clock.state === 'none') return;
    const R = this.clock.state === 'building' ? 2.6 : PLINTH.step / 2;
    if (S.x + R < x0 || S.x - R > x1 || S.z + R < z0 || S.z - R > z1) return;
    const ux = Math.cos(S.yaw), uz = -Math.sin(S.yaw);
    out({ cyl: false, x: S.x, z: S.z, r: 0, hx: PLINTH.step / 2, hz: PLINTH.step / 2, ux, uz, y0: S.y - 0.5, y1: S.y + PLINTH.stepH });
    out({ cyl: false, x: S.x, z: S.z, r: 0, hx: PLINTH.w / 2, hz: PLINTH.w / 2, ux, uz, y0: S.y, y1: S.y + PLINTH.stepH + PLINTH.h + PLINTH.capH });
    // The building site's fence.
    if (this.clock.state === 'building') out({ cyl: false, x: S.x, z: S.z, r: 0, hx: 2.6, hz: 2.6, ux, uz, y0: S.y, y1: S.y + 2 });
  }

  // ================================================================== saves, dev

  save(): { state: StatueState; t: number } {
    const o = this.clock.serialize();
    try { localStorage.setItem(this.key, JSON.stringify(o)); } catch { /* storage unavailable */ }
    return o;
  }

  restore(o: { state?: unknown; t?: unknown } | null | undefined): void {
    this.clock.restore(o ?? null);
    this.save();
    this.show();
  }

  status(): Record<string, unknown> {
    const S = this.site, p = this.g.player.pos;
    return { state: this.clock.state, progress: +this.clock.progress.toFixed(2), high: Math.round(this.clock.high), low: Math.round(this.clock.low), at: S ? { x: Math.round(S.x), z: Math.round(S.z), y: +S.y.toFixed(1), ground: +this.g.world.terrain.height(S.x, S.z).toFixed(1), d: Math.round(Math.hypot(p.x - S.x, p.z - S.z)), name: S.name } : null, dressed: !!this.rig?.dressed, bronzed: this.bronzed, stats: { ...this.clock.stats } };
  }

  dev(what?: 'build' | 'unveil' | 'topple' | 'remove' | 'go'): Record<string, unknown> {
    const C = this.clock, S = this.site;
    if (!S) return { error: 'this city has no town hall' };
    switch (what) {
      case 'build': C.state = 'building'; C.t = 0; this.signal('voted'); break;
      case 'unveil': C.state = 'building'; C.t = FAME.buildT; C.low = 0; this.signal(C.step(0, 50) ?? 'unveiled'); break;
      case 'topple': if (C.state !== 'standing') { C.state = 'standing'; this.show(); } C.state = 'toppled'; C.stats.toppled++; this.signal('toppled'); break;
      case 'remove': C.state = 'none'; C.t = 0; this.save(); this.show(); break;
      case 'go': {
        // In front of it, looking at it.
        const P = this.g.player, d = 9;
        const fx = -Math.sin(S.yaw), fz = -Math.cos(S.yaw);
        P.pos.set(S.x + fx * d, this.g.world.groundHeight(S.x + fx * d, S.z + fz * d) + 0.05, S.z + fz * d);
        P.vel.set(0, 0, 0);
        break;
      }
      default: break;
    }
    return this.status();
  }
}

// ================================================================== the site

/** The building site's half size (its fence): kept clear of anything standing. */
const SITE_R = 2.8;

/**
 * The statue's spot: on the town hall's square, off to one side of its fountain, facing out — the
 * first of a few spots on the square with nothing standing on it (a rotunda, a campanile, the
 * fountain's benches: anything over knee height in the building site's footprint), at the square's
 * own level (never on a roof).
 */
function siteOf(lm: Landmark, g: Game): { x: number; z: number; y: number; yaw: number; name: string } {
  const P = lm.p, hu = lm.hu, hv = lm.hv;
  const front = hv - 4 - (P.d ?? 24) - (P.wingD ?? 0);
  const sq = (-hv + front) / 2, depth = front + hv;
  const ca = Math.cos(lm.angle), sa = Math.sin(lm.angle);
  const at = (u: number, v: number) => ({ x: lm.x + u * ca - v * sa, z: lm.z + u * sa + v * ca });
  // Facing out over the square (−v): the rig faces −Z at yaw 0.
  const yaw = -lm.angle;
  const W = g.world;
  /** The square's level here: the ground below roofs (a little above the terrain: paving, a plaza). */
  const floor = (x: number, z: number) => W.groundHeight(x, z, W.terrain.height(x, z) + 1.2);
  const clearAt = (x: number, z: number): boolean => {
    const y = floor(x, z), R = SITE_R;
    for (const [dx, dz] of [[0, 0], [R, 0], [-R, 0], [0, R], [0, -R], [R, R], [R, -R], [-R, R], [-R, -R]]) {
      const top = W.groundHeight(x + dx, z + dz);
      if (top > y + 0.5 || Math.abs(floor(x + dx, z + dz) - y) > 0.6) return false;
    }
    return true;
  };
  const tries: [number, number][] = [];
  for (const dv of [0, -0.22, 0.22]) for (const fu of [-0.52, 0.52, -0.36, 0.36, -0.7, 0.7]) tries.push([fu * hu, sq + dv * depth]);
  for (const [u, v] of tries) {
    const p = at(u, v);
    if (clearAt(p.x, p.z)) return { ...p, y: floor(p.x, p.z), yaw, name: lm.name };
  }
  // Nowhere clear: the first spot, still on the ground.
  const p = at(tries[0][0], tries[0][1]);
  return { ...p, y: floor(p.x, p.z), yaw, name: lm.name };
}

// ================================================================== the pieces

const stone = () => new THREE.MeshStandardMaterial({ color: new THREE.Color(0.62, 0.6, 0.56), roughness: 0.85 });

function makePlinth(hall: string, city: string): THREE.Group {
  const g = new THREE.Group();
  g.name = 'statue-plinth';
  const m = stone(), dark = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.5, 0.48, 0.45), roughness: 0.8 });
  const step = new THREE.Mesh(new THREE.BoxGeometry(PLINTH.step, PLINTH.stepH, PLINTH.step), dark);
  step.position.y = PLINTH.stepH / 2 - 0.05;
  const block = new THREE.Mesh(new THREE.BoxGeometry(PLINTH.w, PLINTH.h, PLINTH.w), m);
  block.position.y = PLINTH.stepH + PLINTH.h / 2;
  const cap = new THREE.Mesh(new THREE.BoxGeometry(PLINTH.cap, PLINTH.capH, PLINTH.cap), dark);
  cap.position.y = PLINTH.stepH + PLINTH.h + PLINTH.capH / 2;
  const foot = new THREE.Mesh(new THREE.BoxGeometry(PLINTH.cap, 0.18, PLINTH.cap), dark);
  foot.position.y = PLINTH.stepH + 0.09;
  // The plaque on the front (−Z).
  const plaque = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.75), new THREE.MeshStandardMaterial({ map: plaqueTexture(hall, city), roughness: 0.35, metalness: 0.75 }));
  plaque.position.set(0, PLINTH.stepH + PLINTH.h * 0.55, -PLINTH.w / 2 - 0.006);
  plaque.rotation.y = Math.PI;
  for (const o of [step, block, cap, foot, plaque]) { o.castShadow = true; o.receiveShadow = true; g.add(o); }
  return g;
}

/** The building site: a fence of panels, scaffolding round the plinth, the figure under a tarp. */
function makeWorks(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'statue-works';
  const fenceM = new THREE.MeshStandardMaterial({ color: 0xd0d4d8, roughness: 0.6, metalness: 0.5, transparent: true, opacity: 0.85 });
  const footM = new THREE.MeshStandardMaterial({ color: 0x8a8a84, roughness: 0.9 });
  const R = 2.6;
  for (let side = 0; side < 4; side++) {
    for (let k = -1; k <= 1; k++) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(1.65, 1.9, 0.04), fenceM);
      const a = (side * Math.PI) / 2;
      const along = k * 1.72, out = R;
      panel.position.set(Math.cos(a) * along + Math.sin(a) * out, 0.95, -Math.sin(a) * along + Math.cos(a) * out);
      panel.rotation.y = a;
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.12, 0.25), footM);
      foot.position.set(panel.position.x, 0.06, panel.position.z);
      foot.rotation.y = a;
      g.add(panel, foot);
    }
  }
  // A sign on the fence.
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.7), new THREE.MeshStandardMaterial({ map: signTexture(), roughness: 0.7 }));
  sign.position.set(0, 1.15, -R - 0.03);
  sign.rotation.y = Math.PI;
  g.add(sign);
  // Scaffolding: four poles and rails round the plinth.
  const pipe = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.4, metalness: 0.8 });
  const top = PLINTH.stepH + PLINTH.h + 3.2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, top, 6), pipe);
    pole.position.set(sx * 1.6, top / 2, sz * 1.6);
    g.add(pole);
  }
  for (const y of [1.2, PLINTH.stepH + PLINTH.h + 0.2, top - 0.2]) for (let s = 0; s < 4; s++) {
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 3.2, 6), pipe);
    const a = (s * Math.PI) / 2;
    rail.rotation.z = Math.PI / 2;
    rail.rotation.y = a;
    rail.position.set(Math.sin(a) * 1.6, y, Math.cos(a) * 1.6);
    g.add(rail);
  }
  // The figure under a tarp: a draped shape on the plinth.
  const tarp = new THREE.MeshStandardMaterial({ color: 0x2f4f8a, roughness: 0.95, side: THREE.DoubleSide });
  const base = PLINTH.stepH + PLINTH.h + PLINTH.capH;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.75, 2.6, 12, 4, true), tarp);
  body.position.y = base + 1.3;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.46, 12, 8), tarp);
  head.position.y = base + 2.65;
  // (The raised fist under the cloth.)
  const arm = new THREE.Mesh(new THREE.ConeGeometry(0.28, 1.3, 8), tarp);
  arm.position.set(0.42, base + 3.1, 0);
  arm.rotation.z = -0.15;
  g.add(body, head, arm);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

/**
 * Bronze: every material of the rig keeps its own shader (folds, normal maps, hair strands) but its
 * colour, metalness and roughness are those of polished, slightly weathered bronze.
 */
function bronze(root: THREE.Object3D): void {
  const done = new Set<THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (done.has(m)) continue;
      done.add(m);
      if (WEBGPU) { gpuKit().bronzeNodeMaterial(m, BRONZE); continue; }
      const std = m as THREE.MeshStandardMaterial;
      if (!std.isMeshStandardMaterial) { if ((m as THREE.MeshBasicMaterial).color) (m as THREE.MeshBasicMaterial).color.copy(BRONZE); continue; }
      const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey.bind(m);
      m.onBeforeCompile = (s, r) => {
        prev.call(m, s, r);
        s.fragmentShader = s.fragmentShader.replace('#include <lights_physical_fragment>', `
          {
            // (Bronze: darker in the creases the material's own colour marks, a green patina facing up.)
            float lum = clamp(dot(diffuseColor.rgb, vec3(0.3, 0.55, 0.15)) * 1.6, 0.55, 1.15);
            vec3 bronzeC = vec3(${BRONZE.r.toFixed(3)}, ${BRONZE.g.toFixed(3)}, ${BRONZE.b.toFixed(3)}) * lum;
            float up = clamp(normal.y, 0.0, 1.0);
            diffuseColor.rgb = mix(bronzeC, vec3(0.16, 0.3, 0.24), up * up * 0.35);
            metalnessFactor = 0.82;
            roughnessFactor = 0.38;
            totalEmissiveRadiance = vec3(0.0);
          }
          #include <lights_physical_fragment>`);
      };
      m.customProgramCacheKey = () => `${prevKey()}|bronze`;
      m.needsUpdate = true;
    }
  });
}

// ================================================================== textures

function canvas(w: number, h: number, draw: (x: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  draw(cv.getContext('2d')!);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function plaqueTexture(hall: string, city: string): THREE.CanvasTexture {
  return canvas(512, 256, (x) => {
    x.fillStyle = '#7a5a2a'; x.fillRect(0, 0, 512, 256);
    x.strokeStyle = '#d8b46a'; x.lineWidth = 8; x.strokeRect(10, 10, 492, 236);
    x.fillStyle = '#f2d998'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = 'bold 54px Georgia, serif'; x.fillText('OUR HERO', 256, 82);
    x.font = 'italic 26px Georgia, serif'; x.fillText('who stood up for this city', 256, 136);
    x.font = '22px Georgia, serif'; x.fillText(`from the grateful people of ${city}`, 256, 186, 470);
    void hall;
  });
}

function signTexture(): THREE.CanvasTexture {
  return canvas(512, 256, (x) => {
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, 512, 256);
    x.fillStyle = '#1d4f91'; x.fillRect(0, 0, 512, 70);
    x.fillStyle = '#ffffff'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = 'bold 36px system-ui, sans-serif'; x.fillText('CITY WORKS', 256, 36);
    x.fillStyle = '#1d242b'; x.font = 'bold 40px system-ui, sans-serif'; x.fillText('A STATUE FOR', 256, 125);
    x.fillText('OUR HERO', 256, 180);
    x.font = '22px system-ui, sans-serif'; x.fillText('Unveiling soon', 256, 228);
  });
}

function sprayTexture(): THREE.CanvasTexture {
  return canvas(512, 256, (x) => {
    x.clearRect(0, 0, 512, 256);
    x.strokeStyle = 'rgba(210, 20, 30, 0.92)'; x.lineCap = 'round'; x.lineJoin = 'round';
    x.lineWidth = 16;
    x.beginPath(); x.moveTo(60, 40); x.lineTo(450, 220); x.moveTo(450, 40); x.lineTo(60, 220); x.stroke();
    x.fillStyle = 'rgba(20, 20, 20, 0.9)';
    x.font = 'bold 72px Impact, "Arial Black", sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.save(); x.translate(256, 130); x.rotate(-0.08); x.fillText('MENACE', 0, 0); x.restore();
  });
}

function disposeTree(o: THREE.Object3D): void {
  o.removeFromParent();
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    for (const mt of Array.isArray(m.material) ? m.material : [m.material]) { (mt as THREE.MeshStandardMaterial).map?.dispose(); mt.dispose(); }
  });
}
