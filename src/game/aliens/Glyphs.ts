/**
 * Glowing alien glyphs the runaway teens draw on facades with their beam (ALIENS_PLAN §5): big
 * symmetric marks of rings, arcs, bars and dots in a gaudy colour, drawn in over a few seconds,
 * glowing on long after the saucer has gone, then fading. A few canvases of strokes are made once
 * and shared; each glyph is a quad just off the wall.
 */
import * as THREE from 'three';

const KINDS = 6;
/** Most glyphs in the city at once (the oldest goes first). */
const MAX = 14;

let textures: THREE.CanvasTexture[] | null = null;

/** A glyph's strokes (white on transparent), seeded. */
function drawGlyph(seed: number): THREE.CanvasTexture {
  const S = 256, c = document.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d')!;
  let s = seed * 9301 + 49297;
  const r = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  x.strokeStyle = '#fff'; x.fillStyle = '#fff';
  x.lineCap = 'round';
  x.shadowColor = '#fff'; x.shadowBlur = 10;
  x.translate(S / 2, S / 2);
  // An outer ring (broken now and then), inner arcs, spokes, dots: mirrored left to right.
  x.lineWidth = 9;
  const R = 100;
  x.beginPath(); x.arc(0, 0, R, -Math.PI / 2 + 0.3 * r(), Math.PI * 1.5 - (r() < 0.5 ? 0.6 : 0)); x.stroke();
  for (let k = 0; k < 3; k++) {
    x.lineWidth = 6 + r() * 6;
    const rr = 25 + r() * 60, a0 = r() * Math.PI, a1 = a0 + 0.6 + r() * 1.6;
    for (const m of [1, -1]) { x.save(); x.scale(m, 1); x.beginPath(); x.arc(0, (r() - 0.5) * 30, rr, a0, a1); x.stroke(); x.restore(); }
  }
  for (let k = 0; k < 2 + Math.floor(r() * 3); k++) {
    x.lineWidth = 7;
    const a = r() * Math.PI, l0 = 15 + r() * 30, l1 = l0 + 25 + r() * 50;
    for (const m of [1, -1]) {
      x.beginPath(); x.moveTo(Math.cos(a) * l0 * m, Math.sin(a) * l0 - 20); x.lineTo(Math.cos(a) * l1 * m, Math.sin(a) * l1 - 20); x.stroke();
    }
  }
  for (let k = 0; k < 3 + Math.floor(r() * 4); k++) {
    const a = r() * Math.PI, d = 30 + r() * 70, rad = 5 + r() * 7;
    for (const m of [1, -1]) { x.beginPath(); x.arc(Math.cos(a) * d * m, Math.sin(a) * d - 10, rad, 0, Math.PI * 2); x.fill(); }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** The gaudy colours the teens' beam draws in. */
export const TEEN_COLOURS = [new THREE.Color(1.6, 0.25, 1.3), new THREE.Color(0.3, 1.7, 0.6), new THREE.Color(1.7, 1.4, 0.2), new THREE.Color(0.2, 1.3, 1.8)];

interface Glyph { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; t: number; drawT: number; until: number; flick: number }

export class Glyphs {
  readonly group = new THREE.Group();
  private list: Glyph[] = [];
  private geo = new THREE.PlaneGeometry(1, 1);
  private time = 0;

  /**
   * A glyph on a wall: centre (x, y, z), the wall's outward normal (nx, nz), size (m), drawn in
   * over `drawT` s, glowing for `secs` s.
   */
  add(x: number, y: number, z: number, nx: number, nz: number, size: number, seed: number, colour: THREE.Color, drawT: number, secs: number): void {
    textures ??= Array.from({ length: KINDS }, (_, i) => drawGlyph(i * 7 + 3));
    if (this.list.length >= MAX) this.remove(0);
    const mat = new THREE.MeshBasicMaterial({
      map: textures[Math.abs(seed) % KINDS], color: colour.clone(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this.geo, mat);
    mesh.position.set(x + nx * 0.12, y, z + nz * 0.12);
    mesh.rotation.y = Math.atan2(nx, nz);
    mesh.scale.set(size, size, 1);
    mesh.renderOrder = 5;
    this.group.add(mesh);
    this.list.push({ mesh, mat, t: 0, drawT, until: drawT + secs, flick: seed % 13 });
  }

  /** How many are glowing now. */
  get count(): number { return this.list.length; }

  update(dt: number, night: number): void {
    this.time += dt;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const g = this.list[i];
      g.t += dt;
      if (g.t > g.until + 20) { this.remove(i); continue; }
      // Drawn in (grows a little as it brightens), a slow pulse, fading at the end; brighter at night.
      const draw = Math.min(1, g.t / g.drawT);
      const fade = 1 - Math.min(1, Math.max(0, (g.t - g.until) / 20));
      const pulse = 0.8 + 0.2 * Math.sin(this.time * 2.3 + g.flick);
      g.mat.opacity = draw * fade * pulse * (0.55 + 0.45 * night);
      const s = g.mesh.scale.x;
      g.mesh.scale.y = s * (0.6 + 0.4 * draw);
    }
  }

  private remove(i: number): void {
    const g = this.list[i];
    g.mesh.removeFromParent();
    g.mat.dispose();
    this.list.splice(i, 1);
  }
}
