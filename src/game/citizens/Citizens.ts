/**
 * The city's well-known citizens: ordinary people with a supernatural quirk (a crystal, a curse, a
 * bit of luck), neither heroes nor villains. Each lives in its own module (game/citizens/<name>/)
 * and plugs in here: a frame update, its saved state (one SaveData field `citizens`, keyed by the
 * citizen's id), and gossip, the lines passers-by drop about them in small talk (People.chatLine),
 * so the hero hears of them before meeting them.
 *
 * `homeShop` finds a citizen's shop: a deterministic one for the seed (the same bakery every time),
 * found by planning the candidate cells one per frame (as the shard search does), not on load.
 */
import type { Game } from '../Game';
import type { CellPlan } from '../../plan/cell';
import type { District } from '../../plan/types';
import { planCell } from '../../plan/cell';
import { hash32 } from '../../core/rng';

export interface CityCitizen {
  /** Stable id (the key of its saved state): 'baker', 'florist' … */
  readonly id: string;
  /** Shown in the admin console's "Go to" list. */
  readonly label?: string;
  update(dt: number): void;
  save?(): unknown;
  restore?(d: unknown): void;
  /** A line a passer-by at (x, z) might say about them (null: nothing to say). */
  gossip?(x: number, z: number): string | null;
  /** Where they are now, or their usual spot (admin console "Go to"); null: not known yet. */
  where?(): { x: number; z: number } | null;
  /** Console status (dev.citizens()). */
  status?(): Record<string, unknown>;
}

export class Citizens {
  readonly list: CityCitizen[] = [];
  /** Saved states of citizens not (yet) added when a save was restored. */
  private pending: Record<string, unknown> = {};

  add<T extends CityCitizen>(c: T): T {
    this.list.push(c);
    if (c.id in this.pending) { c.restore?.(this.pending[c.id]); delete this.pending[c.id]; }
    return c;
  }

  get(id: string): CityCitizen | undefined { return this.list.find((c) => c.id === id); }

  update(dt: number): void {
    for (const c of this.list) c.update(dt);
  }

  save(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const c of this.list) { const d = c.save?.(); if (d !== undefined && d !== null) out[c.id] = d; }
    return out;
  }

  restore(d: unknown): void {
    if (!d || typeof d !== 'object') return;
    for (const [id, v] of Object.entries(d as Record<string, unknown>)) {
      const c = this.get(id);
      if (c) c.restore?.(v); else this.pending[id] = v;
    }
  }

  /** Something a passer-by says about one of them (any one with something to say). */
  gossip(x: number, z: number): string | null {
    const lines: string[] = [];
    for (const c of this.list) { const l = c.gossip?.(x, z); if (l) lines.push(l); }
    return lines.length ? lines[Math.floor(Math.random() * lines.length)] : null;
  }

  status(): Record<string, unknown> {
    return Object.fromEntries(this.list.map((c) => [c.id, c.status?.() ?? {}]));
  }
}

/** A shop found for a citizen: its cell, plan and building, the spot by the door and the way out. */
export interface HomeShop {
  cell: number;
  /** Building index in the cell plan. */
  b: number;
  /** Just outside the door, and the unit normal out of the front. */
  x: number; z: number; nx: number; nz: number;
  /** Unit along the frontage. */
  ux: number; uz: number;
}

/**
 * A search for a citizen's shop over the cells of the given districts, the most central first
 * (deterministic per seed and `salt`): `step()` plans one candidate cell a call and asks `pick`
 * for the shop in it; `found` holds it once there is one, `failed` when no candidate had one.
 */
export class HomeShopSearch {
  found: HomeShop | null = null;
  failed = false;
  private queue: number[];

  constructor(
    private g: Game,
    districts: readonly District[],
    salt: number,
    private pick: (plan: CellPlan, cell: number) => HomeShop | null,
    max = 40,
  ) {
    const M = g.macro, c0 = M.centres[0] ?? { x: 0, z: 0 };
    const cand = M.cells.filter((c) => districts.includes(c.district) && c.area > 2500);
    // Central, with a little seeded jitter so it is not always the very middle.
    const key = (c: (typeof cand)[number]) => Math.hypot(c.centroid[0] - c0.x, c.centroid[1] - c0.z) * (0.75 + 0.5 * ((hash32(c.id * 7919 + salt) % 1000) / 1000));
    this.queue = cand.sort((a, b) => key(a) - key(b)).slice(0, max).map((c) => c.id);
  }

  /** Plan the next candidate (true when the search is over). */
  step(): boolean {
    if (this.found || this.failed) return true;
    const cell = this.queue.shift();
    if (cell === undefined) { this.failed = true; return true; }
    const g = this.g, st = g.streamer.cells.get(cell);
    const plan = st && st.status === 'ready' && st.plan ? st.plan : planCell(g.macro, g.macro.cells[cell], g.terrain);
    this.found = this.pick(plan, cell);
    return !!this.found;
  }
}
