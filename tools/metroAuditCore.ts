/**
 * Metro geometry invariants, measured on the pure geometry (tubes, halls, timetable):
 * stations vs tracks, track continuity and gradients, clearances (cover, other lines,
 * sewers), trains vs track and platforms, entrance routes. Used by tools/metroaudit.ts
 * (report) and tools/selftest.ts (pass/fail).
 */
import type { Terrain } from '../src/world/terrain';
import type { MetroLine } from '../src/plan/types';
import { tubeAt, boxAt, slideMove, makeTube, type Tube, type Box } from '../src/underground/Volumes';
import { TUNNEL_HW, TUNNEL_H, STATION_HW, STATION_H, PLATFORM_H, SEWER_HW, SEWER_H, TRACK_OFF, CAR_L, CARS, CAR_W, CAR_FLOOR, trainsOn, carPose, ownHallHits } from '../src/underground/layout';

export interface AuditLine { line: MetroLine; tube: Tube; stops: { s: number; hall: Box | null }[] }
export interface AuditInput { terrain: Terrain; lines: AuditLine[]; sewers: Tube[]; halls: Box[]; passages?: { name: string; tube: Tube; hall: Box; ground: (x: number, z: number) => number }[] }

export interface LineReport {
  name: string;
  /** Station ↔ track: worst lateral offset of the track from the hall axis inside the hall (m), worst |track floor − hall floor| (m). */
  hallLateral: number; hallDy: number;
  /** Track: steepest gradient, tightest curve radius (m) and biggest gradient change between consecutive segments. */
  maxGrade: number; minRadius: number; maxGradeChange: number;
  /** Least soil cover over the tunnel/hall roof (m) and where. */
  minCover: number;
  /** Clearance conflicts with other lines' tunnels/halls and with sewers (sample count), least vertical gap there. */
  lineConflicts: number; sewerConflicts: number; minGap: number;
  /** Trains: dwelling cars outside the hall, car floor off the track bed/platform height (m). */
  carsOutside: number; carDy: number; carLateral: number;
  /** Dwelling trains: gap from the car side to the platform edge (min/max, m), step from the platform to the car floor (m). */
  platformGapMin: number; platformGapMax: number; floorStep: number;
}

const hwAt = (halls: Box[], x: number, y: number, z: number) => halls.some((b) => boxAt(b, x, y + 0.5, z, 0)) ? STATION_HW : TUNNEL_HW;
const hAt = (halls: Box[], x: number, y: number, z: number) => halls.some((b) => boxAt(b, x, y + 0.5, z, 0)) ? STATION_H : TUNNEL_H;

/** Point on a tube's centreline at arc length s (x, floor y, z). */
function at(t: Tube, s: number): [number, number, number] {
  const C = t.cum, P = t.pts;
  s = Math.max(0, Math.min(C[C.length - 1], s));
  let i = 0;
  while (i < C.length - 2 && C[i + 1] < s) i++;
  const f = (s - C[i]) / Math.max(1e-6, C[i + 1] - C[i]);
  return [P[i * 3] + (P[i * 3 + 3] - P[i * 3]) * f, P[i * 3 + 1] + (P[i * 3 + 4] - P[i * 3 + 1]) * f, P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * f];
}

/** Nearest centreline point of a tube (plan distance), with its floor. */
function nearest(t: Tube, x: number, z: number): { d: number; y: number; x: number; z: number } {
  const P = t.pts;
  let bd = Infinity, by = 0, bx = 0, bz = 0;
  for (let i = 0; i + 5 < P.length; i += 3) {
    const ax = P[i], az = P[i + 2], dx = P[i + 3] - ax, dz = P[i + 5] - az;
    const l2 = dx * dx + dz * dz;
    let u = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    u = Math.max(0, Math.min(1, u));
    const qx = ax + dx * u, qz = az + dz * u, d = Math.hypot(x - qx, z - qz);
    if (d < bd) { bd = d; by = P[i + 1] + (P[i + 4] - P[i + 1]) * u; bx = qx; bz = qz; }
  }
  return { d: bd, y: by, x: bx, z: bz };
}

export function auditLines(inp: AuditInput): LineReport[] {
  const { terrain, halls } = inp;
  const out: LineReport[] = [];
  inp.lines.forEach((L, li) => {
    const t = L.tube, P = t.pts, n = P.length / 3;
    const r: LineReport = { name: L.line.name, hallLateral: 0, hallDy: 0, maxGrade: 0, minRadius: Infinity, maxGradeChange: 0, minCover: Infinity, lineConflicts: 0, sewerConflicts: 0, minGap: Infinity, carsOutside: 0, carDy: 0, carLateral: 0, platformGapMin: Infinity, platformGapMax: -Infinity, floorStep: 0 };
    // Stations ↔ track.
    for (const st of L.stops) {
      const b = st.hall;
      if (!b) { r.hallLateral = Infinity; continue; }
      for (let s = st.s - b.hu; s <= st.s + b.hu; s += 2) {
        const [x, y, z] = at(t, s);
        const dx = x - b.cx, dz = z - b.cz;
        const u = dx * b.ux + dz * b.uz, v = -dx * b.uz + dz * b.ux;
        if (Math.abs(u) > b.hu) continue;
        r.hallLateral = Math.max(r.hallLateral, Math.abs(v));
        r.hallDy = Math.max(r.hallDy, Math.abs(y - b.y0));
      }
    }
    // Continuity / gradients / kinks / cover.
    let prevG = NaN;
    for (let i = 0; i + 1 < n; i++) {
      const L2 = t.cum[i + 1] - t.cum[i];
      if (L2 < 1e-3) continue;
      const g = (P[i * 3 + 4] - P[i * 3 + 1]) / L2;
      r.maxGrade = Math.max(r.maxGrade, Math.abs(g));
      if (!isNaN(prevG)) r.maxGradeChange = Math.max(r.maxGradeChange, Math.abs(g - prevG));
      prevG = g;
    }
    // Horizontal curvature: circumradius of track points 5 m either side, every 2.5 m.
    for (let s0 = 5; s0 + 5 <= t.cum[n - 1]; s0 += 2.5) {
      const [ax, , az] = at(t, s0 - 5), [bx, , bz] = at(t, s0), [cx, , cz] = at(t, s0 + 5);
      const cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
      if (Math.abs(cross) < 1e-9) continue;
      const R = (Math.hypot(bx - ax, bz - az) * Math.hypot(cx - bx, cz - bz) * Math.hypot(cx - ax, cz - az)) / (2 * Math.abs(cross));
      r.minRadius = Math.min(r.minRadius, R);
    }
    const total = t.cum[n - 1];
    for (let s = 0; s <= total; s += 5) {
      const [x, y, z] = at(t, s);
      r.minCover = Math.min(r.minCover, terrain.height(x, z) - (y + hAt(halls, x, y, z)));
      const hw = hwAt(halls, x, y, z), top = y + hAt(halls, x, y, z);
      // Other lines.
      inp.lines.forEach((M, mi) => {
        if (mi === li) return;
        const q = nearest(M.tube, x, z);
        const hw2 = hwAt(halls, q.x, q.y, q.z);
        if (q.d > hw + hw2 + 1) return;
        const top2 = q.y + hAt(halls, q.x, q.y, q.z);
        const gap = Math.max(q.y - top, y - top2);
        r.minGap = Math.min(r.minGap, gap);
        if (gap < 1) r.lineConflicts++;
      });
      // Sewers (floor channel 0.45 below the invert).
      for (const sw of inp.sewers) {
        if (x < sw.bounds[0] - hw || x > sw.bounds[2] + hw || z < sw.bounds[1] - hw || z > sw.bounds[3] + hw) continue;
        const q = nearest(sw, x, z);
        if (q.d > hw + SEWER_HW + 0.5) continue;
        const gap = Math.max(q.y - 0.45 - top, y - (q.y + SEWER_H));
        r.minGap = Math.min(r.minGap, gap);
        if (gap < 0.5) r.sewerConflicts++;
      }
    }
    // Trains: sample a full cycle; cars of dwelling trains must stand inside the hall on its track bed.
    const S = L.line.stationS;
    const cycle = S.length > 1 ? 2 * (Math.abs(S[S.length - 1] - S[0]) / 16 + S.length * 30) : 0;
    for (let tm = 0; tm < cycle; tm += 7) {
      for (const tr of trainsOn(L.line, tm)) {
        for (let c = 0; c < CARS; c++) {
          const p = carPose(t, tr, c);
          if (!p) { r.carsOutside++; continue; }
          const h = tubeAt(t, p.x, p.y + 0.5, p.z);
          if (!h) { r.carLateral = Math.max(r.carLateral, 99); continue; }
          r.carLateral = Math.max(r.carLateral, Math.abs(Math.abs(h.lat) - TRACK_OFF));
          if (!tr.dwell) continue;
          const b = L.stops[tr.next]?.hall;
          if (!b) continue;
          const dx = p.x - b.cx, dz = p.z - b.cz;
          const u = dx * b.ux + dz * b.uz, v = -dx * b.uz + dz * b.ux;
          if (Math.abs(u) > b.hu - CAR_L / 2 + 0.01) r.carsOutside++;
          r.carDy = Math.max(r.carDy, Math.abs(p.y - b.y0));
          // Platform edge to the car side, platform top to the car floor.
          const edge = Math.min(...b.platforms.filter((q) => Math.sign(q[0] + q[1]) === Math.sign(v)).map((q) => Math.min(Math.abs(q[0]), Math.abs(q[1]))));
          const g = edge - (Math.abs(v) + CAR_W / 2);
          r.platformGapMin = Math.min(r.platformGapMin, g);
          r.platformGapMax = Math.max(r.platformGapMax, g);
          r.floorStep = Math.max(r.floorStep, Math.abs(p.y + CAR_FLOOR - (b.y0 + PLATFORM_H)));
        }
      }
    }
    out.push(r);
  });
  return out;
}

export interface PassageReport { name: string; maxSlope: number; floorErr: number; ceilingOut: number; hits: number; endsOnPlatform: boolean; /** Highest step between floor samples 0.2 m apart anywhere across the passage (a ledge where it turns). */ ledge: number;
  /** Player-like walks (both ways, cutting the turns more or less) that got stuck, and where the first one did. */
  stuck: number; stuckAt: string }

/**
 * Entrance passages: walkable slope everywhere, the floor query along the walk equals the passage
 * floor (nothing else captures the walker), the ceiling stays under the street outside the opening,
 * no other tunnel/hall/sewer is cut, and the passage ends on the platform of its hall.
 */
export function auditPassages(inp: AuditInput, inHole: (x: number, z: number) => boolean): PassageReport[] {
  const out: PassageReport[] = [];
  const under = (inp.passages ?? []).map((p) => p.tube).filter((t) => t.underpass);
  for (const ps of inp.passages ?? []) {
    // (The halls' underpasses count as other volumes for every passage but themselves.)
    const vols = [...inp.lines.map((l) => l.tube), ...inp.sewers, ...under.filter((u) => u !== ps.tube)];
    const t = ps.tube, P = t.pts, n = P.length / 3;
    const r: PassageReport = { name: ps.name, maxSlope: 0, floorErr: 0, ceilingOut: 0, hits: 0, endsOnPlatform: false, ledge: passageLedge(t), stuck: 0, stuckAt: '' };
    const w = passageWalk(t, [t, ...under.filter((u) => u !== t)], inp.halls);
    r.stuck = w.stuck; r.stuckAt = w.at;
    for (let i = 0; i + 1 < n; i++) {
      const L2 = t.cum[i + 1] - t.cum[i];
      if (L2 > 1e-3) r.maxSlope = Math.max(r.maxSlope, Math.abs(P[i * 3 + 4] - P[i * 3 + 1]) / L2);
    }
    const total = t.cum[n - 1];
    for (let s = 0; s <= total; s += 0.25) {
      const [x, y, z] = at(t, s);
      // Highest floor at the walker's feet among all volumes (as Underground.floorAt).
      let best = -Infinity;
      for (const v of [t, ...vols]) { const h = tubeAt(v, x, y + 0.3, z); if (h && h.floor <= y + 0.9) best = Math.max(best, h.floor); }
      for (const b of inp.halls) { const h = boxAt(b, x, y + 0.3, z); if (h && h.floor <= y + 0.9) best = Math.max(best, h.floor); }
      r.floorErr = Math.max(r.floorErr, Math.abs(best - y));
      if (!inHole(x, z) && !t.underpass) r.ceilingOut = Math.max(r.ceilingOut, y + 2.0 - (ps.ground(x, z) - 0.15));
      // Other volumes cut by the passage's walking space (feet to 2.2 m).
      for (const v of vols) {
        const h = tubeAt(v, x, y + 1.1, z, -0.3);
        if (h && (v.underpass || Math.abs(h.floor - y) > 0.5)) { r.hits++; break; }
      }
      for (const b of inp.halls) if (b !== ps.hall && boxAt(b, x, y + 1.1, z, 0) && y + 1.1 > b.y0) { r.hits++; break; }
    }
    // Through its own hall's roof (a corridor over the hall pushed down too far).
    if (!t.underpass) r.hits += ownHallHits(ps.hall, P);
    const [ex, ey, ez] = at(t, total);
    const h = boxAt(ps.hall, ex, ey + 0.3, ez);
    r.endsOnPlatform = !!h && Math.abs(h.floor - (ps.hall.y0 + PLATFORM_H)) < 0.01 && Math.abs(ey - h.floor) < 0.05;
    out.push(r);
  }
  return out;
}

/**
 * Highest step between neighbouring floor samples (0.2 m apart, along and across) anywhere inside a
 * passage, off its centre line too: what a walker keeping to one side meets (a slope running into a
 * turn leaves a ledge across the corner).
 */
export function passageLedge(t: Tube): number {
  const P = t.pts, hw = t.halfWidth - 0.3, d = 0.2;
  const fl = (x: number, z: number) => tubeAt(t, x, 0, z, -0.3, true)?.floor ?? null;
  let worst = 0;
  for (let i = 0; i + 5 < P.length; i += 3) {
    const ax = P[i], az = P[i + 2], L = Math.hypot(P[i + 3] - ax, P[i + 5] - az);
    if (L < 1e-3) continue;
    const ux = (P[i + 3] - ax) / L, uz = (P[i + 5] - az) / L;
    for (let a = -hw; a <= L + hw; a += d) for (let c = -hw; c <= hw; c += d) {
      const x = ax + ux * a - uz * c, z = az + uz * a + ux * c, f = fl(x, z);
      if (f === null) continue;
      for (const [nx, nz] of [[ux * d, uz * d], [-uz * d, ux * d]]) {
        // The floor a walker standing at f finds a step on (as Underground.floorAt: in reach of the feet).
        const h = tubeAt(t, x + nx, f + 0.5, z + nz, -0.3);
        if (h && h.floor <= f + 1.1) worst = Math.max(worst, Math.abs(h.floor - f));
      }
    }
  }
  return worst;
}

/**
 * Walk a passage end to end and back like a player: the heading turns (rate-limited, like the
 * camera) toward a point some way ahead on the centre line, so the walker cuts the turns and
 * runs into the walls there; it moves as Collision.collide does underground (slideMove, kept
 * r/2 inside the volumes) on the floors Underground.floorAt finds. Counts the walks that stop
 * making headway (stuck against a wall or a ledge).
 */
export function passageWalk(t: Tube, tubes: Tube[], halls: Box[]): { stuck: number; walks: number; at: string } {
  const [bx0, bz0, bx1, bz1] = t.bounds;
  tubes = tubes.filter((v) => v.bounds[0] < bx1 && v.bounds[2] > bx0 && v.bounds[1] < bz1 && v.bounds[3] > bz0);
  halls = halls.filter((b) => b.bounds[0] < bx1 && b.bounds[2] > bx0 && b.bounds[1] < bz1 && b.bounds[3] > bz0);
  const R = 0.3, SPEED = 5.2, HZ = 120;
  const inside = (x: number, y: number, z: number) => tubes.some((v) => tubeAt(v, x, y, z, -R / 2)) || halls.some((b) => boxAt(b, x, y, z, -R / 2));
  const floorAt = (x: number, y: number, z: number) => {
    let best: number | null = null;
    for (const v of tubes) { const h = tubeAt(v, x, y, z); if (h && h.floor <= y + 0.6 && (best === null || h.floor > best)) best = h.floor; }
    for (const b of halls) { const h = boxAt(b, x, y, z); if (h && h.floor <= y + 0.6 && (best === null || h.floor > best)) best = h.floor; }
    return best;
  };
  // The way a player takes: flat stretches cut straight across where the space allows (a landing
  // that folds back on itself is one floor, nobody walks its zig-zag centre line).
  const P = t.pts, way: number[] = [P[0], P[1], P[2]];
  for (let i = 0; i < P.length / 3 - 1;) {
    let j = i + 1;
    for (let k = P.length / 3 - 1; k > i + 1; k--) {
      let flat = true;
      for (let m = i; m <= k && flat; m++) flat = Math.abs(P[m * 3 + 1] - P[i * 3 + 1]) < 0.01;
      if (!flat) continue;
      const L = Math.hypot(P[k * 3] - P[i * 3], P[k * 3 + 2] - P[i * 3 + 2]);
      let clear = true;
      for (let d = 0; d <= L && clear; d += 0.2) {
        const f = d / Math.max(L, 1e-6), x = P[i * 3] + (P[k * 3] - P[i * 3]) * f, z = P[i * 3 + 2] + (P[k * 3 + 2] - P[i * 3 + 2]) * f;
        clear = inside(x, P[i * 3 + 1] + 0.3, z);
      }
      if (clear) { j = k; break; }
    }
    way.push(P[j * 3], P[j * 3 + 1], P[j * 3 + 2]);
    i = j;
  }
  const W = makeTube(t.kind, way, t.halfWidth, t.height);
  const n = way.length / 3, total = W.cum[n - 1];
  let stuck = 0, walks = 0, where = '';
  for (const dir of [1, -1]) for (const look of [1.2, 2.5, 4]) {
    walks++;
    const along = (s: number) => at(W, dir > 0 ? s : total - s);
    let [x, y, z] = along(0.3);
    const [ax, , az] = along(1.3);
    let yaw = Math.atan2(ax - x, az - z), s = 0.3, best = s, since = 0, tx = ax, tz = az;
    for (let f = 0; f < HZ * 120; f++) {
      // Headway: the nearest point of the way a little either side of the last one.
      let bs = s, bd = Infinity;
      for (let q = Math.max(0, s - 1); q <= Math.min(total, s + 1.5); q += 0.05) { const [qx, , qz] = along(q); const d = Math.hypot(qx - x, qz - z); if (d < bd) { bd = d; bs = q; } }
      s = bs;
      if (s >= total - 0.6) break;
      if (s > best + 0.05) { best = s; since = 0; } else if (++since > HZ * 3) {
        // (Only inside its own passage: a walker that cut a turn into the hall and stands under
        // the stairs it aims for is lost, not stuck.)
        if (!tubeAt(t, x, y + 0.3, z)) break;
        stuck++;
        if (!where) where = `${x.toFixed(1)},${y.toFixed(2)},${z.toFixed(1)} (${dir > 0 ? 'in' : 'out'}, ${s.toFixed(1)} of ${total.toFixed(1)} m)`;
        break;
      }
      // The carrot: the farthest point of the way ahead (up to look m) in a clear line from the
      // walker, like a player steering round a hairpin rather than into its middle wall.
      if (f % 6 === 0) {
        for (let q = Math.min(total, s + look); q >= s; q -= 0.25) {
          const [qx, , qz] = along(q), L = Math.hypot(qx - x, qz - z);
          let clear = true;
          for (let d = 0.2; d < L && clear; d += 0.2) clear = inside(x + (qx - x) * d / L, y + 0.3, z + (qz - z) * d / L);
          if (clear || q - 0.25 < s) { tx = qx; tz = qz; break; }
        }
      }
      const want = Math.atan2(tx - x, tz - z), lim = 4 / HZ;
      yaw += Math.max(-lim, Math.min(lim, Math.atan2(Math.sin(want - yaw), Math.cos(want - yaw))));
      const [mx, mz] = slideMove((qx, qz) => inside(qx, y + 0.3, qz), x, z, x + Math.sin(yaw) * SPEED / HZ, z + Math.cos(yaw) * SPEED / HZ);
      const g = floorAt(mx, y + 0.3, mz);
      // (No floor in reach: off the volumes, the walker would fall; count it as not getting on.)
      if (g === null) continue;
      x = mx; z = mz; y = g;
    }
  }
  return { stuck, walks, at: where };
}
