/**
 * Name boards of cafés and restaurants (plan/eatery.ts): one 1024² canvas of 32 slots of
 * 512 × 64 (2 columns × 16 rows). Slots 0–7 are fixed generic boards per kind ("CAFÉ",
 * "PIZZERIA", …) for eateries farther away; slots 8–31 hold the real names of the nearest ones
 * and are reassigned as the player moves (least recently used first). The canvas is uploaded
 * at most once a second, only when a slot was redrawn. Drawn by the sign shader (Signs).
 */
import * as THREE from 'three';
import { Eatery, EATERY, EATERY_KINDS } from '../plan/eatery';
import { TERRACE_PALETTE } from '../plan/terrace';

const SLOT_W = 512, SLOT_H = 64, COLS = 2, ROWS = 16;
const FIRST_NAMED = EATERY_KINDS;
export const NAME_SLOTS = COLS * ROWS - FIRST_NAMED;

/** uv rect (u0, v0, u1, v1) of a slot (flipY: canvas top = v 1). */
function slotRect(i: number): [number, number, number, number] {
  const S = 1024, m = 1.5, x = (i % COLS) * SLOT_W, y = Math.floor(i / COLS) * SLOT_H;
  return [(x + m) / S, 1 - (y + SLOT_H - m) / S, (x + SLOT_W - m) / S, 1 - (y + m) / S];
}

const css = (c: [number, number, number], k = 1) => `rgb(${Math.round(c[0] * k * 255)},${Math.round(c[1] * k * 255)},${Math.round(c[2] * k * 255)})`;

export class NameAtlas {
  readonly texture: THREE.CanvasTexture;
  private g: CanvasRenderingContext2D;
  /** Named slot → key of the eatery shown there, and when it was last wanted. */
  private owner: (number | null)[] = new Array(NAME_SLOTS).fill(null);
  private used: number[] = new Array(NAME_SLOTS).fill(-1);
  private slotOf = new Map<number, number>();
  private dirty = false;
  private lastUpload = -1e9;
  private frame = 0;

  constructor() {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1024;
    this.g = cv.getContext('2d')!;
    this.g.fillStyle = '#000';
    this.g.fillRect(0, 0, 1024, 1024);
    for (let k = 1; k < EATERY_KINDS; k++) this.draw(k, kindWord(k as Eatery), k as Eatery, k === Eatery.Bar ? 6 : k === Eatery.Pizzeria ? 2 : k === Eatery.IceCream ? 7 : 1);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture = t;
  }

  /** Generic board of a kind (far away). */
  generic(kind: Eatery): [number, number, number, number] { return slotRect(kind); }

  /** Start of an assignment pass (one per Signs.fill). */
  begin(): void { this.frame++; }

  /** The named board of an eatery (key unique per eatery), drawn into a free slot when needed; null when all slots are taken this pass. */
  named(key: number, name: string, kind: Eatery, palette: number): [number, number, number, number] | null {
    let s = this.slotOf.get(key);
    if (s === undefined) {
      // Least recently wanted slot not wanted in this pass.
      let best = -1, bu = Infinity;
      for (let i = 0; i < NAME_SLOTS; i++) if (this.used[i] < this.frame && this.used[i] < bu) { bu = this.used[i]; best = i; }
      if (best < 0) return null;
      const old = this.owner[best];
      if (old !== null) this.slotOf.delete(old);
      this.owner[best] = key;
      this.slotOf.set(key, best);
      this.draw(FIRST_NAMED + best, name, kind, palette);
      this.dirty = true;
      s = best;
    }
    this.used[s] = this.frame;
    return slotRect(FIRST_NAMED + s);
  }

  /** Upload redrawn slots (throttled). */
  flush(now: number): void {
    if (!this.dirty || now - this.lastUpload < 1) return;
    this.dirty = false;
    this.lastUpload = now;
    this.texture.needsUpdate = true;
  }

  private draw(slot: number, text: string, kind: Eatery, palette: number): void {
    const g = this.g;
    const x0 = (slot % COLS) * SLOT_W, y0 = Math.floor(slot / COLS) * SLOT_H;
    const pal = TERRACE_PALETTE[palette % TERRACE_PALETTE.length][0];
    const light = pal[0] + pal[1] + pal[2] > 2.2;
    g.save();
    g.beginPath(); g.rect(x0, y0, SLOT_W, SLOT_H); g.clip();
    g.translate(x0, y0);
    // A painted board in the café's colour (a dark board for light schemes), a thin gilt rim.
    const bg = light ? [0.1, 0.11, 0.1] as [number, number, number] : pal;
    const gr = g.createLinearGradient(0, 0, 0, SLOT_H);
    gr.addColorStop(0, css(bg, 0.62)); gr.addColorStop(1, css(bg, 0.42));
    g.fillStyle = gr; g.fillRect(0, 0, SLOT_W, SLOT_H);
    g.strokeStyle = kind === Eatery.Bar ? 'rgba(255,170,90,0.9)' : 'rgba(225,195,120,0.85)';
    g.lineWidth = 3; g.strokeRect(4, 4, SLOT_W - 8, SLOT_H - 8);
    const ink = kind === Eatery.Bar ? '#ffc98a' : '#f3e6c4';
    icon(g, kind, 36, SLOT_H / 2, 17, ink);
    const serif = kind === Eatery.Cafe || kind === Eatery.Bistro || kind === Eatery.Restaurant || kind === Eatery.Bakery;
    const font = serif ? 'Georgia, "Times New Roman", serif' : 'Arial, Helvetica, sans-serif';
    let size = 38;
    g.font = `${serif ? 'italic 600' : '700'} ${size}px ${font}`;
    const maxW = SLOT_W - 96;
    const w = g.measureText(text).width;
    if (w > maxW) { size = Math.floor(size * maxW / w); g.font = `${serif ? 'italic 600' : '700'} ${size}px ${font}`; }
    g.fillStyle = ink;
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    if (kind === Eatery.Bar) { g.shadowColor = '#ff9a40'; g.shadowBlur = 10; }
    g.fillText(text, (SLOT_W + 60) / 2, SLOT_H / 2 + 2);
    g.restore();
  }
}

function kindWord(k: Eatery): string {
  return k === Eatery.Cafe ? 'CAFÉ' : k === Eatery.IceCream ? 'GELATO' : (EATERY[k]?.label ?? '').toUpperCase();
}

/** Small marks: a cup, cutlery, a croissant, a pizza slice, a cone, a glass. */
function icon(g: CanvasRenderingContext2D, k: Eatery, x: number, y: number, r: number, col: string): void {
  g.save();
  g.translate(x, y);
  g.strokeStyle = col; g.fillStyle = col; g.lineWidth = r * 0.16; g.lineCap = 'round';
  g.beginPath();
  if (k === Eatery.Cafe || k === Eatery.Bistro) { // cup with steam
    g.moveTo(-r * 0.7, -r * 0.1); g.lineTo(-r * 0.55, r * 0.75); g.lineTo(r * 0.45, r * 0.75); g.lineTo(r * 0.6, -r * 0.1); g.closePath(); g.fill();
    g.beginPath(); g.arc(r * 0.75, r * 0.25, r * 0.25, -1.2, 1.4); g.stroke();
    g.beginPath(); g.moveTo(-r * 0.2, -r * 0.35); g.quadraticCurveTo(-r * 0.45, -r * 0.65, -r * 0.15, -r * 0.95); g.stroke();
    g.beginPath(); g.moveTo(r * 0.2, -r * 0.35); g.quadraticCurveTo(-r * 0.05, -r * 0.65, r * 0.25, -r * 0.95); g.stroke();
  } else if (k === Eatery.Restaurant) { // fork and knife
    g.moveTo(-r * 0.35, -r); g.lineTo(-r * 0.35, r); g.stroke();
    for (const dx of [-0.6, -0.1]) { g.beginPath(); g.moveTo(-r * 0.35 + dx * r * 0.5, -r); g.lineTo(-r * 0.35 + dx * r * 0.5, -r * 0.35); g.stroke(); }
    g.beginPath(); g.moveTo(r * 0.4, r); g.lineTo(r * 0.4, -r); g.quadraticCurveTo(r * 0.85, -r * 0.4, r * 0.4, 0); g.fill(); g.stroke();
  } else if (k === Eatery.Bakery) { // croissant
    g.lineWidth = r * 0.3;
    g.arc(0, r * 0.45, r * 0.85, Math.PI * 1.1, Math.PI * 1.9); g.stroke();
  } else if (k === Eatery.Pizzeria) { // slice
    g.moveTo(0, r); g.lineTo(-r * 0.75, -r * 0.7); g.quadraticCurveTo(0, -r * 1.05, r * 0.75, -r * 0.7); g.closePath(); g.fill();
  } else if (k === Eatery.IceCream) { // cone
    g.moveTo(-r * 0.45, -r * 0.05); g.lineTo(0, r); g.lineTo(r * 0.45, -r * 0.05); g.closePath(); g.fill();
    g.beginPath(); g.arc(0, -r * 0.35, r * 0.45, 0, Math.PI * 2); g.fill();
  } else { // wine glass
    g.moveTo(-r * 0.5, -r); g.quadraticCurveTo(-r * 0.5, 0, 0, r * 0.05); g.quadraticCurveTo(r * 0.5, 0, r * 0.5, -r); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0, r * 0.8); g.moveTo(-r * 0.4, r * 0.85); g.lineTo(r * 0.4, r * 0.85); g.stroke();
  }
  g.restore();
}
