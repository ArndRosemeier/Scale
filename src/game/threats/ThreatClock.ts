/**
 * The City Threat Clock (THREATS_PLAN §3): when the city's next event comes, and the omens
 * before it. Pure (no three.js, no game), deterministic per seed, headless-testable; its state is
 * a small object the threat director saves per city like Progress.
 *
 * Pressure builds from played time, karma earned and chaos (the player's own collateral):
 *
 *   pressure += dt + karma × perKarma + chaos × perChaos        (seconds of play equivalent)
 *
 * Event n has a seeded gap (the first minor no earlier than ~45 min of play, later ones 20–30
 * min apart, × the "City events" setting's scale) and becomes due when both
 *
 *   played ≥ last + gap        (at most one event per gap: a hard limit)
 *   pressure ≥ lastP + gap × slack   (time alone brings it at 1.4 × the gap, a busy hero sooner)
 *
 * hold. A seeded lead (4–8 min) before that the clock arms: 2–3 omens of the coming archetype
 * are spread over the lead, and the event never fires before the lead has passed — omens always
 * come first. The archetype table is where threats plug in, never the same one twice in a row.
 *
 * Major events (the Strider; THREATS_PLAN §3): none before ~3 h of play (× the setting's scale)
 * and only once the karma earned in this city has reached a milestone (150, then +250 per major);
 * then 1.5–3 h apart. When one is due the next planned event is a major one: its lead is longer
 * (10–16 min) with 3–4 omens of its own, and it never comes before its floor.
 */
import { Rng, deriveSeed } from '../../core/rng';

export type CityEvents = 'off' | 'rare' | 'normal' | 'frequent';

/** Gaps and the first event scale with the setting (off: nothing happens). */
export const EVENT_SCALE: Record<CityEvents, number> = { off: Infinity, rare: 2, normal: 1, frequent: 0.5 };

export const CLOCK = {
  /** No minor event before this much play (s, × scale). */
  firstMinor: 45 * 60,
  /** Between minor events (s of play, × scale). */
  gapMin: 20 * 60, gapMax: 30 * 60,
  /** Pressure an event needs, as a multiple of its gap. */
  slack: 1.4,
  /** Pressure (s) per karma point earned and per unit of chaos (an entry on the player's ledger). */
  perKarma: 6, perChaos: 1.5,
  /** Omens: the lead before the event (s, at most half the gap) and how many. */
  leadMin: 4 * 60, leadMax: 8 * 60, omensMin: 2, omensMax: 3,
  /** Major events: not before this much play (s, × scale), then this far apart; the karma milestone. */
  firstMajor: 3 * 3600, majorGapMin: 1.5 * 3600, majorGapMax: 3 * 3600,
  majorKarma: 150, majorKarmaStep: 250,
  /** Major events: their omens' lead (s) and count. */
  majorLeadMin: 10 * 60, majorLeadMax: 16 * 60, majorOmensMin: 3, majorOmensMax: 4,
};

/** A kind of threat the clock can schedule (THREATS_PLAN §1); omen kinds are the archetype's own. */
export interface ArchetypeDef {
  id: string;
  tier: 'minor' | 'major';
  weight: number;
  omens: readonly string[];
}

export const ARCHETYPES: readonly ArchetypeDef[] = [
  { id: 'robots', tier: 'minor', weight: 1, omens: ['glitch', 'drone', 'billboard'] },
  { id: 'brood', tier: 'minor', weight: 1, omens: ['chitter', 'glimpse', 'chitter'] },
  { id: 'strider', tier: 'major', weight: 1, omens: ['tremor', 'wake', 'tremor'] },
];

export const isMajor = (id: string | null) => !!id && ARCHETYPES.some((a) => a.id === id && a.tier === 'major');

/** Event n as planned from the seed and the state at the previous event. */
export interface PlannedEvent {
  n: number;
  archetype: string;
  seed: number;
  /** Played time (s) from which it may fire, and the pressure it needs. */
  minAt: number;
  need: number;
  /** Seconds of omens before it. */
  lead: number;
  /** Omens: when (fraction of the lead) and which kind. */
  omens: { at: number; kind: string }[];
}

export type ClockSignal =
  | { type: 'omen'; n: number; archetype: string; kind: string; index: number; seed: number }
  | { type: 'event'; n: number; archetype: string; seed: number };

export interface ClockState {
  v: 1;
  /** Seconds played (this city). */
  played: number;
  pressure: number;
  /** Events so far. */
  n: number;
  /** Played time and pressure at the last event. */
  lastAt: number;
  lastP: number;
  /** Archetype of the last event (variety). */
  last: string | null;
  /** Armed for event n at this played time (omens running), or null. */
  armedAt: number | null;
  omensDone: number;
  /** Karma earned in this city (the major events' milestone). */
  karma: number;
  /** Major events so far, and the played time of the last one. */
  majors: number;
  lastMajorAt: number;
  /** The armed event is a major one. */
  armedMajor: boolean;
}

export function freshClock(): ClockState {
  return { v: 1, played: 0, pressure: 0, n: 0, lastAt: 0, lastP: 0, last: null, armedAt: null, omensDone: 0, karma: 0, majors: 0, lastMajorAt: 0, armedMajor: false };
}

export class ThreatClock {
  readonly state: ClockState;
  setting: CityEvents = 'normal';
  private cache: { key: string; plan: PlannedEvent } | null = null;

  constructor(readonly seed: number, state?: Partial<ClockState> | null) {
    this.state = { ...freshClock(), ...(state && state.v === 1 ? state : {}) };
  }

  /** The plan of the next event (pure function of seed, n, setting, the last event and whether a major one is due). */
  next(): PlannedEvent {
    const S = this.state;
    const major = S.armedAt !== null ? S.armedMajor : this.majorDue();
    const floor = major ? this.majorFloor() : 0;
    const key = `${S.n}:${this.setting}:${S.lastAt}:${S.lastP}:${S.last}:${major}:${floor}`;
    if (this.cache?.key === key) return this.cache.plan;
    const plan = planEvent(this.seed, S.n, this.setting, S.lastAt, S.lastP, S.last, major, floor);
    this.cache = { key, plan };
    return plan;
  }

  /** Earliest played time of the next major event (s). */
  majorFloor(): number {
    const S = this.state, scale = EVENT_SCALE[this.setting];
    if (S.majors === 0) return CLOCK.firstMajor * scale;
    return S.lastMajorAt + new Rng(deriveSeed(this.seed, 'major', S.majors)).range(CLOCK.majorGapMin, CLOCK.majorGapMax) * scale;
  }

  /** Karma earned needed for the next major event. */
  milestone(): number { return CLOCK.majorKarma + CLOCK.majorKarmaStep * this.state.majors; }

  /** Is a major event due (its omens may start): the karma milestone reached and its floor near. */
  majorDue(): boolean {
    const S = this.state;
    if (this.setting === 'off' || S.karma < this.milestone()) return false;
    return S.played >= this.majorFloor() - CLOCK.majorLeadMax * EVENT_SCALE[this.setting];
  }

  /**
   * Advance by dt seconds of play with the karma earned and the chaos caused meanwhile;
   * returns the omens and events due now. While not `ready` (the player is somewhere it could
   * not be seen) a due event waits.
   */
  tick(dt: number, karma = 0, chaos = 0, ready = true): ClockSignal[] {
    const S = this.state, out: ClockSignal[] = [];
    S.played += dt;
    S.pressure += dt + Math.max(0, karma) * CLOCK.perKarma + Math.max(0, chaos) * CLOCK.perChaos;
    S.karma += Math.max(0, karma);
    if (this.setting === 'off') { S.armedAt = null; S.omensDone = 0; return out; }
    const P = this.next();
    if (S.armedAt === null) {
      if (S.played >= P.minAt - P.lead && S.pressure >= P.need - P.lead) { S.armedAt = S.played; S.omensDone = 0; S.armedMajor = isMajor(P.archetype); }
      else return out;
    }
    const since = S.played - S.armedAt;
    while (S.omensDone < P.omens.length && since >= P.omens[S.omensDone].at * P.lead) {
      const o = P.omens[S.omensDone];
      out.push({ type: 'omen', n: P.n, archetype: P.archetype, kind: o.kind, index: S.omensDone, seed: deriveSeed(P.seed, 'omen', S.omensDone) });
      S.omensDone++;
    }
    if (ready && since >= P.lead && S.omensDone >= P.omens.length && S.played >= P.minAt && S.pressure >= P.need) {
      out.push({ type: 'event', n: P.n, archetype: P.archetype, seed: P.seed });
      this.ran(P.archetype);
    }
    return out;
  }

  /** An event ran (the clock's, or one spawned by hand): the next one counts from now. */
  ran(archetype: string): void {
    const S = this.state;
    if (isMajor(archetype)) { S.majors++; S.lastMajorAt = S.played; }
    S.armedMajor = false;
    S.n++;
    S.lastAt = S.played;
    S.lastP = S.pressure;
    S.last = archetype;
    S.armedAt = null;
    S.omensDone = 0;
  }

  /** Debug: where the clock stands. */
  status(): { played: number; pressure: number; n: number; next: PlannedEvent; armed: boolean; inS: number } {
    const S = this.state, P = this.next();
    const inS = Math.max(P.minAt - S.played, P.need - S.pressure, S.armedAt === null ? P.lead : P.lead - (S.played - S.armedAt));
    return { played: S.played, pressure: S.pressure, n: S.n, next: P, armed: S.armedAt !== null, inS };
  }
}

/** Event n's plan (pure). `major`: a major event is due, not before `majorFloor` (played s). */
export function planEvent(seed: number, n: number, setting: CityEvents, lastAt: number, lastP: number, last: string | null, major = false, majorFloor = 0): PlannedEvent {
  const rng = new Rng(deriveSeed(seed, 'threat', n));
  const scale = EVENT_SCALE[setting];
  const gap = (n === 0 ? CLOCK.firstMinor : rng.range(CLOCK.gapMin, CLOCK.gapMax)) * scale;
  if (n === 0) rng.float(); // (same stream position for every n)
  const tier = ARCHETYPES.filter((a) => a.tier === (major ? 'major' : 'minor'));
  const pool = tier.length > 1 ? tier.filter((a) => a.id !== last) : tier;
  const arch = rng.weighted(pool, (a) => a.weight);
  const lead = major ? rng.range(CLOCK.majorLeadMin, CLOCK.majorLeadMax) * Math.min(1, scale) : Math.min(rng.range(CLOCK.leadMin, CLOCK.leadMax), gap * 0.5);
  const count = major ? rng.int(CLOCK.majorOmensMin, CLOCK.majorOmensMax) : rng.int(CLOCK.omensMin, CLOCK.omensMax);
  const omens: { at: number; kind: string }[] = [];
  for (let k = 0; k < count; k++) {
    // Spread over the lead (jittered within its share), the last one well before the event.
    const at = ((k + rng.range(0.15, 0.85)) / count) * 0.92;
    // A variety of omen kinds: no two alike in a row.
    let kind = rng.pick(arch.omens);
    if (k > 0 && kind === omens[k - 1].kind && arch.omens.length > 1) kind = arch.omens[(arch.omens.indexOf(kind) + 1) % arch.omens.length];
    omens.push({ at, kind });
  }
  return {
    n, archetype: arch.id, seed: deriveSeed(seed, 'threat', n, 'event'),
    minAt: major ? Math.max(lastAt + gap, majorFloor) : lastAt + gap, need: lastP + gap * CLOCK.slack, lead, omens,
  };
}
