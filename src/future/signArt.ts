/**
 * Procedural art atlas for the animated signage (fictional brands only), drawn once on a
 * 2048² canvas:
 *  - y    0–1023: 32 shop fascias, 512×128 (4 columns × 8 rows); cells 28–31 are seamless tickers
 *  - y 1024–1535: 12 vertical blade signs, 128×512 (x 0–1535) and 4 hologram cells, 256×256
 *                 (x 1536–2047, 2 × 2)
 *  - y 1536–2047: 8 billboard slides, 512×256 (4 × 2), cycled by the screen shader
 */
import * as THREE from 'three';
import { Rng } from '../core/rng';

export const ART = { size: 2048, fascias: 32, tickers: [28, 29, 30, 31], blades: 12, holos: 4, slides: 8 };

/** uv rect (u0, v0, u1, v1) of a cell (flipY: canvas top = v 1). */
function rect(x: number, y: number, w: number, h: number): [number, number, number, number] {
  const S = ART.size, m = 1.5;
  return [(x + m) / S, 1 - (y + h - m) / S, (x + w - m) / S, 1 - (y + m) / S];
}
export const fasciaRect = (i: number) => rect((i % 4) * 512, Math.floor(i / 4) * 128, 512, 128);
export const bladeRect = (i: number) => rect(i * 128, 1024, 128, 512);
export const holoRect = (i: number) => rect(1536 + (i % 2) * 256, 1024 + Math.floor(i / 2) * 256, 256, 256);
export const slideRect = (i: number) => rect((i % 4) * 512, 1536 + Math.floor(i / 4) * 256, 512, 256);

interface Brand { name: string; hue: number; glyph: number; light?: boolean }
const BRANDS: Brand[] = [
  { name: 'KIKO NOODLES', hue: 12, glyph: 0 }, { name: 'FERNWAY COFFEE', hue: 30, glyph: 1, light: true }, { name: 'ORBIT MOBILE', hue: 200, glyph: 2 },
  { name: 'HELIX BANK', hue: 160, glyph: 3, light: true }, { name: 'LUMEN OPTICS', hue: 50, glyph: 4 }, { name: 'PARCELO', hue: 175, glyph: 5 },
  { name: 'BLOOM GROCER', hue: 110, glyph: 6, light: true }, { name: 'QUANTA FIT', hue: 280, glyph: 2 }, { name: 'SORA SUSHI', hue: 350, glyph: 0 },
  { name: 'PIXEL ARCADE', hue: 300, glyph: 7 }, { name: 'NOVA PHARMACY', hue: 140, glyph: 8 }, { name: 'VOLTA E-BIKES', hue: 70, glyph: 9 },
  { name: 'ATLAS INSURANCE', hue: 215, glyph: 3, light: true }, { name: 'MOSAIC BOOKS', hue: 25, glyph: 7, light: true }, { name: 'TIDE LAUNDRY', hue: 190, glyph: 10 },
  { name: 'CIRRUS CLOUD', hue: 205, glyph: 10 }, { name: 'MAPLE & CO', hue: 5, glyph: 6, light: true }, { name: 'ZEPHYR TRAVEL', hue: 185, glyph: 9 },
  { name: 'KAIROS WATCHES', hue: 40, glyph: 1 }, { name: 'ECHO AUDIO', hue: 260, glyph: 4 }, { name: 'GRAIN BAKERY', hue: 35, glyph: 6, light: true },
  { name: 'NIMBUS AIR', hue: 210, glyph: 10 }, { name: 'VERDE SALADS', hue: 120, glyph: 6 }, { name: 'HALO DENTAL', hue: 180, glyph: 2, light: true },
  { name: 'POLARIS REALTY', hue: 230, glyph: 8 }, { name: 'OKAMI RAMEN', hue: 0, glyph: 0 }, { name: 'LUNA FLORIST', hue: 320, glyph: 4 },
  { name: 'AXON CLINIC', hue: 195, glyph: 8, light: true },
];
const TICKERS = ['OPEN 24/7  •  DRONE DELIVERY IN 12 MIN  •  ', 'FRESH RAMEN  •  HOT BOWLS  •  ORDER AHEAD  •  ', 'METRO M2  ARRIVING 3 MIN  •  M5  6 MIN  •  ', 'CHARGE & GO  •  E-BIKES  •  SCOOTERS  •  '];
const BLADES: [string, number][] = [['HOTEL', 45], ['RAMEN', 8], ['BAR', 300], ['CAFE', 30], ['CINEMA', 350], ['SUSHI', 190], ['GYM', 280], ['BOOKS', 40], ['DENTAL', 180], ['KARAOKE', 320], ['24H', 140], ['TAXI', 52]];
const SLIDES: { head: string; sub: string; brand: string; h0: number; h1: number }[] = [
  { head: 'TALK TO THE FUTURE', sub: 'the new O7 handset — all day battery', brand: 'ORBIT', h0: 215, h1: 265 },
  { head: 'RIDE THE CITY', sub: 'e-bikes from 1 credit per minute', brand: 'VOLTA', h0: 70, h1: 140 },
  { head: 'QUIETLY SMART', sub: 'banking that keeps out of your way', brand: 'HELIX BANK', h0: 165, h1: 210 },
  { head: 'FLY DIRECT', sub: 'every hour to the coast', brand: 'NIMBUS AIR', h0: 195, h1: 30 },
  { head: 'METRO EVERY 3 MIN', sub: 'leave the car - take the line', brand: 'CITY TRANSIT', h0: 45, h1: 15 },
  { head: 'SUSHI BY DRONE', sub: 'at your window in 12 minutes', brand: 'SORA', h0: 345, h1: 300 },
  { head: 'STRONGER EVERY DAY', sub: 'first month free at all studios', brand: 'QUANTA FIT', h0: 275, h1: 320 },
  { head: 'LOOK UP', sub: 'the observation deck reopens', brand: 'SKYLINE 360', h0: 230, h1: 190 },
];

let atlas: THREE.CanvasTexture | null = null;

export function signAtlas(): THREE.CanvasTexture {
  if (atlas) return atlas;
  const S = ART.size;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  const rng = Rng.from('signart');
  const clip = (x: number, y: number, w: number, h: number, fn: () => void) => { g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip(); g.translate(x, y); fn(); g.restore(); };
  const fit = (s: string, maxW: number, size: number, weight = '700', font = 'Arial, Helvetica, sans-serif') => {
    g.font = `${weight} ${size}px ${font}`;
    const w = g.measureText(s).width;
    if (w > maxW) { size = Math.floor(size * maxW / w); g.font = `${weight} ${size}px ${font}`; }
    return size;
  };
  const glow = (col: string, blur: number) => { g.shadowColor = col; g.shadowBlur = blur; };
  const noGlow = () => { g.shadowBlur = 0; };
  // ---- fascias
  for (let i = 0; i < 28; i++) {
    const b = BRANDS[i];
    clip((i % 4) * 512, Math.floor(i / 4) * 128, 512, 128, () => {
      const c = `hsl(${b.hue},85%,60%)`;
      if (b.light) {
        // Backlit light box: white face, brand colour lettering.
        const gr = g.createLinearGradient(0, 0, 0, 128);
        gr.addColorStop(0, '#f4f6f8'); gr.addColorStop(1, '#d9dde2');
        g.fillStyle = gr; g.fillRect(0, 0, 512, 128);
        g.fillStyle = `hsl(${b.hue},70%,32%)`;
        glyph(g, b.glyph, 64, 64, 34, `hsl(${b.hue},70%,38%)`);
        fit(b.name, 360, 52);
        g.textBaseline = 'middle';
        g.fillText(b.name, 116, 68);
      } else {
        const gr = g.createLinearGradient(0, 0, 512, 128);
        gr.addColorStop(0, '#04060a'); gr.addColorStop(1, `hsl(${b.hue},40%,8%)`);
        g.fillStyle = gr; g.fillRect(0, 0, 512, 128);
        glow(c, 14);
        glyph(g, b.glyph, 64, 64, 36, c);
        g.fillStyle = '#ffffff';
        fit(b.name, 360, 54);
        g.textBaseline = 'middle';
        glow(c, 18);
        g.fillText(b.name, 116, 68);
        noGlow();
        g.fillStyle = c; g.fillRect(116, 104, 120, 4);
      }
    });
  }
  // ---- tickers (seamless: the text is laid twice over the cell width)
  ART.tickers.forEach((cell, k) => {
    clip((cell % 4) * 512, Math.floor(cell / 4) * 128, 512, 128, () => {
      g.fillStyle = '#020304'; g.fillRect(0, 0, 512, 128);
      const hue = [30, 0, 50, 110][k];
      const s = TICKERS[k];
      g.font = '700 46px Arial, Helvetica, sans-serif';
      const w = g.measureText(s).width;
      g.save();
      g.scale(512 / w, 1);
      g.fillStyle = `hsl(${hue},100%,62%)`;
      glow(`hsl(${hue},100%,55%)`, 10);
      g.textBaseline = 'middle';
      g.fillText(s, 0, 66);
      g.restore();
      noGlow();
      // LED dot matrix look.
      g.fillStyle = 'rgba(0,0,0,0.5)';
      for (let x = 0; x < 512; x += 4) g.fillRect(x, 0, 1, 128);
      for (let y = 0; y < 128; y += 4) g.fillRect(0, y, 512, 1);
    });
  });
  // ---- blades (vertical letters)
  BLADES.forEach(([word, hue], i) => {
    clip(i * 128, 1024, 128, 512, () => {
      g.fillStyle = '#05060a'; g.fillRect(0, 0, 128, 512);
      g.strokeStyle = `hsl(${hue},90%,60%)`; g.lineWidth = 4;
      g.strokeRect(8, 8, 112, 496);
      const n = word.length;
      const step = Math.min(84, 470 / n);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `700 ${Math.floor(step * 0.86)}px Arial, Helvetica, sans-serif`;
      glow(`hsl(${hue},100%,60%)`, 16);
      g.fillStyle = `hsl(${hue},100%,78%)`;
      for (let k = 0; k < n; k++) g.fillText(word[k], 64, 256 + (k - (n - 1) / 2) * step);
      noGlow();
      g.textAlign = 'start';
    });
  });
  // ---- holograms (on black: the shader turns brightness into opacity)
  const holo = (i: number, fn: () => void) => clip(1536 + (i % 2) * 256, 1024 + Math.floor(i / 2) * 256, 256, 256, () => {
    g.fillStyle = '#000'; g.fillRect(0, 0, 256, 256);
    g.strokeStyle = '#bff'; g.fillStyle = '#bff'; g.lineWidth = 3;
    glow('#7ff', 10);
    fn();
    noGlow();
  });
  holo(0, () => { // wireframe globe + CITY INFO
    for (let k = -2; k <= 2; k++) { g.beginPath(); g.ellipse(128, 104, 70, Math.abs(k) * 22 + 0.1, 0, 0, Math.PI * 2); g.stroke(); }
    for (let k = 0; k < 4; k++) { g.beginPath(); g.ellipse(128, 104, (k / 3) * 70 + 0.1, 70, 0, 0, Math.PI * 2); g.stroke(); }
    g.textAlign = 'center'; g.font = '700 30px Arial, Helvetica, sans-serif'; g.fillText('CITY INFO', 128, 216); g.textAlign = 'start';
  });
  holo(1, () => { // map pin
    g.beginPath(); g.arc(128, 90, 46, Math.PI * 0.85, Math.PI * 2.15); g.lineTo(128, 186); g.closePath(); g.stroke();
    g.beginPath(); g.arc(128, 90, 16, 0, Math.PI * 2); g.fill();
    g.textAlign = 'center'; g.font = '700 26px Arial, Helvetica, sans-serif'; g.fillText('YOU ARE HERE', 128, 226); g.textAlign = 'start';
  });
  holo(2, () => { // ORBIT ring logo
    g.lineWidth = 6;
    g.beginPath(); g.ellipse(128, 100, 74, 26, -0.4, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(128, 100, 30, 0, Math.PI * 2); g.fill();
    g.textAlign = 'center'; g.font = '700 40px Arial, Helvetica, sans-serif'; g.fillText('ORBIT', 128, 212); g.textAlign = 'start';
  });
  holo(3, () => { // VOLTA bolt
    g.beginPath(); g.moveTo(146, 30); g.lineTo(92, 118); g.lineTo(128, 118); g.lineTo(108, 186); g.lineTo(168, 92); g.lineTo(132, 92); g.closePath(); g.fill();
    g.textAlign = 'center'; g.font = '700 40px Arial, Helvetica, sans-serif'; g.fillText('VOLTA', 128, 228); g.textAlign = 'start';
  });
  // ---- billboard slides
  SLIDES.forEach((s, i) => {
    clip((i % 4) * 512, 1536 + Math.floor(i / 4) * 256, 512, 256, () => {
      const gr = g.createLinearGradient(0, 0, 512, 256);
      gr.addColorStop(0, `hsl(${s.h0},70%,22%)`); gr.addColorStop(1, `hsl(${s.h1},75%,10%)`);
      g.fillStyle = gr; g.fillRect(0, 0, 512, 256);
      const r = rng.fork('slide', i);
      for (let k = 0; k < 5; k++) {
        g.beginPath();
        g.arc(r.range(260, 520), r.range(-20, 270), r.range(40, 140), 0, Math.PI * 2);
        g.fillStyle = `hsla(${s.h1 + r.range(-30, 30)},80%,${r.range(35, 60)}%,0.18)`;
        g.fill();
      }
      g.fillStyle = '#fff';
      g.textBaseline = 'alphabetic';
      fit(s.head, 440, 54, '800');
      g.fillText(s.head, 32, 112);
      g.fillStyle = 'rgba(255,255,255,0.8)';
      fit(s.sub, 440, 24, '400');
      g.fillText(s.sub, 32, 152);
      g.fillStyle = `hsl(${s.h0},90%,70%)`;
      g.fillRect(32, 186, 46, 6);
      g.fillStyle = '#fff';
      fit(s.brand, 300, 30, '700');
      g.fillText(s.brand, 32, 228);
    });
  });
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  atlas = t;
  return t;
}

/** Simple brand marks. */
function glyph(g: CanvasRenderingContext2D, k: number, x: number, y: number, r: number, col: string): void {
  g.save();
  g.translate(x, y);
  g.fillStyle = col; g.strokeStyle = col; g.lineWidth = r * 0.22;
  g.beginPath();
  switch (k % 11) {
    case 0: g.arc(0, 0, r, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.arc(0, 0, r * 0.45, 0, Math.PI * 2); g.fill(); break; // bowl / target
    case 1: g.arc(0, 0, r, 0.2, Math.PI * 1.8); g.stroke(); break; // C-mark
    case 2: g.ellipse(0, 0, r, r * 0.38, -0.5, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.arc(0, 0, r * 0.32, 0, Math.PI * 2); g.fill(); break; // orbit
    case 3: for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); } g.closePath(); g.stroke(); break; // hexagon
    case 4: g.arc(0, 0, r, 0, Math.PI * 2); g.fill(); g.globalCompositeOperation = 'destination-out'; g.beginPath(); g.arc(r * 0.35, -r * 0.2, r * 0.75, 0, Math.PI * 2); g.fill(); break; // crescent
    case 5: g.rect(-r * 0.8, -r * 0.6, r * 1.6, r * 1.2); g.stroke(); g.beginPath(); g.moveTo(-r * 0.8, -r * 0.1); g.lineTo(r * 0.8, -r * 0.1); g.stroke(); break; // parcel
    case 6: for (let i = 0; i < 5; i++) { g.save(); g.rotate((i / 5) * Math.PI * 2); g.beginPath(); g.ellipse(0, -r * 0.5, r * 0.25, r * 0.5, 0, 0, Math.PI * 2); g.fill(); g.restore(); } break; // flower
    case 7: g.rect(-r * 0.7, -r * 0.7, r * 1.4, r * 1.4); g.fill(); g.clearRect(-r * 0.25, -r * 0.25, r * 0.5, r * 0.5); break; // pixel block
    case 8: g.rect(-r * 0.22, -r * 0.8, r * 0.44, r * 1.6); g.rect(-r * 0.8, -r * 0.22, r * 1.6, r * 0.44); g.fill(); break; // cross
    case 9: g.moveTo(r * 0.2, -r); g.lineTo(-r * 0.5, r * 0.15); g.lineTo(0, r * 0.15); g.lineTo(-r * 0.2, r); g.lineTo(r * 0.55, -r * 0.2); g.lineTo(0, -r * 0.2); g.closePath(); g.fill(); break; // bolt
    default: for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(-r, -r * 0.4 + i * r * 0.4); g.bezierCurveTo(-r * 0.3, -r * 0.8 + i * r * 0.4, r * 0.3, i * r * 0.4, r, -r * 0.4 + i * r * 0.4); g.stroke(); } break; // waves
  }
  g.restore();
}
