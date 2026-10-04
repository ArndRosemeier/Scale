/**
 * The casualty ledger of the city's incidents (THREATS_PLAN §2 "Casualties without gore"): people
 * evacuated, injured, trapped and rescued — never dead. Pure (no three.js), tested in selftest.ts.
 *
 * Rules:
 *  - evacuate(n)   people the sirens sent down into the metro (a running total);
 *  - injure(n)     someone knocked down by the monster, the army's fire or a blast: injured, waiting
 *                  for care (paramedics, the player carrying them to the triage tent);
 *  - trap(n)       someone under the rubble of a collapse: trapped, waiting to be dug out;
 *  - dig(byPlayer) a trapped person dug out: trapped −1, rescued +1;
 *  - treat(byP.)   an injured person cared for (brought to triage, collected by medics): injured −1,
 *                  rescued +1;
 *  - settle()      everyone still waiting is looked after by the crews (a long while after, a load).
 *
 * Counts never go negative, `trapped` and `injured` only fall by a rescue, nobody is ever counted
 * dead (there is no such field). `byPlayer` counts the rescues the player made.
 */
export interface CasualtyCounts {
  evacuated: number;
  injured: number;
  trapped: number;
  rescued: number;
  byPlayer: number;
}

export const NO_CASUALTIES: Readonly<CasualtyCounts> = { evacuated: 0, injured: 0, trapped: 0, rescued: 0, byPlayer: 0 };

export class CasualtyLedger {
  readonly c: CasualtyCounts = { ...NO_CASUALTIES };

  evacuate(n = 1): void { this.c.evacuated += Math.max(0, Math.floor(n)); }
  injure(n = 1): void { this.c.injured += Math.max(0, Math.floor(n)); }
  trap(n = 1): void { this.c.trapped += Math.max(0, Math.floor(n)); }

  /** A trapped person dug out (false: nobody was trapped). */
  dig(byPlayer: boolean): boolean {
    if (this.c.trapped <= 0) return false;
    this.c.trapped--;
    this.c.rescued++;
    if (byPlayer) this.c.byPlayer++;
    return true;
  }

  /** An injured person cared for (false: nobody was waiting). */
  treat(byPlayer: boolean): boolean {
    if (this.c.injured <= 0) return false;
    this.c.injured--;
    this.c.rescued++;
    if (byPlayer) this.c.byPlayer++;
    return true;
  }

  /** The crews look after everyone still waiting. Returns how many. */
  settle(): number {
    const n = this.c.injured + this.c.trapped;
    this.c.rescued += n;
    this.c.injured = 0;
    this.c.trapped = 0;
    return n;
  }

  /** Anything to show (the HUD ledger)? */
  get any(): boolean { return this.c.evacuated + this.c.injured + this.c.trapped + this.c.rescued > 0; }

  serialize(): CasualtyCounts { return { ...this.c }; }

  /** Saves: take saved counts (sanitised: whole, ≥ 0). */
  restore(o: Partial<Record<keyof CasualtyCounts, unknown>> | null | undefined): void {
    for (const k of Object.keys(NO_CASUALTIES) as (keyof CasualtyCounts)[]) {
      const v = Number(o?.[k]);
      this.c[k] = Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
    }
  }

  reset(): void { Object.assign(this.c, NO_CASUALTIES); }
}

/**
 * People left in a struck district (they did not get out in time): split into trapped (under the
 * rubble) and injured, deterministically — never dead.
 */
export function strikeCasualties(left: number): { trapped: number; injured: number } {
  const n = Math.max(0, Math.floor(left));
  const trapped = Math.ceil(n * 0.4);
  return { trapped, injured: n - trapped };
}
