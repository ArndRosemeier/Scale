/**
 * What each street character wears (game/street): garments from the city wardrobe plus the costume
 * pieces of humanoid/client/streetwear.ts, and body paint (living statues, the mime's white face).
 * Deterministic per character seed.
 */
import { Rng } from '../../core/rng';
import type { EquipmentVisuals, ItemVisual } from '../../items/types';
import type { HumanoidAppearance } from '../../humanoid/types';
import type { StreetKind } from './cast';
import { BOARDS } from './lines';

type C3 = [number, number, number];
export type Paint = 'silver' | 'gold' | 'mime' | null;

export interface Costume {
  eq: EquipmentVisuals;
  paint: Paint;
  /** What is in the hand: null empty, an item id, undefined their own. */
  held: string | null | undefined;
}

const v = (seed: number, primary: C3, secondary: C3 = primary, pattern = 'plain', style = ''): ItemVisual =>
  ({ shape: 'cloth', seed, primary, secondary, accent: secondary, material: pattern, glow: 0, glowColor: [0, 0, 0], wear: 0.1, style });

const DARK: C3 = [0.08, 0.08, 0.09];
const NEON: C3[] = [[0.75, 1.0, 0.1], [1.0, 0.25, 0.65], [1.0, 0.55, 0.05], [0.1, 0.9, 0.95]];
const PASTEL: C3[] = [[0.62, 0.74, 0.92], [0.92, 0.72, 0.78], [0.72, 0.88, 0.74], [0.9, 0.86, 0.66]];
const EARTH: C3[] = [[0.35, 0.27, 0.2], [0.2, 0.28, 0.22], [0.45, 0.4, 0.33], [0.26, 0.24, 0.3], [0.5, 0.2, 0.15]];

export function costumeFor(kind: StreetKind, seed: number, female: boolean): Costume {
  const r = new Rng(seed ^ 0x57ee7);
  const s = () => r.nextU32();
  const pick = <T>(a: readonly T[]) => r.pick(a);
  switch (kind) {
    case 'preacher':
      return {
        eq: {
          chest: { defId: 'shirt', visual: v(s(), [0.82, 0.8, 0.72]) },
          back: { defId: 'coat', visual: v(s(), pick(EARTH), pick(EARTH)) },
          legs: { defId: 'trousers', visual: v(s(), [0.22, 0.2, 0.18]) },
          feet: { defId: 'boots', visual: v(s(), [0.2, 0.13, 0.08]) },
          shoulders: { defId: 'sandwichboard', visual: v(s(), [0.36, 0.25, 0.16], [0.36, 0.25, 0.16], 'plain', pick(BOARDS.preacher)) },
        },
        paint: null, held: null,
      };
    case 'busker':
      return {
        eq: {
          chest: { defId: r.chance(0.5) ? 'tshirt' : 'shirt', visual: v(s(), pick(EARTH), pick(EARTH), r.chance(0.4) ? 'checks' : 'plain') },
          back: r.chance(0.5) ? { defId: 'jacket', visual: v(s(), [0.14, 0.12, 0.11], DARK, 'leather') } : undefined,
          legs: { defId: 'jeans', visual: v(s(), [0.16, 0.22, 0.38]) },
          feet: { defId: 'boots', visual: v(s(), [0.25, 0.16, 0.1]) },
          head: r.chance(0.5) ? { defId: 'beanie', visual: v(s(), pick(EARTH)) } : undefined,
          trinket: { defId: 'guitar', visual: v(s(), pick([[0.72, 0.45, 0.2], [0.55, 0.3, 0.12], [0.85, 0.62, 0.32]] as C3[])) },
        },
        paint: null, held: null,
      };
    case 'statue': {
      const gold = r.chance(0.4);
      const c: C3 = gold ? [0.78, 0.62, 0.25] : [0.66, 0.68, 0.72];
      return {
        eq: {
          chest: { defId: 'shirt', visual: v(s(), c) },
          back: { defId: 'coat', visual: v(s(), c) },
          legs: { defId: 'trousers', visual: v(s(), c) },
          feet: { defId: 'shoes', visual: v(s(), c) },
          head: r.chance(0.6) ? { defId: 'cap', visual: v(s(), c) } : undefined,
        },
        paint: gold ? 'gold' : 'silver', held: null,
      };
    }
    case 'mime':
      return {
        eq: {
          chest: { defId: 'sweater', visual: v(s(), [0.95, 0.95, 0.95], [0.05, 0.05, 0.06], 'stripes') },
          legs: { defId: 'trousers', visual: v(s(), DARK) },
          feet: { defId: 'shoes', visual: v(s(), DARK) },
          head: { defId: 'beanie', visual: v(s(), DARK) },
        },
        paint: 'mime', held: null,
      };
    case 'juggler':
      return {
        eq: {
          chest: { defId: 'shirt', visual: v(s(), pick([[0.8, 0.15, 0.15], [0.15, 0.35, 0.75], [0.9, 0.7, 0.1]] as C3[]), [0.95, 0.9, 0.2], 'checks') },
          legs: { defId: r.chance(0.5) ? 'trousers' : 'shorts', visual: v(s(), pick(PASTEL), pick(NEON), 'stripes') },
          feet: { defId: 'sneakers', visual: v(s(), pick(NEON)) },
          head: { defId: 'cap', visual: v(s(), pick(NEON)) },
        },
        paint: null, held: null,
      };
    case 'dancer':
      return {
        eq: {
          chest: { defId: r.chance(0.6) ? 'sweater' : 'tshirt', visual: v(s(), pick([...NEON, [0.1, 0.1, 0.12], [0.95, 0.95, 0.95]] as C3[])) },
          legs: { defId: r.chance(0.7) ? 'trousers' : 'jeans', visual: v(s(), pick([[0.12, 0.12, 0.14], [0.3, 0.32, 0.36], [0.18, 0.22, 0.38]] as C3[]), [0.9, 0.9, 0.9], 'stripes') },
          feet: { defId: 'sneakers', visual: v(s(), [0.95, 0.95, 0.95]) },
          head: r.chance(0.5) ? { defId: 'cap', visual: v(s(), pick(NEON)) } : undefined,
          face: { defId: 'headphones', visual: v(s(), pick([[0.9, 0.1, 0.1], [0.08, 0.08, 0.08], [0.95, 0.95, 0.95]] as C3[])) },
        },
        paint: null, held: null,
      };
    case 'mascot': {
      const y: C3 = [0.98, 0.86, 0.25];
      return {
        eq: {
          chest: { defId: 'sweater', visual: v(s(), y, [0.95, 0.8, 0.2], 'quilted') },
          back: { defId: 'coat', visual: v(s(), y, y, 'quilted') },
          legs: { defId: 'trousers', visual: v(s(), y) },
          feet: { defId: 'boots', visual: v(s(), [0.98, 0.55, 0.1]) },
          head: { defId: 'chickenhead', visual: v(s(), [0.99, 0.92, 0.42]) },
        },
        paint: null, held: null,
      };
    }
    case 'conspiracy':
      return {
        eq: {
          chest: { defId: 'sweater', visual: v(s(), pick(EARTH), pick(EARTH), 'checks') },
          back: r.chance(0.6) ? { defId: 'jacket', visual: v(s(), [0.3, 0.32, 0.22]) } : undefined,
          legs: { defId: 'trousers', visual: v(s(), pick(EARTH)) },
          feet: { defId: 'sneakers', visual: v(s(), [0.4, 0.38, 0.36]) },
          head: { defId: 'tinfoil', visual: v(s(), [0.8, 0.8, 0.84]) },
          shoulders: { defId: 'sandwichboard', visual: v(s(), [0.15, 0.15, 0.17], [0.15, 0.15, 0.17], 'plain', pick(BOARDS.conspiracy)) },
        },
        paint: null, held: null,
      };
    case 'pigeons':
      return {
        eq: {
          chest: { defId: female ? 'dress' : 'sweater', visual: v(s(), pick(PASTEL), pick(EARTH), 'checks') },
          back: { defId: 'coat', visual: v(s(), pick(EARTH), pick(EARTH)) },
          legs: female ? undefined : { defId: 'trousers', visual: v(s(), pick(EARTH)) },
          feet: { defId: 'shoes', visual: v(s(), [0.2, 0.14, 0.1]) },
          head: { defId: 'beanie', visual: v(s(), pick(PASTEL)) },
        },
        paint: null, held: 'bag',
      };
    case 'sleepwalker': {
      const pj = pick(PASTEL);
      return {
        eq: {
          chest: { defId: 'shirt', visual: v(s(), pj, [0.98, 0.98, 0.98], 'stripes') },
          legs: { defId: 'trousers', visual: v(s(), pj, [0.98, 0.98, 0.98], 'stripes') },
          head: { defId: 'nightcap', visual: v(s(), pj, [0.98, 0.98, 0.98]) },
        },
        paint: null, held: null,
      };
    }
    case 'tourist':
      return {
        eq: {
          chest: { defId: 'shirt', visual: v(s(), pick([[0.95, 0.5, 0.3], [0.3, 0.7, 0.85], [0.9, 0.85, 0.3]] as C3[]), [0.95, 0.95, 0.9], 'checks') },
          legs: { defId: 'shorts', visual: v(s(), [0.75, 0.68, 0.5]) },
          feet: { defId: 'sneakers', visual: v(s(), [0.95, 0.95, 0.95]) },
          head: { defId: 'cap', visual: v(s(), pick(PASTEL)) },
          trinket: { defId: 'citymap', visual: v(s(), [0.95, 0.93, 0.85]) },
        },
        paint: null, held: null,
      };
    case 'band': return musicianCostume('guitar', seed, female, false);
    case 'jogger': {
      const n1 = pick(NEON), n2 = pick(NEON);
      return {
        eq: {
          chest: { defId: 'tshirt', visual: v(s(), n1) },
          legs: { defId: female ? 'shorts' : r.chance(0.5) ? 'shorts' : 'trousers', visual: v(s(), [0.08, 0.08, 0.1], n2, 'stripes') },
          feet: { defId: 'sneakers', visual: v(s(), n2) },
          head: { defId: 'sweatband', visual: v(s(), n2) },
        },
        paint: null, held: null,
      };
    }
  }
}

/** Who plays what: the street bands (guitar, bass, cajón) and the stadium's band (game/concert). */
export type MusicianPart = 'guitar' | 'bass' | 'cajon' | 'singer' | 'keys' | 'drums';

const STAGE: C3[] = [[0.05, 0.05, 0.06], [0.75, 0.08, 0.12], [0.9, 0.9, 0.92], [0.55, 0.1, 0.6], [0.85, 0.7, 0.25]];

/**
 * A musician's clothes and instrument: street players in jeans and earthy shirts, the stadium band
 * (`stage`) in black, red and silver, the singer in a glittering top or dress with a microphone.
 */
export function musicianCostume(part: MusicianPart, seed: number, female: boolean, stage: boolean): Costume {
  const r = new Rng(seed ^ 0x6a7d1);
  const s = () => r.nextU32();
  const pick = <T>(a: readonly T[]) => r.pick(a);
  const top = stage ? pick(STAGE) : pick(EARTH);
  const eq: EquipmentVisuals = {
    chest: { defId: r.chance(0.5) ? 'tshirt' : 'shirt', visual: v(s(), top, pick(EARTH), !stage && r.chance(0.4) ? 'checks' : 'plain') },
    back: r.chance(stage ? 0.6 : 0.35) ? { defId: 'jacket', visual: v(s(), stage ? DARK : [0.14, 0.12, 0.11], DARK, 'leather') } : undefined,
    legs: { defId: 'jeans', visual: v(s(), stage ? DARK : [0.16, 0.22, 0.38]) },
    feet: { defId: 'boots', visual: v(s(), stage ? DARK : [0.25, 0.16, 0.1]) },
    head: !stage && r.chance(0.4) ? { defId: 'beanie', visual: v(s(), pick(EARTH)) } : undefined,
  };
  if (part === 'guitar') eq.trinket = { defId: 'guitar', visual: v(s(), stage ? pick([[0.75, 0.08, 0.1], [0.08, 0.08, 0.09], [0.9, 0.88, 0.8]] as C3[]) : pick([[0.72, 0.45, 0.2], [0.55, 0.3, 0.12], [0.85, 0.62, 0.32]] as C3[])) };
  if (part === 'bass') eq.trinket = { defId: 'bass', visual: v(s(), pick([[0.1, 0.25, 0.55], [0.08, 0.08, 0.09], [0.6, 0.12, 0.1], [0.85, 0.82, 0.7]] as C3[])) };
  if (part === 'singer') {
    const sparkle = pick([[0.85, 0.85, 0.9], [0.8, 0.65, 0.25], [0.75, 0.1, 0.2]] as C3[]);
    if (female && r.chance(0.5)) { eq.chest = { defId: 'dress', visual: v(s(), sparkle, sparkle, 'scales') }; eq.legs = undefined; eq.back = undefined; }
    else { eq.chest = { defId: 'tshirt', visual: v(s(), sparkle, sparkle, 'scales') }; eq.back = { defId: 'jacket', visual: v(s(), DARK, DARK, 'leather') }; }
  }
  return { eq, paint: null, held: part === 'singer' ? 'stagemic' : null };
}

/** Body paint over the appearance (CrowdRenderer.appearance): silver / gold statues, the mime's white face. */
export function paintAppearance(app: HumanoidAppearance, paint: Paint): void {
  if (!paint) return;
  if (paint === 'mime') {
    app.skinTone = [0.96, 0.95, 0.93];
    app.beardStyle = 'none';
    return;
  }
  const c: C3 = paint === 'gold' ? [0.8, 0.63, 0.26] : [0.67, 0.69, 0.73];
  app.skinTone = c;
  app.skinAccent = c;
  app.skinPattern = 'none';
  app.hairColor = c;
  app.eyeColor = [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6];
  app.beardStyle = 'none';
}
