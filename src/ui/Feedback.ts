/**
 * Feedback: a "Feedback" link next to the version label (main menu and pause menu) opens the
 * community board (board.futuremagic.de) in a new tab, where players report bugs, share ideas
 * and talk to the developer.
 */

/** Where the Feedback link goes. */
export const BOARD_URL = 'https://board.futuremagic.de/';

/** A small clickable "Feedback" label, styled like the version link. */
export function feedbackLink(): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ver-link fb-link';
  b.textContent = 'Feedback';
  b.title = 'Bugs, ideas, questions: the Scale board (opens in a new tab)';
  b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); showFeedback(); };
  return b;
}

/** Opens the board in a new tab (and frees the mouse, so the tab switch is not fought over). */
export function showFeedback(): void {
  if (document.pointerLockElement) document.exitPointerLock();
  window.open(BOARD_URL, '_blank', 'noopener');
}
