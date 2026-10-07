/** A "Manual" link next to the version label (main menu and pause menu): opens the player's
 *  manual (public/manual/Scale-Manual.pdf) in a new tab. A button like the Feedback link, so it
 *  gets the same look in both menus. */
export function manualLink(): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ver-link fb-link';
  b.textContent = 'Manual';
  b.title = "Player's manual (PDF)";
  b.onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    window.open(`${import.meta.env.BASE_URL}manual/Scale-Manual.pdf`, '_blank', 'noopener');
  };
  return b;
}
