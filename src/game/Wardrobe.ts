/**
 * Clothes shops have a full-length fitting mirror (InteriorGen, furniture use 'dress'). Standing
 * at it, E opens the character creator on the hero's current look; saving changes the hero on
 * the spot and keeps the look as the selected created character (so the next game and saves
 * start with it).
 *
 * Three costumes (F1–F3): all start as the hero's starting look, the mirror changes only the one
 * being worn, and the keys switch between them anywhere. The set goes into the save.
 */
import type { Game } from './Game';
import { Player } from '../player/Player';
import { CharacterCreator, disposeCreatorPreview } from '../ui/CharacterCreator';
import { outfitFromVisuals, type CharacterLook } from '../avatar/look';
import { avatarStore, isGenerated, type StoredGenerated } from '../avatar/AvatarStore';
import { isClothesShop } from '../interior/InteriorGen';
import type { MapMarker } from '../ui/map/GameMap';
import { COSTUME_COUNT, readCostumes, type SavedCostumes } from './costumes';

export class Wardrobe {
  private open = false;
  private closedAt = -1e9;

  private markT = 0;
  private markKey = '';

  /** The three costumes (null: the look the hero started with) and the one being worn. */
  private looks: (CharacterLook | null)[] = Array(COSTUME_COUNT).fill(null);
  active = 0;
  /** A costume being put on (the rig rebuilds); a further key press waits for it. */
  private changing: Promise<void> | null = null;

  constructor(private g: Game) {}

  /** Map: the nearest clothes shops (a few, so the map stays readable); F1–F3: put on a costume. */
  update(dt: number): void {
    const inp = this.g.input;
    for (let i = 0; i < COSTUME_COUNT; i++) {
      if (inp.hit(`F${i + 1}`)) { inp.pressed.delete(`F${i + 1}`); this.wear(i); }
    }
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

  hint(): string | null { return this.near() ? `Fitting mirror — press <b>E</b> to change costume ${this.active + 1}` : null; }

  /** Put on costume i (0-based). */
  wear(i: number): void {
    if (this.open || i === this.active || i < 0 || i >= COSTUME_COUNT) return;
    const from = this.looks[this.active], to = this.looks[i];
    this.active = i;
    this.g.powerHud?.toast(`Costume <b>${i + 1}</b>`, 'info', 1600);
    // Untouched costumes are the same look: nothing to rebuild.
    if (!to || (from && JSON.stringify(from) === JSON.stringify(to))) return;
    this.putOn(to);
  }

  /** Dress the hero in a look (one rebuild at a time; the last one asked for wins). */
  private putOn(look: CharacterLook): void {
    const P = this.g.player;
    const run = (this.changing ?? Promise.resolve()).then(async () => {
      if (this.looks[this.active] !== look) return; // switched on meanwhile
      try { await P.applyLook(structuredClone(look)); } catch (e) { console.warn('[wardrobe] could not change the costume', e); }
    });
    this.changing = run;
    void run.finally(() => { if (this.changing === run) this.changing = null; });
  }

  /** For the save: null while all three are still the starting look. */
  save(): SavedCostumes | null {
    return this.looks.some((l) => l) ? { active: this.active, looks: this.looks.map((l) => l && structuredClone(l)) } : null;
  }

  /** From a save (SaveSystem.apply): the three costumes, the hero in the one that was worn. */
  restore(raw: unknown): void {
    const c = readCostumes(raw);
    if (!c) return;
    this.looks = c.looks;
    this.active = c.active;
    const l = this.looks[this.active];
    if (l && JSON.stringify(l) !== JSON.stringify(Player.look)) this.putOn(l);
  }

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
    if (this.changing) await this.changing;
    const look: CharacterLook = this.looks[this.active] ?? Player.look ?? { appearance: structuredClone(P.app), outfit: outfitFromVisuals(P.rig.outfit ?? {}, P.app.seed) };
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
        // The other costumes keep the look they had (the starting look, until changed).
        for (let i = 0; i < COSTUME_COUNT; i++) this.looks[i] ??= structuredClone(look);
        this.looks[this.active] = structuredClone(next);
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
