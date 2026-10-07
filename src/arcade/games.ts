/**
 * The arcade's video games: small classics drawn on a 320×240 canvas (the cabinet's screen).
 * Each game steps with the frame time and a pad (held directions, fire, and what was pressed
 * this frame); idle cabinets run an attract mode (the game playing itself or just moving).
 * Pure canvas code, no three.js: the cabinet (arcade/Cabinets) puts the canvas on its screen.
 */

export const SW = 320, SH = 240;

export type Btn = 'left' | 'right' | 'up' | 'down' | 'fire';

export interface Pad {
  left: boolean; right: boolean; up: boolean; down: boolean; fire: boolean;
  /** Pressed this frame. */
  hit: Set<Btn>;
}

export const NO_PAD: Pad = { left: false, right: false, up: false, down: false, fire: false, hit: new Set() };

/** A short tone: frequency (Hz), length (s), waveform. */
export type Beep = (freq: number, dur: number, wave?: OscillatorType) => void;

export abstract class ArcadeGame {
  abstract readonly title: string;
  /** Marquee colour. */
  abstract readonly color: string;
  /** Controls, one short line. */
  abstract readonly help: string;
  score = 0;
  over = false;
  beep: Beep = () => {};
  /** Start a new game. */
  abstract reset(): void;
  abstract step(dt: number, p: Pad): void;
  /** Attract mode: keep the screen alive while nobody plays (default: play with a dummy pad). */
  abstract idle(dt: number): void;
  abstract draw(c: CanvasRenderingContext2D): void;
}

const rnd = Math.random;
const wrap = (v: number, m: number) => ((v % m) + m) % m;

function text(c: CanvasRenderingContext2D, s: string, x: number, y: number, size = 12, color = '#fff', align: CanvasTextAlign = 'center'): void {
  c.font = `bold ${size}px "Courier New", monospace`;
  c.textAlign = align;
  c.textBaseline = 'middle';
  c.fillStyle = color;
  c.fillText(s, x, y);
}
export { text as screenText };

// ------------------------------------------------------------------ Rock Storm (asteroids)

interface Rock { x: number; y: number; vx: number; vy: number; s: number; r: number; shape: number[]; a: number; va: number }

export class RockStorm extends ArcadeGame {
  readonly title = 'ROCK STORM';
  readonly color = '#7fd4ff';
  readonly help = '←→ turn  ↑ thrust  SPACE fire';
  private ship = { x: SW / 2, y: SH / 2, vx: 0, vy: 0, a: -Math.PI / 2, dead: 0, safe: 0 };
  private shots: { x: number; y: number; vx: number; vy: number; t: number }[] = [];
  private rocks: Rock[] = [];
  private lives = 3;
  private wave = 0;
  private thrust = false;
  private cool = 0;

  reset(): void {
    this.score = 0; this.over = false; this.lives = 3; this.wave = 0;
    this.shots = []; this.rocks = [];
    this.respawn();
    this.nextWave();
  }

  private respawn(): void {
    Object.assign(this.ship, { x: SW / 2, y: SH / 2, vx: 0, vy: 0, a: -Math.PI / 2, dead: 0, safe: 2 });
  }

  private nextWave(): void {
    this.wave++;
    for (let i = 0; i < Math.min(3 + this.wave, 9); i++) {
      // Away from the ship.
      const a = rnd() * Math.PI * 2, d = 80 + rnd() * 60;
      this.addRock(wrap(SW / 2 + Math.cos(a) * d, SW), wrap(SH / 2 + Math.sin(a) * d, SH), 3);
    }
  }

  private addRock(x: number, y: number, s: number): void {
    const r = s === 3 ? 22 : s === 2 ? 12 : 6;
    const sp = (18 + rnd() * 22) * (4 - s) * 0.6 + this.wave * 2;
    const a = rnd() * Math.PI * 2;
    const shape: number[] = [];
    for (let i = 0; i < 10; i++) shape.push(0.72 + rnd() * 0.32);
    this.rocks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, s, r, shape, a: 0, va: (rnd() - 0.5) * 2 });
  }

  step(dt: number, p: Pad): void {
    const S = this.ship;
    this.moveRocks(dt);
    if (this.over) return;
    if (S.dead > 0) {
      S.dead -= dt;
      if (S.dead <= 0) { if (this.lives > 0) this.respawn(); else this.over = true; }
    } else {
      if (p.left) S.a -= 4.2 * dt;
      if (p.right) S.a += 4.2 * dt;
      this.thrust = p.up;
      if (p.up) { S.vx += Math.cos(S.a) * 160 * dt; S.vy += Math.sin(S.a) * 160 * dt; }
      const drag = Math.exp(-0.6 * dt);
      S.vx *= drag; S.vy *= drag;
      const sp = Math.hypot(S.vx, S.vy);
      if (sp > 200) { S.vx *= 200 / sp; S.vy *= 200 / sp; }
      S.x = wrap(S.x + S.vx * dt, SW); S.y = wrap(S.y + S.vy * dt, SH);
      S.safe = Math.max(0, S.safe - dt);
      this.cool -= dt;
      if ((p.hit.has('fire') || (p.fire && this.cool < -0.25)) && this.shots.length < 5) {
        this.cool = 0;
        this.shots.push({ x: S.x + Math.cos(S.a) * 8, y: S.y + Math.sin(S.a) * 8, vx: S.vx + Math.cos(S.a) * 260, vy: S.vy + Math.sin(S.a) * 260, t: 0.9 });
        this.beep(880, 0.05, 'square');
      }
      if (S.safe <= 0) for (const r of this.rocks) {
        if (Math.hypot(r.x - S.x, r.y - S.y) < r.r * 0.85 + 5) {
          S.dead = 1.6; this.lives--; this.beep(90, 0.5, 'sawtooth');
          break;
        }
      }
    }
    for (const s of this.shots) { s.x = wrap(s.x + s.vx * dt, SW); s.y = wrap(s.y + s.vy * dt, SH); s.t -= dt; }
    for (const s of this.shots) {
      for (let i = 0; i < this.rocks.length; i++) {
        const r = this.rocks[i];
        if (s.t > 0 && Math.hypot(r.x - s.x, r.y - s.y) < r.r) {
          s.t = 0;
          this.rocks.splice(i, 1);
          this.score += r.s === 3 ? 20 : r.s === 2 ? 50 : 100;
          this.beep(r.s === 3 ? 110 : r.s === 2 ? 160 : 230, 0.12, 'triangle');
          if (r.s > 1) for (let k = 0; k < 2; k++) this.addRock(r.x, r.y, r.s - 1);
          break;
        }
      }
    }
    this.shots = this.shots.filter((s) => s.t > 0);
    if (!this.rocks.length) this.nextWave();
  }

  private moveRocks(dt: number): void {
    for (const r of this.rocks) { r.x = wrap(r.x + r.vx * dt, SW); r.y = wrap(r.y + r.vy * dt, SH); r.a += r.va * dt; }
  }

  idle(dt: number): void {
    if (this.rocks.length < 5) for (let i = 0; i < 6; i++) this.addRock(rnd() * SW, rnd() * SH, 1 + Math.floor(rnd() * 3));
    this.ship.dead = 1; this.shots = [];
    this.moveRocks(dt);
  }

  draw(c: CanvasRenderingContext2D): void {
    c.strokeStyle = '#e8f4ff';
    c.lineWidth = 1.5;
    for (const r of this.rocks) {
      c.beginPath();
      for (let i = 0; i <= 10; i++) {
        const a = r.a + (i % 10) / 10 * Math.PI * 2, d = r.r * r.shape[i % 10];
        const x = r.x + Math.cos(a) * d, y = r.y + Math.sin(a) * d;
        if (i) c.lineTo(x, y); else c.moveTo(x, y);
      }
      c.stroke();
    }
    c.fillStyle = '#fff';
    for (const s of this.shots) c.fillRect(s.x - 1, s.y - 1, 2, 2);
    const S = this.ship;
    if (S.dead <= 0 && (S.safe <= 0 || Math.floor(S.safe * 8) % 2 === 0)) {
      const P = (a: number, d: number): [number, number] => [S.x + Math.cos(S.a + a) * d, S.y + Math.sin(S.a + a) * d];
      c.beginPath();
      c.moveTo(...P(0, 9)); c.lineTo(...P(2.5, 7)); c.lineTo(...P(Math.PI, 3)); c.lineTo(...P(-2.5, 7)); c.closePath();
      c.stroke();
      if (this.thrust && Math.random() < 0.7) {
        c.strokeStyle = '#ffb347';
        c.beginPath(); c.moveTo(...P(2.8, 5)); c.lineTo(...P(Math.PI, 9 + Math.random() * 4)); c.lineTo(...P(-2.8, 5)); c.stroke();
      }
    }
    text(c, String(this.score).padStart(5, '0'), 8, 10, 12, '#fff', 'left');
    for (let i = 0; i < this.lives; i++) text(c, 'A', SW - 12 - i * 10, 10, 11, '#7fd4ff');
  }
}

// ------------------------------------------------------------------ Block Drop (falling blocks)

const PIECES: [number, number][][] = [
  [[0, 1], [1, 1], [2, 1], [3, 1]], // I
  [[0, 0], [1, 0], [0, 1], [1, 1]], // O
  [[1, 0], [0, 1], [1, 1], [2, 1]], // T
  [[1, 0], [2, 0], [0, 1], [1, 1]], // S
  [[0, 0], [1, 0], [1, 1], [2, 1]], // Z
  [[0, 0], [0, 1], [1, 1], [2, 1]], // J
  [[2, 0], [0, 1], [1, 1], [2, 1]], // L
];
const PIECE_COLORS = ['#3ce0f0', '#f0dc3c', '#b45cf0', '#4ce05a', '#f0503c', '#4c78f0', '#f09a3c'];
const COLS = 10, ROWS = 20, CELL = 11, BX = 105, BY = 10;

export class BlockDrop extends ArcadeGame {
  readonly title = 'BLOCK DROP';
  readonly color = '#ffd84a';
  readonly help = '←→ move  ↑/SPACE turn  ↓ drop';
  private grid: number[] = [];
  private cur: { k: number; cells: [number, number][]; x: number; y: number } = { k: 0, cells: [], x: 0, y: 0 };
  private next = 0;
  private fall = 0;
  private lines = 0;
  private level = 1;
  private das = 0;
  private flash: number[] = [];
  private flashT = 0;
  private demoX = 0;

  reset(): void {
    this.grid = new Array(COLS * ROWS).fill(0);
    this.score = 0; this.lines = 0; this.level = 1; this.over = false; this.flash = [];
    this.next = Math.floor(rnd() * 7);
    this.spawn();
  }

  private spawn(): void {
    const k = this.next;
    this.next = Math.floor(rnd() * 7);
    this.cur = { k, cells: PIECES[k].map(([x, y]) => [x, y]), x: 3, y: 0 };
    this.demoX = Math.floor(rnd() * 8);
    if (!this.fits(this.cur.cells, 3, 0)) this.over = true;
  }

  private fits(cells: [number, number][], ox: number, oy: number): boolean {
    for (const [x, y] of cells) {
      const gx = x + ox, gy = y + oy;
      if (gx < 0 || gx >= COLS || gy >= ROWS) return false;
      if (gy >= 0 && this.grid[gy * COLS + gx]) return false;
    }
    return true;
  }

  private rotate(): void {
    if (this.cur.k === 1) return;
    const n = this.cur.k === 0 ? 4 : 3;
    const rot = this.cur.cells.map(([x, y]): [number, number] => [n - 1 - y, x]);
    for (const dx of [0, -1, 1, -2, 2]) if (this.fits(rot, this.cur.x + dx, this.cur.y)) { this.cur.cells = rot; this.cur.x += dx; this.beep(520, 0.03, 'square'); return; }
  }

  private move(dx: number): boolean {
    if (!this.fits(this.cur.cells, this.cur.x + dx, this.cur.y)) return false;
    this.cur.x += dx;
    return true;
  }

  /** Down one row, or lock the piece. */
  private drop(): void {
    if (this.fits(this.cur.cells, this.cur.x, this.cur.y + 1)) { this.cur.y++; return; }
    for (const [x, y] of this.cur.cells) {
      const gy = y + this.cur.y;
      if (gy < 0) { this.over = true; return; }
      this.grid[gy * COLS + x + this.cur.x] = this.cur.k + 1;
    }
    const full: number[] = [];
    for (let r = 0; r < ROWS; r++) {
      let n = 0;
      for (let k = 0; k < COLS; k++) if (this.grid[r * COLS + k]) n++;
      if (n === COLS) full.push(r);
    }
    if (full.length) {
      for (const r of full) { this.grid.splice(r * COLS, COLS); this.grid.unshift(...new Array(COLS).fill(0)); }
      this.lines += full.length;
      this.score += [0, 100, 300, 500, 800][full.length] * this.level;
      this.level = 1 + Math.floor(this.lines / 10);
      this.flash = full; this.flashT = 0.15;
      this.beep(full.length >= 4 ? 990 : 660, 0.15, 'triangle');
    } else this.beep(140, 0.04, 'square');
    this.spawn();
  }

  step(dt: number, p: Pad): void {
    if (this.over) return;
    this.flashT -= dt;
    if (p.hit.has('up') || p.hit.has('fire')) this.rotate();
    if (p.hit.has('left')) { this.move(-1); this.das = -0.17; }
    else if (p.hit.has('right')) { this.move(1); this.das = -0.17; }
    else if (p.left || p.right) {
      this.das += dt;
      while (this.das > 0.05) { this.das -= 0.05; this.move(p.left ? -1 : 1); }
    }
    const every = p.down ? 0.035 : Math.max(0.08, 0.8 - (this.level - 1) * 0.07);
    this.fall += dt;
    while (this.fall > every && !this.over) { this.fall -= every; this.drop(); if (p.down) this.score += 1; }
  }

  idle(dt: number): void {
    if (this.over || !this.grid.length) { this.reset(); }
    this.fall += dt;
    while (this.fall > 0.09 && !this.over) {
      this.fall -= 0.09;
      if (this.cur.x < this.demoX) this.move(1); else if (this.cur.x > this.demoX) this.move(-1);
      else if (rnd() < 0.15) this.rotate();
      this.drop();
    }
    this.score = 0;
  }

  draw(c: CanvasRenderingContext2D): void {
    c.fillStyle = '#0a0a24';
    c.fillRect(BX - 2, BY - 2, COLS * CELL + 4, ROWS * CELL + 4);
    c.strokeStyle = '#5a5aa0';
    c.lineWidth = 2;
    c.strokeRect(BX - 2, BY - 2, COLS * CELL + 4, ROWS * CELL + 4);
    const cell = (x: number, y: number, col: string) => {
      c.fillStyle = col;
      c.fillRect(BX + x * CELL, BY + y * CELL, CELL - 1, CELL - 1);
      c.fillStyle = 'rgba(255,255,255,0.35)';
      c.fillRect(BX + x * CELL, BY + y * CELL, CELL - 1, 2);
    };
    for (let r = 0; r < ROWS; r++) for (let k = 0; k < COLS; k++) {
      const v = this.grid[r * COLS + k];
      if (v) cell(k, r, PIECE_COLORS[v - 1]);
    }
    if (this.flashT > 0) { c.fillStyle = 'rgba(255,255,255,0.6)'; c.fillRect(BX, BY + ROWS * CELL - CELL * this.flash.length, COLS * CELL, CELL * this.flash.length); }
    if (!this.over) for (const [x, y] of this.cur.cells) if (y + this.cur.y >= 0) cell(x + this.cur.x, y + this.cur.y, PIECE_COLORS[this.cur.k]);
    text(c, 'SCORE', 52, 30, 11, '#aab');
    text(c, String(this.score), 52, 46, 13);
    text(c, 'LINES', 52, 74, 11, '#aab');
    text(c, String(this.lines), 52, 90, 13);
    text(c, 'LEVEL', 52, 118, 11, '#aab');
    text(c, String(this.level), 52, 134, 13);
    text(c, 'NEXT', 268, 30, 11, '#aab');
    for (const [x, y] of PIECES[this.next]) {
      c.fillStyle = PIECE_COLORS[this.next];
      c.fillRect(246 + x * CELL, 46 + y * CELL, CELL - 1, CELL - 1);
    }
  }
}

// ------------------------------------------------------------------ Snake

const SC = 10, SCOLS = 32, SROWS = 22, SY = 20;

export class Snake extends ArcadeGame {
  readonly title = 'SNAKE';
  readonly color = '#7dff6a';
  readonly help = 'ARROWS / WASD steer';
  private body: [number, number][] = [];
  private dir: [number, number] = [1, 0];
  private want: [number, number] = [1, 0];
  private food: [number, number] = [0, 0];
  private t = 0;

  reset(): void {
    this.body = [[10, 11], [9, 11], [8, 11]];
    this.dir = [1, 0]; this.want = [1, 0];
    this.score = 0; this.over = false; this.t = 0;
    this.place();
  }

  private place(): void {
    for (let i = 0; i < 200; i++) {
      const f: [number, number] = [Math.floor(rnd() * SCOLS), Math.floor(rnd() * SROWS)];
      if (!this.body.some(([x, y]) => x === f[0] && y === f[1])) { this.food = f; return; }
    }
  }

  private free(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < SCOLS && y < SROWS && !this.body.slice(0, -1).some(([bx, by]) => bx === x && by === y);
  }

  private advance(): void {
    if ((this.want[0] !== -this.dir[0] || this.want[1] !== -this.dir[1])) this.dir = this.want;
    const [hx, hy] = this.body[0];
    const nx = hx + this.dir[0], ny = hy + this.dir[1];
    if (!this.free(nx, ny)) { this.over = true; this.beep(90, 0.5, 'sawtooth'); return; }
    this.body.unshift([nx, ny]);
    if (nx === this.food[0] && ny === this.food[1]) { this.score += 10; this.beep(720, 0.06, 'square'); this.place(); }
    else this.body.pop();
  }

  step(dt: number, p: Pad): void {
    if (this.over) return;
    if (p.hit.has('left') || (p.left && !p.up && !p.down)) this.want = [-1, 0];
    else if (p.hit.has('right') || (p.right && !p.up && !p.down)) this.want = [1, 0];
    else if (p.hit.has('up') || p.up) this.want = [0, -1];
    else if (p.hit.has('down') || p.down) this.want = [0, 1];
    this.t += dt;
    const every = Math.max(0.055, 0.12 - this.body.length * 0.0012);
    while (this.t > every && !this.over) { this.t -= every; this.advance(); }
  }

  idle(dt: number): void {
    if (this.over || !this.body.length) this.reset();
    this.t += dt;
    while (this.t > 0.09 && !this.over) {
      this.t -= 0.09;
      // Greedy: towards the food, any free way otherwise.
      const [hx, hy] = this.body[0];
      const opts: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      opts.sort((a, b) => Math.hypot(hx + a[0] - this.food[0], hy + a[1] - this.food[1]) - Math.hypot(hx + b[0] - this.food[0], hy + b[1] - this.food[1]));
      const ok = opts.find((o) => (o[0] !== -this.dir[0] || o[1] !== -this.dir[1]) && this.free(hx + o[0], hy + o[1]));
      if (ok) this.want = ok;
      this.advance();
      if (this.body.length > 40) this.over = true;
    }
    this.score = 0;
  }

  draw(c: CanvasRenderingContext2D): void {
    c.strokeStyle = '#2e6a2a';
    c.lineWidth = 2;
    c.strokeRect(0, SY - 1, SCOLS * SC, SROWS * SC + 2);
    c.fillStyle = '#ff4d5e';
    c.beginPath(); c.arc(this.food[0] * SC + SC / 2, SY + this.food[1] * SC + SC / 2, SC / 2 - 1, 0, Math.PI * 2); c.fill();
    this.body.forEach(([x, y], i) => {
      c.fillStyle = i === 0 ? '#c8ff6a' : i % 2 ? '#5ad84a' : '#4cc43e';
      c.fillRect(x * SC + 1, SY + y * SC + 1, SC - 2, SC - 2);
    });
    text(c, `SCORE ${this.score}`, 8, 10, 12, '#fff', 'left');
  }
}

// ------------------------------------------------------------------ Brick Breaker

export class BrickBreaker extends ArcadeGame {
  readonly title = 'BRICK BREAKER';
  readonly color = '#ff7ad9';
  readonly help = '←→ move  SPACE launch';
  private px = SW / 2;
  private ball = { x: 0, y: 0, vx: 0, vy: 0, stuck: true };
  private bricks: number[] = [];
  private lives = 3;
  private round = 0;
  private static readonly BW = 30;
  private static readonly BH = 10;
  private static readonly BC = 10;
  private static readonly BR = 6;
  private static readonly TOP = 34;

  reset(): void {
    this.score = 0; this.lives = 3; this.over = false; this.round = 0;
    this.newWall();
  }

  private newWall(): void {
    this.round++;
    this.bricks = new Array(BrickBreaker.BC * BrickBreaker.BR).fill(1);
    this.serve();
  }

  private serve(): void { this.ball = { x: this.px, y: SH - 22, vx: 0, vy: 0, stuck: true }; }

  private launch(): void {
    const sp = 150 + this.round * 15;
    const a = -Math.PI / 2 + (rnd() - 0.5) * 0.8;
    Object.assign(this.ball, { vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, stuck: false });
  }

  private physics(dt: number): void {
    const B = this.ball;
    if (B.stuck) { B.x = this.px; return; }
    const n = Math.ceil(Math.hypot(B.vx, B.vy) * dt / 3);
    for (let k = 0; k < n; k++) {
      const h = dt / n;
      B.x += B.vx * h; B.y += B.vy * h;
      if (B.x < 3) { B.x = 3; B.vx = Math.abs(B.vx); }
      if (B.x > SW - 3) { B.x = SW - 3; B.vx = -Math.abs(B.vx); }
      if (B.y < 3) { B.y = 3; B.vy = Math.abs(B.vy); }
      // Paddle: the angle follows where it hits.
      if (B.vy > 0 && B.y > SH - 20 && B.y < SH - 12 && Math.abs(B.x - this.px) < 26) {
        const sp = Math.hypot(B.vx, B.vy) * 1.01, a = -Math.PI / 2 + ((B.x - this.px) / 26) * 1.05;
        B.vx = Math.cos(a) * sp; B.vy = Math.sin(a) * sp;
        this.beep(330, 0.04, 'square');
      }
      const { BW, BH, BC, TOP } = BrickBreaker;
      const col = Math.floor((B.x - 10) / BW), row = Math.floor((B.y - TOP) / BH);
      if (col >= 0 && col < BC && row >= 0 && row < BrickBreaker.BR && this.bricks[row * BC + col]) {
        this.bricks[row * BC + col] = 0;
        this.score += (BrickBreaker.BR - row) * 10;
        const cx = 10 + col * BW + BW / 2, cy = TOP + row * BH + BH / 2;
        if (Math.abs(B.x - cx) / BW > Math.abs(B.y - cy) / BH) B.vx = -B.vx; else B.vy = -B.vy;
        this.beep(440 + (BrickBreaker.BR - row) * 80, 0.05, 'square');
        if (this.bricks.every((v) => !v)) { this.newWall(); return; }
      }
      if (B.y > SH + 4) {
        this.lives--;
        this.beep(90, 0.4, 'sawtooth');
        if (this.lives <= 0) this.over = true; else this.serve();
        return;
      }
    }
  }

  step(dt: number, p: Pad): void {
    if (this.over) return;
    if (p.left) this.px -= 260 * dt;
    if (p.right) this.px += 260 * dt;
    this.px = Math.max(24, Math.min(SW - 24, this.px));
    if (this.ball.stuck && (p.hit.has('fire') || p.hit.has('up'))) this.launch();
    this.physics(dt);
  }

  idle(dt: number): void {
    if (this.over || !this.bricks.length) this.reset();
    if (this.ball.stuck) this.launch();
    this.px += Math.max(-200 * dt, Math.min(200 * dt, this.ball.x + Math.sin(performance.now() / 700) * 14 - this.px));
    this.px = Math.max(24, Math.min(SW - 24, this.px));
    this.physics(dt);
    this.lives = 3; this.score = 0;
  }

  draw(c: CanvasRenderingContext2D): void {
    const { BW, BH, BC, BR, TOP } = BrickBreaker;
    const cols = ['#ff4d5e', '#ff9a3c', '#ffe14a', '#5ade5a', '#4cb4ff', '#b46cff'];
    for (let r = 0; r < BR; r++) for (let k = 0; k < BC; k++) {
      if (!this.bricks[r * BC + k]) continue;
      c.fillStyle = cols[r];
      c.fillRect(10 + k * BW + 1, TOP + r * BH + 1, BW - 2, BH - 2);
    }
    c.fillStyle = '#e8e8ff';
    c.fillRect(this.px - 24, SH - 16, 48, 5);
    c.beginPath(); c.arc(this.ball.x, this.ball.y, 3, 0, Math.PI * 2); c.fill();
    text(c, String(this.score).padStart(5, '0'), 8, 12, 12, '#fff', 'left');
    for (let i = 0; i < this.lives; i++) { c.fillStyle = '#e8e8ff'; c.fillRect(SW - 22 - i * 16, 9, 12, 4); }
  }
}

// ------------------------------------------------------------------ Paddle Ball (pong)

export class PaddleBall extends ArcadeGame {
  readonly title = 'PADDLE BALL';
  readonly color = '#ffffff';
  readonly help = '↑↓ move  first to 7';
  private a = SH / 2;
  private b = SH / 2;
  private ball = { x: SW / 2, y: SH / 2, vx: 0, vy: 0 };
  private sa = 0;
  private sb = 0;
  private wait = 0;

  reset(): void { this.sa = this.sb = 0; this.score = 0; this.over = false; this.a = this.b = SH / 2; this.serve(1); }

  private serve(dir: number): void {
    this.ball = { x: SW / 2, y: SH / 2, vx: 0, vy: 0 };
    this.wait = 0.8;
    this.serveDir = dir;
  }
  private serveDir = 1;

  private ai(y: number, speed: number, dt: number): number {
    const want = this.ball.vx * (y === this.a ? -1 : 1) > 0 ? this.ball.y : SH / 2;
    return y + Math.max(-speed * dt, Math.min(speed * dt, want - y));
  }

  private physics(dt: number): void {
    const B = this.ball;
    if (this.wait > 0) {
      this.wait -= dt;
      if (this.wait <= 0) { const a = (rnd() - 0.5) * 0.9; B.vx = Math.cos(a) * 170 * this.serveDir; B.vy = Math.sin(a) * 170; }
      return;
    }
    B.x += B.vx * dt; B.y += B.vy * dt;
    if (B.y < 4) { B.y = 4; B.vy = Math.abs(B.vy); this.beep(240, 0.03, 'square'); }
    if (B.y > SH - 4) { B.y = SH - 4; B.vy = -Math.abs(B.vy); this.beep(240, 0.03, 'square'); }
    const hit = (py: number, side: number) => {
      const off = (B.y - py) / 22;
      const sp = Math.min(380, Math.hypot(B.vx, B.vy) * 1.06), a = off * 0.9;
      B.vx = Math.cos(a) * sp * side; B.vy = Math.sin(a) * sp;
      this.beep(480, 0.04, 'square');
    };
    if (B.vx < 0 && B.x < 18 && B.x > 8 && Math.abs(B.y - this.a) < 22) hit(this.a, 1);
    if (B.vx > 0 && B.x > SW - 18 && B.x < SW - 8 && Math.abs(B.y - this.b) < 22) hit(this.b, -1);
    if (B.x < -6) { this.sb++; this.beep(150, 0.25, 'triangle'); this.serve(-1); }
    if (B.x > SW + 6) { this.sa++; this.score += 100; this.beep(660, 0.25, 'triangle'); this.serve(1); }
  }

  step(dt: number, p: Pad): void {
    if (this.over) return;
    if (p.up) this.a -= 220 * dt;
    if (p.down) this.a += 220 * dt;
    this.a = Math.max(20, Math.min(SH - 20, this.a));
    this.b = Math.max(20, Math.min(SH - 20, this.ai(this.b, 150, dt)));
    this.physics(dt);
    if (this.sa >= 7 || this.sb >= 7) { this.over = true; if (this.sa >= 7) this.score += 500; }
  }

  idle(dt: number): void {
    if (this.sa >= 7 || this.sb >= 7) this.reset();
    this.a = Math.max(20, Math.min(SH - 20, this.ai(this.a, 160, dt)));
    this.b = Math.max(20, Math.min(SH - 20, this.ai(this.b, 160, dt)));
    this.physics(dt);
  }

  draw(c: CanvasRenderingContext2D): void {
    c.fillStyle = '#666';
    for (let y = 4; y < SH; y += 14) c.fillRect(SW / 2 - 1, y, 2, 7);
    c.fillStyle = '#fff';
    c.fillRect(10, this.a - 20, 5, 40);
    c.fillRect(SW - 15, this.b - 20, 5, 40);
    if (this.wait <= 0) c.fillRect(this.ball.x - 3, this.ball.y - 3, 6, 6);
    text(c, String(this.sa), SW / 2 - 30, 20, 22);
    text(c, String(this.sb), SW / 2 + 30, 20, 22);
  }
}

// ------------------------------------------------------------------ Space Raiders (invaders)

export class SpaceRaiders extends ArcadeGame {
  readonly title = 'SPACE RAIDERS';
  readonly color = '#7dff6a';
  readonly help = '←→ move  SPACE fire';
  private px = SW / 2;
  private aliens: { x: number; y: number; r: number; alive: boolean }[] = [];
  private ox = 0;
  private oy = 0;
  private dir = 1;
  private shot: { x: number; y: number } | null = null;
  private bombs: { x: number; y: number }[] = [];
  private lives = 3;
  private wave = 0;
  private stepT = 0;
  private frame = 0;
  private dead = 0;

  reset(): void { this.score = 0; this.lives = 3; this.over = false; this.wave = 0; this.newWave(); }

  private newWave(): void {
    this.wave++;
    this.aliens = [];
    for (let r = 0; r < 5; r++) for (let k = 0; k < 9; k++) this.aliens.push({ x: 40 + k * 26, y: 34 + r * 18, r, alive: true });
    this.ox = 0; this.oy = Math.min(40, (this.wave - 1) * 8); this.dir = 1;
    this.shot = null; this.bombs = [];
  }

  private physics(dt: number, fire: boolean): void {
    const alive = this.aliens.filter((a) => a.alive);
    if (!alive.length) { this.newWave(); return; }
    // The march speeds up as the ranks thin.
    this.stepT += dt;
    const every = 0.05 + alive.length / 45 * 0.5;
    if (this.stepT > every) {
      this.stepT = 0;
      this.frame ^= 1;
      const minX = Math.min(...alive.map((a) => a.x)) + this.ox, maxX = Math.max(...alive.map((a) => a.x)) + this.ox;
      if ((this.dir > 0 && maxX > SW - 16) || (this.dir < 0 && minX < 16)) { this.dir = -this.dir; this.oy += 8; }
      else this.ox += this.dir * 5;
      this.beep(this.frame ? 70 : 60, 0.06, 'square');
    }
    if (fire && !this.shot && this.dead <= 0) { this.shot = { x: this.px, y: SH - 24 }; this.beep(900, 0.06, 'square'); }
    if (this.shot) {
      this.shot.y -= 300 * dt;
      if (this.shot.y < 0) this.shot = null;
      else for (const a of alive) {
        if (Math.abs(a.x + this.ox - this.shot.x) < 9 && Math.abs(a.y + this.oy - this.shot.y) < 6) {
          a.alive = false; this.shot = null; this.score += (5 - a.r) * 10; this.beep(200, 0.1, 'triangle');
          break;
        }
      }
    }
    if (rnd() < dt * (0.8 + this.wave * 0.3) && this.bombs.length < 4) {
      const a = alive[Math.floor(rnd() * alive.length)];
      this.bombs.push({ x: a.x + this.ox, y: a.y + this.oy + 6 });
    }
    for (const b of this.bombs) b.y += 110 * dt;
    if (this.dead > 0) this.dead -= dt;
    else for (const b of this.bombs) {
      if (Math.abs(b.x - this.px) < 9 && b.y > SH - 22 && b.y < SH - 10) {
        b.y = SH + 10; this.lives--; this.dead = 1.2; this.beep(80, 0.5, 'sawtooth');
        if (this.lives <= 0) this.over = true;
      }
    }
    this.bombs = this.bombs.filter((b) => b.y < SH);
    if (alive.some((a) => a.y + this.oy > SH - 30)) this.over = true;
  }

  step(dt: number, p: Pad): void {
    if (this.over) return;
    if (this.dead <= 0) {
      if (p.left) this.px -= 140 * dt;
      if (p.right) this.px += 140 * dt;
      this.px = Math.max(12, Math.min(SW - 12, this.px));
    }
    this.physics(dt, p.hit.has('fire') || p.fire);
  }

  idle(dt: number): void {
    if (this.over || !this.aliens.length) this.reset();
    this.px += Math.sin(performance.now() / 900) * 80 * dt;
    this.px = Math.max(12, Math.min(SW - 12, this.px));
    this.physics(dt, rnd() < 0.05);
    this.lives = 3; this.score = 0;
  }

  draw(c: CanvasRenderingContext2D): void {
    const cols = ['#ff6af0', '#ff6af0', '#6ae8ff', '#6ae8ff', '#c8ff6a'];
    for (const a of this.aliens) {
      if (!a.alive) continue;
      const x = a.x + this.ox, y = a.y + this.oy;
      c.fillStyle = cols[a.r];
      c.fillRect(x - 7, y - 3, 14, 6);
      c.fillRect(x - 4, y - 6, 8, 3);
      c.fillStyle = '#000';
      c.fillRect(x - 4, y - 2, 2, 2); c.fillRect(x + 2, y - 2, 2, 2);
      c.fillStyle = cols[a.r];
      const l = this.frame ? 2 : 0;
      c.fillRect(x - 7 + l, y + 3, 2, 3); c.fillRect(x + 5 - l, y + 3, 2, 3);
    }
    if (this.dead <= 0 || Math.floor(this.dead * 10) % 2) {
      c.fillStyle = '#7dff6a';
      c.fillRect(this.px - 9, SH - 16, 18, 6);
      c.fillRect(this.px - 2, SH - 21, 4, 5);
    }
    c.fillStyle = '#fff';
    if (this.shot) c.fillRect(this.shot.x - 1, this.shot.y - 4, 2, 8);
    c.fillStyle = '#ff8a5a';
    for (const b of this.bombs) c.fillRect(b.x - 1, b.y - 4, 3, 8);
    c.fillStyle = '#7dff6a';
    c.fillRect(0, SH - 6, SW, 1);
    text(c, String(this.score).padStart(5, '0'), 8, 10, 12, '#fff', 'left');
    text(c, `x${this.lives}`, SW - 8, 10, 12, '#7dff6a', 'right');
  }
}

/** All games, in the order cabinets cycle through them. */
export const GAMES: (new () => ArcadeGame)[] = [RockStorm, BlockDrop, SpaceRaiders, Snake, BrickBreaker, PaddleBall];
