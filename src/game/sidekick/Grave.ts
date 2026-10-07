/**
 * A fallen sidekick's grave (SIDEKICK_PLAN §7): a pale headstone with their name cut into it and
 * the shard's mark, a fresh mound in front, a few flowers. Placed in a cemetery by Sidekick (the
 * spot from companionRules.graveSpot) and kept in the save.
 */
import * as THREE from 'three';

const STONE = new THREE.MeshStandardMaterial({ color: 0xc9c6bd, roughness: 0.85, metalness: 0.02 });
const SOIL = new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 1 });
const PETALS = [0xf2f2ee, 0xe8c547, 0xc84a5a, 0x9fb7e8].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7 }));
const STEM = new THREE.MeshStandardMaterial({ color: 0x3d6b2f, roughness: 0.9 });

/** The grave, its front (the inscription) facing −Z rotated by `yaw` (the props' convention: towards the gate). */
export function makeGrave(name: string, yaw: number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'sidekick-grave';
  // The stone: a slab with a rounded top on a low base.
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.14, 0.42), STONE);
  base.position.y = 0.07;
  const slab = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.82, 0.16), STONE);
  slab.position.y = 0.14 + 0.41;
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.39, 0.39, 0.16, 24, 1, false, 0, Math.PI), STONE);
  top.rotation.set(Math.PI / 2, 0, Math.PI / 2);
  top.position.y = 0.14 + 0.82;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.86), new THREE.MeshStandardMaterial({ map: inscription(name), roughness: 0.8, transparent: true }));
  face.position.set(0, 0.14 + 0.5, -0.081);
  face.rotation.y = Math.PI;
  // The mound in front, flowers on it.
  const mound = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.16, 1.7), SOIL);
  mound.position.set(0, 0.06, -1.0);
  mound.scale.set(1, 1, 1);
  g.add(base, slab, top, face, mound);
  for (let i = 0; i < 7; i++) {
    const x = -0.28 + (i % 4) * 0.18 + (i > 3 ? 0.09 : 0), z = -0.5 - (i > 3 ? 0.22 : 0) - (i % 2) * 0.05;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.22, 4), STEM);
    stem.position.set(x, 0.24, z);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), PETALS[i % PETALS.length]);
    head.position.set(x, 0.36, z);
    g.add(stem, head);
  }
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.rotation.y = yaw;
  return g;
}

function inscription(name: string): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 320;
  const x = cv.getContext('2d')!;
  x.clearRect(0, 0, 256, 320);
  x.textAlign = 'center'; x.textBaseline = 'middle';
  // The shard's mark: a small pale-blue diamond.
  x.fillStyle = 'rgba(120, 170, 230, 0.9)';
  x.beginPath(); x.moveTo(128, 34); x.lineTo(146, 64); x.lineTo(128, 96); x.lineTo(110, 64); x.closePath(); x.fill();
  x.fillStyle = 'rgba(60, 58, 54, 0.92)';
  x.font = 'italic 22px Georgia, serif'; x.fillText('In memory of', 128, 128);
  // Their name, on two lines if it is long.
  const parts = name.split(' ');
  x.font = 'bold 30px Georgia, serif';
  if (name.length > 13 && parts.length > 1) {
    x.fillText(parts.slice(0, -1).join(' '), 128, 170, 236);
    x.fillText(parts[parts.length - 1], 128, 206, 236);
  } else x.fillText(name, 128, 182, 236);
  x.font = 'italic 19px Georgia, serif'; x.fillText('who stood by the hero', 128, 250, 236);
  x.fillText('and by this city', 128, 276, 236);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
