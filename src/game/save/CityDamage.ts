/**
 * City damage in saves: what the destruction system keeps per cell (element alive / window
 * state, broken slab tiles), which buildings collapsed (gone, or cut down to a lower top) and the
 * rubble mounds. Stored compactly (codec.ts index runs, base64); restored into loaded cells at
 * once and into the others when they stream in.
 *
 * It also keeps collapsed buildings collapsed across cell eviction (the world index rebuilds a
 * cell's buildings standing when it streams back in; the element state already survived).
 *
 * Breakable landmarks keep their broken pieces (what they held up is gone on restore).
 *
 * Not kept: loose and settled debris, broken street props and trees, wrecked cars, road craters.
 */
import type { Game } from '../Game';
import type { CellState } from '../../stream/CityStreamer';
import { encodeIndexSet, decodeIndexSet, lowIndices } from './codec';
import type { SaveDamage } from './model';

export class CityDamage {
  /** Collapsed buildings by cell: building index → top (−1: gone). Kept across eviction. */
  private collapsed = new Map<number, Map<number, number>>();
  /** Cells whose damaged buildings still need their slabs shown (restored dead elements). */
  private pendingDead = new Map<number, number[]>();

  constructor(private g: Game) {
    const S = g.streamer;
    const ready = S.onCellReady, evicted = S.onCellEvicted;
    S.onCellReady = (c) => { ready?.(c); try { this.cellReady(c); } catch (e) { console.warn('[saves] damage restore', e); } };
    S.onCellEvicted = (c) => { try { this.remember(c); } catch (e) { console.warn('[saves] damage', e); } evicted?.(c); };
  }

  /** Original top of a building (before any collapse). */
  private originalTop(cs: CellState, i: number): number {
    const b = this.g.streamer.buildingInfo(cs, i);
    return b ? b.base + b.height : Infinity;
  }

  /** Collapsed buildings of a loaded cell into `collapsed`. */
  private remember(cs: CellState): void {
    const refs = this.g.world.cellBuildings(cs.id);
    if (!refs.length) return;
    let m = this.collapsed.get(cs.id);
    for (const r of refs) {
      const top = !r.alive ? -1 : r.top < this.originalTop(cs, r.index) - 0.05 ? r.top : null;
      if (top === null) continue;
      if (!m) this.collapsed.set(cs.id, (m = new Map()));
      m.set(r.index, top);
    }
  }

  private cellReady(cs: CellState): void {
    const refs = this.g.world.cellBuildings(cs.id);
    const col = this.collapsed.get(cs.id), dead = this.pendingDead.get(cs.id);
    if (!col && !dead) return;
    this.pendingDead.delete(cs.id);
    const D = this.g.destruction;
    for (const r of refs) {
      const top = col?.get(r.index);
      if (top !== undefined) D.restoreBuilding(r, top);
      else if (dead && anyIn(dead, r.elemBase, r.elemBase + r.elemCount)) D.restoreBuilding(r, null);
    }
  }

  /** A building rebuilt (Reconstruction): no longer collapsed, nothing of it to restore. */
  forget(cell: number, index: number): void {
    const m = this.collapsed.get(cell);
    if (m) { m.delete(index); if (!m.size) this.collapsed.delete(cell); }
    const dead = this.pendingDead.get(cell);
    const ref = this.g.world.cellBuildings(cell)[index];
    if (dead && ref) this.pendingDead.set(cell, dead.filter((e) => e < ref.elemBase || e >= ref.elemBase + ref.elemCount));
  }

  capture(): SaveDamage | null {
    const g = this.g, D = g.destruction, I = g.interiors;
    const cells: SaveDamage['cells'] = [];
    for (const [id, st] of g.streamer.elementStates()) {
      const cs = st.cell;
      // Dead: broken, not just hidden by an open interior. Glass: shattered in a standing wall, not opened by an interior.
      const dead = lowIndices(st.data, st.count, 2, 0, cs ? (e) => D.isBroken(cs, e) || !D.interiorHidden?.(cs, e) : undefined);
      const glass = lowIndices(st.data, st.count, 2, 1, (e) => st.data[e * 2] >= 128 && !(cs && I.opened(cs, e)));
      const slabs = D.brokenTiles(id);
      if (!dead.length && !glass.length && !slabs.length) continue;
      cells.push({ id, n: st.count, dead: encodeIndexSet(dead), glass: encodeIndexSet(glass), slabs: encodeIndexSet(slabs) });
    }
    for (const cs of g.streamer.cells.values()) if (cs.status === 'ready') this.remember(cs);
    const buildings: SaveDamage['buildings'] = [];
    for (const [cell, m] of this.collapsed) for (const [i, top] of m) buildings.push([cell, i, Math.round(top * 100) / 100]);
    const mounds: SaveDamage['mounds'] = D.mounds.map((m) => [r2(m.x), r2(m.z), r2(m.r), r2(m.h)]);
    const landmarks: NonNullable<SaveDamage['landmarks']> = (D.landmarks?.capture() ?? []).map(([i, n, dead]) => [i, n, encodeIndexSet(dead)]);
    if (!cells.length && !buildings.length && !mounds.length && !landmarks.length) return null;
    return { cells, buildings, mounds, ...(landmarks.length ? { landmarks } : {}) };
  }

  /** Put saved damage back (a fresh city: nothing broken yet). Returns cells restored. */
  restore(d: SaveDamage | null): number {
    if (!d) return 0;
    const g = this.g, D = g.destruction;
    for (const [cell, i, top] of d.buildings) {
      let m = this.collapsed.get(cell);
      if (!m) this.collapsed.set(cell, (m = new Map()));
      m.set(i, top);
    }
    let n = 0;
    for (const c of d.cells) {
      const dead = decodeIndexSet(c.dead), glass = decodeIndexSet(c.glass), slabs = decodeIndexSet(c.slabs);
      const ok = g.streamer.restoreElements(c.id, c.n, (data) => {
        for (const e of dead) if (e < c.n) data[e * 2] = 0;
        for (const e of glass) if (e < c.n) data[e * 2 + 1] = 0;
      });
      if (!ok) { console.warn(`[saves] cell ${c.id}: element count changed, its damage is skipped`); continue; }
      D.restoreBroken(c.id, slabs);
      if (dead.length) this.pendingDead.set(c.id, dead);
      n++;
    }
    for (const [x, z, r, h] of d.mounds) D.restoreMound(x, z, r, h);
    for (const [i, cnt, dead] of d.landmarks ?? []) {
      if (D.landmarks && !D.landmarks.restore(i, cnt, decodeIndexSet(dead))) console.warn(`[saves] landmark ${i}: its pieces changed, its damage is skipped`);
    }
    // Cells that are loaded already.
    for (const cs of g.streamer.cells.values()) if (cs.status === 'ready') this.cellReady(cs);
    return n;
  }
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Does the sorted list hold a value in [lo, hi)? */
function anyIn(sorted: number[], lo: number, hi: number): boolean {
  let a = 0, b = sorted.length;
  while (a < b) { const m = (a + b) >> 1; if (sorted[m] < lo) a = m + 1; else b = m; }
  return a < sorted.length && sorted[a] < hi;
}
