/**
 * Console helpers for testing (window.dev).
 */
import type { Game } from '../game/Game';
import type { BuildingRef } from '../world/WorldIndex';
import { statusOf } from '../shared/status';
import type { WeatherSetting } from '../render/Weather';
import { LandUse } from '../world/landuse';
import { RuralPlan } from '../world/rural';

export function installDevtools(game: Game): void {
  let rural: RuralPlan | null = null;
  const ruralPlan = () => { if (!rural) { const land = new LandUse(game.terrain); rural = new RuralPlan(game.terrain, land, game.macro); land.settle = rural; } return rural; };
  const dev = {
    game,
    wait: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    nearestBuilding(x = game.player.pos.x, z = game.player.pos.z, skip = 0): BuildingRef | null {
      const bs = game.world.buildingsIn(x - 120, z - 120, x + 120, z + 120).filter((b) => b.alive);
      const c = (b: BuildingRef) => Math.hypot((b.bounds[0] + b.bounds[2]) / 2 - x, (b.bounds[1] + b.bounds[3]) / 2 - z);
      bs.sort((a, b) => c(a) - c(b));
      return bs[skip] ?? null;
    },
    /** Free camera at position looking at a target. */
    look(px: number, py: number, pz: number, tx: number, ty: number, tz: number): void {
      const g = game as unknown as { freeCam: boolean; yaw: number; pitch: number };
      g.freeCam = true;
      game.renderer.camera.position.set(px, py, pz);
      const dx = tx - px, dy = ty - py, dz = tz - pz;
      g.yaw = Math.atan2(-dx, -dz);
      g.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    },
    playerCam(): void { (game as unknown as { freeCam: boolean }).freeCam = false; },
    /** Countryside: settlements nearest the camera (kind 0 hamlet, 1 village, 2 town, 3 farm), lakes, a view of one. */
    rural: {
      list(kind = -1, n = 8) {
        const c = game.renderer.camera.position;
        return ruralPlan().settlements.filter((s) => kind < 0 || s.kind === kind).map((s) => ({ id: s.id, kind: s.kind, name: s.name, x: Math.round(s.x), z: Math.round(s.z), d: Math.round(Math.hypot(s.x - c.x, s.z - c.z)) })).sort((a, b) => a.d - b.d).slice(0, n);
      },
      lakes: () => game.terrain.lakes.map((l, i) => ({ i, x: Math.round(l.x), z: Math.round(l.z), r: Math.round(l.r) })),
      /** Free camera looking at settlement `id` from `dist` m away and `h` m up. */
      look(id: number, dist = 260, h = 90, yaw = 0.6) {
        const s = ruralPlan().settlements[id];
        const y = game.terrain.height(s.x, s.z);
        dev.look(s.x + Math.cos(yaw) * dist, y + h, s.z + Math.sin(yaw) * dist, s.x, y + 5, s.z);
        return { name: s.name, kind: ['hamlet', 'village', 'town', 'farm'][s.kind] };
      },
      stats: () => game.rural.stats,
    },
    /** Blast the ground floor of a building on one side; camera at a distance. */
    blastBuilding(b: BuildingRef, impulse = 3e6, dist = 110): void {
      const L = game.destruction.layoutOf(b);
      const pan = L.panels[Math.floor(L.floors[0].panelCount / 2)];
      const x = (pan.ax + pan.bx) / 2, z = (pan.az + pan.bz) / 2;
      dev.look(x + pan.nx * dist + pan.nz * dist * 0.5, L.base + L.height + 45, z + pan.nz * dist - pan.nx * dist * 0.5, L.centroid[0], L.base + L.height * 0.3, L.centroid[1]);
      setTimeout(() => game.interactions.blast(x + pan.nx, L.base + 2, z + pan.nz, impulse), 800);
    },
    /** Put the player at the door of a nearby building (inside=true: just inside it). */
    door(inside = false, skip = 0, filter: (b: BuildingRef) => boolean = (b) => b.desc.floors >= 3 && b.desc.floors < 12): BuildingRef | null {
      let b: BuildingRef | null = null;
      for (let k = 0, found = 0; k < 60; k++) {
        const c = dev.nearestBuilding(undefined, undefined, k);
        if (c && filter(c)) { if (found++ === skip) { b = c; break; } }
      }
      if (!b) return null;
      const L = game.destruction.layoutOf(b);
      const P = b.poly, n = P.length / 2, i = L.door.edge, j = (i + 1) % n;
      const ex = P[j * 2] - P[i * 2], ez = P[j * 2 + 1] - P[i * 2 + 1];
      const el = Math.hypot(ex, ez);
      const nx = ez / el, nz = -ex / el;
      const d = inside ? -2.5 : 3;
      (game as unknown as { freeCam: boolean }).freeCam = false;
      game.player.pos.set(L.door.x + nx * d, L.base + 0.3, L.door.z + nz * d);
      game.camRig.yaw = Math.atan2(nx, nz) + (inside ? Math.PI : 0);
      game.camRig.pitch = -0.15;
      game.camRig.zoom = inside ? 1.2 : 2.5;
      return b;
    },
    setSize(h: number): void { game.player.height = h; },
    teleport(x: number, z: number): void { game.player.pos.set(x, game.world.groundHeight(x, z) + 0.1, z); },
    /** Put the player in the side room with the gap to hidden colony i (no hint in the game itself). */
    colony(i = 0): { room: number; kind: string; x: number; z: number } | null {
      const U = game.underground, c = U.rooms.colonies[i];
      if (!c) return null;
      const r = U.rooms.rooms[c.room], m = r.main, u = m.u0 + 0.6, v = (m.v0 + m.v1) / 2;
      const x = r.ox + r.nx * u - r.nz * v, z = r.oz + r.nz * u + r.nx * v;
      (game as unknown as { freeCam: boolean }).freeCam = false;
      game.player.pos.set(x, r.y + 0.1, z);
      game.player.vel.set(0, 0, 0);
      game.camRig.yaw = Math.atan2(-r.nx, -r.nz);
      return { room: r.id, kind: r.kind, x: Math.round(x), z: Math.round(z) };
    },
    /** The deep realm: go('hall' | 'gardens' | 'lake' | 'archive' | 'front' | 'lip' | 'bottom' | 'warrens' | 'heart' | 'lookout' | 'gate0' …), places, status. */
    deep: {
      places: () => Object.keys(game.underground.deep?.plan.places ?? {}),
      go(name = 'hall'): { x: number; y: number; z: number } | null {
        const D = game.underground.deep;
        if (!D) return null;
        let p: { x: number; y: number; z: number } | null = D.plan.places[name] ?? null;
        const g = /^gate(\d+)$/.exec(name);
        if (g) { const r = D.plan.roads.find((q) => q.colony === Number(g[1])) ?? D.plan.roads[0]; p = r ? { x: r.pts[3], y: r.pts[4], z: r.pts[5] } : null; }
        if (!p) return null;
        (game as unknown as { freeCam: boolean }).freeCam = false;
        game.player.pos.set(p.x, p.y + 0.2, p.z);
        game.player.vel.set(0, 0, 0);
        return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
      },
      status: () => ({ ...game.underground.deep?.meshes.stats, busy: game.underground.deep?.meshes.busy, roads: game.underground.deep?.plan.roads.length }),
    },
    /** The slime civilisation: status(), trust(v), raid(), breach(), war(patch). */
    slimes: {
      status: () => game.slimeRealm?.debug(),
      trust: (v: number) => { const T = game.slimeRealm.trust; T.add(v - T.value, 'dev'); return T.value; },
      raid: () => game.slimeRealm.devRaid(),
      breach: () => game.slimeRealm.devBreach(),
      war: (patch: Record<string, unknown> = {}) => Object.assign(game.slimeRealm.war, patch),
    },
    hour(h: number): void { game.sky.hour = h; },
    /** Weather: set('rain' | 'storm' | … | 'auto'), next(), status(), forecast(n), strike(distance m). */
    weather: {
      set: (k: WeatherSetting) => game.weather.set(k),
      next: () => game.weather.next(),
      auto: () => game.weather.set('auto'),
      status: () => game.weather.status(),
      forecast: (n?: number) => game.weather.forecast(n),
      strike: (d?: number) => game.weather.strike(d),
    },
    /** Power states on a person / car / robot / drone / prop (frozen, shrunk, burning …). */
    status: statusOf,
  };
  (window as unknown as { dev: typeof dev }).dev = dev;
}
