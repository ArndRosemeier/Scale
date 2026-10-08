/**
 * "Your graphics card is not used" hint.
 *
 * Laptops with a dedicated GPU often run the browser on the integrated one (Windows decides
 * per app, and Chrome ignores WebGL's powerPreference there), and a browser with hardware
 * acceleration off renders on the CPU. A page cannot list the installed GPUs, so the hint is
 * driven by what WebGL renders on: a software renderer, or an integrated GPU. WebGPU sometimes
 * reports a different adapter for 'high-performance' — then the hint can name the card.
 *
 * Shown on the start menu (before a city loads) and once in-game when the auto graphics level
 * falls to Low; "Don't show again" is remembered per GPU.
 */

import { gpuName } from '../render/Graphics';
import { esc } from './esc';

const DISMISS_KEY = 'scale.gpuHint.dismissed';

export type GpuIssue = 'software' | 'integrated';

export interface GpuProbe {
  /** What WebGL renders on ("Intel(R) UHD Graphics"). */
  renderer: string;
  issue: GpuIssue | null;
  /** A dedicated GPU WebGPU reported that WebGL does not use ("NVIDIA"), when it could tell. */
  unused: string | null;
}

/** WebGL renderer name of a throwaway context (before the game has its renderer). */
export function webglRenderer(): string {
  const gl = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl');
  if (!gl) return '';
  const name = gpuName(gl);
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return name;
}

export function classifyGpu(renderer: string): GpuIssue | null {
  const g = renderer.toLowerCase();
  if (!g) return null;
  if (/swiftshader|llvmpipe|softpipe|basic render|software/.test(g)) return 'software';
  // Intel integrated (not Arc); AMD integrated: "Radeon(TM) Graphics", Vega, 680M / 780M / 890M.
  if (/intel/.test(g) && !/\barc\b/.test(g)) return 'integrated';
  if (/radeon\(tm\) graphics|radeon graphics|radeon vega|vega \d+ graphics|radeon \d{3}m\b/.test(g)) return 'integrated';
  return null;
}

/** The vendor WebGPU's high-performance adapter reports, when it differs from WebGL's. */
async function unusedGpu(renderer: string): Promise<string | null> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(o: object): Promise<{ info?: { vendor?: string }; requestAdapterInfo?: () => Promise<{ vendor?: string }> } | null> } }).gpu;
    if (!gpu) return null;
    const a = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    const v = ((a?.info ?? await a?.requestAdapterInfo?.())?.vendor ?? '').toLowerCase();
    const name = v.includes('nvidia') ? 'NVIDIA' : v.includes('amd') || v.includes('ati') ? 'AMD' : null;
    if (!name) return null;
    // An AMD adapter on an AMD-integrated machine may just be the same chip.
    if (name === 'AMD' && /radeon|amd/i.test(renderer)) return null;
    return name;
  } catch { return null; }
}

export async function probeGpu(renderer = webglRenderer()): Promise<GpuProbe> {
  const issue = classifyGpu(renderer);
  return { renderer, issue, unused: issue === 'integrated' ? await unusedGpu(renderer) : null };
}

const isWindows = (): boolean => {
  const p = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform;
  return p ? p === 'Windows' : /Windows/.test(navigator.userAgent);
};

/** Browser name, its executable and the settings page for hardware acceleration. */
function browserInfo(): { name: string; exe: string; settings: string | null; restart: string | null } {
  const brands = ((navigator as unknown as { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands ?? []).map((b) => b.brand);
  const ua = navigator.userAgent;
  if (brands.includes('Microsoft Edge') || /Edg\//.test(ua)) return { name: 'Microsoft Edge', exe: 'msedge.exe', settings: 'edge://settings/system', restart: 'edge://restart' };
  if (brands.includes('Opera') || /OPR\//.test(ua)) return { name: 'Opera', exe: 'opera.exe', settings: 'opera://settings/system', restart: null };
  if (brands.includes('Brave')) return { name: 'Brave', exe: 'brave.exe', settings: 'brave://settings/system', restart: 'brave://restart' };
  if (/Firefox\//.test(ua)) return { name: 'Firefox', exe: 'firefox.exe', settings: 'about:preferences', restart: null };
  if (brands.includes('Google Chrome') || /Chrome\//.test(ua)) return { name: 'Google Chrome', exe: 'chrome.exe', settings: 'chrome://settings/system', restart: 'chrome://restart' };
  return { name: 'your browser', exe: 'your browser’s .exe', settings: null, restart: null };
}

function dismissed(renderer: string): boolean {
  try { return localStorage.getItem(DISMISS_KEY) === renderer; } catch { return false; }
}

let open: HTMLElement | null = null;
let shownThisSession = false;

/**
 * Show the hint if this probe calls for it (and it was not dismissed for this GPU).
 * `slow`: shown because the game runs badly (in-game), not just because of the GPU type.
 */
export function maybeShowGpuHint(p: GpuProbe, slow = false): void {
  if (!p.issue || open || shownThisSession || dismissed(p.renderer)) return;
  // Integrated GPUs are fine on machines that have nothing else: on the start menu only when
  // WebGPU saw another card, or on Windows (where the wrong-GPU case is common); in-game when slow.
  if (p.issue === 'integrated' && !p.unused && !slow && !isWindows()) return;
  shownThisSession = true;
  open = build(p);
  document.body.appendChild(open);
}

function copyable(text: string): string {
  return `<button type="button" class="gh-copy" data-copy="${esc(text)}" title="Copy — browsers do not let pages open this address">${esc(text)}</button>`;
}

function build(p: GpuProbe): HTMLElement {
  const b = browserInfo();
  const win = isWindows();
  const el = document.createElement('div');
  el.id = 'gpuHint';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'ghTitle');
  const restart = `Close ${esc(b.name)} completely — every window — and start it again${b.restart ? ` (or open ${copyable(b.restart)})` : ''}. The change only applies to a fresh start.`;
  let body: string;
  if (p.issue === 'software') {
    body = `
      <p>${esc(b.name)} is drawing Scale on the processor (<b>${esc(p.renderer)}</b>) instead of a graphics card, so it will be very slow. Hardware acceleration is probably switched off.</p>
      <ol>
        ${b.settings ? `<li>Open ${copyable(b.settings)} in a new tab.</li>` : '<li>Open your browser’s settings, section System.</li>'}
        <li>Switch on <b>Use graphics acceleration when available</b>${b.name === 'Firefox' ? ' (Firefox: Settings → Performance)' : ''}.</li>
        <li>${restart}</li>
      </ol>`;
  } else {
    const card = p.unused ? `your <b>${p.unused}</b> graphics card` : 'a dedicated graphics card (NVIDIA or AMD)';
    body = `
      <p>${esc(b.name)} is using the built-in graphics chip <b>${esc(p.renderer)}</b>${p.unused ? `, not ${card}` : ''}. ${p.unused ? '' : `If this computer has ${card}, the browser is not using it — common on laptops.`} Scale runs much smoother on the dedicated card.</p>
      ${win ? `
      <ol>
        <li><a class="gh-btn" href="ms-settings:display-advancedgraphics">Open Windows graphics settings</a> <span class="gh-sub">(Settings → System → Display → Graphics; confirm “Open Settings” if the browser asks)</span></li>
        <li>Find <b>${esc(b.name)}</b> in the list. Not there? Add it: <i>Add desktop app → Browse</i> and pick <code>${esc(b.exe)}</code>.</li>
        <li>Click it, choose <b>High performance</b> (the ${p.unused ?? 'NVIDIA / AMD'} card) and save.</li>
        <li>${restart}</li>
      </ol>
      <p class="gh-sub">NVIDIA alternative: NVIDIA Control Panel → Manage 3D settings → Program settings → ${esc(b.name)} → <i>High-performance NVIDIA processor</i>.</p>`
      : `<p class="gh-sub">Choose the dedicated GPU for ${esc(b.name)} in your system’s graphics settings, then restart the browser.</p>`}`;
  }
  el.innerHTML = `
    <div class="gh-panel">
      <h2 id="ghTitle">${p.issue === 'software' ? 'No graphics acceleration' : 'Your graphics card may not be used'}</h2>
      ${body}
      <div class="gh-foot">
        <label><input type="checkbox" class="gh-never"> Don’t show again${p.issue === 'integrated' && !p.unused ? ' (this computer has no other graphics card)' : ''}</label>
        <button type="button" class="gh-close">OK</button>
      </div>
    </div>`;
  const close = () => {
    if ((el.querySelector('.gh-never') as HTMLInputElement).checked) { try { localStorage.setItem(DISMISS_KEY, p.renderer); } catch { /* storage unavailable */ } }
    el.remove();
    open = null;
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => { if (e.code === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  (el.querySelector('.gh-close') as HTMLButtonElement).onclick = close;
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  for (const c of el.querySelectorAll<HTMLButtonElement>('.gh-copy')) {
    c.onclick = () => {
      void navigator.clipboard?.writeText(c.dataset.copy!).then(() => { c.classList.add('copied'); setTimeout(() => c.classList.remove('copied'), 1500); }).catch(() => {});
    };
  }
  // Keyboard users land in the dialog; the game's keys stay out while it is open.
  el.addEventListener('keydown', (e) => e.stopPropagation());
  if (document.pointerLockElement) document.exitPointerLock();
  setTimeout(() => (el.querySelector('.gh-close') as HTMLButtonElement).focus(), 0);
  return el;
}
