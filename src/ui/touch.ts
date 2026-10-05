/**
 * Touch mode: body.touch shows the on-screen controls (TouchControls) and touch-sized HUD.
 * On from the start on a touch-first device (iPad, phones: a coarse primary pointer), and
 * switched on by the first touch anywhere (touch-screen laptops); a real mouse moving switches
 * it off again (an iPad with a trackpad or mouse). `?touch` forces it on, `?touch=0` off.
 */

const param = new URLSearchParams(location.search).get('touch');
const forced = param !== null;
let on = forced ? param !== '0' : typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const listeners: ((on: boolean) => void)[] = [];

export function isTouch(): boolean { return on; }

/** Called whenever touch mode turns on or off. */
export function onTouchMode(fn: (on: boolean) => void): void { listeners.push(fn); }

function set(v: boolean): void {
  if (v === on) return;
  on = v;
  document.body.classList.toggle('touch', v);
  for (const fn of listeners) fn(v);
}

let installed = false;
/** Once, at start-up. */
export function installTouchMode(): void {
  if (installed) return;
  installed = true;
  document.body.classList.toggle('touch', on);
  if (!forced) {
    window.addEventListener('touchstart', () => set(true), { passive: true, capture: true });
    let travel = 0;
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse' || !on) { travel = 0; return; }
      // (A few pixels of jitter from a resting mouse do not switch it.)
      travel += Math.abs(e.movementX) + Math.abs(e.movementY);
      if (travel > 40) { travel = 0; set(false); }
    }, { passive: true });
  }
  // Safari's own pinch zoom of the page (it ignores user-scalable=no).
  for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, (e) => { if (on) e.preventDefault(); }, { passive: false });
}
