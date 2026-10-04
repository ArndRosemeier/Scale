/**
 * The Murk breaking out into the city (THREATS_PLAN archetype 'murk', started by the slime realm
 * when the war goes badly: the Murk hold the Hall and are strong, at night): a pack of them pours
 * out of a manhole and goes for people — knocking them down — and for the player. The police come
 * (they can strike and shoot them); the Lumen's call fights them; they go back under after a while
 * or when most of them are dead.
 */
import type { Game } from '../Game';
import type { Cause } from '../Stimuli';
import type { ThreatEvent, ThreatOutcome, ThreatTarget } from '../threats/ThreatEvent';
import type { Blob, Factions } from '../../underground/deep/Factions';
import type { PedAgent } from '../../sim/Pedestrians';

/** How long they stay up (s) before going back under. */
const STAY = 300;

let nextId = 9000;

export class MurkBreach implements ThreatEvent {
  readonly id = nextId++;
  readonly archetype = 'murk';
  readonly tier = 'minor' as const;
  readonly engageOnFoot = true;
  readonly radius = 70;
  t = 0;
  active = true;
  outcome: ThreatOutcome | null = null;
  hurt = 0;
  x: number; z: number;
  readonly blobs: Blob[] = [];
  private total: number;
  private targets = new Map<Blob, ThreatTarget & { b: Blob }>();
  private cool = new Map<Blob, number>();
  private leaving = false;

  constructor(private g: Game, private F: Factions, readonly hole: { x: number; z: number }, n: number) {
    this.x = hole.x; this.z = hole.z;
    const y = g.world.groundHeight(hole.x, hole.z);
    for (let i = 0; i < n; i++) {
      const b = F.spawn('murk', i === 0 && n > 6 ? 'brute' : 'breacher', hole.x + (Math.random() - 0.5) * 0.6, y, hole.z + (Math.random() - 0.5) * 0.6, `breach${this.id}`, true);
      b.vy = 4 + Math.random() * 3;
      b.y = y + 0.2;
      const a = Math.random() * Math.PI * 2;
      b.tx = hole.x + Math.cos(a) * (6 + Math.random() * 10); b.tz = hole.z + Math.sin(a) * (6 + Math.random() * 10);
      b.mode = 'move';
      b.den = { x: hole.x, y, z: hole.z };
      this.blobs.push(b);
    }
    this.total = n;
    g.audio.play('murk_growl', hole.x, y, hole.z, 1, 0.8, 12, g.renderer.camera.position);
    g.audio.play('metal_bend', hole.x, y, hole.z, 0.7, 1.2, 10, g.renderer.camera.position);
    g.stimuli.emit('threat', hole.x, y, hole.z, 3, 60, { cause: 'threat' });
  }

  private alive(): Blob[] { return this.blobs.filter((b) => b.mode !== 'dead' && b.hp > 0); }

  strength(): number { return this.alive().length / Math.max(1, this.total); }

  targetsNear(x: number, z: number, r: number): ThreatTarget[] {
    const out: ThreatTarget[] = [];
    for (const b of this.alive()) {
      if (Math.hypot(b.x - x, b.z - z) > r) continue;
      let t = this.targets.get(b);
      if (!t) {
        const bb = b;
        t = { b, get x() { return bb.x; }, get y() { return bb.y + bb.r; }, get z() { return bb.z; }, grounded: true, get on() { return bb.mode !== 'dead' && bb.hp > 0; }, speed: 3 } as ThreatTarget & { b: Blob };
        this.targets.set(b, t);
      }
      out.push(t);
    }
    return out;
  }

  strike(t: ThreatTarget, jx: number, jy: number, jz: number, cause: Cause): void {
    const b = (t as ThreatTarget & { b?: Blob }).b;
    if (b) this.F.hurt(b, 0.6 + Math.hypot(jx, jy, jz) / 1500, cause === 'player', b.x - jx, b.z - jz);
  }

  shoot(t: ThreatTarget, dmg: number, cause: Cause, fromX: number, fromZ: number): boolean {
    const b = (t as ThreatTarget & { b?: Blob }).b;
    if (!b) return false;
    this.F.hurt(b, dmg * 0.05, cause === 'player', fromX, fromZ);
    return b.hp <= 0;
  }

  update(dt: number): void {
    if (!this.active) return;
    this.t += dt;
    const alive = this.alive();
    if (alive.length) {
      let sx = 0, sz = 0;
      for (const b of alive) { sx += b.x; sz += b.z; }
      this.x = sx / alive.length; this.z = sz / alive.length;
    }
    // Most of them down: the rest flee back under; or time is up.
    if (!this.leaving && (this.t > STAY || this.strength() < 0.3)) {
      this.leaving = true;
      for (const b of alive) { b.mode = 'go'; b.path = []; b.tx = this.hole.x; b.tz = this.hole.z; b.foe = null; }
    }
    if (this.leaving) {
      for (const b of alive) if (Math.hypot(b.x - this.hole.x, b.z - this.hole.z) < 1.2) b.mode = 'dead';
      if (!this.alive().length) this.end(this.strength() < 0.3 && this.t < STAY ? 'stopped' : 'retreated');
      return;
    }
    if (!alive.length) { this.end('stopped'); return; }
    // Going for people: the nearest within reach of each, knocked down on contact.
    for (const b of alive) {
      if (b.mode === 'fight' || b.mode === 'go') continue;
      const c = (this.cool.get(b) ?? 0) - dt;
      this.cool.set(b, c);
      const ps = this.g.peds.neighbours(b.x, b.z, 14, _nb).filter((a: PedAgent) => a.alive && !a.inside && a.state !== 5);
      if (!ps.length) { if (b.mode === 'idle' && Math.random() < dt) { const a = Math.random() * 6.28; b.tx = b.x + Math.cos(a) * 12; b.tz = b.z + Math.sin(a) * 12; b.mode = 'move'; } continue; }
      ps.sort((p, q) => Math.hypot(p.x - b.x, p.z - b.z) - Math.hypot(q.x - b.x, q.z - b.z));
      const a = ps[0];
      b.tx = a.x; b.tz = a.z; b.mode = 'move';
      if (Math.hypot(a.x - b.x, a.z - b.z) < 1.0 + b.r && c <= 0) {
        this.cool.set(b, 2.5);
        b.lunge = 0.3;
        this.g.reactions.knockDown(a, a.x - b.x, a.z - b.z, 3.5, 'threat');
        this.hurt++;
        this.g.audio.play('slime_squish', b.x, b.y, b.z, 0.6, 0.7, 6, this.g.renderer.camera.position);
      }
    }
    if (Math.random() < dt * 0.3 && alive.length) {
      const b = alive[Math.floor(Math.random() * alive.length)];
      this.g.stimuli.emit('threat', b.x, b.y, b.z, 2.5, 40, { cause: 'threat' });
    }
  }

  private end(o: ThreatOutcome): void {
    this.active = false;
    this.outcome = o;
  }

  shutdown(): void {
    this.leaving = true;
    for (const b of this.alive()) { b.mode = 'go'; b.path = []; b.tx = this.hole.x; b.tz = this.hole.z; }
  }

  dispose(): void {
    for (const b of this.blobs) b.mode = 'dead';
    this.active = false;
  }

  snapshot(): Record<string, unknown> {
    return { id: this.id, t: Math.round(this.t), alive: this.alive().length, total: this.total, hurt: this.hurt, leaving: this.leaving, outcome: this.outcome };
  }
}

const _nb: PedAgent[] = [];
