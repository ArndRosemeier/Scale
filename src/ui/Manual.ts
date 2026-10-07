/** A "Manual" link next to the version label (main menu and pause menu): opens the player's
 *  manual (public/manual/Scale-Manual.pdf) in a new tab. */
export function manualLink(): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'ver-link fb-link';
  a.href = `${import.meta.env.BASE_URL}manual/Scale-Manual.pdf`;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = 'Manual';
  a.title = "Player's manual (PDF)";
  a.onclick = (e) => e.stopPropagation();
  return a;
}
