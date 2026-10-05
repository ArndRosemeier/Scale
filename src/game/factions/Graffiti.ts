/**
 * Gang tags on the walls (VILLAINS_PLAN §3.7, "show, don't tell"): a tagger's work appears while
 * they paint (fading in with their progress) and stays when they finish — the group's emblem and
 * name in its colours, sprayed with drips. Kept with the city's turf in saves (newest TAGS.max).
 *
 * One small canvas texture per group, one quad per tag (a few dozen at most), one material setup
 * shared by all (a single shader variant, precompiled through `warmup`).
 */
import * as THREE from 'three';
import { Rng } from '../../core/rng';
import type { Faction } from './Factions';

export const TAGS = { max: 48, w: 1.45, h: 0.9, lift: 0.035 };

/** A tag on a wall: centre point, outward normal, the group (by archetype) and a seed for its look. */
export interface Tag { x: number; y: number; z: number; nx: number; nz: number; archetype: string; seed: number }

const css = (c: [number, number, number]) => `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;

/** The group's tag: its emblem big, the last word of its name in fat sprayed letters, drips. */
function tagCanvas(f: Faction, seed: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 160;
  const g = cv.getContext('2d')!;
  const r = new Rng(seed ^ 0x7a6);
  const fill = css(f.palette.accent), edge = '#101010';
  const word = (f.name.replace(/^the /i, '').split(/\s+/).pop() ?? f.name).replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 8);
  g.translate(128, 84);
  g.rotate((r.float() - 0.5) * 0.18);
  // Overspray haze.
  g.fillStyle = fill;
  g.globalAlpha = 0.12;
  for (let i = 0; i < 70; i++) { g.beginPath(); g.arc((r.float() - 0.5) * 220, (r.float() - 0.5) * 110, 3 + r.float() * 10, 0, Math.PI * 2); g.fill(); }
  g.globalAlpha = 1;
  // The letters: outline, then fill, slanted.
  g.font = `italic 900 ${word.length > 6 ? 46 : 56}px Impact, "Arial Black", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 10;
  g.strokeStyle = edge;
  g.strokeText(word, 0, 18);
  g.fillStyle = fill;
  g.fillText(word, 0, 18);
  // The emblem above, in the outline colour with a fill halo.
  g.font = '900 44px "Segoe UI Symbol", "Noto Sans Symbols", sans-serif';
  g.lineWidth = 6;
  g.strokeStyle = fill;
  g.strokeText(f.emblem, 0, -34);
  g.fillStyle = edge;
  g.fillText(f.emblem, 0, -34);
  // Drips under the letters.
  g.fillStyle = fill;
  for (let i = 0; i < 7; i++) {
    const x = (r.float() - 0.5) * 170, len = 10 + r.float() * 28;
    g.fillRect(x, 38, 2.5, len);
    g.beginPath(); g.arc(x + 1.25, 38 + len, 2.6, 0, Math.PI * 2); g.fill();
  }
  return cv;
}

export class Graffiti {
  readonly group = new THREE.Group();
  /** Finished tags, oldest first (saved). */
  readonly tags: Tag[] = [];
  private meshes: THREE.Mesh[] = [];
  /** Tags being painted, by crime id. */
  private wip = new Map<number, THREE.Mesh>();
  private geo = new THREE.PlaneGeometry(TAGS.w, TAGS.h);
  private mats = new Map<string, THREE.MeshStandardMaterial>();

  constructor(private faction: (archetype: string) => Faction | null) {
    this.group.name = 'graffiti';
  }

  private material(f: Faction, seed: number): THREE.MeshStandardMaterial {
    const key = `${f.archetype}:${seed % 3}`;
    let m = this.mats.get(key);
    if (!m) {
      const tex = new THREE.CanvasTexture(tagCanvas(f, seed % 3));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      m = new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      this.mats.set(key, m);
    }
    return m;
  }

  private mesh(t: Tag, f: Faction): THREE.Mesh {
    // Per-tag material clone only while painting (its opacity fades in); finished tags share one.
    const m = new THREE.Mesh(this.geo, this.material(f, t.seed));
    m.position.set(t.x + t.nx * TAGS.lift, t.y, t.z + t.nz * TAGS.lift);
    m.rotation.y = Math.atan2(t.nx, t.nz);
    m.renderOrder = 2;
    this.group.add(m);
    return m;
  }

  /** A tag in progress (k: 0..1 painted). */
  paint(id: number, t: Tag, k: number): void {
    const f = this.faction(t.archetype);
    if (!f) return;
    let m = this.wip.get(id);
    if (!m) {
      m = this.mesh(t, f);
      m.material = (m.material as THREE.MeshStandardMaterial).clone();
      this.wip.set(id, m);
    }
    (m.material as THREE.MeshStandardMaterial).opacity = Math.max(0.05, Math.min(1, k));
  }

  /** The tagger finished: the tag stays. */
  finish(id: number, t: Tag): void {
    this.drop(id);
    this.add(t);
  }

  /** The tagger was stopped: the half-done tag goes (they never finish it). */
  drop(id: number): void {
    const m = this.wip.get(id);
    if (!m) return;
    this.group.remove(m);
    (m.material as THREE.Material).dispose();
    this.wip.delete(id);
  }

  add(t: Tag): void {
    const f = this.faction(t.archetype);
    if (!f) return;
    this.tags.push(t);
    this.meshes.push(this.mesh(t, f));
    while (this.tags.length > TAGS.max) { this.tags.shift(); const m = this.meshes.shift(); if (m) this.group.remove(m); }
  }

  /** Replace all finished tags (a loaded save). */
  restore(list: readonly Tag[]): void {
    for (const m of this.meshes) this.group.remove(m);
    this.meshes = [];
    this.tags.length = 0;
    for (const t of list.slice(-TAGS.max)) this.add(t);
  }

  /** Warm-up object (shader precompile): one finished tag's material. */
  warmup(f: Faction): THREE.Object3D {
    return new THREE.Mesh(this.geo, this.material(f, 0));
  }
}
