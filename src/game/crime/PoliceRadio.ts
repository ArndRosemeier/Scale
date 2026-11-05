/**
 * The police radio (Arnd, 2026-11-05: "something significant at 100"). When the city's trust in the
 * hero reaches RADIO.giveAt, the police give them a radio on their channel. From then on the hero hears
 * the calls the police get, wherever the crime is (the crime director's ring, out to 450 m):
 *
 *   - a short dispatch toast with a squelch ("A robbery reported on Elm Street. Units responding."),
 *   - the call on the map and as a goal on the compass with its distance, until the crime is over or
 *     the hero is there,
 *   - the city's threats the police turn out for ("All units: …, keep clear"),
 *   - and a word of thanks from dispatch when the hero stopped a crime they had called in.
 *
 * A group's crime also goes into that group's story in the tracker (heard on the radio).
 * The radio is taken back when the reputation falls below RADIO.loseAt and given again at giveAt.
 * It is kept with the reputation (per city, and in saves).
 *
 * The rules (`radioHeld`, the lines) are pure; `PoliceRadio` is the game's side.
 */
import type { MapMarker } from '../../ui/map/GameMap';
import type { ToastKind } from '../../ui/PowerHud';

export const RADIO = {
  /** The police give the radio at this reputation… */
  giveAt: 100,
  /** …and take it back below this one. */
  loseAt: 70,
  /** At most one dispatch toast every `toastGap` s (more calls still go on the map). */
  toastGap: 10,
  /** A call is over for the radio once the hero is this close (m). */
  arrive: 30,
  /** Calls kept on the map at once (newest first; only the newest is a compass goal). */
  calls: 3,
  /** A call the crime outlives is dropped after this long (s). */
  keep: 240,
  /** The police blue of the radio's toasts and markers. */
  color: '#5b9cff',
};

/** Does the hero have the radio at this reputation (`had`: they had it a moment ago)? */
export function radioHeld(had: boolean, rep: number): boolean {
  return had ? rep >= RADIO.loseAt : rep >= RADIO.giveAt;
}

/** "a purse snatching" → "A purse snatching". */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const RESPONDING = ['Units responding.', 'Nearest unit, please respond.', 'Cars are on the way.', 'Any unit in the area?'];
const THANKS = ['Nice work out there. We\'ll pick them up.', 'Dispatch here: thanks for the assist, hero.', 'Good job. A car is coming for them.', 'Copy that, scene secured. Thank you.'];

/** A call as dispatch reads it: what (KINDS[kind].stopped, "a robbery"), where ("on Elm Street"), by whom. */
export function callLine(what: string, where: string, group: string | null, u: number): string {
  const by = group ? ` ${group} suspected.` : '';
  return `${cap(what)} reported${where ? ` ${where}` : ''}.${by} ${RESPONDING[Math.floor(u * RESPONDING.length) % RESPONDING.length]}`;
}

/** What dispatch calls a threat that has no title of its own (ThreatEvent.archetype). */
export const THREAT_CALLS: Record<string, string> = {
  robots: 'rogue robots attacking people', brood: 'a swarm of creatures', teens: 'an unidentified flying object',
  strider: 'a giant creature', burrower: 'something huge under the streets', leviathan: 'something huge in the river',
  roc: 'a giant bird', mech: 'a giant war machine', tree: 'a walking tree', rampage: 'a giant on a rampage', boss: 'a gang boss with an army',
};

/** A threat the police turn out for. */
export function threatLine(what: string, where: string): string {
  return `All units: ${what} reported${where ? ` ${where}` : ''}. Keep civilians clear.`;
}

export function thanksLine(u: number): string {
  return THANKS[Math.floor(u * THANKS.length) % THANKS.length];
}

/** What the radio needs of a crime. */
export interface RadioCrime { readonly id: number; readonly active: boolean; readonly hot: { x: number; z: number } }

export interface RadioHost {
  rep(): number;
  /** Kept with the reputation. */
  saved: { get(): boolean; set(v: boolean): void };
  player(): { x: number; z: number };
  /** "on Elm Street" / "in Mill Quarter" / "". */
  where(x: number, z: number): string;
  toast(html: string, kind: ToastKind, ms: number): void;
  squelch(): void;
  markers(list: MapMarker[]): void;
  /** A group's crime: a clue in its story (heard). */
  clue?(group: number, text: string, x: number, z: number): void;
  time(): number;
  random(): number;
}

/** A threat as the radio follows it (ThreatEvent). */
export interface RadioThreat { readonly active: boolean; readonly x: number; readonly z: number }

interface Call { crime: RadioCrime | null; threat: RadioThreat | null; x: number; z: number; label: string; at: number }

export class PoliceRadio {
  private had = false;
  private calls: Call[] = [];
  private toastT = -1e9;
  private markKey = '';
  private markT = 0;
  /** Crimes the radio called (for the thanks). */
  private called = new Set<number>();
  stats = { given: 0, taken: 0, calls: 0, threats: 0, thanks: 0, toasts: 0 };

  constructor(private h: RadioHost) {
    this.had = h.saved.get();
  }

  get held(): boolean { return this.had; }

  /** The police called to a crime (CrimeWorld.callPolice). `what`: KINDS[kind].stopped; `group`: its name, if a group's; `fid`: its id. */
  call(c: RadioCrime, what: string, group: string | null, fid = -1): void {
    if (!this.had || this.called.has(c.id)) return;
    const H = this.h, where = H.where(c.hot.x, c.hot.z);
    this.called.add(c.id);
    this.stats.calls++;
    const line = callLine(what, where, group, H.random());
    this.push({ crime: c, threat: null, x: c.hot.x, z: c.hot.z, label: `Police radio: ${what}${where ? ` ${where}` : ''}`, at: H.time() });
    this.say(line);
    if (fid >= 0) H.clue?.(fid, `Police radio: ${what} reported ${where}`.trim(), c.hot.x, c.hot.z);
  }

  /** A city threat the police turn out for (ResponseDirector.open); `title`: its title ("Giant worm — …"). */
  threat(ev: RadioThreat, title: string): void {
    if (!this.had) return;
    const H = this.h, x = ev.x, z = ev.z, where = H.where(x, z), what = title.split(' — ')[0];
    this.stats.threats++;
    this.push({ crime: null, threat: ev, x, z, label: `Police radio: ${what}${where ? ` ${where}` : ''}`, at: H.time() });
    this.say(threatLine(what, where), 'warn', true);
  }

  /** The hero stopped a crime: dispatch says thanks if it was one of theirs. */
  stopped(c: RadioCrime): void {
    if (!this.had || !this.called.delete(c.id)) return;
    this.stats.thanks++;
    this.calls = this.calls.filter((k) => k.crime !== c);
    this.say(thanksLine(this.h.random()), 'info', true);
  }

  update(dt: number): void {
    const H = this.h, rep = H.rep(), now = radioHeld(this.had, rep);
    if (now !== this.had) {
      this.had = now;
      H.saved.set(now);
      if (now) {
        this.stats.given++;
        H.squelch();
        H.toast(`<b style="color:${RADIO.color}">📻 The police gave you a radio</b> — the city trusts you. You hear their calls now: where, what, and how far (map and compass).`, 'info', 9000);
      } else {
        this.stats.taken++;
        this.calls = [];
        this.called.clear();
        H.toast(`<b>📻 The police took their radio back</b> — they don't trust you like they did (it comes back at +${RADIO.giveAt})`, 'warn', 7000);
      }
    }
    this.markT -= dt;
    if (this.markT > 0) return;
    this.markT = 0.5;
    // Calls follow their crime and end with it, or once the hero is there.
    const p = H.player(), t = H.time();
    this.calls = this.calls.filter((k) => {
      if (k.crime) { if (!k.crime.active) return false; k.x = k.crime.hot.x; k.z = k.crime.hot.z; }
      if (k.threat) { if (!k.threat.active) return false; k.x = k.threat.x; k.z = k.threat.z; }
      return t - k.at < RADIO.keep && Math.hypot(k.x - p.x, k.z - p.z) > RADIO.arrive;
    });
    // Old calls the hero never answered are forgotten (oldest first).
    for (const id of this.called) { if (this.called.size <= 32) break; this.called.delete(id); }
    const list: MapMarker[] = this.calls.map((k, i) => ({ x: k.x, z: k.z, color: RADIO.color, kind: 'alert', place: true, title: k.label, ...(i === 0 ? { always: true } : {}) }));
    const key = list.map((m) => `${Math.round(m.x / 4)},${Math.round(m.z / 4)}`).join(';');
    if (key !== this.markKey) { this.markKey = key; H.markers(list); }
  }

  /** Dev and tests: the calls on the radio now. */
  get open(): readonly { x: number; z: number; label: string }[] { return this.calls; }

  private push(k: Call): void {
    this.calls.unshift(k);
    if (this.calls.length > RADIO.calls) this.calls.length = RADIO.calls;
    this.markT = 0;
  }

  private say(line: string, kind: ToastKind = 'info', always = false): void {
    const H = this.h, t = H.time();
    if (!always && t - this.toastT < RADIO.toastGap) return;
    this.toastT = t;
    this.stats.toasts++;
    H.squelch();
    H.toast(`<b style="color:${RADIO.color}">📻 Dispatch:</b> ${line}`, kind, 6500);
  }
}
