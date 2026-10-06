/**
 * City news cards for the big billboards (game/news): a canvas of NEWS_CARDS cards, 512 × 256
 * each (two across, four down), redrawn when the news changes. The billboards' slide shows put a
 * card up in two of their eight slots (Signs shader, `uCards`).
 *
 * A card: a colour band with the story's kind (CITY NEWS · POLICE · HERO · CRIME ALERT), the
 * headline in large letters (two lines at most), the neighbourhood and time small underneath; the
 * last card of a set is the area report (the player's neighbourhood: crime level and police).
 */
import * as THREE from 'three';

export const NEWS_CARDS = 8;
const CW = 512, CH = 256;

export interface NewsCard {
  /** Band colour and its word. */
  kind: 'crime' | 'police' | 'hero' | 'city' | 'area';
  head: string;
  sub: string;
  /** Area report: the crime level 0..1 drawn as a bar. */
  level?: number;
}

const BAND: Record<NewsCard['kind'], [string, string]> = {
  crime: ['#d8342b', 'CRIME ALERT'],
  police: ['#2f6fd6', 'POLICE NEWS'],
  hero: ['#e8a91c', 'HERO WATCH'],
  city: ['#2c9a6a', 'CITY NEWS'],
  area: ['#6b4bd1', 'YOUR AREA'],
};

export class NewsArt {
  readonly texture: THREE.CanvasTexture;
  private g: CanvasRenderingContext2D;
  /** Cards drawn (0: none — the billboards show their ads only). */
  count = 0;
  private key = '';

  constructor() {
    const cv = document.createElement('canvas');
    cv.width = CW * 2;
    cv.height = CH * 4;
    this.g = cv.getContext('2d')!;
    this.g.fillStyle = '#000';
    this.g.fillRect(0, 0, cv.width, cv.height);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture = t;
  }

  /** Draw a set of cards (at most NEWS_CARDS); nothing happens when it is the same set. */
  set(cards: readonly NewsCard[]): void {
    const list = cards.slice(0, NEWS_CARDS);
    const key = list.map((c) => `${c.kind}|${c.head}|${c.sub}|${c.level?.toFixed(2) ?? ''}`).join('\n');
    if (key === this.key) return;
    this.key = key;
    list.forEach((c, i) => this.card(i, c));
    this.count = list.length;
    this.texture.needsUpdate = true;
  }

  private card(i: number, c: NewsCard): void {
    const g = this.g, x0 = (i % 2) * CW, y0 = Math.floor(i / 2) * CH;
    const [col, word] = BAND[c.kind];
    g.save();
    g.beginPath();
    g.rect(x0, y0, CW, CH);
    g.clip();
    const bg = g.createLinearGradient(0, y0, 0, y0 + CH);
    bg.addColorStop(0, '#10161f');
    bg.addColorStop(1, '#05080c');
    g.fillStyle = bg;
    g.fillRect(x0, y0, CW, CH);
    // Band.
    g.fillStyle = col;
    g.fillRect(x0, y0, CW, 46);
    g.fillStyle = '#fff';
    g.font = '800 28px system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillText(word, x0 + 18, y0 + 24);
    g.textAlign = 'right';
    g.font = '700 22px system-ui, sans-serif';
    g.fillText('● LIVE', x0 + CW - 16, y0 + 24);
    // Headline: two lines at most, as large as fits.
    g.textAlign = 'left';
    g.fillStyle = '#f4f6f8';
    let size = 46, lines: string[] = [];
    for (; size >= 28; size -= 3) {
      g.font = `800 ${size}px system-ui, sans-serif`;
      lines = wrap(g, c.head, CW - 36);
      if (lines.length <= 2) break;
    }
    lines = lines.slice(0, 2);
    const lh = size * 1.12, top = y0 + 46 + (c.level !== undefined ? 22 : 30) + size * 0.5;
    lines.forEach((l, k) => g.fillText(l, x0 + 18, top + k * lh));
    // Area report: a bar from green to red with a marker.
    if (c.level !== undefined) {
      const by = y0 + CH - 74, bw = CW - 36;
      const gr = g.createLinearGradient(x0 + 18, 0, x0 + 18 + bw, 0);
      gr.addColorStop(0, '#2fbf71'); gr.addColorStop(0.45, '#e6c229'); gr.addColorStop(1, '#e03b2c');
      g.fillStyle = gr;
      g.fillRect(x0 + 18, by, bw, 14);
      const mx = x0 + 18 + bw * Math.max(0, Math.min(1, c.level));
      g.fillStyle = '#fff';
      g.beginPath(); g.moveTo(mx, by - 2); g.lineTo(mx - 9, by - 16); g.lineTo(mx + 9, by - 16); g.closePath(); g.fill();
    }
    g.fillStyle = '#9fb0c2';
    g.font = '600 24px system-ui, sans-serif';
    g.fillText(c.sub, x0 + 18, y0 + CH - 28);
    g.restore();
  }
}

function wrap(g: CanvasRenderingContext2D, s: string, w: number): string[] {
  const words = s.split(' '), out: string[] = [];
  let line = '';
  for (const wd of words) {
    const t = line ? `${line} ${wd}` : wd;
    if (g.measureText(t).width > w && line) { out.push(line); line = wd; } else line = t;
  }
  if (line) out.push(line);
  return out;
}
