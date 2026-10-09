/**
 * Themes: the materials a design is built in. What goes in each room is the interior core's
 * (fill/starship lists it, fill/place finds the spots); the prop catalogue (design/props) builds
 * each piece in these materials.
 */
import { mat, METAL, PANEL, CONC, GLASS, GLOW, type PartMat, type RGB } from '../../plan/landmarkParts';

export type PropName = 'pod' | 'locker' | 'console' | 'holo' | 'table' | 'stool' | 'bench' | 'planter' | 'screen' | 'crate' | 'counter' | 'rack';

export interface Theme {
  name: string;
  floor: PartMat;
  walk: PartMat;
  wall: PartMat;
  trim: PartMat;
  glass: PartMat;
  glow: PartMat;
  furniture: PartMat;
}

/** The starship's: pale panels, dark metal floors, cyan light strips. */
export function scifiTheme(accent: RGB, light: RGB = [0.45, 0.9, 1.0]): Theme {
  return {
    name: 'scifi',
    floor: mat(METAL, [0.34, 0.36, 0.4]),
    walk: mat(METAL, [0.5, 0.53, 0.58]),
    wall: mat(PANEL, [0.86, 0.89, 0.92]),
    trim: mat(METAL, accent),
    glass: mat(GLASS, [0.7, 0.9, 1.0]),
    glow: mat(PANEL, light, GLOW),
    furniture: mat(CONC, [0.9, 0.92, 0.94]),
  };
}
