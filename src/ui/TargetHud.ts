/**
 * Target marker and frame (Tab targeting): four corner brackets round the target on screen
 * (a small caret at the screen edge when it is out of view), and a frame at the bottom left
 * with its name, kind, distance and state. The frame keeps a slot for the threat colour
 * ("con") and a health bar for the crime phase (TargetInfo.con / .health).
 */
import * as THREE from 'three';
import type { Targeting } from '../game/Targeting';
import { statusOf } from '../shared/status';

const _c = new THREE.Vector3();
const _t = new THREE.Vector3();

export class TargetHud {
  private mark: HTMLDivElement;
  private frame: HTMLDivElement;
  private nm: HTMLDivElement;
  private kind: HTMLSpanElement;
  private dist: HTMLSpanElement;
  private con: HTMLDivElement;
  private hp: HTMLDivElement;
  private hpFill: HTMLDivElement;
  private shown = false;
  private last = '';

  constructor(private targeting: Targeting, private camera: THREE.PerspectiveCamera) {
    this.mark = document.createElement('div');
    this.mark.id = 'tmark';
    this.mark.innerHTML = '<i></i><i></i><i></i><i></i><b></b>';
    this.frame = document.createElement('div');
    this.frame.id = 'tframe';
    this.frame.innerHTML = '<div class="con"></div><div class="nm"></div><div class="sub"><span class="kd"></span><span class="ds"></span></div><div class="hp"><div></div></div>';
    document.body.append(this.mark, this.frame);
    this.nm = this.frame.querySelector('.nm')!;
    this.kind = this.frame.querySelector('.kd')!;
    this.dist = this.frame.querySelector('.ds')!;
    this.con = this.frame.querySelector('.con')!;
    this.hp = this.frame.querySelector('.hp')!;
    this.hpFill = this.hp.firstElementChild as HTMLDivElement;
  }

  setVisible(v: boolean): void {
    if (!v) { this.mark.style.display = 'none'; this.frame.style.display = 'none'; this.shown = false; }
  }

  update(): void {
    const T = this.targeting, t = T.current;
    if (!t) {
      if (this.shown) { this.mark.style.display = 'none'; this.frame.style.display = 'none'; this.shown = false; this.last = ''; }
      return;
    }
    if (!this.shown) { this.mark.style.display = 'block'; this.frame.style.display = 'block'; this.shown = true; }
    const W = window.innerWidth, H = window.innerHeight;
    // Brackets: project the body's bottom and top.
    const c = T.centre(t, _c);
    const h = T.height(t);
    _t.copy(c).project(this.camera);
    const behind = _t.z > 1;
    let sx = (_t.x * 0.5 + 0.5) * W, sy = (-_t.y * 0.5 + 0.5) * H;
    const on = !behind && sx > 0 && sx < W && sy > 0 && sy < H;
    if (on) {
      _t.set(c.x, c.y + h * 0.55, c.z).project(this.camera);
      const top = (-_t.y * 0.5 + 0.5) * H;
      const half = Math.max(12, Math.min(H * 0.4, (sy - top) * 1.1));
      const wHalf = Math.max(12, half * (t.kind === 'car' ? 1.4 : t.kind === 'person' || t.kind === 'bot' ? 0.55 : 0.9));
      this.mark.classList.remove('edge');
      this.mark.style.width = `${wHalf * 2}px`;
      this.mark.style.height = `${half * 2}px`;
      this.mark.style.transform = `translate(${sx - wHalf}px, ${sy - half}px)`;
      (this.mark.lastElementChild as HTMLElement).style.transform = '';
    } else {
      // Off screen: a caret at the edge pointing towards it.
      if (behind) { sx = W - sx; sy = H - sy; }
      const dx = sx - W / 2, dy = sy - H / 2;
      const k = Math.min((W / 2 - 30) / Math.max(1e-3, Math.abs(dx)), (H / 2 - 30) / Math.max(1e-3, Math.abs(dy)));
      const ex = W / 2 + dx * k, ey = H / 2 + dy * k;
      this.mark.classList.add('edge');
      this.mark.style.width = '10px';
      this.mark.style.height = '10px';
      this.mark.style.transform = `translate(${ex - 5}px, ${ey - 5}px)`;
      (this.mark.lastElementChild as HTMLElement).style.transform = `rotate(${Math.atan2(dy, dx) * 180 / Math.PI - 90}deg)`;
    }
    // Frame (text only when it changes).
    const info = T.info(t);
    const s = statusOf(t.obj);
    const st = s ? [s.frozen > 0 && 'frozen', s.burning > 0 && 'burning', s.stunned > 0 && 'stunned', s.shrink > 0 && 'shrunk', s.wet > 0 && 'wet'].filter(Boolean).join(', ') : '';
    const d = info.dist < 10 ? info.dist.toFixed(1) : Math.round(info.dist).toString();
    const key = `${info.name}|${info.kind}|${d}|${st}|${info.con}|${info.health}`;
    if (key === this.last) return;
    this.last = key;
    this.nm.textContent = info.name;
    this.kind.innerHTML = st ? `${info.kind} · <span class="st">${st}</span>` : info.kind;
    this.dist.textContent = `${d} m`;
    this.con.style.background = info.con ?? 'rgba(255,255,255,0.25)';
    this.hp.style.display = info.health === null ? 'none' : 'block';
    if (info.health !== null) this.hpFill.style.width = `${Math.round(info.health * 100)}%`;
  }
}
