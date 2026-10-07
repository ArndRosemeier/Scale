/**
 * Themes: what a room looks like is a theme's materials plus the props it feeds each room
 * function. A room recipe lists props by name at places in the room's own frame (s across from
 * -0.5 to 0.5, t from the door at 0 to the back wall at 1); the prop catalogue (design/props)
 * builds them. Swapping the theme (the props it feeds and its materials) turns the same layout
 * from a starship into an office or a hotel.
 */
import { mat, METAL, PANEL, CONC, GLASS, GLOW, type PartMat, type RGB } from '../../plan/landmarkParts';
import type { RoomFn } from './types';

export type PropName = 'pod' | 'locker' | 'console' | 'holo' | 'table' | 'stool' | 'bench' | 'planter' | 'screen' | 'crate' | 'counter' | 'rack';

/** A prop at (s, t) in the room, turned to face: 'door', 'back' (the back wall), 'left' or 'right'. */
export interface PropAt { prop: PropName; s: number; t: number; face: 'door' | 'back' | 'left' | 'right' }

export interface Theme {
  name: string;
  floor: PartMat;
  walk: PartMat;
  wall: PartMat;
  trim: PartMat;
  glass: PartMat;
  glow: PartMat;
  furniture: PartMat;
  /** Room recipes per function (one is picked per room by its seed). */
  rooms: Partial<Record<RoomFn, PropAt[][]>>;
}

const p = (prop: PropName, s: number, t: number, face: PropAt['face'] = 'door'): PropAt => ({ prop, s, t, face });

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
    rooms: {
      quarters: [
        [p('pod', -0.3, 0.8, 'door'), p('pod', 0.3, 0.8, 'door'), p('locker', 0, 0.96, 'door'), p('screen', 0, 0.99, 'door'), p('stool', 0.25, 0.3)],
        [p('pod', -0.32, 0.55, 'right'), p('locker', 0.3, 0.9, 'left'), p('table', 0.1, 0.35), p('stool', 0.1, 0.18, 'back'), p('planter', -0.3, 0.12)],
      ],
      lab: [
        [p('console', -0.25, 0.9), p('console', 0.25, 0.9), p('holo', 0, 0.5), p('rack', -0.42, 0.4, 'right'), p('screen', 0, 0.99)],
        [p('holo', 0, 0.55), p('console', 0, 0.92), p('crate', 0.35, 0.2), p('crate', 0.35, 0.3), p('rack', -0.4, 0.5, 'right')],
      ],
      mess: [
        [p('counter', 0, 0.94), p('table', -0.2, 0.5), p('table', 0.2, 0.5), p('stool', -0.2, 0.36, 'back'), p('stool', 0.2, 0.36, 'back'), p('stool', -0.2, 0.64), p('stool', 0.2, 0.64)],
      ],
      lounge: [
        [p('bench', 0, 0.9), p('bench', -0.35, 0.5, 'right'), p('planter', 0.35, 0.85), p('planter', -0.35, 0.15), p('holo', 0.1, 0.45), p('screen', 0, 0.99)],
      ],
      storage: [
        [p('crate', -0.3, 0.85), p('crate', -0.1, 0.85), p('crate', -0.3, 0.6), p('rack', 0.38, 0.6, 'left'), p('rack', 0.38, 0.85, 'left'), p('locker', 0, 0.97)],
      ],
      control: [
        [p('console', -0.3, 0.8, 'back'), p('console', 0, 0.85, 'back'), p('console', 0.3, 0.8, 'back'), p('holo', 0, 0.45), p('screen', 0, 0.99), p('stool', 0, 0.7)],
      ],
    },
  };
}
