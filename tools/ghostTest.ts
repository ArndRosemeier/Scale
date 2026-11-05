/**
 * Self test of the ghost tour guide (game/ghost), run by tools/selftest.ts (or on its own:
 * `npx tsx tools/ghostTest.ts`): when tours run, the stops in a real cemetery, the wall test,
 * where the group stands, his lines, and that the ghost shader patch finds its places in three's
 * shaders.
 */
import * as THREE from 'three';
import { makeProfile } from '../src/world/settings';
import { Terrain } from '../src/world/terrain';
import { buildMacroPlan } from '../src/plan/macro';
import { planCell, PropType } from '../src/plan/cell';
import { pointInPoly } from '../src/core/geom2';
import { Rng } from '../src/core/rng';
import { cemeteryStops, crossesBuilding, headingTo, nightLeft, tourHours, tourSlot, type GravePiece } from '../src/game/ghost/tour';
import { ghostify, setGhostFade } from '../src/game/ghost/look';
import { ghostLine, STORIES, TOURIST_LINES, GHOST_NAME, type GhostTopic } from '../src/game/ghost/lines';
import { GHOST_OWNER, STREET_OWNER, AFTERMATH_OWNER, FAME_OWNER, METRO_OWNER, PEOPLE_OWNER, SIDEKICK_OWNER, CONCERT_OWNER, SOCCER_OWNER, FLOATER_OWNER, GRANDMA_OWNER, GARGOYLE_OWNER, GIANT_OWNER } from '../src/sim/actors/Actor';

type Check = (ok: boolean, msg: string) => void;

export function ghostChecks(check: Check): void {
  // When.
  check(tourHours(20) && tourHours(23.9) && tourHours(1) && !tourHours(12) && !tourHours(5) && tourHours(24 + 21), 'ghost: tours from dusk to the small hours only');
  check(Math.abs(nightLeft(23) - 4.5) < 1e-9 && Math.abs(nightLeft(2) - 1.5) < 1e-9 && nightLeft(10) === 0, 'ghost: hours of night left');
  // Through walls: a box in the way.
  const box = (x: number, z: number) => x > 4 && x < 6 && Math.abs(z) < 3;
  check(crossesBuilding(0, 0, 10, 0, box) && !crossesBuilding(0, 5, 10, 5, box) && !crossesBuilding(0, 0, 3.5, 0, box), 'ghost: a leg through a house is told from one round it');
  // The group: in front of him, a few metres off, not on top of each other.
  const face = 0.7, slots = [0, 1, 2, 3, 4, 5].map((i) => tourSlot(10, 10, face, i, 6));
  const fx = -Math.sin(face), fz = -Math.cos(face);
  const ahead = slots.every((s) => ((s.x - 10) * fx + (s.z - 10) * fz) > 1.2);
  const dist = slots.every((s) => { const d = Math.hypot(s.x - 10, s.z - 10); return d > 2 && d < 3.6; });
  let minGap = Infinity;
  for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) minGap = Math.min(minGap, Math.hypot(slots[i].x - slots[j].x, slots[i].z - slots[j].z));
  check(ahead && dist && minGap > 0.5, `ghost: the group stands in an arc in front of him (closest two ${minGap.toFixed(2)} m apart)`);
  check(Math.abs(headingTo(0, 0, 0, -5)) < 1e-9 && Math.abs(headingTo(0, 0, -5, 0) - Math.PI / 2) < 1e-9, 'ghost: headings face −Z forward');
  // A real cemetery: the main tomb, then graves inside the walls, spaced out.
  const terrain = new Terrain(makeProfile({ seed: 42, size: 0.35 }));
  const macro = buildMacroPlan(terrain);
  let tours = 0, inside = 0, all = 0, spaced = true;
  for (const c of macro.cells) {
    if (c.district === 'water') continue;
    const p = planCell(macro, c, terrain);
    for (const cem of p.cemeteries) {
      const P = p.props;
      let tomb: GravePiece | null = null;
      const pieces: GravePiece[] = [];
      for (let i = 0; i < P.length; i += 6) {
        if (!pointInPoly(cem.outer, P[i + 1], P[i + 2])) continue;
        const piece = { x: P[i + 1], z: P[i + 2], yaw: P[i + 3] };
        if (P[i] === PropType.Tomb && P[i + 5] === 0) tomb = piece;
        else if (P[i] === PropType.Gravestone || P[i] === PropType.Grave || P[i] === PropType.Tomb) pieces.push(piece);
      }
      if (!tomb) continue;
      const rng = new Rng(7);
      const stops = cemeteryStops(tomb, pieces, (a) => rng.shuffle(a));
      if (stops.length >= 3) tours++;
      for (const s of stops) { all++; if (pointInPoly(cem.outer, s.x, s.z)) inside++; }
      for (let i = 0; i < stops.length; i++) for (let j = i + 1; j < stops.length; j++) if (Math.hypot(stops[i].x - stops[j].x, stops[i].z - stops[j].z) < 9) spaced = false;
    }
  }
  check(tours >= 1, `ghost: seed 42 has a cemetery with a full tour (${tours})`);
  check(all > 0 && inside / all > 0.9 && spaced, `ghost: cemetery stops inside the walls (${inside} of ${all}) and 9 m apart (${spaced})`);
  // Lines.
  const sets = [...STORIES.graveStory, ...STORIES.houseStory, ...STORIES.oldStory];
  check(sets.length >= 15 && sets.every((s) => s.length === 3 && s.every((l) => l.length > 8 && l.length < 120)), `ghost: ${sets.length} stories, three short bubbles each`);
  const topics: Exclude<GhostTopic, 'graveStory' | 'houseStory' | 'oldStory'>[] = ['welcome', 'start', 'punch', 'follow', 'phaseStart', 'phaseEnd', 'farewell', 'invite', 'fly', 'giant', 'tiny', 'hero', 'villain', 'wanted', 'through', 'hitThrough', 'scared', 'lost', 'thanks', 'dawn'];
  const bad = topics.filter((t) => { const l = ghostLine(t, () => 0.999); return !l || l.includes('{') || l.length > 140; });
  check(bad.length === 0, `ghost: a line for every moment (${bad.join(', ')})`);
  check(Object.values(TOURIST_LINES).every((L) => L.length >= 3) && GHOST_NAME.length > 3, 'ghost: the tourists have lines');
  // Owner ids: his tourists' own, no clash with another system's.
  const owners = [GHOST_OWNER, STREET_OWNER, AFTERMATH_OWNER, FAME_OWNER, METRO_OWNER, PEOPLE_OWNER, SIDEKICK_OWNER, CONCERT_OWNER, SOCCER_OWNER, FLOATER_OWNER, GRANDMA_OWNER, GARGOYLE_OWNER, GIANT_OWNER];
  check(new Set(owners).size === owners.length, 'ghost: the tourists have their own actor owner id');
  // The lantern's glowing glass keeps its own colour (only see-through, faded by opacity); cloth is patched.
  const glass = new THREE.MeshStandardMaterial({ color: 0x73ffcc, emissive: 0x73ffcc, emissiveIntensity: 2.4 });
  const cloth = new THREE.MeshStandardMaterial({ color: 0x444444 });
  const plainHook = THREE.Material.prototype.onBeforeCompile;
  const rig = new THREE.Group();
  rig.add(new THREE.Mesh(new THREE.BoxGeometry(), glass), new THREE.Mesh(new THREE.BoxGeometry(), cloth));
  ghostify(rig);
  const full = glass.opacity;
  setGhostFade(0.5);
  const half = glass.opacity;
  setGhostFade(1);
  check(glass.onBeforeCompile === plainHook && cloth.onBeforeCompile !== plainHook && glass.transparent && Math.abs(half - full / 2) < 1e-9, 'ghost: the lantern flame keeps its colour and fades with him');
  // The GLSL patch's anchors are in three's lit shaders (look.ts patchGlsl).
  for (const k of ['physical', 'standard'] as const) {
    const f = THREE.ShaderLib[k].fragmentShader;
    check(f.includes('#include <opaque_fragment>') && f.includes('#include <common>') && f.includes('vViewPosition'), `ghost: three's ${k} shader has the places the ghost patch hooks into`);
  }
}

if (process.argv[1]?.endsWith('ghostTest.ts')) {
  let fails = 0;
  ghostChecks((ok, msg) => { if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); });
  process.exit(fails ? 1 : 0);
}
