/**
 * The part of loading that does not depend on the player's choices (seed, size, mode, hero),
 * started while the start screen is showing instead of after Start: the renderer and its GPU
 * device, the procedural textures, the Actors bodies and clips, the physics engine, the sky and
 * the shared lights, the crowd templates (fixed seeds), the hidden stand-in people that warm up
 * the clothing shaders, and the shaders of those stand-ins, the crowd, the interiors and the
 * city's own materials (render/cityWarmup).
 *
 * Every city uses the same materials; the seed only decides where things stand. So what is built
 * here is exactly what the game would build after Start, just earlier. Start (main.ts) awaits
 * whatever is still running; `?auto` and save loads simply start it at once.
 *
 * The start screen's backdrop runs on the same main thread, so the steps run one after the other
 * and the main-thread parts are cut into frame-sized jobs (frameWork, pumped once per frame here).
 * `?preload=0` turns it off (everything then starts with Start, as before).
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { loadGpuKit } from '../render/gpuMode';
import { Renderer } from '../render/Renderer';
import { Graphics } from '../render/Graphics';
import { SkySystem } from '../render/SkySystem';
import { TextureLibrary } from '../render/TextureLibrary';
import { lightPool } from '../render/lightPool';
import { actors } from '../humanoid/actors/service';
import { clipLibraryReady } from '../humanoid/client/anim/clips';
import { warmRigs } from '../humanoid/client/warmRigs';
import { interiorWarmup } from '../interior/InteriorBuilder';
import { bakeCrowdTemplates, type CrowdTemplate } from '../sim/CrowdBaker';
import { frameWork } from '../core/frameWork';
import { CrowdRenderer } from '../sim/CrowdRenderer';
import { cityWarmup } from '../render/cityWarmup';

export const PRELOAD_OFF = new URLSearchParams(location.search).get('preload') === '0';

export class Preload {
  readonly renderer: Renderer;
  readonly graphics: Graphics;
  readonly tex = new TextureLibrary();
  /** The sky (lights, fog, environment map): part of every lit material's program key. */
  readonly sky: SkySystem;
  /** Textures generated (or read from the browser's cache). */
  readonly texReady: Promise<void>;
  /** Actors bodies and clips, the physics engine. */
  readonly peopleReady: Promise<unknown>;
  /** The crowd's baked templates. */
  readonly templates: Promise<CrowdTemplate[]>;
  /** The crowd's renderer (built from the templates; the game adds its group to the scene). */
  readonly crowd: Promise<CrowdRenderer>;
  /** The city's materials on small meshes, kept so their programs stay (render/cityWarmup). */
  private city: THREE.Group | null = null;
  /** Interior materials on small meshes (staged by the warm-up; compiled here first). */
  readonly interior: THREE.Group;
  /** The hidden stand-in people dressed (and, where possible, their shaders compiled). */
  readonly warm: Promise<unknown>;
  /** Progress of the step still running, for the loading screen (0..1 each). */
  readonly progress = { tex: 0, bake: 0 };
  /** When each step finished (ms after the preload began), for the load log. */
  readonly times: Record<string, number> = {};
  readonly t0 = performance.now();
  private pumping = true;

  private constructor(renderer: Renderer) {
    this.renderer = renderer;
    this.graphics = new Graphics(renderer.gl, renderer.webgpu);
    // A start without shadows compiles the shaders without them (the cheapest for weak GPUs).
    renderer.gl.shadowMap.enabled = this.graphics.startShadows;
    this.sky = new SkySystem(renderer.gl, renderer.scene, renderer.reversed);
    // The only point / spot lights, shared by every system (a fixed, small count keeps shaders small).
    lightPool.attach(renderer.scene);
    actors.renderer = renderer.gl;
    this.interior = interiorWarmup();
    const mark = (k: string) => (this.times[k] = Math.round(performance.now() - this.t0));
    this.texReady = this.tex.load((f) => { this.progress.tex = f; }).then(() => { mark('textures'); });
    this.peopleReady = Promise.all([actors.ready(), clipLibraryReady(), RAPIER.init()]).then(() => mark('people'));
    // (One after the other: each step's main-thread work would otherwise land in the same frames.)
    this.templates = Promise.all([this.texReady, this.peopleReady])
      .then(() => bakeCrowdTemplates((f) => { this.progress.bake = f; }))
      .then((t) => { mark('crowd'); return t; });
    this.crowd = this.templates.then((t) => new CrowdRenderer(t, renderer.scene));
    this.warm = this.crowd.then((c) => this.warmShaders(c)).then(() => { mark('shaders'); }, (e) => console.warn('[preload] shaders', e));
    this.pump();
  }

  /** Stand-in people dressed, then their shaders and the interiors' compiled, one part at a time. */
  private async warmShaders(crowd: CrowdRenderer): Promise<void> {
    const R = this.renderer;
    const holder = new THREE.Group();
    holder.name = 'warm-rigs';
    R.scene.add(holder);
    await warmRigs(holder, new THREE.Vector3());
    const stage = new THREE.Group();
    this.city = cityWarmup(this.tex);
    stage.add(this.interior, this.city, crowd.group);
    R.scene.add(stage);
    const parts = [...holder.children, ...this.interior.children, ...crowd.group.children];
    this.city.traverse((o) => { if ((o as THREE.Mesh).isMesh) parts.push(o); });
    try {
      for (const part of parts) {
        await R.compileAsync(part);
        await nextFrame();
      }
    } finally {
      // (The interior pieces go back to the warm-up's staging; the stand-ins stay all game.)
      R.scene.remove(stage);
      stage.remove(this.interior, crowd.group);
    }
  }

  /** frameWork's jobs (dressing the stand-ins, the crowd bake), a frame's worth per frame. */
  private pump = () => {
    if (!this.pumping) return;
    frameWork.pump();
    requestAnimationFrame(this.pump);
  };

  /** The game's own frame loop pumps frameWork from now on. */
  stopPump(): void {
    this.pumping = false;
  }

  /** One line for the load log: what was ready when Start was pressed. */
  report(startAt: number): string {
    const at = Math.round(startAt - this.t0);
    const steps = Object.entries(this.times).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)} s${v <= at ? '' : ' (after Start)'}`);
    return `[preload] began ${(at / 1000).toFixed(1)} s before Start; ${steps.join(', ') || 'nothing finished yet'}`;
  }

  private static p: Promise<Preload> | null = null;

  /** Starts the preload (once) on the game's canvas. */
  static start(canvas: HTMLCanvasElement): Promise<Preload> {
    return (Preload.p ??= (async () => {
      await loadGpuKit(true);
      const r = new Renderer(canvas);
      await r.init();
      const pre = new Preload(r);
      (window as unknown as { preload: Preload }).preload = pre;
      return pre;
    })());
  }

  static get started(): boolean {
    return !!Preload.p;
  }
}

/** The next frame (or 50 ms in a hidden tab, where frames stop). */
function nextFrame(): Promise<void> {
  return new Promise((r) => { requestAnimationFrame(() => r()); setTimeout(r, 50); });
}
