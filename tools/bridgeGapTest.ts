/**
 * Self test of the fallen bridge spans (game/threats/leviathan/BridgeBreaks, build/bridges gaps),
 * run by tools/selftest.ts: for cities with bridges, a gap in the middle of a deck leaves the mesh
 * smaller with nothing left at deck level inside it, the same for the same seed; `bridgeDeck`
 * finds no deck in the gap and the deck either side of it; a span falls between neighbouring piers
 * (stone, girder) or as a 16–24 m piece, clear of the deck ends and of an earlier gap.
 */
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { bridgeProfiles, bridgePiers, buildBridges, type BridgeProfile } from '../src/build/bridges';
import { WorldIndex } from '../src/world/WorldIndex';
import { breakSpan, BRIDGE_BREAK } from '../src/game/threats/leviathan/BridgeBreaks';
import type { MeshData } from '../src/build/meshBuilder';

type Check = (ok: boolean, msg: string) => void;

const tris = (m: MeshData) => m.index.length / 3;

/** Vertices at deck level well inside the gap (between s0 + inset and s1 − inset, within the deck width). */
function deckLevelIn(m: MeshData, p: BridgeProfile, s0: number, s1: number, inset: number): number {
  const P = m.attrs.position.array, [ox, oy, oz] = m.origin;
  let n = 0;
  for (let i = 0; i < P.length; i += 3) {
    const dx = P[i] + ox - p.ax, dz = P[i + 2] + oz - p.az, s = dx * p.dx + dz * p.dz;
    if (s <= s0 + inset || s >= s1 - inset || Math.abs(-dx * p.dz + dz * p.dx) > p.width / 2 - 0.5) continue;
    const y = P[i + 1] + oy - p.y(s);
    if (y > -0.5 && y < 1.5) n++;
  }
  return n;
}

export function bridgeGapChecks(check: Check): void {
  let cities = 0, pierChecked = 0, pieceChecked = 0, spanFails = 0;
  // (Per bridge only failures are reported; one summary line at the end.)
  const each: Check = (ok, msg) => { if (!ok) { spanFails++; check(false, msg); } };
  for (let seed = 1; seed <= 12 && cities < 2; seed++) {
    const terrain = new Terrain(makeProfile({ seed, size: 0.6 }));
    const macro = buildMacroPlan(terrain);
    const profs = bridgeProfiles(macro, terrain);
    if (!profs.length) continue;
    cities++;
    const p = profs[0], mid = (p.s0 + p.s1) / 2;
    const span = breakSpan(p, mid, []);
    check(!!span, `bridge gaps: seed ${seed} (${p.style}, ${(p.s1 - p.s0).toFixed(0)} m): a span can fall mid-deck`);
    if (!span) continue;
    const [s0, s1] = span, gap = { edge: p.edge, s0, s1, seed: 1234 };
    const whole = buildBridges(macro, terrain).build();
    const cut = buildBridges(macro, terrain, [gap]).build(), again = buildBridges(macro, terrain, [gap]).build();
    const left = deckLevelIn(cut, p, s0, s1, 7);
    check(tris(cut) < tris(whole) && left === 0, `bridge gaps: seed ${seed}: a ${(s1 - s0).toFixed(0)} m gap leaves the mesh smaller (${tris(whole)} → ${tris(cut)} triangles), nothing at deck level inside (${left} vertices)`);
    const A = cut.attrs.position.array, B = again.attrs.position.array;
    let same = A.length === B.length && cut.index.length === again.index.length;
    for (let i = 0; same && i < A.length; i++) if (A[i] !== B[i]) same = false;
    check(same, `bridge gaps: seed ${seed}: the broken bridge is the same for the same seed`);
    // Deck queries: open water in the gap, deck either side.
    const stub = { bridges: [{ ...p, gaps: [[s0, s1]] as [number, number][] }] };
    const at = (s: number) => WorldIndex.prototype.bridgeDeck.call(stub as unknown as WorldIndex, p.ax + p.dx * s, p.az + p.dz * s);
    const inside = at((s0 + s1) / 2), before = at(s0 - 1), after = at(s1 + 1);
    check(inside === -Infinity && Number.isFinite(before) && Number.isFinite(after), `bridge gaps: seed ${seed}: bridgeDeck has no deck in the gap (${inside}) and the deck either side (${before.toFixed(1)}, ${after.toFixed(1)})`);
    // Spans: between piers, or a 16–24 m piece; inside the ends; never across a gap.
    for (const q of profs) {
      const piers = bridgePiers(q.style, q.s0, q.s1);
      const sp = breakSpan(q, (q.s0 + q.s1) / 2, []);
      if (!sp) continue;
      const inEnds = sp[0] >= q.s0 + BRIDGE_BREAK.endKeep - 1e-6 && sp[1] <= q.s1 - BRIDGE_BREAK.endKeep + 1e-6;
      if (piers.length) {
        const st = [q.s0, ...piers, q.s1];
        const k = st.findIndex((s, i) => i < st.length - 1 && sp[0] >= s - 1e-6 && sp[1] <= st[i + 1] + 1e-6);
        each(k >= 0 && inEnds && !piers.some((s) => s > sp[0] + 1e-6 && s < sp[1] - 1e-6), `bridge gaps: seed ${seed} ${q.style}: the span ${sp[0].toFixed(1)}–${sp[1].toFixed(1)} falls between piers (${piers.map((s) => s.toFixed(1)).join(' ')})`);
        pierChecked++;
      } else {
        const L = sp[1] - sp[0];
        const clipped = sp[0] <= q.s0 + BRIDGE_BREAK.endKeep + 1e-6 || sp[1] >= q.s1 - BRIDGE_BREAK.endKeep - 1e-6;
        each(inEnds && L <= BRIDGE_BREAK.piece[1] + 1e-6 && (L >= BRIDGE_BREAK.piece[0] - 1e-6 || clipped), `bridge gaps: seed ${seed} ${q.style}: a ${L.toFixed(1)} m piece inside the deck ends`);
        pieceChecked++;
      }
      // A second break next to the first stops at its edge; one inside it is refused.
      const near = breakSpan(q, sp[1] + 3, [{ s0: sp[0], s1: sp[1] }]), within = breakSpan(q, (sp[0] + sp[1]) / 2, [{ s0: sp[0], s1: sp[1] }]);
      each(within === null && (near === null || near[0] >= sp[1] - 1e-6), `bridge gaps: seed ${seed} ${q.style}: a second span never overlaps the first (${near ? near.map((s) => s.toFixed(1)).join('–') : 'none'})`);
    }
  }
  check(cities >= 2 && spanFails === 0 && pierChecked > 0 && pieceChecked > 0, `bridge gaps: ${cities} cities with bridges: spans fall between piers (${pierChecked}) or as 16–24 m pieces (${pieceChecked}), inside the deck ends, never across a gap (${spanFails} wrong)`);
}
