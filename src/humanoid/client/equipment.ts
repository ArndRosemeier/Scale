/**
 * Equipment on a Character: turns `EquipmentVisuals` into what the person wears and holds.
 *
 *  - Soft clothes become Actors garments, fitted to the body by the Actors runtime (see
 *    actors/outfit.ts and Character.dress).
 *  - Rigid parts (caps, masks, costume heads, a sandwich board, the raised dead's bones) are
 *    built by the items module in socket space and parented to the character's sockets
 *    (BodyFit from the body's measurements).
 *  - Held items (main/off hand) come from `buildItemObject`, gripped at the fist; one-handed
 *    weapons can be sheathed at the hip and two-handers / bows slung on the back while out of
 *    combat.
 *
 * Rebuilt only when the equipment set changes (keyed by def ids + visuals).
 */
import * as THREE from 'three';
import type { EquipmentVisuals, EquipSlot, ItemVisual } from '../../items/types';
import type { BodyRegion, RigidPart, WearableSpec, BodyFit } from '../../items/wearable';
import { resolveWearable, buildItemObject, animateItem, setItemSkyVis, disposeItemObject, itemDef } from './wardrobe';
import type { Character } from './Character';
import type { GripClass } from './anim/actions';
import { dressPlan } from '../actors/outfit';

/** Regions whose loss means the whole body is replaced (the raised dead's bones). */
const WHOLE_BODY: BodyRegion[] = ['chest', 'belly', 'pelvis', 'thigh.L', 'thigh.R'];

/** Classify a held item for animation and carry poses. */
export function gripClassOf(defId: string | undefined, shape: string | undefined): GripClass {
  if (!defId && !shape) return 'none';
  const def = defId ? itemDef(defId) : undefined;
  const s = shape ?? def?.visual.shape ?? '';
  if (/^shield/.test(s)) return 'shield';
  if (/torch|lantern/.test(s) || def?.category === 'light') return 'torch';
  if (/^bow/.test(s)) return 'bow';
  if (/crossbow/.test(s)) return 'crossbow';
  if (/^staff/.test(s)) return 'staff';
  if (/wand/.test(s)) return 'wand';
  if (/^(spear|glaive|halberd|javelin)/.test(s)) return def?.twoHanded === false ? 'blade' : 'polearm';
  if (/^throw|sling/.test(s)) return 'thrown';
  if (def?.twoHanded || /great|maul|\.war$/.test(s)) return 'twohand';
  if (/^dagger|knife/.test(s)) return 'dagger';
  if (/^axe/.test(s)) return 'axe';
  if (/^(mace|hammer|flail|club)/.test(s)) return 'blunt';
  if (/^sword/.test(s)) return 'blade';
  if (def?.tool || /pick|shovel|sickle|rod|tool/.test(s)) return 'tool';
  if (def?.category === 'weapon') return 'blade';
  return 'item';
}

export class EquipmentRig {
  /** Bumped by every set(): staged jobs of an outdated outfit skip themselves. */
  private gen = 0;
  private key = '#unset';
  private rigids: THREE.Object3D[] = [];
  private held: { slot: 'mainhand' | 'offhand'; obj: THREE.Object3D; grip: GripClass; stowSocket: string | null }[] = [];
  private skyVis = 1;
  main: GripClass = 'none';
  off: GripClass = 'none';
  /** Held items currently drawn (vs. stowed). */
  drawn = true;

  constructor(private ch: Character) {}

  /**
   * Dress the character. With `schedule`, every held item and rigid part is built as its own job
   * and `done` runs after the last one and the garments are on; without, pieces are built
   * immediately. A newer `set` makes jobs still pending from an older one skip themselves.
   */
  set(eq: EquipmentVisuals | undefined, schedule?: (job: () => void, label: string) => void, done?: () => void) {
    // Everything visible counts (colours, pattern, cut), not only item and seed.
    const key = eq ? Object.entries(eq).filter(([, v]) => v).map(([k, v]) => `${k}:${v!.defId}:${JSON.stringify(v!.visual)}`).sort().join('|') : '';
    if (key === this.key) {
      done?.();
      return;
    }
    this.key = key;
    const gen = ++this.gen;
    const run = (job: () => void, label = 'equipment') => {
      const guarded = () => {
        if (gen === this.gen) job();
      };
      if (schedule) schedule(guarded, label);
      else guarded();
    };
    this.clear();
    eq ??= {};
    const ch = this.ch;
    const plan = dressPlan(eq, ch.traits.gender < 0.5, new Set(ch.actor.catalog.garments.map((g) => g.id)));
    let hideHair = false, hideBeard = false;
    const hidden = new Set<BodyRegion>();
    const fit = ch.body.fit;
    for (const [slot, item] of Object.entries(plan.rest) as [EquipSlot, NonNullable<EquipmentVisuals[EquipSlot]>][]) {
      if (!item || item.defId === 'no-underwear') continue;
      if (slot === 'mainhand' || slot === 'offhand') {
        run(() => this.addHeld(slot, item.defId, item.visual), `held ${item.defId}`);
        continue;
      }
      let spec: WearableSpec | null = null;
      try {
        spec = resolveWearable(item.defId, item.visual);
      } catch (e) {
        console.warn('[humanoid] resolveWearable failed', item.defId, e);
      }
      if (!spec) continue;
      hideHair ||= !!spec.hideHair;
      hideBeard ||= !!spec.hideBeard;
      for (const r of spec.hideRegions ?? []) hidden.add(r);
      for (const l of spec.layers) if (l.kind === 'rigid') run(() => this.addRigid(l, slot, fit), `rigid ${item.defId}`);
    }
    ch.setBodyHidden(WHOLE_BODY.every((r) => hidden.has(r)));
    // (A skull mask over the face and scalp: no hair through it.)
    if (hidden.has('scalp')) hideHair = true;
    void ch.dress(plan, hideHair, hideBeard).catch((e) => console.warn('[humanoid] dressing failed', e)).finally(() => {
      if (gen === this.gen) run(() => done?.(), 'dressed');
    });
  }

  private addRigid(part: RigidPart, slot: EquipSlot, fit: BodyFit) {
    let socket: string = part.socket;
    // Rings: ring1 goes on the left hand (resolver builds for hand.R).
    if (slot === 'ring1' && socket === 'hand.R') socket = 'hand.L';
    const s = this.ch.sockets.get(socket);
    if (!s) return;
    let obj: THREE.Object3D;
    try {
      obj = part.build(fit);
    } catch (e) {
      console.warn('[humanoid] rigid part build failed', slot, e);
      return;
    }
    obj.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
    s.add(obj);
    setItemSkyVis(obj, this.skyVis);
    this.rigids.push(obj);
  }

  private addHeld(slot: 'mainhand' | 'offhand', defId: string, visual: ItemVisual) {
    const grip = gripClassOf(defId, visual.shape);
    let obj: THREE.Object3D;
    try {
      obj = buildItemObject(defId, visual);
    } catch (e) {
      console.warn('[humanoid] held item build failed', defId, e);
      return;
    }
    obj.traverse((o) => { o.castShadow = true; });
    setItemSkyVis(obj, this.skyVis);
    // Bows are held in the left hand even when equipped as main hand.
    const hand = grip === 'bow' || grip === 'shield' || slot === 'offhand' ? 'L' : 'R';
    const stow = grip === 'twohand' || grip === 'polearm' || grip === 'bow' || grip === 'crossbow' ? 'back' : grip === 'blade' || grip === 'axe' || grip === 'blunt' || grip === 'dagger' ? (hand === 'R' ? 'hip.L' : 'hip.R') : grip === 'shield' ? 'back' : null;
    const holder = new THREE.Group();
    holder.add(obj);
    holder.userData.hand = hand;
    this.held.push({ slot, obj: holder, grip, stowSocket: stow });
    if (slot === 'mainhand') this.main = grip;
    else this.off = grip;
    if (grip === 'bow' && slot === 'mainhand') this.off = this.off === 'none' ? 'bow' : this.off;
    this.place(this.held[this.held.length - 1], this.drawn);
  }

  private place(h: { obj: THREE.Object3D; grip: GripClass; stowSocket: string | null }, drawn: boolean) {
    const hand = h.obj.userData.hand as 'L' | 'R';
    const atHand = drawn || !h.stowSocket;
    const sock = this.ch.sockets.get(atHand ? `grip.${hand}` : h.stowSocket === 'back' ? 'back' : h.stowSocket!);
    if (!sock) return;
    sock.add(h.obj);
    h.obj.position.set(0, 0, 0);
    h.obj.rotation.set(0, 0, 0);
    h.obj.scale.setScalar(1);
    if (atHand) {
      if (h.grip === 'shield') {
        // Shield strapped to the forearm: face (+Z) out of the back of the hand, top (+Y)
        // toward the elbow, centred on the forearm.
        const body = this.ch.body;
        const hb = body.sockets[`hand.${hand}`].basis, gb = body.sockets[`grip.${hand}`].basis;
        const d = new THREE.Vector3(hb[6], hb[7], hb[8]);
        const gx = new THREE.Vector3(gb[0], gb[1], gb[2]), gy = new THREE.Vector3(gb[3], gb[4], gb[5]), gz = new THREE.Vector3(gb[6], gb[7], gb[8]);
        const dl = new THREE.Vector3(d.dot(gx), d.dot(gy), d.dot(gz)).normalize();
        const up = new THREE.Vector3(0, 0, -1);
        up.addScaledVector(dl, -up.dot(dl)).normalize();
        const xo = new THREE.Vector3().crossVectors(up, dl);
        h.obj.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xo, up, dl));
        h.obj.position.copy(up).multiplyScalar(0.13).addScaledVector(dl, body.fit.forearmRadius * 0.6);
      } else if (h.grip === 'bow') {
        h.obj.rotation.set(0, 0, 0);
      } else if (h.grip === 'torch') {
        h.obj.rotation.set(0, 0, 0);
      }
    } else if (h.stowSocket === 'back') {
      // Diagonal across the back (body-aligned socket: +Z forward, so push to −Z behind).
      h.obj.position.set(0, -0.05, -0.06);
      h.obj.rotation.set(0, 0, h.grip === 'shield' ? 0 : 2.5);
      if (h.grip === 'shield') h.obj.rotation.set(0, Math.PI, 0), h.obj.position.set(0, 0, -0.08);
      if (h.grip === 'bow') h.obj.rotation.set(0, Math.PI / 2, 2.6);
    } else {
      // Sheathed at the hip, hilt up and forward.
      h.obj.position.set(h.stowSocket === 'hip.L' ? 0.1 : -0.1, -0.02, 0.02);
      h.obj.rotation.set(0.35, 0, Math.PI - 0.25 * (h.stowSocket === 'hip.L' ? 1 : -1));
    }
  }

  /** Draw or stow weapons. */
  setDrawn(d: boolean) {
    if (d === this.drawn) return;
    this.drawn = d;
    for (const h of this.held) this.place(h, d);
  }

  update(time: number) {
    for (const h of this.held) if (h.grip === 'torch') animateItem(h.obj.children[0], time);
  }

  setSkyVis(v: number) {
    this.skyVis = v;
    for (const r of this.rigids) setItemSkyVis(r, v);
    for (const h of this.held) setItemSkyVis(h.obj, v);
  }

  /** Object to anchor effects/lights to for a held slot. */
  heldObject(slot: 'mainhand' | 'offhand'): THREE.Object3D | null {
    return this.held.find((h) => h.slot === slot)?.obj ?? null;
  }

  private clear() {
    for (const r of this.rigids) { r.removeFromParent(); disposeItemObject(r); }
    this.rigids = [];
    for (const h of this.held) { h.obj.removeFromParent(); disposeItemObject(h.obj); }
    this.held = [];
    this.main = this.off = 'none';
  }

  dispose() {
    this.clear();
  }
}
