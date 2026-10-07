/**
 * Clothes shops have a full-length fitting mirror (InteriorGen, furniture use 'dress'). Standing
 * at it, E opens the character creator on the hero's current look; saving changes the hero on
 * the spot and keeps the look as the selected created character (so the next game and saves
 * start with it).
 */
import type { Game } from './Game';
import { Player } from '../player/Player';
import { CharacterCreator, disposeCreatorPreview } from '../ui/CharacterCreator';
import { outfitFromVisuals, type CharacterLook } from '../avatar/look';
import { avatarStore, isGenerated, type StoredGenerated } from '../avatar/AvatarStore';
import { isClothesShop } from '../interior/InteriorGen';
import type { MapMarker } from '../ui/map/GameMap';

export class Wardrobe {
  private open = false;
  private closedAt = -1e9;

  private markT = 0;
  private markKey = '';

  constructor(private g: Game) {}

  /** Map: the nearest clothes shops (a few, so the map stays readable). */
  update(dt: number): void {
    this.markT -= dt;
    if (this.markT > 0) return;
    this.markT = 2;
    const p = this.g.player.pos, R = 450;
    const shops = this.g.world.buildingsIn(p.x - R, p.z - R, p.x + R, p.z + R)
      .filter((b) => b.alive && isClothesShop(b.desc))
      .map((b) => ({ x: (b.bounds[0] + b.bounds[2]) / 2, z: (b.bounds[1] + b.bounds[3]) / 2 }))
      .sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))
      .slice(0, 4);
    const key = shops.map((s) => `${s.x.toFixed(0)},${s.z.toFixed(0)}`).join(';');
    if (key === this.markKey) return;
    this.markKey = key;
    this.g.map.setMarkers('clothes', shops.map((s): MapMarker => ({ x: s.x, z: s.z, color: '#c98be0', kind: 'faint', title: 'Clothes shop — the fitting mirror inside changes your look (E)' })));
  }

  /** The creator is open (or just closed: its Esc must not open the pause menu). */
  get holdsPointer(): boolean { return this.open || performance.now() - this.closedAt < 400; }

  private near(): boolean {
    const p = this.g.player;
    return !p.flying && p.height < 2.4 && !this.g.player.seat && !!this.g.interiors.dressMirrorNear(p.pos.x, p.pos.y, p.pos.z);
  }

  hint(): string | null { return this.near() ? 'Fitting mirror — press <b>E</b> to change your look' : null; }

  /** E at the mirror: open the creator. */
  use(): boolean {
    if (this.open || !this.near()) return false;
    void this.show();
    return true;
  }

  private async show(): Promise<void> {
    const g = this.g, P = g.player;
    this.open = true;
    g.input.suspended = true;
    if (document.pointerLockElement) document.exitPointerLock();
    const look: CharacterLook = Player.look ?? { appearance: structuredClone(P.app), outfit: outfitFromVisuals(P.rig.outfit ?? {}, P.app.seed) };
    let stored: StoredGenerated | null = null;
    try {
      const id = avatarStore.selected();
      const a = id ? await avatarStore.get(id) : undefined;
      if (a && isGenerated(a)) stored = a;
    } catch { /* no storage: the look still changes for this game */ }
    new CharacterCreator({
      name: stored?.name ?? 'My hero',
      look,
      onSave: async ({ name, look: next, thumb }) => {
        await P.applyLook(next);
        try {
          const a: StoredGenerated = {
            kind: 'generated',
            id: stored?.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            name, look: next, thumb: thumb ?? stored?.thumb, created: stored?.created ?? Date.now(),
          };
          await avatarStore.put(a);
          avatarStore.select(a.id);
        } catch (e) { console.warn('[wardrobe] could not store the look', e); }
      },
      onClose: () => {
        this.open = false;
        this.closedAt = performance.now();
        g.input.suspended = false;
        // The creator's preview has its own WebGL context: release it in game.
        disposeCreatorPreview();
      },
    });
  }
}
