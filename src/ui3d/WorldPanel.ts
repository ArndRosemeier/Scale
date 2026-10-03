/**
 * World-space UI panel: a quad in the 3D world whose face is a 2D canvas (crisp text,
 * readouts, anything 2D) with clickable button regions.
 *
 * - Size in metres, resolution in canvas pixels per metre.
 * - Buttons are rectangles in canvas pixels; hover and press states are drawn by the
 *   panel, the owner draws everything else in `paint`.
 * - The readable face points along the panel's local +Z. To face a world direction
 *   (dx, dz) set `object.rotation.y = atan2(dx, dz)` (see `faceTowards`).
 * - Presses come from the PanelManager (crosshair ray, within reach).
 */
import * as THREE from 'three';

export interface PanelButton {
  id: string;
  /** Rectangle in canvas pixels (origin top-left). */
  x: number; y: number; w: number; h: number;
  label: string;
  /** Lit (e.g. a selected floor). */
  active?: boolean;
  disabled?: boolean;
  /** Round button (elevator style) instead of a rounded rectangle. */
  round?: boolean;
}

export interface PanelStyle {
  background: string;
  border: string;
  button: string;
  buttonHover: string;
  buttonActive: string;
  text: string;
  textActive: string;
  font: string;
}

const DEFAULT_STYLE: PanelStyle = {
  background: '#1b1e22', border: '#5c636b', button: '#2c3137', buttonHover: '#3d444c', buttonActive: '#d8a23a',
  text: '#d9dee3', textActive: '#1a1206', font: '600 {px}px system-ui, "Segoe UI", sans-serif',
};

export class WorldPanel {
  readonly object = new THREE.Group();
  readonly mesh: THREE.Mesh;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  buttons: PanelButton[] = [];
  style: PanelStyle;
  /** Extra drawing (background content, readouts) after the base, before the buttons. */
  paint: ((ctx: CanvasRenderingContext2D, p: WorldPanel) => void) | null = null;
  /** Button pressed (id), or a press on the surface (id = null) with canvas coordinates. */
  onPress: ((id: string | null, x: number, y: number) => void) | null = null;
  /** Panels can be switched off without removing them (no hits, not drawn). */
  enabled = true;
  hover: string | null = null;
  private flash: string | null = null;
  private flashT = 0;
  private tex: THREE.CanvasTexture;
  private dirty = true;

  constructor(readonly widthM: number, readonly heightM: number, pxPerM = 640, style: Partial<PanelStyle> = {}) {
    this.width = Math.max(32, Math.round(widthM * pxPerM));
    this.height = Math.max(32, Math.round(heightM * pxPerM));
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d')!;
    this.style = { ...DEFAULT_STYLE, ...style };
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    const mat = new THREE.MeshBasicMaterial({ map: this.tex });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(widthM, heightM), mat);
    this.mesh.userData.worldPanel = this;
    this.object.add(this.mesh);
    // A thin backing plate so the panel reads as a physical object from the side.
    const back = new THREE.Mesh(new THREE.BoxGeometry(widthM + 0.02, heightM + 0.02, 0.012), plateMaterial());
    back.position.z = -0.007;
    this.object.add(back);
  }

  /** Turn the readable face towards world direction (dx, dz). */
  faceTowards(dx: number, dz: number): void {
    this.object.rotation.y = Math.atan2(dx, dz);
  }

  invalidate(): void { this.dirty = true; }

  setHover(id: string | null): void {
    if (id !== this.hover) { this.hover = id; this.dirty = true; }
  }

  /** Called by the PanelManager with the hit uv (0..1, origin bottom-left). */
  press(u: number, v: number): void {
    const x = u * this.width, y = (1 - v) * this.height;
    const b = this.buttonAt(x, y);
    if (b && !b.disabled) { this.flash = b.id; this.flashT = performance.now(); this.dirty = true; }
    this.onPress?.(b && !b.disabled ? b.id : null, x, y);
  }

  buttonAt(x: number, y: number): PanelButton | null {
    for (const b of this.buttons) if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
    return null;
  }

  buttonAtUV(u: number, v: number): PanelButton | null {
    return this.buttonAt(u * this.width, (1 - v) * this.height);
  }

  /** Redraw if something changed (cheap to call every frame). */
  update(): void {
    if (this.flash && performance.now() - this.flashT > 180) { this.flash = null; this.dirty = true; }
    if (!this.dirty) return;
    this.dirty = false;
    const c = this.ctx, s = this.style, W = this.width, H = this.height;
    c.clearRect(0, 0, W, H);
    c.fillStyle = s.background;
    roundRect(c, 1, 1, W - 2, H - 2, Math.min(W, H) * 0.06);
    c.fill();
    c.strokeStyle = s.border;
    c.lineWidth = Math.max(2, W * 0.012);
    c.stroke();
    this.paint?.(c, this);
    for (const b of this.buttons) {
      const lit = b.active || this.flash === b.id;
      c.fillStyle = lit ? s.buttonActive : this.hover === b.id && !b.disabled ? s.buttonHover : s.button;
      if (b.round) {
        c.beginPath();
        c.arc(b.x + b.w / 2, b.y + b.h / 2, Math.min(b.w, b.h) / 2, 0, Math.PI * 2);
      } else roundRect(c, b.x, b.y, b.w, b.h, Math.min(b.w, b.h) * 0.18);
      c.fill();
      c.strokeStyle = this.hover === b.id ? '#e8eef4' : s.border;
      c.lineWidth = Math.max(1.5, Math.min(b.w, b.h) * 0.05);
      c.stroke();
      c.fillStyle = lit ? s.textActive : b.disabled ? '#6b7177' : s.text;
      c.font = s.font.replace('{px}', String(Math.round(Math.min(b.h * 0.5, b.w * 0.42))));
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 1);
    }
    this.tex.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.tex.dispose();
    this.object.traverse((o) => { if (o !== this.mesh && (o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose(); });
  }
}

let plate: THREE.Material | null = null;
function plateMaterial(): THREE.Material {
  return plate ??= new THREE.MeshStandardMaterial({ color: 0x8a9096, metalness: 0.85, roughness: 0.35 });
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
