/**
 * Working elevator for a multi-storey building: a shaft (walls come from the floor
 * plans), a cabin that moves between landings, sliding cabin and landing doors, a call
 * panel beside every landing door and a floor keypad inside the cabin (WorldPanels).
 *
 * Local frame of the shaft: x along the lift's u axis (front / doors at +x = +hu),
 * z along v. The group sits at the shaft centre.
 */
import * as THREE from 'three';
import type { LiftShaft } from './InteriorGen';
import { WorldPanel } from '../ui3d/WorldPanel';
import type { PanelManager } from '../ui3d/PanelManager';

const DOOR_W = 1.0;
const DOOR_H = 2.1;
const SPEED = 2.5;
const ACCEL = 1.2;
const DOOR_TIME = 0.9;
const DWELL = 4;

type DoorState = 'closed' | 'opening' | 'open' | 'closing';

interface Landing {
  group: THREE.Group;
  leaves: THREE.Mesh[];
  call: WorldPanel;
}

export class Elevator {
  readonly group = new THREE.Group();
  private cabin = new THREE.Group();
  private cabinDoors: THREE.Mesh[] = [];
  private keypad: WorldPanel;
  private landings = new Map<number, Landing>();
  /** Requested floors (from calls and the keypad). */
  private requests = new Set<number>();
  private cur: number;
  private y: number;
  private v = 0;
  private target: number | null = null;
  private door: DoorState = 'closed';
  /** 0 closed … 1 open. */
  private open = 0;
  private dwell = 0;
  private dir = 0;

  constructor(
    readonly lift: LiftShaft,
    /** Landing level (finished floor y) per floor index; null where the shaft doesn't reach. */
    readonly levels: (number | null)[],
    private panels: PanelManager,
  ) {
    this.group.position.set(lift.cx, 0, lift.cz);
    this.group.rotation.y = Math.atan2(-lift.uz, lift.ux);
    this.cur = levels.findIndex((l) => l !== null);
    this.y = levels[this.cur] ?? 0;
    this.buildCabin();
    this.keypad = this.makeKeypad();
    this.cabin.add(this.keypad.object);
    this.panels.add(this.keypad);
    this.group.add(this.cabin);
    this.place();
  }

  // ------------------------------------------------------------ queries

  /** Finished floor height of the cabin. */
  get cabinY(): number { return this.y; }

  /** Is (x, z) inside the shaft (cabin footprint)? */
  inShaft(x: number, z: number, margin = 0): boolean {
    const L = this.lift, dx = x - L.cx, dz = z - L.cz;
    const u = dx * L.ux + dz * L.uz, v = -dx * L.uz + dz * L.ux;
    return Math.abs(u) < L.hu + margin && Math.abs(v) < L.hv + margin;
  }

  /** Doorway of landing f blocked (doors not open far enough, or no cabin there)? */
  landingBlocked(f: number): boolean {
    return !(this.target === null && this.cur === f && this.open > 0.75);
  }

  /** Door segment across the landing doorway (world x0,z0,x1,z1). */
  doorSegment(): [number, number, number, number] {
    const L = this.lift, vx = -L.uz, vz = L.ux;
    const fx = L.cx + L.ux * L.hu, fz = L.cz + L.uz * L.hu;
    return [fx - vx * DOOR_W / 2, fz - vz * DOOR_W / 2, fx + vx * DOOR_W / 2, fz + vz * DOOR_W / 2];
  }

  /** Floor index whose landing band contains y. */
  floorAt(y: number): number {
    let best = -1;
    this.levels.forEach((l, i) => { if (l !== null && y >= l - 0.5) best = i; });
    return best;
  }

  // ------------------------------------------------------------ control

  call(f: number): void {
    if (this.levels[f] === null || this.levels[f] === undefined) return;
    if (this.target === null && f === this.cur) {
      // Already here: (re)open.
      if (this.door === 'closing' || this.door === 'closed') this.door = 'opening';
      this.dwell = 0;
      return;
    }
    this.requests.add(f);
    this.refreshPanels();
  }

  // ------------------------------------------------------------ landings

  /** Doors and call panel for a built floor. */
  addLanding(f: number): void {
    const y = this.levels[f];
    if (y === null || y === undefined || this.landings.has(f)) return;
    const L = this.lift;
    const g = new THREE.Group();
    g.position.y = y;
    // Steel frame around the doorway.
    const frame = mats().frame;
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, DOOR_H + 0.08, 0.08), frame);
      post.position.set(L.hu + 0.06, (DOOR_H + 0.08) / 2, s * (DOOR_W / 2 + 0.04));
      g.add(post);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, DOOR_W + 0.16), frame);
    lintel.position.set(L.hu + 0.06, DOOR_H + 0.04, 0);
    g.add(lintel);
    // Floor number above the doors.
    const sign = new WorldPanel(0.3, 0.16, 400, { background: '#101214' });
    sign.paint = (c, p) => {
      c.fillStyle = '#e8b04a'; c.font = `700 ${p.height * 0.7}px system-ui`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(label(f), p.width / 2, p.height / 2 + 2);
    };
    sign.object.position.set(L.hu + 0.06, DOOR_H + 0.25, 0);
    sign.faceTowards(1, 0);
    sign.enabled = false;
    sign.update();
    g.add(sign.object);
    // Sliding landing doors (outside the shaft wall).
    const leaves: THREE.Mesh[] = [];
    for (let k = 0; k < 2; k++) {
      const leaf = new THREE.Mesh(new THREE.BoxGeometry(0.04, DOOR_H, DOOR_W / 2), mats().door);
      leaf.position.set(L.hu + 0.09, DOOR_H / 2, 0);
      leaf.castShadow = true;
      g.add(leaf);
      leaves.push(leaf);
    }
    // Call panel beside the doors.
    const call = new WorldPanel(0.16, 0.3, 700);
    call.object.position.set(L.hu + 0.07, 1.15, DOOR_W / 2 + 0.3);
    call.faceTowards(1, 0);
    const cw = call.width, ch = call.height;
    call.buttons = [{ id: 'call', x: cw * 0.22, y: ch * 0.52, w: cw * 0.56, h: cw * 0.56, label: '●', round: true }];
    call.paint = (c, p) => this.paintIndicator(c, p.width, p.height * 0.42);
    call.onPress = (id) => { if (id === 'call') this.call(f); };
    g.add(call.object);
    this.panels.add(call);
    this.group.add(g);
    this.landings.set(f, { group: g, leaves, call });
    this.place();
  }

  removeLanding(f: number): void {
    const l = this.landings.get(f);
    if (!l) return;
    this.panels.remove(l.call);
    l.call.dispose();
    this.group.remove(l.group);
    l.group.traverse((o) => { if ((o as THREE.Mesh).isMesh && o !== l.call.mesh) (o as THREE.Mesh).geometry.dispose(); });
    this.landings.delete(f);
  }

  dispose(): void {
    for (const f of [...this.landings.keys()]) this.removeLanding(f);
    this.panels.remove(this.keypad);
    this.keypad.dispose();
    this.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose(); });
  }

  // ------------------------------------------------------------ simulation

  update(dt: number): void {
    // Doors.
    if (this.door === 'opening') { this.open = Math.min(1, this.open + dt / DOOR_TIME); if (this.open >= 1) { this.door = 'open'; this.dwell = 0; } }
    else if (this.door === 'closing') { this.open = Math.max(0, this.open - dt / DOOR_TIME); if (this.open <= 0) this.door = 'closed'; }
    else if (this.door === 'open') {
      this.dwell += dt;
      if (this.dwell > DWELL) this.door = 'closing';
    }
    // Travel.
    if (this.target !== null) {
      const ty = this.levels[this.target]!;
      const dist = ty - this.y;
      const want = Math.sign(dist) * Math.min(SPEED, Math.sqrt(2 * ACCEL * Math.abs(dist)));
      this.v += Math.sign(want - this.v) * Math.min(Math.abs(want - this.v), ACCEL * dt * 1.5);
      this.y += this.v * dt;
      if (Math.abs(ty - this.y) < 0.01 || Math.sign(ty - this.y) !== Math.sign(dist)) {
        this.y = ty; this.v = 0;
        this.cur = this.target;
        this.target = null;
        this.requests.delete(this.cur);
        this.door = 'opening';
        this.refreshPanels();
      }
    } else if (this.door === 'closed' && this.requests.size) {
      // Next stop: keep going in the current direction while there are requests that way.
      const up = [...this.requests].filter((f) => f > this.cur).sort((a, b) => a - b);
      const down = [...this.requests].filter((f) => f < this.cur).sort((a, b) => b - a);
      const next = this.dir >= 0 ? (up[0] ?? down[0]) : (down[0] ?? up[0]);
      if (next === undefined) this.requests.clear();
      else { this.target = next; this.dir = Math.sign(next - this.cur); this.refreshPanels(); }
    } else if (this.door === 'open' && this.requests.size && this.dwell > 1.5) {
      this.door = 'closing';
    }
    this.place();
  }

  private place(): void {
    this.cabin.position.y = this.y;
    // Cabin doors slide with the landing doors of the floor the cabin is at.
    const slide = (DOOR_W / 2) * this.open;
    this.cabinDoors.forEach((d, k) => { d.position.z = (k ? 1 : -1) * (DOOR_W / 4 + slide); });
    for (const [f, l] of this.landings) {
      const o = f === this.cur && this.target === null ? slide : 0;
      l.leaves.forEach((d, k) => { d.position.z = (k ? 1 : -1) * (DOOR_W / 4 + o); });
      l.call.invalidate();
    }
    this.keypad.invalidate();
  }

  private refreshPanels(): void {
    for (const b of this.keypad.buttons) {
      const f = Number(b.id.slice(1));
      if (b.id.startsWith('f')) b.active = this.requests.has(f) || this.target === f;
    }
    for (const [f, l] of this.landings) l.call.buttons[0].active = this.requests.has(f) || this.target === f;
  }

  // ------------------------------------------------------------ meshes

  private buildCabin(): void {
    const L = this.lift, M = mats();
    const w = L.hu * 2 - 0.12, d = L.hv * 2 - 0.12, h = 2.35;
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.receiveShadow = true;
      this.cabin.add(mesh);
      return mesh;
    };
    add(new THREE.BoxGeometry(w, 0.1, d), M.floor, 0, -0.05, 0); // floor (top at the landing level)
    add(new THREE.BoxGeometry(w, 0.08, d), M.wall, 0, h, 0); // roof
    add(new THREE.BoxGeometry(0.05, h, d), M.wall, -w / 2, h / 2, 0); // back
    for (const s of [-1, 1]) add(new THREE.BoxGeometry(w, h, 0.05), M.wall, 0, h / 2, s * d / 2); // sides
    // Front returns beside the doorway.
    const ret = (d - DOOR_W) / 2;
    for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.05, h, ret), M.wall, w / 2, h / 2, s * (DOOR_W / 2 + ret / 2));
    add(new THREE.BoxGeometry(0.05, h - DOOR_H, DOOR_W), M.wall, w / 2, (h + DOOR_H) / 2, 0);
    // Handrail and ceiling light.
    add(new THREE.BoxGeometry(w * 0.7, 0.04, 0.04), M.frame, -0.05, 0.92, d / 2 - 0.07);
    add(new THREE.BoxGeometry(w * 0.6, 0.02, d * 0.5), M.light, 0, h - 0.05, 0);
    // Cabin doors.
    for (let k = 0; k < 2; k++) {
      const leaf = add(new THREE.BoxGeometry(0.035, DOOR_H, DOOR_W / 2), M.door, w / 2 - 0.05, DOOR_H / 2, 0);
      this.cabinDoors.push(leaf);
    }
  }

  private makeKeypad(): WorldPanel {
    const floors = this.levels.map((l, i) => (l === null ? -1 : i)).filter((i) => i >= 0);
    const cols = floors.length > 18 ? 4 : floors.length > 8 ? 3 : 2;
    const rows = Math.ceil(floors.length / cols);
    const btn = 0.075, gap = 0.018, pad = 0.03, disp = 0.09;
    const wM = cols * btn + (cols - 1) * gap + pad * 2;
    const hM = disp + rows * btn + (rows - 1) * gap + pad * 2 + btn * 0.8 + gap;
    const p = new WorldPanel(wM, hM, 900);
    const px = p.width / wM;
    // Lowest floor bottom-left, like a real keypad.
    floors.forEach((f, i) => {
      const r = rows - 1 - Math.floor(i / cols), c = i % cols;
      p.buttons.push({ id: 'f' + f, label: label(f), round: true,
        x: (pad + c * (btn + gap)) * px, y: (pad + disp + r * (btn + gap)) * px, w: btn * px, h: btn * px });
    });
    // Door open / close.
    const by = (pad + disp + rows * (btn + gap)) * px;
    const bw = (wM - pad * 2 - gap) / 2 * px;
    p.buttons.push({ id: 'open', label: '◀|▶', x: pad * px, y: by, w: bw, h: btn * 0.8 * px });
    p.buttons.push({ id: 'close', label: '▶|◀', x: pad * px + bw + gap * px, y: by, w: bw, h: btn * 0.8 * px });
    p.paint = (c, q) => this.paintIndicator(c, q.width, (pad + disp * 0.85) * px);
    p.onPress = (id) => {
      if (!id) return;
      if (id === 'open') { if (this.target === null) { this.door = 'opening'; this.dwell = 0; } return; }
      if (id === 'close') { if (this.door === 'open') this.door = 'closing'; return; }
      this.call(Number(id.slice(1)));
    };
    // On the inner side wall next to the doors, facing into the cabin.
    p.object.position.set(this.lift.hu - 0.42, 1.2, this.lift.hv - 0.1);
    p.faceTowards(0, -1);
    return p;
  }

  /** Floor readout with travel arrow (top band of a panel). */
  private paintIndicator(c: CanvasRenderingContext2D, w: number, h: number): void {
    c.fillStyle = '#0b0c0e';
    c.fillRect(w * 0.12, h * 0.15, w * 0.76, h * 0.7);
    const f = this.target !== null ? this.floorAt(this.y + 0.3) : this.cur;
    const arrow = this.target === null ? '' : this.target > this.cur || this.v > 0.05 ? '▲' : '▼';
    c.fillStyle = '#ff9c2a';
    c.font = `700 ${Math.round(h * 0.5)}px system-ui`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(`${arrow}${label(Math.max(0, f))}`, w / 2, h * 0.52);
  }
}

function label(f: number): string { return f === 0 ? 'G' : String(f); }

let M: { floor: THREE.Material; wall: THREE.Material; door: THREE.Material; frame: THREE.Material; light: THREE.Material } | null = null;
function mats() {
  return M ??= {
    floor: new THREE.MeshStandardMaterial({ color: 0x3a3836, roughness: 0.8 }),
    wall: new THREE.MeshStandardMaterial({ color: 0xb8bcc0, metalness: 0.75, roughness: 0.32 }),
    door: new THREE.MeshStandardMaterial({ color: 0xc4c8cc, metalness: 0.85, roughness: 0.25 }),
    frame: new THREE.MeshStandardMaterial({ color: 0x6d7378, metalness: 0.8, roughness: 0.4 }),
    light: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4e0, emissiveIntensity: 1.2 }),
  };
}
