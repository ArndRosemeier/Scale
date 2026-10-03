/**
 * Start-screen character picker: the default (generated) human or an imported model.
 * Imports (GLB / glTF / VRM / FBX) are analysed immediately (rig mapping, clips), get a
 * thumbnail and are stored in the browser; the selection is remembered.
 */
import * as THREE from 'three';
import { avatarStore, type StoredAvatar } from '../avatar/AvatarStore';
import { loadModel, extOf, IMPORT_EXTENSIONS } from '../avatar/AvatarLoader';
import { mapHumanoid } from '../avatar/HumanoidMap';
import type { LoadedModel } from '../avatar/ImportedAvatar';

const MAX_BYTES = 200e6;

export class AvatarMenu {
  readonly el: HTMLDivElement;
  private list: HTMLDivElement;
  private status: HTMLDivElement;
  private input: HTMLInputElement;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'avatars';
    this.el.innerHTML = `
      <div class="avatars-head">Your character</div>
      <div class="avatar-list"></div>
      <div class="avatar-actions">
        <button type="button" class="avatar-import">Import model…</button>
        <a class="avatar-converter" href="converter/" target="_blank" rel="noopener" title="Converts FBX, .blend, OBJ, DAE and more into GLB (Windows, uses Blender)">Other formats? Get the converter</a>
      </div>
      <div class="avatar-status"></div>`;
    parent.appendChild(this.el);
    this.list = this.el.querySelector('.avatar-list') as HTMLDivElement;
    this.status = this.el.querySelector('.avatar-status') as HTMLDivElement;
    this.input = document.createElement('input');
    this.input.type = 'file';
    this.input.accept = IMPORT_EXTENSIONS.join(',');
    this.input.onchange = () => { const f = this.input.files?.[0]; if (f) void this.importFile(f); this.input.value = ''; };
    (this.el.querySelector('.avatar-import') as HTMLButtonElement).onclick = () => this.input.click();
    // Drop a model anywhere on the start screen.
    const drop = parent.closest('#menu') ?? parent;
    drop.addEventListener('dragover', (e) => { e.preventDefault(); this.el.classList.add('drop'); });
    drop.addEventListener('dragleave', () => this.el.classList.remove('drop'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      this.el.classList.remove('drop');
      const f = (e as DragEvent).dataTransfer?.files?.[0];
      if (f) void this.importFile(f);
    });
    void this.render();
  }

  private say(text: string, kind: 'info' | 'ok' | 'warn' = 'info'): void {
    this.status.textContent = text;
    this.status.className = `avatar-status ${kind}`;
  }

  async render(): Promise<void> {
    let items: StoredAvatar[] = [];
    try { items = await avatarStore.list(); } catch { this.say('Browser storage is not available: imported characters cannot be kept.', 'warn'); }
    const stored = avatarStore.selected();
    const active = stored && items.some((i) => i.id === stored) ? stored : null;
    this.list.innerHTML = '';
    const card = (id: string | null, name: string, sub: string, thumb: string | null) => {
      const c = document.createElement('div');
      c.className = 'avatar-card' + (id === active ? ' sel' : '');
      c.innerHTML = `<div class="thumb">${thumb ? `<img src="${thumb}" alt="">` : '<span>👤</span>'}</div><div class="name"></div><div class="sub"></div>${id ? '<button type="button" class="del" title="Delete">×</button>' : ''}`;
      (c.querySelector('.name') as HTMLElement).textContent = name;
      (c.querySelector('.sub') as HTMLElement).textContent = sub;
      c.onclick = (e) => {
        if ((e.target as HTMLElement).classList.contains('del')) return;
        avatarStore.select(id);
        void this.render();
      };
      const del = c.querySelector('.del') as HTMLButtonElement | null;
      if (del && id) del.onclick = async () => { await avatarStore.remove(id); void this.render(); };
      this.list.appendChild(c);
    };
    card(null, 'Default human', 'Generated, matches the city', null);
    for (const a of items) card(a.id, a.name, describe(a), a.thumb ?? null);
  }

  async importFile(file: File): Promise<void> {
    const ext = extOf(file.name);
    if (!IMPORT_EXTENSIONS.includes(ext)) {
      this.say(`"${file.name}": ${ext || 'this format'} can't be imported directly. Convert it to GLB first (see "Get the converter").`, 'warn');
      return;
    }
    if (file.size > MAX_BYTES) { this.say(`"${file.name}" is too large (${(file.size / 1e6).toFixed(0)} MB).`, 'warn'); return; }
    this.say(`Importing ${file.name}…`);
    try {
      const data = await file.arrayBuffer();
      const model = await loadModel(data.slice(0), file.name);
      const map = mapHumanoid(model.scene, model.json, model.associations);
      const mode = map.ok ? 'retarget' : model.animations.length ? 'clips' : 'static';
      const note = map.ok ? undefined : map.notes[0] ?? (map.missing.length ? `missing ${map.missing.slice(0, 3).join(', ')}` : undefined);
      const a: StoredAvatar = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        name: file.name.replace(/\.[^.]+$/, ''),
        file: file.name, data, size: file.size, created: Date.now(),
        thumb: thumbnail(model),
        info: { mode, source: map.source, mapped: Object.keys(map.bones).length, clips: model.animations.length, note },
      };
      await avatarStore.put(a);
      avatarStore.select(a.id);
      this.say(mode === 'static' ? `${a.name}: imported, but it has no skeleton or animations — it will stand still.` : `${a.name}: ${describe(a)}. Selected.`, mode === 'static' ? 'warn' : 'ok');
      void this.render();
    } catch (e) {
      console.error(e);
      this.say(`Could not import "${file.name}": ${(e as Error).message}`, 'warn');
    }
  }
}

function describe(a: StoredAvatar): string {
  const i = a.info;
  if (!i) return a.file;
  if (i.mode === 'retarget') return `Full animation (${i.source === 'vrm' ? 'VRM' : i.source === 'names' ? 'named' : 'auto-detected'} rig)`;
  if (i.mode === 'clips') return `Plays its own ${i.clips} animation${i.clips === 1 ? '' : 's'}`;
  return 'Static model';
}

/** Load the selected imported avatar (null: default human or nothing selected). */
export async function loadSelectedAvatar(): Promise<{ model: LoadedModel; stored: StoredAvatar } | null> {
  const id = avatarStore.selected();
  if (!id) return null;
  const a = await avatarStore.get(id);
  if (!a) return null;
  return { model: await loadModel(a.data.slice(0), a.file), stored: a };
}

/** Small preview image of a model (front view, own lights, offscreen). */
function thumbnail(model: LoadedModel): string | undefined {
  try {
    const size = 128;
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setSize(size, size);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
    const d = new THREE.DirectionalLight(0xffffff, 1.6);
    d.position.set(1, 2, 3);
    scene.add(d);
    const obj = model.scene;
    const parent = obj.parent;
    scene.add(obj);
    const box = new THREE.Box3().setFromObject(obj);
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const h = Math.max(s.y, s.x * 0.8, 1e-3);
    const cam = new THREE.PerspectiveCamera(30, 1, h * 0.01, h * 20);
    cam.position.set(c.x, c.y + h * 0.05, c.z + h * 2.1);
    cam.lookAt(c);
    r.render(scene, cam);
    const url = r.domElement.toDataURL('image/png');
    scene.remove(obj);
    if (parent) parent.add(obj);
    r.dispose();
    r.forceContextLoss();
    return url;
  } catch {
    return undefined;
  }
}
