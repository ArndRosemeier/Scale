/**
 * Game mode: Normal (start as an ordinary person, earn karma, buy powers) or
 * Sandbox (every power at full strength). Chosen on the start screen.
 */
export type GameMode = 'normal' | 'sandbox';

const KEY = 'scale.mode';

export function loadMode(): GameMode {
  try { return localStorage.getItem(KEY) === 'sandbox' ? 'sandbox' : 'normal'; } catch { return 'normal'; }
}

export function saveMode(m: GameMode): void {
  try { localStorage.setItem(KEY, m); } catch { /* storage unavailable */ }
}

export const MODE_INFO: Record<GameMode, { name: string; desc: string }> = {
  normal: { name: 'Normal', desc: 'Start as an ordinary person. Do good deeds, earn karma, buy and grow your powers.' },
  sandbox: { name: 'Sandbox', desc: 'Every power unlocked at full strength. Fly, grow, smash — no limits.' },
};
