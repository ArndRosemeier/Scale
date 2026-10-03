/**
 * Ability registry: what each power is, how it is triggered, and what its ranks do.
 * Mechanics live in AbilitySystem (wrapping Player / Interactions); numbers in tuning.ts.
 */
import {
  MAX_RANK, PUNCH_IMPULSE, JUMP_HEIGHT, DASH_DIST, DASH_COOLDOWN, SHOCK_IMPULSE, SHOCK_RANGE, SHOCK_COOLDOWN, SHOCK_COST,
  FLIGHT_SPEED, SIZE_RANGE, JUMP, DASH,
} from './tuning';

export type AbilityId = 'strength' | 'superJump' | 'dash' | 'shockwave' | 'flight' | 'size';

export interface AbilityDef {
  id: AbilityId;
  name: string;
  /** One-line description. */
  desc: string;
  /** Inline SVG (24×24, currentColor). */
  icon: string;
  /** passive: always on (no hotbar); active: hotbar-assignable. */
  kind: 'active' | 'passive';
  /** tap: fires on press; hold: charges while held, fires on release; toggle: on/off. */
  trigger: 'tap' | 'hold' | 'toggle' | 'none';
  maxRank: number;
  /** Native key besides the hotbar (shown in the UI). */
  key?: string;
  /** Effect summary of rank r (1..maxRank). */
  rankText(r: number): string;
  /** Energy cost and cooldown summary (actives). */
  costText?(r: number): string;
}

const svg = (body: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const fmtJ = (j: number) => (j >= 1000 ? `${Math.round(j / 1000)}k` : `${j}`);
const fmtH = (h: number) => (h < 1 ? `${Math.round(h * 100)} cm` : `${h} m`);

export const ABILITIES: AbilityDef[] = [
  {
    id: 'strength', name: 'Super strength', kind: 'passive', trigger: 'none', maxRank: MAX_RANK, key: 'Left click',
    desc: 'Punches hit harder and running into walls smashes through them.',
    icon: svg('<path d="M7 11V7.5a1.5 1.5 0 0 1 3 0V10"/><path d="M10 9.5V6.5a1.5 1.5 0 0 1 3 0V10"/><path d="M13 9.5V7a1.5 1.5 0 0 1 3 0v3.5"/><path d="M16 10a1.5 1.5 0 0 1 3 0v3a7 7 0 0 1-7 7h-1a6 6 0 0 1-5-2.7L4.2 14.6a1.6 1.6 0 0 1 2.6-1.8L8 14V11"/><path d="M3 5l1.5 1.5M6.5 2.5L7 4.5M2 9h2"/>'),
    rankText: (r) => `Punch ${fmtJ(PUNCH_IMPULSE[r])} N·s · ${['', 'shatters windows', 'breaks glass facades', 'breaks wood and metal walls', 'breaks brick and stone', 'smashes concrete'][r]}`,
  },
  {
    id: 'superJump', name: 'Super jump', kind: 'active', trigger: 'hold', maxRank: MAX_RANK, key: 'Hold Space',
    desc: 'Hold Space to charge, release to leap onto rooftops. Heavy landings shake the ground.',
    icon: svg('<path d="M6 11l6-6 6 6"/><path d="M6 17l6-6 6 6"/><path d="M4 21h16"/>'),
    rankText: (r) => `Leap up to ${JUMP_HEIGHT[r]} m high`,
    costText: () => `${JUMP.cost} energy at full charge`,
  },
  {
    id: 'dash', name: 'Dash', kind: 'active', trigger: 'tap', maxRank: MAX_RANK,
    desc: 'A burst of speed where you look — through crowds, across gaps, into walls.',
    icon: svg('<path d="M11 6l6 6-6 6"/><path d="M17 6l6 6-6 6" opacity="0.55"/><path d="M2 9h6M1 12h7M2 15h6"/>'),
    rankText: (r) => `${DASH_DIST[r]} m burst · ${DASH_COOLDOWN[r]} s cooldown`,
    costText: () => `${DASH.cost} energy`,
  },
  {
    id: 'shockwave', name: 'Shockwave', kind: 'active', trigger: 'tap', maxRank: MAX_RANK,
    desc: 'Detonate a concussive blast where you look.',
    icon: svg('<circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4"/><path d="M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2"/>'),
    rankText: (r) => `Blast ${fmtJ(SHOCK_IMPULSE[r])} N·s · reach ${SHOCK_RANGE[r]} m · ${SHOCK_COOLDOWN[r]} s cooldown`,
    costText: (r) => `${SHOCK_COST[Math.max(1, r)]} energy`,
  },
  {
    id: 'flight', name: 'Flight', kind: 'active', trigger: 'toggle', maxRank: MAX_RANK, key: 'F',
    desc: 'Take to the sky. Shift to boost, Space / Ctrl to climb and sink.',
    icon: svg('<path d="M3 13c3-1 5-4 6-8 1 3 1 6-1 9"/><path d="M21 13c-3-1-5-4-6-8-1 3-1 6 1 9"/><path d="M12 8v9"/><path d="M9 19l3-2 3 2"/>'),
    rankText: (r) => `Cruise ${Math.round(22 * FLIGHT_SPEED[r])} m/s · boost ${Math.round(160 * FLIGHT_SPEED[r])} m/s`,
  },
  {
    id: 'size', name: 'Size shift', kind: 'passive', trigger: 'none', maxRank: MAX_RANK, key: 'Numpad + / −',
    desc: 'Grow into a giant or shrink to the size of a mouse.',
    icon: svg('<path d="M14 4h6v6"/><path d="M20 4l-6.5 6.5"/><path d="M10 20H4v-6"/><path d="M4 20l6.5-6.5"/><rect x="9.5" y="9.5" width="5" height="5" rx="1" opacity="0.55"/>'),
    rankText: (r) => `Size ${fmtH(SIZE_RANGE[r][0])} … ${fmtH(SIZE_RANGE[r][1])}`,
  },
];

export const ABILITY: Record<AbilityId, AbilityDef> = Object.fromEntries(ABILITIES.map((a) => [a.id, a])) as Record<AbilityId, AbilityDef>;

export const HOTBAR_SLOTS = 8;
