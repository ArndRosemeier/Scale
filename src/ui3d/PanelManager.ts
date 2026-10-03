/**
 * Routes the crosshair to world panels: hover highlight, and a left click on a button
 * within reach presses it (and is consumed, so it does not also punch).
 */
import * as THREE from 'three';
import type { WorldPanel } from './WorldPanel';
import type { Input } from '../game/Input';

export class PanelManager {
  private panels = new Set<WorldPanel>();
  private ray = new THREE.Raycaster();
  private hovered: WorldPanel | null = null;
  private crosshair = document.getElementById('crosshair');
  private center = new THREE.Vector2(0, 0);
  private promptEl: HTMLDivElement | null = null;
  /** Hint for something usable that is not a panel (manholes …); panels near you take precedence. */
  external: string | null = null;
  private shownPrompt = '';

  add(p: WorldPanel): void { this.panels.add(p); }
  remove(p: WorldPanel): void {
    this.panels.delete(p);
    if (this.hovered === p) this.hovered = null;
  }

  /**
   * Call after the camera has moved, before click handlers (punch) run.
   * `reachFrom`: the player's hands; `reach`: how far they reach.
   */
  update(camera: THREE.Camera, reachFrom: THREE.Vector3, reach: number, input: Input): void {
    let best: { p: WorldPanel; u: number; v: number } | null = null;
    if (this.panels.size) {
      this.ray.setFromCamera(this.center, camera);
      this.ray.far = camera.position.distanceTo(reachFrom) + reach + 1;
      let bestD = Infinity;
      for (const p of this.panels) {
        if (!p.enabled || !isShown(p.object)) continue;
        // Cheap distance cull before the ray test.
        p.object.getWorldPosition(_tmp);
        if (_tmp.distanceTo(reachFrom) > reach + Math.max(p.widthM, p.heightM)) continue;
        const hit = this.ray.intersectObject(p.mesh, false)[0];
        if (!hit || !hit.uv || hit.distance > bestD) continue;
        if (hit.point.distanceTo(reachFrom) > reach) continue;
        bestD = hit.distance;
        best = { p, u: hit.uv.x, v: hit.uv.y };
      }
    }
    // Hover feedback on the panel and the crosshair.
    const b = best ? best.p.buttonAtUV(best.u, best.v) : null;
    if (this.hovered && this.hovered !== best?.p) this.hovered.setHover(null);
    this.hovered = best?.p ?? null;
    if (best) best.p.setHover(b && !b.disabled ? b.id : null);
    this.crosshair?.classList.toggle('hot', !!(b && !b.disabled));
    if (best && input.clicked & 1 && input.locked) {
      best.p.press(best.u, best.v);
      input.clicked &= ~1; // consumed: no punch
    }
    for (const p of this.panels) p.update();
    // Proximity: the nearest panel with a prompt shows it and gets keyboard shortcuts.
    let near: WorldPanel | null = null, nd = Infinity;
    const scale = Math.max(1, reach / 2.1);
    for (const p of this.panels) {
      if (!p.enabled || !p.prompt || !isShown(p.object)) continue;
      p.object.getWorldPosition(_tmp);
      const d = _tmp.distanceTo(reachFrom);
      if (d < p.promptRange * scale && d < nd) { nd = d; near = p; }
    }
    this.showPrompt(near?.prompt ?? this.external ?? '');
    if (near?.onKey) {
      for (const code of input.pressed) {
        const key = code === 'KeyE' ? 'E' : /^(Digit|Numpad)(\d)$/.exec(code)?.[2];
        if (key && near.onKey(key)) input.pressed.delete(code); // consumed (no manhole, no other use)
      }
    }
  }

  private showPrompt(html: string): void {
    if (html === this.shownPrompt) return;
    this.shownPrompt = html;
    if (!this.promptEl) {
      this.promptEl = document.createElement('div');
      this.promptEl.id = 'panel-prompt';
      document.body.appendChild(this.promptEl);
    }
    this.promptEl.innerHTML = html;
    this.promptEl.classList.toggle('show', !!html);
  }
}

const _tmp = new THREE.Vector3();

function isShown(o: THREE.Object3D): boolean {
  for (let q: THREE.Object3D | null = o; q; q = q.parent) if (!q.visible) return false;
  return true;
}
