/**
 * Temporary states that powers put on things in the world — people, cars, robots, drones,
 * props: frozen, shrunk, burning, stunned, wet. One registry keyed by the object itself
 * (a PedAgent, Vehicle, Robot, Drone, prop …), so the simulation and render layers need only
 * a one-line lookup to honour them:
 *
 *   const st = statusOf(agent);           // undefined for almost everything, almost always
 *   if (st && st.frozen > 0) …            // hold still, no animation, ice tint
 *   scale *= st?.scale ?? 1;              // shrunk
 *
 * `statusOf` is a counter check while nothing is affected, so the idle cost is nil.
 * Timers count down in `tickStatus` (the power layer calls it once per frame).
 */

export interface TargetStatus {
  /** Seconds left frozen in place (no movement, no animation, ice tint). */
  frozen: number;
  /** Seconds left shrunk; `scale` eases to `scaleTo` and back to 1 when it runs out. */
  shrink: number;
  /** Current size factor (1 = normal) and the factor it eases to while shrunk. */
  scale: number;
  scaleTo: number;
  /** Seconds left on fire (flames / smoke on it). */
  burning: number;
  /** Seconds left stunned (electrocuted: stalls cars, twitches people). */
  stunned: number;
  /** Seconds left wet (darker, steams when heated). */
  wet: number;
  /** Pose held while frozen. */
  hx: number; hy: number; hz: number; hyaw: number; hphase: number;
  /** Whatever the owner wants to remember to undo the state (original size, paint …). */
  saved: Record<string, unknown> | null;
}

const map = new WeakMap<object, TargetStatus>();
const live: object[] = [];
let count = 0;

/** State of an object, or undefined when nothing is on it. Free while nothing is affected. */
export function statusOf(o: object): TargetStatus | undefined {
  return count === 0 ? undefined : map.get(o);
}

/** State of an object, created (all clear) if needed. */
export function statusFor(o: object): TargetStatus {
  let s = map.get(o);
  if (!s) {
    s = { frozen: 0, shrink: 0, scale: 1, scaleTo: 1, burning: 0, stunned: 0, wet: 0, hx: 0, hy: 0, hz: 0, hyaw: 0, hphase: 0, saved: null };
    map.set(o, s);
    live.push(o);
    count = live.length;
  }
  return s;
}

/** Number of affected objects (0: the whole layer idles). */
export function statusCount(): number { return count; }

/** The affected objects (do not mutate). */
export function statusList(): readonly object[] { return live; }

/** True while any state is still running (or the size is still easing back). */
export function statusActive(s: TargetStatus): boolean {
  return s.frozen > 0 || s.shrink > 0 || s.burning > 0 || s.stunned > 0 || s.wet > 0 || Math.abs(s.scale - 1) > 1e-3;
}

/**
 * Count the timers down and ease sizes; `onEnd(o, s)` runs when an object is clear again
 * (restore what was saved) and it leaves the registry.
 */
export function tickStatus(dt: number, onEnd: (o: object, s: TargetStatus) => void): void {
  for (let i = live.length - 1; i >= 0; i--) {
    const o = live[i];
    const s = map.get(o)!;
    s.frozen = Math.max(0, s.frozen - dt);
    s.burning = Math.max(0, s.burning - dt);
    s.stunned = Math.max(0, s.stunned - dt);
    s.wet = Math.max(0, s.wet - dt);
    if (s.shrink > 0) {
      s.shrink = Math.max(0, s.shrink - dt);
      // Shrinks in ~0.4 s.
      s.scale += (s.scaleTo - s.scale) * Math.min(1, dt * 9);
    } else if (s.scale !== 1) {
      // Pops back in ~0.6 s.
      s.scale += (1 - s.scale) * Math.min(1, dt * 6);
      if (Math.abs(s.scale - 1) < 2e-3) s.scale = 1;
    }
    if (!statusActive(s)) {
      onEnd(o, s);
      map.delete(o);
      live[i] = live[live.length - 1];
      live.pop();
    }
  }
  count = live.length;
}

/** Drop an object's state at once (it left the world). */
export function clearStatus(o: object): void {
  if (!map.has(o)) return;
  map.delete(o);
  const i = live.indexOf(o);
  if (i >= 0) { live[i] = live[live.length - 1]; live.pop(); }
  count = live.length;
}
