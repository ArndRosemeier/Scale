/**
 * Themes: the materials a design is built in. What goes in each room is the interior core's
 * (fill/starship lists it, fill/place finds the spots); the prop catalogue (design/props) builds
 * each piece in these materials.
 */
import { mat, METAL, PANEL, CONC, GLASS, GLOW, PLASTER, GRANITE, GRAVEL, type PartMat, type RGB } from '../../plan/landmarkParts';

export type PropName = 'pod' | 'locker' | 'console' | 'holo' | 'table' | 'stool' | 'bench' | 'planter' | 'screen' | 'crate' | 'counter' | 'rack'
  | 'case' | 'statue' | 'bigStatue' | 'seat' | 'painting' | 'reception'
  | 'palm' | 'tree' | 'fern' | 'flowerBed' | 'cactus' | 'rock' | 'fountain'
  | 'checkDesk' | 'scanner' | 'belt' | 'gateDesk' | 'seatRow' | 'board';

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

/** A museum's: pale stone walls, polished floors, dark wood and bronze; `stone` the facade's. */
export function museumTheme(stone: PartMat, modern: boolean): Theme {
  return {
    name: 'museum',
    floor: modern ? mat(CONC, [1.05, 1.05, 1.05]) : mat(GRANITE, [0.9, 0.88, 0.84]),
    walk: mat(GRANITE, [0.9, 0.88, 0.84]),
    wall: modern ? mat(PLASTER, [1.04, 1.04, 1.04]) : mat(PLASTER, [1.06, 1.02, 0.94]),
    trim: mat(METAL, modern ? [0.75, 0.76, 0.78] : [0.62, 0.45, 0.25]),
    glass: mat(GLASS, [0.85, 0.95, 1.0]),
    // (Door frames: the facade's stone.)
    glow: stone,
    furniture: mat(PLASTER, modern ? [0.22, 0.22, 0.24] : [0.36, 0.22, 0.13]),
  };
}

/** A glasshouse's: gravel paths, the plinth's brick, the frame's painted iron, wooden benches. */
export function gardenTheme(frame: PartMat, plinth: PartMat): Theme {
  return {
    name: 'garden',
    floor: mat(GRAVEL, [0.95, 0.88, 0.74]),
    walk: mat(GRAVEL, [0.95, 0.88, 0.74]),
    wall: plinth,
    trim: frame,
    glass: mat(GLASS, [0.85, 0.95, 1.0]),
    glow: frame,
    furniture: mat(PLASTER, [0.42, 0.28, 0.16]),
  };
}

/** An airport terminal's: pale stone floors, white panels, steel, blue signs. */
export function terminalTheme(): Theme {
  return {
    name: 'terminal',
    floor: mat(GRANITE, [1.0, 1.0, 0.98]),
    walk: mat(GRANITE, [1.0, 1.0, 0.98]),
    wall: mat(PANEL, [0.95, 0.95, 0.96]),
    trim: mat(METAL, [0.72, 0.74, 0.77]),
    glass: mat(GLASS, [0.85, 0.95, 1.0]),
    glow: mat(PANEL, [0.35, 0.6, 1.1], GLOW),
    furniture: mat(PLASTER, [0.3, 0.33, 0.38]),
  };
}
