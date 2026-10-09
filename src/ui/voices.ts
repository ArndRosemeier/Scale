/**
 * Voices as speech bubbles: a cry for help, a shout, a fall, a dog's bark, a gull's call. The game
 * used to synthesize these as sounds (tools/synth*.mjs); procedural speech never sounded like
 * words, so every voice now shows as a bubble over whoever makes it (Barks.sayAt) and animal calls
 * as italic sound words. Screams and crowds stay sounds (recorded, not attempts at words).
 *
 * One call for any system: `voice(anchor, 'help')`. It needs no wiring through hosts: Barks
 * registers itself as the sink, and with none (headless tests) a voice is simply not shown.
 */

/** Anything with a position: a person (feet), the hero, a dog, a bird, a rat. */
export interface VoiceAnchor { x: number; y: number; z: number; alive?: boolean }

const LINES = {
  /** A victim calling out (mugging, bag snatch). */
  help: ['Help!', 'Help me!', 'Somebody help!', 'Please, help!'],
  /** Someone under rubble. */
  trapped: ['Help!', 'Down here!', 'Help me!', 'I can\'t get out!', 'Over here!'],
  /** A shopkeeper after a robber. */
  stop: ['Stop! Thief!', 'Hey! Stop them!', 'Somebody stop them!'],
  hey: ['Hey!', 'Hey, you!'],
  /** An officer at an armed criminal, and at the hero. */
  police: ['Police! Drop it!', 'Drop the weapon!'],
  policeHero: ['Police! Stand down!', 'Hands where we can see them!'],
  bomber: ['Everybody back!', 'Nobody move!'],
  /** A lost dog's owner running after it. */
  dogOwner: ['Come back!', 'Here, boy!', 'Stop! Come here!'],
  /** A mild accident (a trip, a stumble). */
  fall: ['Oof!', 'Whoa!', 'Ow!', 'Whoops!', 'Ugh!', 'Ah!'],
  /** Villain tells: a shoulder charge, a whistle for the dog pack. */
  charge: ['Hraaah!', 'Out of my way!'],
  sic: ['Sic \'em!', 'Get them!'],
  cat: ['Meow!', 'Mrrow?', 'Meeow…'],
  dog: ['Woof!', 'Woof woof!', 'Arf!'],
  growl: ['Grrr!', 'Woof! Woof!', 'Rrrarf!'],
  yelp: ['Yip!', 'Yelp!'],
  pigeon: ['Coo…', 'Croo-coo'],
  gull: ['Kyow! Kyow!', 'Kee-ow!'],
  crow: ['Caw! Caw!', 'Caw!'],
  rat: ['Squeak!', 'Eek!', 'Squeak squeak!'],
} as const satisfies Record<string, readonly string[]>;

export type Voice = keyof typeof LINES;

const ANIMAL: ReadonlySet<Voice> = new Set<Voice>(['cat', 'dog', 'growl', 'yelp', 'pigeon', 'gull', 'crow', 'rat']);
/** Calls that matter even unseen: off screen they show low on the screen with a direction. */
const ALERT: ReadonlySet<Voice> = new Set<Voice>(['help', 'trapped', 'stop']);
/** Bubble height above the anchor for animals (people: Barks' 2.05 m). */
const HEAD: Partial<Record<Voice, number>> = { cat: 0.45, dog: 0.85, growl: 0.85, yelp: 0.85, pigeon: 0.45, gull: 0.5, crow: 0.5, rat: 0.35 };

export interface VoiceSink {
  sayAt(a: VoiceAnchor, text: string, o: { head?: number; pause?: number; voice?: boolean; animal?: boolean; tone?: 'angry' | 'cheer' }): boolean;
  /** Would a bubble over this point be on screen (and in sight)? */
  sees(a: VoiceAnchor, head: number): boolean;
  heard(x: number, z: number, text: string): void;
}

let sink: VoiceSink | null = null;

export function setVoiceSink(s: VoiceSink | null): void {
  sink = s;
}

/** A random line of a kind (for callers that word it themselves). */
export function voiceLine(kind: Voice): string {
  const l = LINES[kind];
  return l[Math.floor(Math.random() * l.length)];
}

/**
 * Show a voice over the anchor. `head`: bubble height above it (default per kind); `pause`: before
 * the same anchor speaks again (default 3 s); `text`: a line of one's own instead of the kind's.
 * False when nothing was shown on it.
 */
export function voice(at: VoiceAnchor, kind: Voice, o: { head?: number; pause?: number; text?: string } = {}): boolean {
  if (!sink) return false;
  const head = o.head ?? HEAD[kind] ?? 2.05;
  const text = o.text ?? voiceLine(kind);
  if (sink.sayAt(at, text, { head, pause: o.pause ?? 3, voice: true, animal: ANIMAL.has(kind) })) return true;
  if (ALERT.has(kind) && !sink.sees(at, head)) sink.heard(at.x, at.z, text);
  return false;
}
