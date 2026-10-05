/**
 * Standalone turntable preview for the character creator (ported from Norgo): its own
 * renderer on the given canvas, studio lighting (key, fill, rim, soft environment), one
 * full-detail humanoid with clothes, body / face framing with smooth camera moves, idle or
 * walk-in-place. One instance is meant to be reused (one WebGL context); `stop()` pauses the
 * render loop while hidden, `dispose()` releases the context.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { HumanoidAppearance } from '../types';
import type { EquipmentVisuals } from '../../items/types';
import type { MoveState } from '../../shared/types';
import { BodyService, geometryKey } from './BodyService';
import { HumanoidRig } from './HumanoidRig';

const POSES: Record<string, { move: MoveState; speed?: number }> = {
  idle: { move: 'idle' },
  walk: { move: 'walk', speed: 1.4 },
};

export class HumanoidPreview {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(28, 1, 0.03, 50);
  private rig: HumanoidRig | null = null;
  private equipment: EquipmentVisuals | undefined;
  private focus: 'body' | 'face' = 'body';
  private yaw = 0;
  private pose = 'idle';
  private time = 0;
  private raf = 0;
  private running = false;
  private clock = new THREE.Timer();
  private camPos = new THREE.Vector3(0, 1.2, -4);
  private camTarget = new THREE.Vector3(0, 1, 0);
  private lookTarget = new THREE.Vector3(0, 1, 0);
  private tmp = new THREE.Vector3();
  private ro: ResizeObserver | null = null;
  private readyP: Promise<void> | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {}

  /** Must be awaited once before use (creates the renderer, loads the human assets). */
  ready(): Promise<void> {
    return (this.readyP ??= this.init());
  }

  private async init(): Promise<void> {
    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = r;
    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environmentIntensity = 0.32;
    const key = new THREE.DirectionalLight(0xfff0e0, 2.8);
    key.position.set(-2.5, 4, -3.5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = key.shadow.camera.bottom = -2;
    key.shadow.camera.right = key.shadow.camera.top = 2;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    const fill = new THREE.DirectionalLight(0xc8d8ff, 0.8);
    fill.position.set(3, 2, -2);
    const rim = new THREE.DirectionalLight(0xffffff, 1.6);
    rim.position.set(1.5, 3, 4);
    this.scene.add(key, fill, rim, new THREE.HemisphereLight(0xd8e4ff, 0x40362c, 0.5));
    const floor = new THREE.Mesh(new THREE.CircleGeometry(1.6, 48), new THREE.ShadowMaterial({ opacity: 0.35 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvas);
    this.resize();
    await BodyService.get().ready();
  }

  setAppearance(a: HumanoidAppearance): void {
    if (!this.rig) {
      this.rig = new HumanoidRig(a, { fixedLod: 0, alwaysDrawn: true, castShadow: true });
      this.rig.setEquipment(this.equipment);
      this.scene.add(this.rig.object);
    } else void this.rig.setAppearance(a);
  }

  setEquipment(e: EquipmentVisuals): void {
    this.equipment = e;
    this.rig?.setEquipment(e);
  }

  /** Camera framing: whole body or face close-up. */
  setFocus(f: 'body' | 'face'): void {
    this.focus = f;
  }

  /** Model rotation (radians). */
  setYaw(y: number): void {
    this.yaw = y;
  }

  setPose(p: string): void {
    this.pose = p;
  }

  /** Start / resume the render loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.update();
    this.loop();
  }

  /** Pause the render loop (preview hidden). */
  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private resize(): void {
    const r = this.renderer;
    if (!r) return;
    const w = Math.max(1, this.canvas.clientWidth), h = Math.max(1, this.canvas.clientHeight);
    r.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Camera position / target for a framing (body or face) at the current aspect. */
  private frame(focus: 'body' | 'face', aspect: number, outPos: THREE.Vector3, outTarget: THREE.Vector3, padBottom = 0.22): void {
    const rig = this.rig;
    const h = rig?.height ?? 1.75;
    let boxH: number, boxW: number, cy: number;
    const headBone = rig?.char?.bone('head');
    if (focus === 'face' && headBone) {
      headBone.getWorldPosition(this.tmp);
      const neckToTop = Math.max(0.12, h - this.tmp.y);
      boxH = neckToTop * 2.3;
      boxW = neckToTop * 1.55;
      cy = this.tmp.y + neckToTop * 0.38;
    } else {
      boxH = h * 1.1;
      boxW = h * 0.62;
      cy = h * 0.5;
    }
    // Room at the bottom for the controls overlaid on the stage.
    cy -= boxH * padBottom * 0.5;
    boxH *= 1 + padBottom;
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const d = Math.max(boxH / 2 / tanV, boxW / 2 / (tanV * Math.max(0.2, aspect)));
    outTarget.set(0, cy, 0);
    outPos.set(Math.sin(0.12) * d, cy + d * 0.04, -Math.cos(0.12) * d);
  }

  private loop = (): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.update().getDelta());
    this.time += dt;
    const rig = this.rig;
    if (rig) {
      const preset = POSES[this.pose] ?? POSES.idle;
      const sp = preset.speed ?? 0;
      // Treadmill: velocity along the facing direction, position fixed.
      const vx = -Math.sin(this.yaw) * sp, vz = -Math.cos(this.yaw) * sp;
      const c = this.camera.position;
      rig.update({
        pos: [0, 0, 0], vel: [vx, 0, vz], yaw: this.yaw, flags: 0,
        anim: { move: preset.move, lookAt: this.focus === 'face' ? [c.x, c.y, c.z] : undefined },
      }, dt, this.time);
      this.frame(this.focus, this.camera.aspect, this.camPos, this.camTarget);
    }
    const k = 1 - Math.exp(-dt * 6);
    this.camera.position.lerp(this.camPos, k);
    this.lookTarget.lerp(this.camTarget, k);
    this.camera.lookAt(this.lookTarget);
    this.renderer?.render(this.scene, this.camera);
  };

  /** True once the current look is built and dressed (not a placeholder or an older body). */
  get built(): boolean {
    const rig = this.rig, ch = rig?.char;
    return !!ch && ch.object.visible && (ch.app === rig.app || geometryKey(ch.app) === geometryKey(rig.app));
  }

  /** Built body: its standing height (m) and the appearance it was built from (null while building). */
  get body(): { height: number; app: HumanoidAppearance } | null {
    return this.built && this.rig ? { height: this.rig.height, app: this.rig.app } : null;
  }

  /** Small front-view PNG of the current character (full body, transparent background). */
  thumbnail(w = 120, h = 160): string | undefined {
    const r = this.renderer;
    if (!r || !this.rig) return undefined;
    const pr = r.getPixelRatio();
    const cam = this.camera.clone();
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
    const pos = new THREE.Vector3(), target = new THREE.Vector3();
    const yaw = this.rig.object.rotation.y;
    this.rig.object.rotation.y = 0.35;
    this.frame('body', cam.aspect, pos, target, 0);
    cam.position.copy(pos);
    cam.lookAt(target);
    try {
      r.setPixelRatio(1);
      r.setSize(w, h, false);
      r.render(this.scene, cam);
      return this.canvas.toDataURL('image/png');
    } catch {
      return undefined;
    } finally {
      this.rig.object.rotation.y = yaw;
      r.setPixelRatio(pr);
      this.resize();
      r.render(this.scene, this.camera);
    }
  }

  dispose(): void {
    this.stop();
    this.ro?.disconnect();
    this.rig?.dispose();
    this.rig = null;
    this.scene.environment?.dispose();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer = null;
  }
}
