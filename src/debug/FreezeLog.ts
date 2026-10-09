/**
 * Freeze log controls (the recording itself is in HitchLog): Shift+F9 saves every recorded freeze
 * (this session and the last few before it) with the worst hitches to a .json file, to drop into a
 * bug report. The first freeze of a session shows a short hint that it was logged.
 */
import { hitch, type FreezeRecord } from './HitchLog';
import { download } from '../ui/saveFiles';
import { VERSION } from '../version';

export interface FreezeLogHooks {
  /** What the game is doing right now, in one line. */
  context(): string;
  /** A short HUD message. */
  hint(html: string): void;
  /** City seed, size, graphics, … for the file. */
  env(): Record<string, unknown>;
}

export function installFreezeLog(h: FreezeLogHooks): void {
  hitch.version = VERSION;
  hitch.context = h.context;
  let hinted = false;
  hitch.onFreeze = (f: FreezeRecord) => {
    if (hinted || f.ms < 1000) return;
    hinted = true;
    h.hint(`The game froze for <b>${(f.ms / 1000).toFixed(1)} s</b>. It is logged: <b>Shift+F9</b> saves the freeze log`);
  };
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'F9' || !e.shiftKey || e.ctrlKey || e.altKey) return;
    e.preventDefault(); e.stopImmediatePropagation();
    saveFreezeLog(h.env());
    const n = hitch.freezes.length + hitch.earlier.length;
    h.hint(n ? `Freeze log saved (${n} freeze${n === 1 ? '' : 's'})` : 'Freeze log saved (no freezes recorded yet)');
  }, true);
  (window as unknown as { saveFreezeLog: () => string }).saveFreezeLog = () => saveFreezeLog(h.env());
}

function saveFreezeLog(env: Record<string, unknown>): string {
  const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
  const name = `scale-freezes-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
  return download(new Blob([hitch.freezeReport({ ...env, userAgent: navigator.userAgent })], { type: 'application/json' }), name);
}
