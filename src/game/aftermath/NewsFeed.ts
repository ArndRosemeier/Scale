/**
 * The live news feed on the billboards (THREATS_PLAN §2 "Show, don't tell", §4.9 — the Cloverfield
 * trick): during an incident the big billboard screens near the player show what a news drone sees
 * of the monster — a low-res picture, scan lines, a blinking red dot — so even a weak hero far from
 * the fight sees it from the start; after the last resort's strike they show the cloud over the city.
 *
 * Budget (THREATS_PLAN §4): ONE render target (256 × 144, the scene pass's HDR format, so every
 * material uses the program it already has), updated at most 5 times a second, and only while there
 * is something to show and a billboard near the player to show it on. The picture leaves out what
 * costs most and is never seen from up there — people, cars, street furniture, signs (no feed of
 * the feed), birds, interiors, the underground —, draws every cell's facades at the simple LOD, reuses
 * the frame's shadow map and does not recompute the scene's matrices.
 */
import * as THREE from 'three';
import type { Game } from '../Game';

export const FEED = { w: 256, h: 144, hz: 5, fov: 26, dist: 270, alt: 55, showR: 420, cellsR: 450, newCells: 2 };

export interface FeedTarget {
  x: number; y: number; z: number;
  /** How far the drone stands off (m) and its height over the target. */
  dist: number;
  alt: number;
}

export class NewsFeed {
  readonly rt: THREE.WebGLRenderTarget | null;
  readonly cam = new THREE.PerspectiveCamera(FEED.fov, FEED.w / FEED.h, 1, 9000);
  /** What the drone films (null: off). */
  target: FeedTarget | null = null;
  /**
   * A still picture for the same screens while the drone films nothing (game/fame/PressPhoto: a press
   * photo of the hero with a headline), the feed's HDR encoding; null / strength 0: none.
   */
  still: { tex: THREE.Texture; strength: number } | null = null;
  private t = 0;
  private renderT = 0;
  private orbit = Math.random() * Math.PI * 2;
  private on = 0;
  private hidden: THREE.Object3D[] = [];
  private flags: boolean[] = [];
  private nearT = 0;
  private near = false;
  stats = { renders: 0, ms: 0, msAvg: 0 };

  constructor(private g: Game) {
    let rt: THREE.WebGLRenderTarget | null = null;
    try {
      rt = new THREE.WebGLRenderTarget(FEED.w, FEED.h, { type: THREE.HalfFloatType, depthBuffer: true });
      if (g.renderer.reversed) rt.depthTexture = new THREE.DepthTexture(FEED.w, FEED.h, THREE.FloatType);
      rt.texture.name = 'newsFeed';
    } catch (e) { console.warn('[aftermath] no news feed render target (the billboards show the pictograms)', e); rt = null; }
    this.rt = rt;
  }

  /** Billboards near the player to show it on? (checked every couple of seconds). */
  private billboardsNear(): boolean {
    this.nearT -= 1;
    if (this.nearT > 0) return this.near;
    this.nearT = 120;
    const p = this.g.player.pos;
    this.near = this.g.future.signs.billboardsNear(p.x, p.z, FEED.showR) > 0;
    return this.near;
  }

  update(dt: number): void {
    this.t += dt;
    const g = this.g, signs = g.future.signs, p = g.player.pos;
    const want = !!this.target && !!this.rt && this.billboardsNear() && !g.camRig.underground;
    this.on += ((want ? 1 : 0) - this.on) * Math.min(1, dt * 1.5);
    if (this.on < 0.01 || !this.rt) {
      const S = this.still;
      if (S && S.strength > 0.01 && !this.target) signs.feed(S.tex, p.x, p.z, FEED.showR, S.strength);
      else signs.feed(this.rt?.texture ?? null, p.x, p.z, FEED.showR, 0);
      return;
    }
    signs.feed(this.rt.texture, p.x, p.z, FEED.showR, this.on);
    this.renderT -= dt;
    if (!want || this.renderT > 0) return;
    this.renderT = 1 / FEED.hz;
    this.render();
  }

  /** Point the drone camera and render the picture (also once during the start-up warm-up). */
  render(): void {
    const g = this.g, T = this.target, rt = this.rt;
    if (!rt) return;
    const t0 = performance.now();
    const cam = this.cam;
    if (T) {
      // Circling slowly at its stand-off, looking at it a little from above.
      this.orbit += 0.02;
      const x = T.x + Math.cos(this.orbit) * T.dist, z = T.z + Math.sin(this.orbit) * T.dist;
      cam.position.set(x, Math.max(g.terrain.height(x, z) + 20, T.y + T.alt), z);
      cam.lookAt(T.x, T.y, T.z);
    } else {
      // (The start-up warm-up: at the speck of a creature drawn under the player, so its programs and
      // buffers are ready for the feed too.)
      const p = g.player.pos;
      cam.position.set(p.x + 6, p.y - 1, p.z);
      cam.lookAt(p.x, p.y - 2, p.z);
    }
    cam.updateMatrixWorld();
    const gl = g.renderer.gl, scene = g.renderer.scene;
    this.hide();
    const autoShadow = gl.shadowMap.autoUpdate, autoMatrix = scene.matrixWorldAutoUpdate, prev = gl.getRenderTarget();
    gl.shadowMap.autoUpdate = false;
    scene.matrixWorldAutoUpdate = false;
    try {
      gl.setRenderTarget(rt);
      gl.clear();
      gl.render(scene, cam);
    } finally {
      gl.setRenderTarget(prev);
      gl.shadowMap.autoUpdate = autoShadow;
      scene.matrixWorldAutoUpdate = autoMatrix;
      this.show();
    }
    this.stats.renders++;
    this.stats.ms = performance.now() - t0;
    this.stats.msAvg = this.stats.msAvg * 0.8 + this.stats.ms * 0.2;
  }

  /** Leave out what the drone never sees from up there (and the screens themselves). */
  private hide(): void {
    const g = this.g;
    const H = this.hidden;
    H.length = 0;
    H.push(g.crowd.group, g.props.group, g.future.group, g.birds.mesh, g.interiors.group, g.underground.group, g.crime.group, g.flightFx.group, g.player.rig.object, g.countryside.group, g.debris.group, g.vehicles.group);
    for (const r of (g.crowd as unknown as { rigs: Map<number, { rig: { object: THREE.Object3D } }> }).rigs.values()) H.push(r.rig.object);
    this.flags.length = H.length;
    for (let i = 0; i < H.length; i++) { this.flags[i] = H[i].visible; H[i].visible = false; }
    // Every cell's facades at the simple LOD (a 256 × 144 picture shows no more; the detailed ones
    // cost far more to draw, and to upload the first time they are seen from up there).
    // Cells far from what it films are left out (the skyline stands in for them); cells the feed has
    // not drawn yet come in a couple a picture (their first draw uploads their meshes: tens of ms in one go).
    const L = this.lods, T = this.target;
    L.length = 0;
    let fresh = 0;
    for (const cs of g.streamer.cells.values()) {
      if (cs.status !== 'ready' || !cs.lod0 || !cs.lod1) continue;
      const c = g.macro.cells[cs.id];
      const far = T && Math.hypot(c.centroid[0] - T.x, c.centroid[1] - T.z) - c.radius > FEED.cellsR;
      const late = !far && !this.drawn.has(cs.lod1) && fresh++ >= FEED.newCells;
      if (far || late) { if (cs.group.visible) { H.push(cs.group); this.flags.push(true); cs.group.visible = false; } continue; }
      this.drawn.add(cs.lod1);
      if (!cs.lod0.visible) continue;
      L.push(cs.lod0, cs.lod1);
      cs.lod0.visible = false; cs.lod1.visible = true;
    }
    // The terrain and water tiles (the rest of the city's root) likewise, a few new ones a picture.
    for (const o of g.streamer.root.children) {
      if (o.userData.cell !== undefined || !o.visible || this.drawn.has(o)) continue;
      if (fresh++ >= FEED.newCells * 2) { H.push(o); this.flags.push(true); o.visible = false; continue; }
      this.drawn.add(o);
    }
  }

  private show(): void {
    for (let i = 0; i < this.hidden.length; i++) this.hidden[i].visible = this.flags[i];
    this.hidden.length = 0;
    const L = this.lods;
    for (let i = 0; i < L.length; i += 2) { L[i].visible = true; L[i + 1].visible = false; }
    L.length = 0;
  }
  private lods: THREE.Object3D[] = [];
  /** Cells' simple-LOD meshes the feed has drawn (uploaded) already. */
  private drawn = new WeakSet<THREE.Object3D>();
}
