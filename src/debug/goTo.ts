/**
 * "Go to" targets for the admin console (and `dev.goto` on the command line): every place worth
 * a look in the city that is loaded — each landmark (on its square, and room by room through its
 * walk-in inside), the concert stage, cemeteries, arcades and clothes shops, metro stations,
 * sewer side rooms, manholes, gang hideouts, slime colonies and their deep realms, villages, and
 * the threats and crimes going on right now. Only what this city has is listed.
 *
 * A place with several of a kind is one entry that steps to the next one each time it is used
 * (nearest first, counted from where the player was when the list was made). Places in blocks
 * that are not loaded yet (shops, arcades) are flown to first and entered once their block is in.
 */
import type { Game } from '../game/Game';
import { LANDMARK_KIND_NAME, siteToWorld, type Landmark } from '../plan/landmarks';
import { landmarkInterior, type LmInterior } from '../plan/landmarkParts';
import { planCell, PropType, type CellPlan } from '../plan/cell';
import { isArcade, isClothesShop } from '../interior/InteriorGen';
import type { BuildingDesc } from '../plan/building';
import { pointInPoly, polyCentroid } from '../core/geom2';
import type { BuildingRef } from '../world/WorldIndex';
import { GHOST_PLATFORM } from '../underground/rooms';

type Dev = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface GoPlace {
  group: string;
  label: string;
  /** How many there are (an entry that steps through them), or 1. */
  count: number;
  go: () => unknown;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (v: number) => Math.round(v);

/** Calls a helper that may not exist (a system not built in this mode). */
function call(dev: Dev, path: string, ...args: unknown[]): unknown {
  let o: Dev | undefined = dev, parent: Dev | undefined;
  for (const k of path.split('.')) { parent = o; o = o?.[k]; }
  if (typeof o !== 'function') return `no dev.${path} here`;
  return (o as (...a: unknown[]) => unknown).apply(parent, args);
}

/**
 * Cemeteries, arcades and clothes shops are only in the blocks' plans, and planning a whole big
 * city takes minutes: the cells are planned nearest first (from where the first search began),
 * only as far as the next place asked for, a few at a time so the game keeps running.
 */
interface Found { x: number; z: number; nx: number; nz: number }
type ScanKind = 'cem' | 'arcade' | 'clothes';

export class GoTo {
  /** Step position of each multi-place entry. */
  private step = new Map<string, number>();
  private found: Record<ScanKind, Found[]> = { cem: [], arcade: [], clothes: [] };
  /** Cells still to plan, nearest the first search first (null: not begun). */
  private queue: number[] | null = null;
  private lmOrder: Landmark[] | null = null;

  constructor(private g: Game, private dev: () => Dev) {}

  /** Stand at (x, y, z) facing a point (the camera behind, looking that way). */
  put(x: number, y: number, z: number, lookX?: number, lookZ?: number, inside = false): { x: number; y: number; z: number } {
    const g = this.g;
    if (g.manhole?.active) g.manhole.abort();
    (g as unknown as { freeCam: boolean }).freeCam = false;
    g.player.pos.set(x, y + 0.1, z);
    g.player.vel.set(0, 0, 0);
    // Indoors the camera comes in close, so it stays in the room (no walls between it and the hero).
    g.camRig.zoom = inside ? 1 : 2.6;
    // The boom points from the player to the camera: away from what we look at.
    if (lookX !== undefined && lookZ !== undefined && Math.hypot(lookX - x, lookZ - z) > 0.01) g.camRig.yaw = Math.atan2(x - lookX, z - lookZ);
    g.camRig.snap?.();
    return { x: round(x), y: round(y), z: round(z) };
  }

  /** The standable street point nearest (x, z) (rings outwards), or null. */
  private standNear(x: number, z: number, max = 80): [number, number] | null {
    const W = this.g.world;
    if (W.standable(x, z)) return [x, z];
    for (let r = 2; r <= max; r += 2) {
      const n = Math.max(8, Math.round(r * 1.5));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
        if (W.standable(px, pz)) return [px, pz];
      }
    }
    return null;
  }

  /** On the street `dist` m from (x, z) on the player's side of it, facing it. */
  private near(x: number, z: number, dist: number): unknown {
    const p = this.g.player.pos;
    let dx = p.x - x, dz = p.z - z;
    const L = Math.hypot(dx, dz);
    if (L < 1) { dx = 1; dz = 0; } else { dx /= L; dz /= L; }
    const s = this.standNear(x + dx * dist, z + dz * dist) ?? [x + dx * dist, z + dz * dist];
    return this.put(s[0], this.g.world.groundHeight(s[0], s[1]), s[1], x, z);
  }

  /** A place whose block has not loaded yet: the next press tries the same one again (we are there now). */
  private retry(key: string, i: number, v: unknown): void {
    if (typeof v === 'string' && /not load/.test(v)) this.step.set(key, i - 1);
  }

  /** Next index of a stepping entry. */
  private next(key: string, n: number): number {
    const i = (this.step.get(key) ?? -1) + 1;
    const k = i >= n ? 0 : i;
    this.step.set(key, k);
    return k;
  }

  /** Item order of each stepping entry, kept while the count stays (so stepping does not reshuffle as we move). */
  private kept = new Map<string, unknown[]>();

  private stepper<T>(group: string, label: string, key: string, list: T[], go: (t: T, i: number) => unknown): GoPlace | null {
    if (!list.length) return null;
    const had = this.kept.get(key) as T[] | undefined;
    const items = had && had.length === list.length ? had : list;
    this.kept.set(key, items);
    return {
      group, label: items.length > 1 ? `${label} (${items.length})` : label, count: items.length,
      go: () => {
        const i = this.next(key, items.length);
        const r = go(items[i], i);
        const tag = items.length > 1 ? `${i + 1}/${items.length}` : '';
        const done = (v: unknown) => { this.retry(key, i, v); return tag ? { n: tag, at: v } : v; };
        return r instanceof Promise ? r.then(done) : done(r);
      },
    };
  }

  /** Nearest the player first. */
  private byDistance<T>(items: T[], at: (t: T) => [number, number]): T[] {
    const p = this.g.player.pos;
    return items.map((t) => ({ t, d: Math.hypot(at(t)[0] - p.x, at(t)[1] - p.z) })).sort((a, b) => a.d - b.d).map((e) => e.t);
  }

  // ------------------------------------------------------------------ landmarks

  /** The square in front of a landmark (its front faces -v), looking at it. */
  private front(lm: Landmark): unknown {
    const [fx, fz] = siteToWorld(lm, 0, -lm.hv - 3);
    const s = this.standNear(fx, fz, 60) ?? [fx, fz];
    return this.put(s[0], this.g.world.groundHeight(s[0], s[1], lm.base + 3), s[1], lm.x, lm.z);
  }

  /**
   * Inside a landmark: first just in through its door looking in, then one room after another
   * (the walkway point nearest each room's middle).
   */
  private inside(lm: Landmark, ins: LmInterior, i: number): unknown {
    const N = ins.nav;
    if (i === 0 && ins.exits.length) {
      const e = ins.exits[0], x = N[e.node * 3], y = N[e.node * 3 + 1], z = N[e.node * 3 + 2];
      let dx = x - (e.pts[0] ?? lm.x), dz = z - (e.pts[2] ?? lm.z);
      const L = Math.hypot(dx, dz) || 1;
      dx /= L; dz /= L;
      // A few steps in from the door (if that is still indoors), looking further in.
      const inRoom = (px: number, pz: number) => ins.rooms.some((r) => y >= r.y0 - 0.6 && y <= r.y1 && pointInPoly(r.poly, px, pz));
      const k = inRoom(x + dx * 3, z + dz * 3) ? 3 : 0;
      const r = this.put(x + dx * k, y, z + dz * k, x + dx * 10, z + dz * 10, true);
      return { room: 'door', ...r };
    }
    const room = ins.rooms[(i - (ins.exits.length ? 1 : 0)) % ins.rooms.length];
    const [cx, cz] = polyCentroid(room.poly);
    let best = -1, bd = Infinity;
    for (let k = 0; k < N.length / 3; k++) {
      const x = N[k * 3], y = N[k * 3 + 1], z = N[k * 3 + 2];
      if (y < room.y0 - 0.6 || y > room.y1 || !pointInPoly(room.poly, x, z)) continue;
      const d = Math.hypot(x - cx, z - cz);
      if (d < bd) { bd = d; best = k; }
    }
    const x = best >= 0 ? N[best * 3] : cx, y = best >= 0 ? N[best * 3 + 1] : room.y0, z = best >= 0 ? N[best * 3 + 2] : cz;
    return { room: ins.rooms.indexOf(room) + 1, of: ins.rooms.length, ...this.put(x, y, z, cx, cz, true) };
  }

  private landmarkPlaces(out: GoPlace[]): void {
    const g = this.g;
    // Nearest first, as they were the first time (the list keeps its order while you travel).
    const lms = (this.lmOrder ??= this.byDistance(g.macro.landmarks ?? [], (l) => [l.x, l.z]));
    for (const lm of lms) {
      const kind = LANDMARK_KIND_NAME[lm.kind];
      const name = lm.name && lm.name.toLowerCase() !== kind ? `${lm.name} (${kind})` : kind[0].toUpperCase() + kind.slice(1);
      out.push({ group: 'Landmarks', label: name, count: 1, go: () => this.front(lm) });
      const ins = landmarkInterior(lm, g.terrain);
      if (ins && ins.rooms.length) {
        const n = ins.rooms.length + (ins.exits.length ? 1 : 0);
        const steps = Array.from({ length: n }, (_, i) => i);
        const p = this.stepper('Landmarks', `↳ inside, room by room`, `lm:${lm.id}`, steps, (i) => this.inside(lm, ins, i));
        if (p) out.push(p);
      }
    }
  }

  // ------------------------------------------------------------------ city-wide plan scan

  private planOf(cell: number): CellPlan {
    const g = this.g, st = g.streamer.cells.get(cell);
    return st && st.status === 'ready' && st.plan ? st.plan : planCell(g.macro, g.macro.cells[cell], g.terrain);
  }

  /** The i-th place of a kind, nearest first, planning more cells until it is found (null: the city has no more). */
  private async nth(kind: ScanKind, i: number): Promise<Found | null> {
    const g = this.g, cells = g.macro.cells, F = this.found;
    if (!this.queue) this.queue = this.byDistance(cells.map((_, c) => c).filter((c) => cells[c].district !== 'water'), (c) => [cells[c].centroid[0], cells[c].centroid[1]]);
    let t0 = performance.now();
    while (F[kind].length <= i && this.queue.length) {
      this.scanCell(this.queue.shift()!);
      // Let the game run a frame now and then.
      if (performance.now() - t0 > 30) { await wait(0); t0 = performance.now(); }
    }
    return F[kind][i] ?? null;
  }

  /** Cemeteries (in front of the main tomb, which faces the gate), arcades and clothes shops of a cell. */
  private scanCell(c: number): void {
    const plan = this.planOf(c), F = this.found;
    for (const cem of plan.cemeteries) {
      const P = plan.props;
      let best: { x: number; z: number; yaw: number } | null = null;
      for (let i = 0; i < P.length; i += 6) {
        if (P[i] !== PropType.Tomb || !pointInPoly(cem.outer, P[i + 1], P[i + 2])) continue;
        best = { x: P[i + 1], z: P[i + 2], yaw: P[i + 3] };
        if (P[i + 5] === 0) break;
      }
      if (best) { const nx = -Math.sin(best.yaw), nz = -Math.cos(best.yaw); F.cem.push({ x: best.x + nx * 6.5, z: best.z + nz * 6.5, nx, nz }); }
      else { const [x, z] = polyCentroid(cem.outer); F.cem.push({ x, z, nx: 0, nz: 0 }); }
    }
    for (const b of plan.buildings as BuildingDesc[]) {
      const kind = isArcade(b) ? 'arcade' : isClothesShop(b) ? 'clothes' : null;
      if (!kind) continue;
      const [x, z] = polyCentroid(b.poly);
      F[kind].push({ x, z, nx: 0, nz: 0 });
    }
  }

  /** Go into a shop: fly over it, wait for its block to load, then stand just inside its door. */
  private async shop(s: { x: number; z: number }, test: (d: BuildingDesc) => boolean): Promise<unknown> {
    const g = this.g;
    const find = (): BuildingRef | undefined => g.world.buildingsIn(s.x - 2, s.z - 2, s.x + 2, s.z + 2).find((b) => b.alive && test(b.desc) && pointInPoly(b.poly, s.x, s.z));
    let b = find();
    if (!b) {
      const st = this.standNear(s.x, s.z, 60) ?? [s.x, s.z];
      this.put(st[0], g.world.groundHeight(st[0], st[1]), st[1], s.x, s.z);
      for (let k = 0; k < 120 && !b; k++) { await wait(250); b = find(); }
      if (!b) return `its block has not loaded yet (at ${round(s.x)}, ${round(s.z)}): press again`;
    }
    // Just inside the street door, looking in.
    const L = g.destruction.layoutOf(b), P = b.poly, n = P.length / 2, i = L.door.edge, j = (i + 1) % n;
    const ex = P[j * 2] - P[i * 2], ez = P[j * 2 + 1] - P[i * 2 + 1], el = Math.hypot(ex, ez);
    const nx = ez / el, nz = -ex / el;
    return { inside: true, ...this.put(L.door.x - nx * 3.5, L.base + 0.2, L.door.z - nz * 3.5, L.door.x - nx * 8, L.door.z - nz * 8, true) };
  }

  private cityPlaces(out: GoPlace[]): void {
    // Several of a kind, found as you go: each press goes to the next one (back to the first after the last).
    const scanned = (label: string, kind: ScanKind, go: (f: Found) => unknown): GoPlace => ({
      group: 'City', label, count: 0,
      go: async () => {
        let i = this.next(kind, Infinity);
        let f = await this.nth(kind, i);
        if (!f && i > 0) { this.step.set(kind, 0); i = 0; f = await this.nth(kind, 0); }
        if (!f) return 'none in this city';
        const v = await go(f);
        this.retry(kind, i, v);
        return { n: `${i + 1}${this.queue?.length ? '' : '/' + this.found[kind].length}`, at: v };
      },
    });
    out.push(scanned('Cemetery (next)', 'cem', (t) => this.put(t.x, this.g.world.groundHeight(t.x, t.z), t.z, t.x - t.nx * 10, t.z - t.nz * 10)));
    out.push(scanned('Arcade, inside (next)', 'arcade', (s) => this.shop(s, isArcade)));
    out.push(scanned('Clothes shop, inside (next)', 'clothes', (s) => this.shop(s, isClothesShop)));
    out.push({ group: 'City', label: 'Fitting mirror (nearest clothes shop)', count: 1, go: () => call(this.dev(), 'mirror') });
    const d = this.dev();
    if (d.concert) for (const w of ['stage', 'pit', 'stand'] as const) out.push({ group: 'City', label: `Concert: ${w === 'stand' ? 'stands' : w}`, count: 1, go: () => call(this.dev(), 'concert.go', w) });
    // Villages, towns and farms out in the countryside.
    const rural = d.rural?.list?.(-1, 200) as { id: number; kind: number; name: string; x: number; z: number }[] | undefined;
    if (rural?.length) {
      const KIND = ['hamlet', 'village', 'town', 'farm'];
      for (const k of [2, 1, 0, 3]) {
        const list = rural.filter((s) => s.kind === k);
        const p = this.stepper('Countryside', KIND[k][0].toUpperCase() + KIND[k].slice(1), `rural:${k}`, list, (s) => ({ name: s.name, ...(this.near(s.x, s.z, 0) as object) }));
        if (p) out.push(p);
      }
    }
  }

  // ------------------------------------------------------------------ underground

  private undergroundPlaces(out: GoPlace[]): void {
    const g = this.g, U = g.underground;
    if (!U) return;
    const stations = this.byDistance(U.boxes.filter((b) => b.kind === 'station'), (b) => [b.cx, b.cz]);
    const st = this.stepper('Underground', 'Metro station platform', 'metro', stations, (b) => {
      const v = b.hv - 3;
      const x = b.cx - b.uz * v, z = b.cz + b.ux * v;
      return { station: b.station ?? -1, ...this.put(x, b.y0 + 1.05, z, b.cx, b.cz) };
    });
    if (st) out.push(st);
    out.push({ group: 'Underground', label: 'Nearest manhole (climb down)', count: 1, go: () => call(this.dev(), 'manhole', 'down', 1500) });
    const rooms = U.rooms.rooms;
    const kinds = [...new Set(rooms.map((r) => r.kind))].sort((a, b) => (rooms.find((r) => r.kind === a)!.net === 'sewer' ? 0 : 1) - (rooms.find((r) => r.kind === b)!.net === 'sewer' ? 0 : 1) || a.localeCompare(b));
    for (const kind of kinds) {
      const list = this.byDistance(rooms.filter((r) => r.kind === kind), (r) => [r.ox, r.oz]);
      const net = list[0].net === 'metro' ? 'Metro room' : 'Sewer room';
      const p = this.stepper('Underground', `${net}: ${kind}`, `room:${kind}`, list, (r) => {
        const v = (r.doors[0].v0 + r.doors[0].v1) / 2, u = r.main.u0 + (r.kind === 'ghost' ? 2 : 0.6);
        const x = r.ox + r.nx * u - r.nz * v, z = r.oz + r.nz * u + r.nx * v;
        // Facing into the room (along +n).
        // The ghost station's room: onto its old platform (the main box's floor is the track bed).
        const y = r.kind === 'ghost' ? r.main.y0 + GHOST_PLATFORM : r.y;
        return { room: r.id, ...this.put(x, y, z, x + r.nx * 5, z + r.nz * 5, true) };
      });
      if (p) out.push(p);
    }
    const colonies = U.rooms.colonies.map((_, i) => i);
    const c = this.stepper('Underground', 'Slime colony gap', 'colony', colonies, (i) => call(this.dev(), 'colony', i));
    if (c) out.push(c);
    const realms = U.deeps.map((_, i) => i);
    for (const place of ['hall', 'gardens', 'trench', 'heart']) {
      const p = this.stepper('Underground', `Deep realm: ${place}`, `deep:${place}`, realms, (i) => call(this.dev(), 'deep.go', place, i) ?? `no ${place} in realm ${i}`);
      if (p) out.push(p);
    }
  }

  // ------------------------------------------------------------------ people and events

  private eventPlaces(out: GoPlace[]): void {
    const g = this.g, d = this.dev();
    const ids = (g.crime?.hideouts ?? []).map((_, i) => i).filter((i) => g.crime.hideouts[i]);
    const h = this.stepper('Now', 'Gang hideout', 'hideout', ids, async (id) => {
      let r = call(this.dev(), 'hideout', id, 'go');
      // Its block is loading: ask again until it is in.
      for (let k = 0; k < 160 && typeof r === 'string' && r.includes('not loaded'); k++) { await wait(250); r = call(this.dev(), 'hideout', id, 'go'); }
      return r;
    });
    if (h) out.push(h);
    const threats = (d.threat?.director?.events ?? []) as { archetype: string; x: number; z: number; radius: number; active: boolean }[];
    for (const e of threats.filter((t) => t.active)) {
      out.push({ group: 'Now', label: `Threat: ${e.archetype}`, count: 1, go: () => this.near(e.x, e.z, Math.min(120, Math.max(25, e.radius * 0.4))) });
    }
    const crimes = (g.crime?.crimes ?? []) as { kind: string; x: number; z: number }[];
    for (const c of crimes) out.push({ group: 'Now', label: `Crime: ${c.kind}`, count: 1, go: () => this.near(c.x, c.z, 15) });
    if (g.map?.waypoint) out.push({ group: 'Now', label: 'Map marker', count: 1, go: () => { const w = g.map.waypoint!; return this.near(w.x, w.z, 0); } });
  }

  /** Everything there is to go to, right now. */
  list(): GoPlace[] {
    const out: GoPlace[] = [];
    for (const f of [this.landmarkPlaces, this.cityPlaces, this.undergroundPlaces, this.eventPlaces]) {
      try { f.call(this, out); } catch (e) { console.warn('goto:', e); }
    }
    return out;
  }
}
