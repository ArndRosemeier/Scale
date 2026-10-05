/**
 * The hospital's revival ward: a sealed, self-lit room kept deep under the hospital building (off
 * the map, like the metro is under the streets), with the revival machine, two more machines
 * standing by, a short corridor out through sliding doors. Its own collision (floor, ceiling,
 * walls and machines) goes through Collision.room and an obstacle provider while it is open.
 *
 * The revival machine: a white bed under a glass canopy, a tower at its head with a glowing core
 * and a holographic vitals display, scanning rings that sweep along the body.
 */
import * as THREE from 'three';
import type { Obstacle } from '../../world/Collision';
import { WARD, wardInside } from './rules';
import { clamp, smoothstep } from '../../core/math';

const self = (color: number, glow: number, rough = 0.3, metal = 0.05) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, emissive: color, emissiveIntensity: glow });
const M = {
  // (Held low: the frame's tone mapping washes a bright white room out to one flat grey.)
  floor: self(0x6f7d8a, 0.1, 0.62, 0.1),
  wall: self(0xe2e8ed, 0.22, 0.5),
  rib: self(0x27313b, 0.12, 0.4, 0.45),
  base: self(0x3a4652, 0.1, 0.5, 0.2),
  ceil: self(0xb9c3cc, 0.14, 0.7),
  panel: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xf4fbff, emissiveIntensity: 1.5 }),
  cyan: new THREE.MeshStandardMaterial({ color: 0x7ff6ff, emissive: 0x38e8ff, emissiveIntensity: 2.6 }),
  body: self(0xf2f5f8, 0.24, 0.32, 0.15),
  pad: self(0x2a3846, 0.12, 0.6),
  dark: new THREE.MeshStandardMaterial({ color: 0x1e2630, roughness: 0.35, metalness: 0.6, emissive: 0x0b1118, emissiveIntensity: 0.5 }),
  door: self(0x8d9aa6, 0.16, 0.3, 0.45),
  glass: new THREE.MeshBasicMaterial({ color: 0x9feeff, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }),
  ring: new THREE.MeshBasicMaterial({ color: 0x5ff0ff, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }),
  floorGlow: new THREE.MeshBasicMaterial({ color: 0x38e8ff, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
  end: new THREE.MeshBasicMaterial({ color: 0xffffff }),
};

/** A canvas texture panel. */
function canvasPanel(w: number, h: number, px: number, draw: (c: CanvasRenderingContext2D, W: number, H: number) => void, additive = false): { mesh: THREE.Mesh; redraw: () => void } {
  const cv = document.createElement('canvas');
  cv.width = px; cv.height = Math.round((px * h) / w);
  const ctx = cv.getContext('2d')!;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: !additive, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  const redraw = () => { ctx.clearRect(0, 0, cv.width, cv.height); draw(ctx, cv.width, cv.height); tex.needsUpdate = true; };
  redraw();
  return { mesh, redraw };
}

/** Corridor out through the doors: its length (local z beyond the front wall) and half width. */
const COR = { len: 3.6, half: WARD.door.half + 0.05 };

interface Machine {
  group: THREE.Group;
  rings: THREE.Mesh[];
  hinge: THREE.Group;
  core: THREE.Mesh;
}

export class HospitalWard {
  readonly group = new THREE.Group();
  /** World position of the room's floor centre. */
  readonly origin = new THREE.Vector3();
  open = false;
  private main: Machine;
  private idle: Machine[] = [];
  private doorL: THREE.Mesh;
  private doorR: THREE.Mesh;
  private doorK = 0;
  private vitals: { mesh: THREE.Mesh; redraw: () => void };
  private sign: { mesh: THREE.Mesh; redraw: () => void };
  private vit = { hp: 0, bpm: 0, t: 0, state: 'STASIS' };
  private ecg: number[] = [];
  private redrawT = 0;
  private t = 0;
  private scanK = 0;
  private obs: Obstacle[] = [];
  /** Where the hero lies (local), the bed's top. */
  readonly bed = new THREE.Vector3(WARD.pod.x, WARD.pod.top, WARD.pod.z);

  constructor(private name: string) {
    const g = this.group, { hx, hz, h } = WARD;
    const box = (w: number, hh: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), m);
      b.position.set(x, y, z);
      g.add(b);
      return b;
    };
    // Shell: floor, ceiling, walls (the front one round the doors), the corridor.
    box(hx * 2 + 0.6, 0.2, hz * 2 + 0.6, M.floor, 0, -0.1, 0);
    box(hx * 2 + 0.6, 0.2, hz * 2 + 0.6, M.ceil, 0, h + 0.1, 0);
    box(0.3, h, hz * 2 + 0.6, M.wall, -hx - 0.15, h / 2, 0);
    box(0.3, h, hz * 2 + 0.6, M.wall, hx + 0.15, h / 2, 0);
    box(hx * 2 + 0.6, h, 0.3, M.wall, 0, h / 2, -hz - 0.15);
    const fw = hx - WARD.door.half;
    box(fw, h, 0.3, M.wall, -(WARD.door.half + fw / 2), h / 2, hz + 0.15);
    box(fw, h, 0.3, M.wall, WARD.door.half + fw / 2, h / 2, hz + 0.15);
    box(WARD.door.half * 2, h - 2.9, 0.3, M.wall, 0, 2.9 + (h - 2.9) / 2, hz + 0.15);
    const cz = hz + COR.len / 2;
    box(COR.half * 2 + 0.6, 0.2, COR.len, M.floor, 0, -0.1, cz);
    box(COR.half * 2 + 0.6, 0.2, COR.len, M.ceil, 0, 2.95, cz);
    box(0.3, 3, COR.len, M.wall, -COR.half - 0.15, 1.5, cz);
    box(0.3, 3, COR.len, M.wall, COR.half + 0.15, 1.5, cz);
    const end = new THREE.Mesh(new THREE.PlaneGeometry(COR.half * 2, 3), M.end);
    end.position.set(0, 1.5, hz + COR.len - 0.02);
    end.rotation.y = Math.PI;
    g.add(end);
    // Wall ribs (structure), light lines on the long walls, a glowing skirting.
    for (let z = -hz + 1.8; z < hz - 1; z += 3.6) {
      for (const s of [-1, 1]) {
        box(0.22, h, 0.5, M.rib, s * (hx - 0.11), h / 2, z);
        box(0.04, 0.06, 3.0, M.cyan, s * (hx - 0.02), 1.15, z + 1.8);
      }
    }
    // A dark band low on the walls, the skirting light along it.
    for (const s of [-1, 1]) box(0.04, 0.9, hz * 2, M.base, s * (hx - 0.02), 0.45, 0);
    box(hx * 2, 0.9, 0.04, M.base, 0, 0.45, -hz + 0.02);
    for (const s of [-1, 1]) box(0.05, 0.05, hz * 2, M.cyan, s * (hx - 0.05), 0.06, 0);
    // Guide lines on the floor, from the machine to the doors; a dark frame round the doorway.
    const g0 = WARD.pod.z + WARD.pod.len / 2 + 0.6, g1 = hz - 0.3;
    for (const s of [-1, 1]) box(0.08, 0.012, g1 - g0, M.cyan, s * 1.0, 0.006, (g0 + g1) / 2);
    for (const s of [-1, 1]) box(0.22, 3.0, 0.36, M.rib, s * (WARD.door.half + 0.11), 1.5, hz + 0.15);
    box(WARD.door.half * 2 + 0.44, 0.2, 0.36, M.rib, 0, 3.0, hz + 0.15);
    box(hx * 2, 0.05, 0.05, M.cyan, 0, 0.06, -hz + 0.03);
    // Ceiling light panels.
    for (let z = -hz + 2.5; z < hz - 1; z += 4) for (const x of [-3.4, 0, 3.4]) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.4), M.panel);
      p.rotation.x = Math.PI / 2;
      p.position.set(x, h - 0.01, z);
      g.add(p);
    }
    for (let z = hz + 0.8; z < hz + COR.len; z += 1.4) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.5), M.panel);
      p.rotation.x = Math.PI / 2;
      p.position.set(0, 2.84, z);
      g.add(p);
    }
    // The machines: the one for the hero, two standing by.
    this.main = this.machine(WARD.pod.x, WARD.pod.z);
    for (const x of [-4.5, 4.5]) this.idle.push(this.machine(x, WARD.pod.z + 1.2));
    // Equipment by the doors.
    for (const s of [-1, 1]) {
      box(0.7, 1.9, 0.6, M.body, s * (hx - 0.6), 0.95, hz - 2.2);
      box(0.5, 0.06, 0.04, M.cyan, s * (hx - 0.6), 1.5, hz - 2.2 + 0.31);
      box(0.5, 0.06, 0.04, M.cyan, s * (hx - 0.6), 1.1, hz - 2.2 + 0.31);
    }
    // The doors (slide apart).
    this.doorL = box(WARD.door.half, 2.9, 0.12, M.door, -WARD.door.half / 2, 1.45, hz + 0.15);
    this.doorR = box(WARD.door.half, 2.9, 0.12, M.door, WARD.door.half / 2, 1.45, hz + 0.15);
    for (const d of [this.doorL, this.doorR]) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.2, 0.14), M.cyan);
      strip.position.x = d === this.doorL ? WARD.door.half / 2 - 0.08 : -WARD.door.half / 2 + 0.08;
      d.add(strip);
    }
    // Signs: the name on the back wall, the exit over the doors.
    this.sign = canvasPanel(7.5, 1.6, 1024, (c, W, H) => {
      c.fillStyle = 'rgba(16, 34, 52, 0.92)';
      c.fillRect(0, 0, W, H);
      c.fillStyle = '#ff3b3b';
      const s = H * 0.5, x0 = H * 0.25, y0 = H * 0.25;
      c.fillRect(x0 + s / 3, y0, s / 3, s); c.fillRect(x0, y0 + s / 3, s, s / 3);
      c.fillStyle = '#eaf6ff';
      c.font = `600 ${Math.round(H * 0.3)}px system-ui, sans-serif`;
      c.textBaseline = 'middle';
      c.fillText(this.name.toUpperCase(), H * 1.0, H * 0.4);
      c.fillStyle = '#6fe9ff';
      c.font = `400 ${Math.round(H * 0.17)}px system-ui, sans-serif`;
      c.fillText('REGENERATION WARD  ·  LEVEL R', H * 1.0, H * 0.74);
    });
    this.sign.mesh.position.set(0, 3.5, -hz + 0.02); // (high: over the vitals hologram as seen from the ward)
    g.add(this.sign.mesh);
    const exit = canvasPanel(1.4, 0.45, 256, (c, W, H) => {
      c.fillStyle = '#0a2a14'; c.fillRect(0, 0, W, H);
      c.fillStyle = '#4dff7c'; c.font = `700 ${Math.round(H * 0.62)}px system-ui, sans-serif`;
      c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('EXIT', W / 2, H / 2 + 2);
    });
    exit.mesh.position.set(0, 3.3, hz - 0.02);
    exit.mesh.rotation.y = Math.PI;
    g.add(exit.mesh);
    // The vitals hologram over the main machine's head end.
    this.vitals = canvasPanel(1.9, 1.0, 512, (c, W, H) => this.drawVitals(c, W, H), true);
    this.vitals.mesh.position.set(WARD.pod.x, 2.3, WARD.pod.z - WARD.pod.len / 2 - 0.25);
    this.vitals.mesh.rotation.order = 'YXZ';
    this.vitals.mesh.rotation.x = -0.18;
    g.add(this.vitals.mesh);
    g.visible = false;
    this.buildObstacles();
  }

  private machine(x: number, z: number): Machine {
    const P = WARD.pod, grp = new THREE.Group();
    grp.position.set(x, 0, z);
    const add = (m: THREE.Mesh) => { grp.add(m); return m; };
    const plinth = add(new THREE.Mesh(new THREE.BoxGeometry(P.w * 0.8, 0.62, P.len * 0.86), M.body));
    plinth.position.y = 0.31;
    const top = add(new THREE.Mesh(new THREE.BoxGeometry(P.w, 0.16, P.len), M.body));
    top.position.y = 0.7;
    const bed = add(new THREE.Mesh(new THREE.BoxGeometry(P.w * 0.82, 0.1, P.len * 0.94), M.pad));
    bed.position.y = P.top - 0.12;
    const glow = add(new THREE.Mesh(new THREE.BoxGeometry(P.w * 0.84, 0.03, P.len * 0.9), M.cyan));
    glow.position.y = 0.6;
    const ringF = add(new THREE.Mesh(new THREE.RingGeometry(1.55, 1.68, 48), M.floorGlow));
    ringF.rotation.x = -Math.PI / 2;
    ringF.position.y = 0.01;
    ringF.scale.set(0.9, 1.25, 1);
    // The tower at the head with its glowing core.
    const tower = add(new THREE.Mesh(new THREE.BoxGeometry(P.w * 1.15, 1.9, 0.45), M.body));
    tower.position.set(0, 0.95, -P.len / 2 - 0.3);
    const core = add(new THREE.Mesh(new THREE.CircleGeometry(0.26, 28), M.cyan));
    core.position.set(0, 1.35, -P.len / 2 - 0.07);
    const trim = add(new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.035, 8, 28), M.dark));
    trim.position.copy(core.position);
    // Scanning rings round the body's long axis.
    const rings: THREE.Mesh[] = [];
    for (let i = 0; i < 3; i++) {
      const r = add(new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.022, 6, 40), M.ring));
      r.position.set(0, P.top + 0.12, 0);
      r.visible = false;
      rings.push(r);
    }
    // The canopy: a glass half cylinder hinged along one side of the bed.
    const hinge = new THREE.Group();
    hinge.position.set(-P.w / 2 + 0.02, P.top - 0.06, 0);
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.58, P.len * 0.92, 24, 1, true, -Math.PI / 2, Math.PI), M.glass);
    shell.rotation.x = -Math.PI / 2;
    shell.position.x = P.w / 2 - 0.02;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.58, 0.025, 6, 24, Math.PI), M.body);
    rim.position.set(P.w / 2 - 0.02, 0, P.len * 0.46);
    const rim2 = rim.clone();
    rim2.position.z = -P.len * 0.46;
    hinge.add(shell, rim, rim2);
    grp.add(hinge);
    this.group.add(grp);
    return { group: grp, rings, hinge, core };
  }

  private buildObstacles(): void {
    const { hx, hz, h } = WARD, D = WARD.door.half, P = WARD.pod;
    const b = (x: number, z: number, ax: number, az: number, y1 = h): Obstacle => ({ cyl: false, x, z, r: 0, hx: ax, hz: az, ux: 1, uz: 0, y0: 0, y1 });
    const fw = hx - D;
    this.obsLocal = [
      b(-hx - 0.15, 0, 0.15, hz + 0.3), b(hx + 0.15, 0, 0.15, hz + 0.3), b(0, -hz - 0.15, hx + 0.3, 0.15),
      b(-(D + fw / 2), hz + 0.15, fw / 2, 0.15), b(D + fw / 2, hz + 0.15, fw / 2, 0.15),
      b(-COR.half - 0.15, hz + COR.len / 2, 0.15, COR.len / 2 + 0.3), b(COR.half + 0.15, hz + COR.len / 2, 0.15, COR.len / 2 + 0.3),
      b(0, hz + COR.len + 0.15, COR.half + 0.3, 0.15),
      b(P.x, P.z, P.w / 2, P.len / 2, P.top), b(P.x, P.z - P.len / 2 - 0.3, P.w * 0.58, 0.25, 1.9),
      b(-4.5, P.z + 1.2, P.w / 2, P.len / 2, P.top), b(4.5, P.z + 1.2, P.w / 2, P.len / 2, P.top),
      b(-4.5, P.z + 1.2 - P.len / 2 - 0.3, P.w * 0.58, 0.25, 1.9), b(4.5, P.z + 1.2 - P.len / 2 - 0.3, P.w * 0.58, 0.25, 1.9),
      b(-(hx - 0.6), hz - 2.2, 0.35, 0.3, 1.9), b(hx - 0.6, hz - 2.2, 0.35, 0.3, 1.9),
    ];
    this.doorObs = b(0, hz + 0.15, D, 0.15, 2.9);
  }
  private obsLocal: Obstacle[] = [];
  private doorObs!: Obstacle;

  /** Open the ward at a world position (floor centre). */
  place(x: number, y: number, z: number): void {
    this.origin.set(x, y, z);
    this.group.position.copy(this.origin);
    this.group.updateMatrixWorld(true);
    this.obs = this.obsLocal.map((o) => ({ ...o, x: o.x + x, z: o.z + z, y0: o.y0 + y, y1: o.y1 + y }));
    this.doorWorld = { ...this.doorObs, x: this.doorObs.x + x, z: this.doorObs.z + z, y0: this.doorObs.y0 + y, y1: this.doorObs.y1 + y };
    this.room.ceiling = y + WARD.h;
    this.open = true;
    this.group.visible = true;
    this.doorK = 0;
    this.setCanopy(0);
    this.scan(0, false);
  }
  private doorWorld!: Obstacle;

  close(): void {
    this.open = false;
    this.group.visible = false;
  }

  /** Local position of a world point. */
  local(x: number, z: number): { x: number; z: number } {
    return { x: x - this.origin.x, z: z - this.origin.z };
  }

  /** Inside the room or its corridor (world), with a margin from the walls. */
  private within(x: number, y: number, z: number, m: number): boolean {
    if (!this.open) return false;
    const lx = x - this.origin.x, lz = z - this.origin.z, ly = y - this.origin.y;
    if (ly < -2 || ly > WARD.h + 1) return false;
    return wardInside(lx, lz, m) || (Math.abs(lx) <= COR.half - m && lz >= WARD.hz - 0.5 && lz <= WARD.hz + COR.len - m);
  }

  /** For Collision.room. */
  readonly room = {
    inside: (x: number, y: number, z: number) => this.within(x, y, z, -0.4),
    floorAt: (x: number, y: number, z: number) => (this.within(x, y, z, -0.4) ? this.origin.y : null),
    ceiling: 0,
  };

  /** Obstacle provider (walls, machines, the doors while shut). */
  readonly provider = (x0: number, z0: number, x1: number, z1: number, out: (o: Obstacle) => void): void => {
    if (!this.open) return;
    const o = this.origin;
    if (x1 < o.x - WARD.hx - 2 || x0 > o.x + WARD.hx + 2 || z1 < o.z - WARD.hz - 2 || z0 > o.z + WARD.hz + COR.len + 2) return;
    for (const b of this.obs) out(b);
    if (this.doorK < 0.7) out(this.doorWorld);
  };

  /** Camera test: free inside the room and corridor (world). */
  cameraFree(x: number, y: number, z: number): boolean {
    const ly = y - this.origin.y;
    if (ly < 0.08 || ly > WARD.h - 0.08) return false;
    const lx = x - this.origin.x, lz = z - this.origin.z;
    if (wardInside(lx, lz, 0.12)) return true;
    return Math.abs(lx) <= COR.half - 0.12 && lz >= WARD.hz && lz <= WARD.hz + COR.len - 0.12 && ly < 2.85;
  }

  /** Keep a body inside (a last guard against tunnelling out of the room). */
  clampBody(p: THREE.Vector3, r: number, h: number): void {
    const o = this.origin;
    let lx = p.x - o.x, lz = p.z - o.z;
    const inCor = Math.abs(lx) <= COR.half && lz > WARD.hz - 0.2;
    if (inCor) { lx = clamp(lx, -COR.half + r, COR.half - r); lz = Math.min(lz, WARD.hz + COR.len - r); }
    else { lx = clamp(lx, -WARD.hx + r, WARD.hx - r); lz = clamp(lz, -WARD.hz + r, WARD.hz + (Math.abs(lx) < WARD.door.half - r ? 0.5 : -r)); }
    p.x = o.x + lx; p.z = o.z + lz;
    p.y = clamp(p.y, o.y, o.y + Math.max(0, WARD.h - h));
  }

  // ------------------------------------------------------------------ the revival

  /** The scanning rings: progress k (0..1) of the scan, on or off. */
  scan(k: number, on: boolean): void {
    this.scanK = k;
    const P = WARD.pod;
    this.main.rings.forEach((r, i) => {
      r.visible = on;
      // Three rings sweeping along the body, out of phase, narrowing to the chest at the end.
      const ph = Math.sin(this.t * (1.3 + i * 0.35) + i * 2.1);
      const conv = smoothstep(0.75, 1, k);
      r.position.z = ph * (P.len * 0.42) * (1 - conv) + (-0.25) * conv;
      const s = 1 - 0.25 * conv + 0.04 * Math.sin(this.t * 9 + i);
      r.scale.set(s, s, s);
    });
    (M.ring as THREE.MeshBasicMaterial).opacity = on ? 0.6 + 0.35 * Math.sin(this.t * 14) ** 2 : 0;
  }

  /** The canopy: 0 shut … 1 open. */
  setCanopy(k: number): void {
    this.main.hinge.rotation.z = 1.9 * smoothstep(0, 1, k);
  }

  /** Vitals on the hologram: health 0..1, heart rate, the state line. */
  setVitals(hp: number, bpm: number, state: string): void {
    this.vit.hp = hp; this.vit.bpm = bpm; this.vit.state = state;
  }

  /** The machine's core: brightness (a surge at the revival). */
  private coreK = 1;
  surge(k: number): void { this.coreK = k; }

  update(dt: number, player: THREE.Vector3 | null): void {
    if (!this.open) return;
    this.t += dt;
    // Doors open when the hero comes near them.
    let near = false;
    if (player) {
      const l = this.local(player.x, player.z);
      near = Math.abs(l.x) < WARD.door.half + 1.2 && l.z > WARD.hz - WARD.door.open && player.y - this.origin.y < 3;
    }
    const was = this.doorK;
    this.doorK = clamp(this.doorK + (near ? dt * 1.8 : -dt * 1.2), 0, 1);
    this.doorsMoved = was === 0 && this.doorK > 0;
    const k = smoothstep(0, 1, this.doorK);
    this.doorL.position.x = -WARD.door.half / 2 - k * (WARD.door.half - 0.1);
    this.doorR.position.x = WARD.door.half / 2 + k * (WARD.door.half - 0.1);
    // The cores pulse; the main one surges at the revival.
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 2.2);
    (M.cyan as THREE.MeshStandardMaterial).emissiveIntensity = 2.2 + 0.6 * pulse;
    this.main.core.scale.setScalar(1 + 0.12 * pulse + 0.6 * (this.coreK - 1));
    if (this.main.rings[0].visible) this.scan(this.scanK, true);
    // ECG trace and the hologram (redrawn a few times a second).
    this.vit.t += dt;
    this.redrawT -= dt;
    if (this.redrawT <= 0) { this.redrawT = 0.08; this.vitals.redraw(); }
  }

  /** The hologram turns its face to the camera (seen from behind its text would read mirrored). */
  faceVitals(cam: THREE.Vector3): void {
    const m = this.vitals.mesh;
    const dx = cam.x - (this.origin.x + m.position.x), dz = cam.z - (this.origin.z + m.position.z);
    m.rotation.y = Math.atan2(dx, dz) + Math.sin(this.t * 0.5) * 0.04;
  }
  /** The doors started opening this frame (a sound). */
  doorsMoved = false;

  private drawVitals(c: CanvasRenderingContext2D, W: number, H: number): void {
    const v = this.vit;
    c.strokeStyle = 'rgba(95, 240, 255, 0.85)';
    c.lineWidth = 3;
    c.strokeRect(6, 6, W - 12, H - 12);
    c.fillStyle = 'rgba(30, 120, 150, 0.25)';
    c.fillRect(6, 6, W - 12, H - 12);
    c.fillStyle = '#9ff6ff';
    c.font = `600 ${Math.round(H * 0.1)}px system-ui, sans-serif`;
    c.fillText(v.state, 22, H * 0.17);
    c.textAlign = 'right';
    c.fillText(`${Math.round(v.hp * 100)}%`, W - 22, H * 0.17);
    c.textAlign = 'left';
    // Health bar.
    c.fillStyle = 'rgba(95, 240, 255, 0.25)';
    c.fillRect(22, H * 0.23, W - 44, H * 0.06);
    c.fillStyle = v.hp > 0.6 ? '#7dffb0' : v.hp > 0.25 ? '#ffe27a' : '#ff6b6b';
    c.fillRect(22, H * 0.23, (W - 44) * clamp(v.hp, 0, 1), H * 0.06);
    // ECG: a beat every 60/bpm s, flat at 0.
    const ys = H * 0.62, amp = H * 0.22;
    c.strokeStyle = '#7dffb0';
    c.lineWidth = 3;
    c.beginPath();
    const span = 3;
    for (let i = 0; i <= 120; i++) {
      const tt = v.t - span + (i / 120) * span;
      const per = v.bpm > 0 ? 60 / v.bpm : 1e9;
      const ph = ((tt % per) + per) % per;
      let y = 0;
      if (v.bpm > 0) y = ph < 0.04 ? -0.2 * ph / 0.04 : ph < 0.08 ? 1.0 : ph < 0.12 ? -0.45 : ph < 0.3 ? 0.12 * Math.sin(((ph - 0.12) / 0.18) * Math.PI) : 0;
      const px = 22 + (i / 120) * (W - 44);
      if (i === 0) c.moveTo(px, ys - y * amp); else c.lineTo(px, ys - y * amp);
    }
    c.stroke();
    c.fillStyle = '#9ff6ff';
    c.font = `500 ${Math.round(H * 0.09)}px system-ui, sans-serif`;
    c.fillText(v.bpm > 0 ? `♥ ${Math.round(v.bpm)} BPM` : '♥ --', 22, H * 0.92);
    c.textAlign = 'right';
    c.fillText('NEURAL SYNC', W - 22, H * 0.92);
    c.textAlign = 'left';
  }

  /** Something to render once at start-up (shaders compiled before it is needed). */
  warmupObject(): THREE.Object3D {
    const g = this.group.clone();
    g.visible = true;
    g.traverse((o) => { o.visible = true; });
    return g;
  }
}
