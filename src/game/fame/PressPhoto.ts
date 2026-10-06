/**
 * Press photos on the billboards (fame): when a photographer's flash goes off (at most once a visit,
 * and not more often than PHOTO.gap), the scene is rendered once from their camera at the hero — a
 * real picture of the moment, people and all — and the big billboard screens near the hero show it
 * for a while with a headline ("CITY HERO DOES IT AGAIN") in a news bar.
 *
 * One small HDR render target (as the news feed's), read back once per photo; the picture is
 * composed on a canvas (tone mapped, a little contrast, the bar, the headline) and handed to the
 * screens as a half-float texture in the news feed's encoding (NewsFeed.still → Signs.feed), so the
 * screens' own shader shows it like the live feed (scan lines, the red dot).
 */
import * as THREE from 'three';
import type { Game } from '../Game';
import { cityName } from '../../plan/names';

export const PHOTO = { w: 512, h: 288, fov: 30, gap: 75, show: 75, fadeIn: 1.5, fadeOut: 4 };

const HEADLINES = {
  hero: ['CITY HERO DOES IT AGAIN', 'OUR HERO!', 'THE HERO OF {city}', 'SAFE STREETS — THANKS TO THEM', '"JUST DOING MY JOB"', 'WHO IS THE MYSTERY HERO?', 'HERO SPOTTED DOWNTOWN', 'CRIME STOPPED: {n} AND COUNTING'],
  famous: ['HERO SPOTTED ON {street}', 'IS THIS THE NEW HERO?', 'NEW HERO IN TOWN?', 'CAUGHT ON CAMERA: THE HERO', 'SUPERHUMAN SPOTTED'],
  hated: ['MENACE ON THE LOOSE', 'WHO PAYS FOR THE DAMAGE?', 'CITY FED UP WITH "HERO"', 'STOP THIS MENACE'],
};
const SUBS = {
  hero: ['Crowds cheer as the city\'s favourite strikes again', 'Our photographer met the hero in the street', 'Another day, another rescue'],
  famous: ['Witnesses report a costumed stranger helping out', 'Our photographer was there'],
  hated: ['Protests grow as damage mounts', 'Residents demand action'],
};

export class PressPhoto {
  private rt: THREE.WebGLRenderTarget | null = null;
  private readonly cam = new THREE.PerspectiveCamera(PHOTO.fov, PHOTO.w / PHOTO.h, 0.2, 3000);
  private readonly canvas = document.createElement('canvas');
  private tex: THREE.DataTexture | null = null;
  private t = -1;
  private lastT = -1e9;
  private time = 0;
  /** The headline now on the screens (dev, status). */
  headline = '';
  stats = { photos: 0, ms: 0 };

  constructor(private g: Game) {
    this.canvas.width = PHOTO.w;
    this.canvas.height = PHOTO.h;
  }

  /** Can a new photo go up now? */
  get ready(): boolean { return this.time - this.lastT > PHOTO.gap; }

  /**
   * Take the picture from (x, y, z) at the hero and put it up with a headline for this reputation.
   * False when it could not be taken (no render target, a live feed on the screens).
   */
  snap(x: number, y: number, z: number, rep: number, street: string | null): boolean {
    const g = this.g;
    if (g.aftermath?.feed.target) return false;
    const rt = this.target();
    if (!rt) return false;
    const t0 = performance.now();
    const P = g.player, cam = this.cam;
    cam.position.set(x, y, z);
    cam.lookAt(P.pos.x, P.pos.y + P.height * 0.62, P.pos.z);
    cam.updateMatrixWorld();
    const gl = g.renderer.gl, scene = g.renderer.scene, prev = gl.getRenderTarget(), auto = gl.shadowMap.autoUpdate;
    const px = new Uint16Array(PHOTO.w * PHOTO.h * 4);
    gl.shadowMap.autoUpdate = false;
    try {
      gl.setRenderTarget(rt);
      gl.clear();
      gl.render(scene, cam);
      gl.readRenderTargetPixels(rt, 0, 0, PHOTO.w, PHOTO.h, px);
    } catch (e) {
      console.warn('[fame] press photo failed', e);
      return false;
    } finally {
      gl.setRenderTarget(prev);
      gl.shadowMap.autoUpdate = auto;
    }
    this.compose(px, rep, street);
    this.t = 0;
    this.lastT = this.time;
    this.stats.photos++;
    this.stats.ms = Math.round(performance.now() - t0);
    return true;
  }

  update(dt: number): void {
    this.time += dt;
    const feed = this.g.aftermath?.feed;
    if (!feed || this.t < 0 || !this.tex) return;
    this.t += dt;
    const P = PHOTO;
    const k = this.t < P.fadeIn ? this.t / P.fadeIn : this.t > P.show - P.fadeOut ? Math.max(0, (P.show - this.t) / P.fadeOut) : 1;
    feed.still = k > 0 ? { tex: this.tex, strength: k } : null;
    if (this.t > P.show) { this.t = -1; feed.still = null; this.headline = ''; }
  }

  private target(): THREE.WebGLRenderTarget | null {
    if (this.rt) return this.rt;
    try {
      const rt = new THREE.WebGLRenderTarget(PHOTO.w, PHOTO.h, { type: THREE.HalfFloatType, depthBuffer: true });
      if (this.g.renderer.reversed) rt.depthTexture = new THREE.DepthTexture(PHOTO.w, PHOTO.h, THREE.FloatType);
      rt.texture.name = 'pressPhoto';
      this.rt = rt;
    } catch (e) { console.warn('[fame] no render target for press photos', e); }
    return this.rt;
  }

  /** The picture (HDR, bottom row first) → a front page on the canvas → the screens' encoding. */
  private compose(px: Uint16Array, rep: number, street: string | null): void {
    const W = PHOTO.w, H = PHOTO.h, x = this.canvas.getContext('2d')!;
    const img = x.createImageData(W, H), d = img.data;
    const half = THREE.DataUtils.fromHalfFloat;
    for (let row = 0; row < H; row++) {
      const src = (H - 1 - row) * W * 4, dst = row * W * 4;
      for (let i = 0; i < W * 4; i += 4) {
        for (let c = 0; c < 3; c++) {
          // Reinhard, sRGB, a little punch (a press photo, flash-lit).
          const v = Math.max(0, half(px[src + i + c]) * 1.25);
          const t = v / (1 + v);
          d[dst + i + c] = Math.round(255 * Math.min(1, Math.pow(t, 1 / 2.2) * 1.08));
        }
        d[dst + i + 3] = 255;
      }
    }
    x.putImageData(img, 0, 0);
    // (The bare picture, for the city's news cards.)
    const bare = document.createElement('canvas');
    bare.width = W; bare.height = H;
    bare.getContext('2d')!.drawImage(this.canvas, 0, 0);
    // A vignette.
    const vg = x.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.62);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.45)');
    x.fillStyle = vg; x.fillRect(0, 0, W, H);
    // The news bar: a channel tag, the headline, a line under it.
    const tone = rep >= 60 ? 'hero' : rep >= 0 ? 'famous' : 'hated';
    const cityN = cityName(this.g.settings.seed).toUpperCase();
    const n = this.g.crime.rep.stats.stopped;
    const fill = (s: string) => s.replace('{city}', cityN).replace('{n}', String(n)).replace('{street}', (street ?? 'MAIN STREET').toUpperCase());
    const head = fill(pickOf(HEADLINES[tone], this.stats.photos)), sub = fill(pickOf(SUBS[tone], this.stats.photos + 1));
    this.headline = head;
    // (And a lasting card among the city's news cards on the screens: CityNews.)
    try { this.g.city?.postPhoto(bare, head, sub); } catch (e) { console.warn('[fame] news card', e); }
    const barY = H * 0.68;
    x.fillStyle = tone === 'hated' ? 'rgba(150, 18, 18, 0.92)' : 'rgba(12, 32, 78, 0.9)';
    x.fillRect(0, barY, W, H - barY);
    x.fillStyle = tone === 'hated' ? '#ffd23f' : '#d61f2c';
    x.fillRect(0, barY, 112, 26);
    x.fillStyle = '#fff';
    x.font = 'bold 16px system-ui, sans-serif';
    x.textBaseline = 'middle';
    x.fillText(tone === 'hated' ? 'BREAKING' : 'CHANNEL 6', 10, barY + 13);
    x.font = 'bold 30px Impact, "Arial Black", system-ui, sans-serif';
    x.fillText(head, 14, barY + 46, W - 28);
    x.font = '16px system-ui, sans-serif';
    x.fillStyle = 'rgba(255,255,255,0.85)';
    x.fillText(sub, 14, barY + 74, W - 28);
    // Into the screens' encoding: they show f/(1+f), squared, × 1.5 (the live feed's look) — inverted here.
    const out = x.getImageData(0, 0, W, H).data;
    const data = new Uint16Array(W * H * 4);
    const toHalf = THREE.DataUtils.toHalfFloat;
    for (let row = 0; row < H; row++) {
      const src = row * W * 4, dst = (H - 1 - row) * W * 4;
      for (let i = 0; i < W * 4; i += 4) {
        for (let c = 0; c < 3; c++) {
          const o = Math.pow(out[src + i + c] / 255, 2.2) * 0.98;
          const f1 = Math.sqrt(o / 1.5);
          data[dst + i + c] = toHalf(f1 / Math.max(0.02, 1 - f1));
        }
        data[dst + i + 3] = toHalf(1);
      }
    }
    if (!this.tex) {
      this.tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
      this.tex.minFilter = THREE.LinearFilter; this.tex.magFilter = THREE.LinearFilter;
      this.tex.generateMipmaps = false;
      this.tex.name = 'pressPhotoPage';
    } else (this.tex.image as { data: Uint16Array }).data = data;
    this.tex.needsUpdate = true;
  }

  status(): Record<string, unknown> {
    return { showing: this.t >= 0, t: Math.round(this.t), headline: this.headline, ready: this.ready, ...this.stats };
  }
}

function pickOf<T>(a: readonly T[], k: number): T {
  return a[(k * 7 + Math.floor(Math.random() * a.length)) % a.length];
}
