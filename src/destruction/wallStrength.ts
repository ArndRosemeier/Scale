/**
 * How strong walls are: break impulse per wall material, and what share of the city's
 * street-level wall panels a given impulse breaks (derived from the building styles'
 * bay widths and ground-floor heights, so the powers screen can state it truthfully).
 */
import { STYLES, WallMat } from '../plan/building';
import { PLAIN_PANEL } from '../build/buildingLayout';

/** Impulse (N·s) needed to break a panel per m² by wall material. */
export const WALL_STRENGTH: Record<number, number> = {
  [WallMat.GlassCurtain]: 900, [WallMat.MetalPanel]: 4000, [WallMat.WoodSiding]: 3500, [WallMat.Timber]: 5000,
  [WallMat.Plaster]: 9000, [WallMat.Stucco]: 9000, [WallMat.BrickRed]: 14000, [WallMat.BrickBrown]: 14000,
  [WallMat.BrickYellow]: 14000, [WallMat.BrickWhite]: 14000, [WallMat.Brownstone]: 18000, [WallMat.Limestone]: 20000,
  [WallMat.Sandstone]: 18000, [WallMat.Granite]: 24000, [WallMat.Concrete]: 26000, [WallMat.ConcretePanel]: 24000,
};
/** Glass alone breaks much more easily (windows shatter before walls): N·s per m², × 0.3 of the panel. */
export const GLASS_IMPULSE = 120;

export type WallClass = 'glass' | 'wood' | 'metal' | 'plaster' | 'brick' | 'stone' | 'concrete';
export const WALL_CLASS: Record<number, WallClass> = {
  [WallMat.GlassCurtain]: 'glass', [WallMat.MetalPanel]: 'metal', [WallMat.WoodSiding]: 'wood', [WallMat.Timber]: 'wood',
  [WallMat.Plaster]: 'plaster', [WallMat.Stucco]: 'plaster', [WallMat.BrickRed]: 'brick', [WallMat.BrickBrown]: 'brick',
  [WallMat.BrickYellow]: 'brick', [WallMat.BrickWhite]: 'brick', [WallMat.Brownstone]: 'stone', [WallMat.Limestone]: 'stone',
  [WallMat.Sandstone]: 'stone', [WallMat.Granite]: 'stone', [WallMat.Concrete]: 'concrete', [WallMat.ConcretePanel]: 'concrete',
};
export const WALL_CLASSES: WallClass[] = ['glass', 'wood', 'metal', 'plaster', 'brick', 'stone', 'concrete'];

interface Sample { cls: WallClass; need: number; glass: number }
let samples: Sample[] | null = null;

/** Street-level (ground-floor) panels over every style × wall material × bay width × storey height. */
function streetPanels(): Sample[] {
  if (samples) return samples;
  samples = [];
  const S = 5;
  for (const st of Object.values(STYLES)) {
    for (const mat of st.walls) {
      for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) {
        const bay = st.bay[0] + ((st.bay[1] - st.bay[0]) * i) / (S - 1);
        const h = st.groundH[0] + ((st.groundH[1] - st.groundH[0]) * j) / (S - 1);
        // Same grouping as buildingLayout: bays merged into panels up to PLAIN_PANEL wide.
        const area = Math.max(1, Math.floor(PLAIN_PANEL / bay)) * bay * h;
        samples.push({ cls: WALL_CLASS[mat], need: (WALL_STRENGTH[mat] ?? 14000) * area, glass: GLASS_IMPULSE * area * 0.3 });
      }
    }
  }
  return samples;
}

/** Share (0..1) of street-level wall panels of a class that an impulse breaks (full hit). */
export function wallBreakShare(impulse: number, cls: WallClass): number {
  const s = streetPanels().filter((p) => p.cls === cls);
  return s.length ? s.filter((p) => impulse > p.need).length / s.length : 0;
}

/** Share of street-level windows an impulse shatters. */
export function windowShatterShare(impulse: number): number {
  const s = streetPanels();
  return s.filter((p) => impulse > p.glass).length / s.length;
}
