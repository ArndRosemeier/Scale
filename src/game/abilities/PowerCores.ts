/**
 * Power cores in the world (Normal mode): rare glowing loot placed by cores.ts. Each one
 * floats over its spot with a pulsing glow and a faint light beam; walking into it
 * collects it (+max energy, +regeneration or bonus karma). Cores within
 * CORES.discoverRadius are discovered and appear on the map and minimap.
 */
import * as THREE from 'three';
import type { CellPlan } from '../../plan/cell';
import type { Terrain } from '../../world/terrain';
import type { Player } from '../../player/Player';
import type { Progress } from './Progress';
import { needsPlan, resolveCoreSite, LOOT_INFO, type CoreSite, type CoreSpot, type CoreLoot } from './cores';
import { CORES, ENERGY, KARMA } from './tuning';
import type { MapMarker } from '../../ui/map/GameMap';

interface Live {
  site: CoreSite;
  spot: CoreSpot | null;
  refined: boolean;
  obj: THREE.Group | null;
  phase: number;
  /** No spot found (cell without a fitting roof / plaza / park). */
  dead?: boolean;
}

export class PowerCores {
  readonly group = new THREE.Group();
  private live: Live[];
  private mats = new Map<CoreLoot, { core: THREE.MeshBasicMaterial; glow: THREE.SpriteMaterial; beam: THREE.MeshBasicMaterial }>();
  private coreGeo = new THREE.OctahedronGeometry(0.24, 0);
  private beamGeo = new THREE.CylinderGeometry(0.06, 0.18, 60, 8, 1, true).translate(0, 30, 0);
  private resolveT = 0;
  private time = 0;
  private markerKey = '';
  onCollect?: (site: CoreSite, spot: CoreSpot) => void;
  onDiscover?: (site: CoreSite, spot: CoreSpot) => void;
  onMarkers?: (m: MapMarker[]) => void;

  constructor(
    sites: CoreSite[],
    private terrain: Terrain,
    private planOf: (cell: number) => CellPlan | null,
    /** Walkable height near (x, yGuess, z), or NaN when not known yet. */
    private ground: (x: number, y: number, z: number) => number,
    private progress: Progress,
  ) {
    this.live = sites.filter((s) => !progress.hasCore(s.id)).map((s) => ({ site: s, spot: null, refined: false, obj: null, phase: (s.seed % 1000) / 159 }));
    const tex = glowTexture();
    for (const loot of Object.keys(LOOT_INFO) as CoreLoot[]) {
      const c = new THREE.Color(LOOT_INFO[loot].color);
      this.mats.set(loot, {
        core: new THREE.MeshBasicMaterial({ color: c.clone().multiplyScalar(2.2), toneMapped: false }),
        glow: new THREE.SpriteMaterial({ map: tex, color: c, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.9 }),
        beam: new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
      });
    }
    this.group.name = 'powerCores';
  }

  get remaining(): number { return this.live.length; }
  get total(): number { return this.live.length + this.progress.coresCollected; }

  /** Positions of the cores (resolved ones), for tests. */
  debugList(): { id: number; kind: string; loot: string; x: number; y: number; z: number; seen: boolean }[] {
    return this.live.filter((l) => l.spot).map((l) => ({ id: l.site.id, kind: l.site.kind, loot: l.site.loot, x: l.spot!.x, y: l.spot!.y, z: l.spot!.z, seen: this.progress.seenCore(l.site.id) }));
  }

  update(dt: number, p: Player): void {
    this.time += dt;
    this.resolveT -= dt;
    if (this.resolveT <= 0) {
      this.resolveT = 0.5;
      for (const l of this.live) {
        if (l.dead) continue;
        if (!l.spot) {
          const plan = needsPlan(l.site) ? this.planOf(l.site.cell) : null;
          if (needsPlan(l.site) && !plan) continue;
          l.spot = resolveCoreSite(l.site, plan, this.terrain);
          if (!l.spot) { l.dead = true; continue; }
        }
        const d = Math.hypot(l.spot.x - p.pos.x, l.spot.z - p.pos.z);
        if (!l.refined && d < 220) {
          const g = this.ground(l.spot.x, l.spot.y, l.spot.z);
          if (Number.isFinite(g)) { l.spot.y = g; l.refined = true; }
        }
        if (!l.obj && d < 900) this.build(l);
        else if (l.obj && d > 1000) { this.group.remove(l.obj); l.obj = null; }
        if (d < CORES.discoverRadius && !this.progress.seenCore(l.site.id)) {
          this.progress.markSeen(l.site.id);
          this.onDiscover?.(l.site, l.spot);
        }
      }
      this.publishMarkers();
    }
    // Animate and collect.
    const cy = p.pos.y + p.height * 0.5;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const l = this.live[i];
      if (!l.obj || !l.spot) continue;
      const t = this.time + l.phase;
      const core = l.obj.children[0], glow = l.obj.children[1] as THREE.Sprite;
      core.position.y = 1.0 + Math.sin(t * 2) * 0.12;
      core.rotation.y = t * 1.6;
      glow.position.y = core.position.y;
      const s = 1.8 + Math.sin(t * 3.1) * 0.35;
      glow.scale.set(s, s, s);
      const dx = l.spot.x - p.pos.x, dy = l.spot.y + 1 - cy, dz = l.spot.z - p.pos.z;
      const reach = 0.7 + p.radius + p.height * 0.35;
      if (dx * dx + dz * dz < reach * reach && Math.abs(dy) < p.height * 0.6 + 1) {
        this.group.remove(l.obj);
        this.live.splice(i, 1);
        const loot = l.site.loot;
        this.progress.collectCore(l.site.id, loot === 'energy' ? { max: ENERGY.coreMax } : loot === 'regen' ? { regen: ENERGY.coreRegen } : {});
        if (loot === 'karma') this.progress.addKarma(KARMA.coreKarma, 'power core');
        this.onCollect?.(l.site, l.spot);
        this.markerKey = '#stale'; // ('' would equal the key of an empty list: the last core's marker stayed)
        this.publishMarkers();
      }
    }
  }

  private build(l: Live): void {
    const m = this.mats.get(l.site.loot)!;
    const g = new THREE.Group();
    g.position.set(l.spot!.x, l.spot!.y, l.spot!.z);
    const core = new THREE.Mesh(this.coreGeo, m.core);
    core.scale.set(1, 1.5, 1);
    const glow = new THREE.Sprite(m.glow);
    g.add(core, glow);
    // Light beam above ground-level and roof cores (not underground: it would poke out of the street).
    if (l.spot!.surface === 'ground' || l.spot!.surface === 'roof') g.add(new THREE.Mesh(this.beamGeo, m.beam));
    for (const o of g.children) { o.castShadow = false; o.receiveShadow = false; }
    l.obj = g;
    this.group.add(g);
  }

  private publishMarkers(): void {
    const list: MapMarker[] = [];
    for (const l of this.live) if (l.spot && this.progress.seenCore(l.site.id)) list.push({ x: l.spot.x, z: l.spot.z, color: LOOT_INFO[l.site.loot].color, kind: 'core', title: `${LOOT_INFO[l.site.loot].name} — ${LOOT_INFO[l.site.loot].text} (walk into it)` });
    const key = list.map((m) => `${m.x.toFixed(0)},${m.z.toFixed(0)}`).join(';');
    if (key === this.markerKey) return;
    this.markerKey = key;
    this.onMarkers?.(list);
  }
}

function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
