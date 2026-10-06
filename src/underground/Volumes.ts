/**
 * Walkable underground volumes: tubes along polylines (metro tunnels, sewer
 * trunks, inclined entrance passages) and boxes (stations, chambers). Used
 * for collision (floor height, keeping bodies inside) and "am I underground".
 */

export interface Tube {
  /** crawl: the narrow, rough passages to the hidden chambers (drawn by RoomMeshes, not as tube chunks). */
  kind: 'metro' | 'sewer' | 'passage' | 'crawl';
  /** Polyline x,y(floor),z per vertex. */
  pts: number[];
  halfWidth: number;
  height: number;
  /** Arc length per vertex. */
  cum: number[];
  /** Precomputed bounds for culling. */
  bounds: [number, number, number, number];
  /** Floor offset profile across (sewer channel): floor at |lat| < channel is lower. */
  channel?: number;
  channelDepth?: number;
  /** A station's cross-platform underpass (a passage that entrance routes keep clear of). */
  underpass?: boolean;
}

export interface Box {
  /** room: side rooms off the tunnels and the hidden chambers (rooms.ts). */
  kind: 'station' | 'chamber' | 'room';
  cx: number; cz: number; y0: number; y1: number;
  ux: number; uz: number; hu: number; hv: number;
  /** Raised platforms: [v0, v1, height] bands across, optionally only over [u0, u1] along (steps); later ones win. */
  platforms: Platform[];
  bounds: [number, number, number, number];
  /** Station halls: station id, hall index within the station, metro line. */
  station?: number; hall?: number; line?: number;
  /** Side rooms: the room it belongs to; hidden chambers: their colony. */
  room?: number; colony?: number;
}

export type Platform = [number, number, number] | [number, number, number, number, number];

export function makeTube(kind: Tube['kind'], pts: number[], halfWidth: number, height: number, channel?: number, channelDepth?: number): Tube {
  const cum = [0];
  for (let i = 3; i < pts.length; i += 3) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 3], pts[i + 2] - pts[i - 1]));
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < pts.length; i += 3) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); z0 = Math.min(z0, pts[i + 2]); z1 = Math.max(z1, pts[i + 2]); }
  const m = halfWidth + 1;
  return { kind, pts, halfWidth, height, cum, bounds: [x0 - m, z0 - m, x1 + m, z1 + m], channel, channelDepth };
}

export function makeBox(kind: Box['kind'], cx: number, cz: number, y0: number, y1: number, angle: number, hu: number, hv: number, platforms: Platform[] = []): Box {
  const ux = Math.cos(angle), uz = Math.sin(angle);
  const r = Math.hypot(hu, hv) + 1;
  return { kind, cx, cz, y0, y1, ux, uz, hu, hv, platforms, bounds: [cx - r, cz - r, cx + r, cz + r] };
}

export interface TubeHit { tube: Tube; s: number; lat: number; floor: number; seg: number }

/** Nearest tube location for a point (within the tube's width), or null; anyY: at any height. */
export function tubeAt(t: Tube, x: number, y: number, z: number, margin = 0, anyY = false): TubeHit | null {
  if (x < t.bounds[0] || x > t.bounds[2] || z < t.bounds[1] || z > t.bounds[3]) return null;
  let best: TubeHit | null = null, bd = Infinity;
  const P = t.pts;
  for (let i = 0; i + 5 < P.length; i += 3) {
    const ax = P[i], ay = P[i + 1], az = P[i + 2], bx = P[i + 3], by = P[i + 4], bz = P[i + 5];
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz;
    let u = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    u = Math.max(0, Math.min(1, u));
    const qx = ax + dx * u, qz = az + dz * u;
    const d = Math.hypot(x - qx, z - qz);
    if (d > t.halfWidth + margin) continue;
    const floor = ay + (by - ay) * u;
    if (!anyY && (y < floor - 1.5 || y > floor + t.height)) continue;
    if (d < bd) {
      bd = d;
      const L = Math.sqrt(l2) || 1;
      const lat = (dx * (z - az) - dz * (x - ax)) / L;
      let fl = floor;
      if (t.channel && Math.abs(lat) < t.channel) fl -= t.channelDepth ?? 0.5;
      best = { tube: t, s: t.cum[i / 3] + L * u, lat, floor: fl, seg: i / 3 };
    }
  }
  return best;
}

/**
 * Strict interior test for cameras: margin applies on all sides and sewer
 * tubes follow their arched vault (springing at 1.6 m).
 */
export function tubeInterior(t: Tube, x: number, y: number, z: number, margin: number): boolean {
  const h = tubeAt(t, x, y, z, -margin);
  if (!h) return false;
  const P = t.pts, i = h.seg * 3;
  const L = (t.cum[h.seg + 1] ?? t.cum[h.seg]) - t.cum[h.seg] || 1;
  const u = Math.max(0, Math.min(1, (h.s - t.cum[h.seg]) / L));
  const floor = P[i + 1] + ((P[i + 4] ?? P[i + 1]) - P[i + 1]) * u;
  const bottom = floor - (t.channel && Math.abs(h.lat) < t.channel ? (t.channelDepth ?? 0) : 0);
  let top = floor + t.height;
  if (t.kind === 'sewer') {
    const spring = 1.6, r = Math.min(1, Math.abs(h.lat) / t.halfWidth);
    top = floor + spring + (t.height - spring) * Math.sqrt(1 - r * r);
  }
  return y > bottom + margin && y < top - margin;
}

export function boxAt(b: Box, x: number, y: number, z: number, margin = 0): { u: number; v: number; floor: number } | null {
  if (y < b.y0 - 1.5 || y > b.y1) return null;
  const dx = x - b.cx, dz = z - b.cz;
  const u = dx * b.ux + dz * b.uz, v = -dx * b.uz + dz * b.ux;
  if (Math.abs(u) > b.hu + margin || Math.abs(v) > b.hv + margin) return null;
  let floor = b.y0;
  for (const p of b.platforms) if (v >= p[0] && v <= p[1] && (p.length === 3 || (u >= p[3] && u <= p[4]))) floor = b.y0 + p[2];
  return { u, v, floor };
}
