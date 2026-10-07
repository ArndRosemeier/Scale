/**
 * Humanoid appearance — the serializable description of a body. The renderer
 * turns this into a morphed, skinned MakeHuman-based mesh. All values are
 * normalized so they can be generated procedurally, edited in the character
 * creator, and sent over the network compactly.
 */

export type RaceId = 'human' | 'elf' | 'dwarf' | 'orc' | 'halfling' | 'goblin' | 'sylvan' | 'drakeborn' | 'umbral' | 'giantkin';

export const RACE_IDS: RaceId[] = ['human', 'elf', 'dwarf', 'orc', 'halfling', 'goblin', 'sylvan', 'drakeborn', 'umbral', 'giantkin'];

export interface HumanoidAppearance {
  race: RaceId;
  /** Second race for mixed heritage (blends some features), or null. */
  race2: RaceId | null;
  /** 0..1 blend weight of race2. */
  raceMix: number;
  /** Deterministic seed for fine details (freckles, scars, hair strands...). */
  seed: number;
  /** 0..1 strength of the seeded random face/body tweaks that make every person unique.
   *  Absent: 1 (city people). The hero defaults to 0, the plain face the sliders describe. */
  faceDetail?: number;

  // ---- MakeHuman macro parameters, 0..1 ----
  /** 0 = female, 1 = male (continuous). */
  gender: number;
  /** 0 = 1 year, 0.1875 = 11, 0.5 = 25, 1 = 90 (MakeHuman age mapping). */
  age: number;
  muscle: number;
  weight: number;
  height: number;
  proportions: number;
  /** Ethnic mixing weights (sum ~1): african, asian, caucasian — affect base face/body shape. */
  african: number;
  asian: number;
  caucasian: number;

  // ---- local shape modifiers, -1..1 ----
  face: {
    jaw: number; chin: number; cheekbones: number; noseSize: number; noseWidth: number; noseBridge: number;
    browRidge: number; eyeSize: number; eyeSpacing: number; mouthWidth: number; lipFullness: number;
    earSize: number; earPoint: number; headRound: number; foreheadSlope: number;
    /** Cheek fullness: lean, hollow cheeks (−1) … round, full cheeks (+1). Absent in older looks: 0. */
    cheekFullness?: number;
    /** Face width: narrow (−1) … broad (+1). */
    faceWidth?: number;
    /** Resting expression: stern (−1) … smiling (+1) — mouth corners and the face's expression at rest. */
    smile?: number;
  };
  body: {
    shoulders: number; chest: number; waist: number; hips: number; armLength: number; legLength: number;
    neck: number; hands: number; feet: number; belly: number;
  };

  // ---- coloration (sRGB 0..1) ----
  skinTone: [number, number, number];
  /** Secondary skin pattern color (scales, markings, freckles). */
  skinAccent: [number, number, number];
  /** Pattern overlay: none | freckles | scales | bark | spots | tattoos | veins | stripes | crystals */
  skinPattern: 'none' | 'freckles' | 'scales' | 'bark' | 'spots' | 'tattoos' | 'veins' | 'stripes' | 'crystals';
  patternStrength: number;
  eyeColor: [number, number, number];
  /** 0..1 emissive glow of the iris (umbral, drakeborn, magic users). */
  eyeGlow: number;
  /** Pupil shape for non-human races. */
  pupil: 'round' | 'slit' | 'goat' | 'none';
  hairColor: [number, number, number];
  hairStyle: string;
  beardStyle: string;
  browStyle: string;

  // ---- race add-ons ----
  tusks: number;
  horns: { style: 'none' | 'ram' | 'straight' | 'swept' | 'antler' | 'crown'; size: number; color: [number, number, number] };
  tail: { style: 'none' | 'reptile' | 'furred' | 'thin'; length: number };
  /** Scars, warpaint id etc. */
  marks: string[];
  /** Overall scale multiplier applied on top of MakeHuman height (halflings, giantkin). */
  scale: number;
}
