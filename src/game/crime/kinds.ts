/**
 * The crime kinds in one table (VILLAINS_PLAN §3.2: "an operation is one file"): how each is made,
 * what it pays (karma and reputation, PLAYGROUND_PLAN decision 10) and what the map, the target
 * frame and the karma line call it. A new kind is a class and a row here.
 */
import type { Crime, CrimeKind, CrimeWorld } from './Crime';
import { Snatch } from './Snatch';
import { Mugging } from './Mugging';
import { Robbery } from './Robbery';
import { Racket } from './Racket';
import { Tagging } from './Tagging';
import { TurfBrawl } from './TurfBrawl';
import { HideoutGuard } from './HideoutGuard';
import { Bomber } from './Bomber';

export interface KindSpec {
  make(w: CrimeWorld, seed: number, near: { x: number; z: number } | null): Crime;
  /** Karma for knocking one of them out yourself. */
  ko: number;
  /** Karma for stopping it with your help (+25 % with nobody else hurt), and reputation. */
  resolved: number;
  rep: number;
  /** Map / compass line while it runs. */
  title: string;
  /** Name of one of them on the target frame. */
  criminal: string;
  /** What was stopped, for the karma line ("stopped a mugging"). */
  stopped: string;
}

export const KINDS: Record<CrimeKind, KindSpec> = {
  snatch: { make: (w, s, n) => new Snatch(w, s, n), ko: 8, resolved: 10, rep: 3, title: 'Purse snatching — a thief on the run', criminal: 'Thief', stopped: 'a purse snatching' },
  mugging: { make: (w, s, n) => new Mugging(w, s, n), ko: 10, resolved: 15, rep: 4, title: 'A mugging — someone is being threatened', criminal: 'Mugger', stopped: 'a mugging' },
  robbery: { make: (w, s, n) => new Robbery(w, s, n), ko: 14, resolved: 25, rep: 6, title: 'A robbery', criminal: 'Robber', stopped: 'a robbery' },
  racket: { make: (w, s, n) => new Racket(w, s, n), ko: 10, resolved: 16, rep: 4, title: 'Protection money — a shopkeeper is being leaned on', criminal: 'Enforcer', stopped: 'a protection racket' },
  tagging: { make: (w, s, n) => new Tagging(w, s, n), ko: 5, resolved: 8, rep: 2, title: 'Vandals tagging a wall', criminal: 'Tagger', stopped: 'a tagging' },
  brawl: { make: (w, s, n) => new TurfBrawl(w, s, n), ko: 8, resolved: 18, rep: 5, title: 'Turf war — two gangs fighting in the street', criminal: 'Brawler', stopped: 'a turf brawl' },
  // (Hideout guards are placed at a hideout's door by CrimeSystem; `make` without a door puts them at the point.)
  hideout: { make: (w, s, n) => new HideoutGuard(w, s, { x: n?.x ?? w.player.x, z: n?.z ?? w.player.z, nx: 0, nz: 1 }), ko: 9, resolved: 10, rep: 3, title: 'A hideout, guarded', criminal: 'Guard', stopped: 'the guards of a hideout' },
  bomber: { make: (w, s, n) => new Bomber(w, s, n), ko: 18, resolved: 32, rep: 8, title: 'A mad bomber — explosions in the street', criminal: 'Mad bomber', stopped: 'a mad bomber' },
};
