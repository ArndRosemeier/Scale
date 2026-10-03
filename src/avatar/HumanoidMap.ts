/**
 * Humanoid bone mapping for imported characters: find the standard humanoid bones
 * (VRM 1.0 / Unity Mecanim / Godot SkeletonProfileHumanoid set) in an arbitrary
 * skeleton, so our animation system can drive any humanoid rig.
 *
 * Strategies, strongest first:
 *  1. VRM files declare the mapping (VRMC_vrm 1.0 or the VRM 0.x extension).
 *  2. Names (like Godot's auto-mapper): normalise away common prefixes (mixamorig:, DEF-,
 *     Bip01, J_Bip_L_, CC_Base_, …), match per-bone keywords, detect left/right.
 *  3. Structure, for rigs with meaningless names: hips = the bone where two legs branch
 *     downwards and the spine goes up; chest = where both arms and the neck split; the
 *     chains are followed from there. Facing comes from the feet (toes point forward).
 *
 * Every mapping is validated: the 15 required bones (VRM 1.0) must exist and be in a
 * plausible place in the hierarchy (e.g. a hand below its lower arm).
 */
import * as THREE from 'three';

export const REQUIRED = [
  'hips', 'spine', 'head',
  'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
] as const;
export const OPTIONAL = ['chest', 'upperChest', 'neck', 'leftShoulder', 'rightShoulder', 'leftToes', 'rightToes'] as const;
export type HumanBone = (typeof REQUIRED)[number] | (typeof OPTIONAL)[number];

export interface HumanoidMapping {
  bones: Partial<Record<HumanBone, THREE.Bone>>;
  /** Which strategy produced it. */
  source: 'vrm' | 'names' | 'structure' | 'none';
  ok: boolean;
  missing: HumanBone[];
  /** Model facing along +Z (1) or −Z (−1) in its rest pose. */
  facing: 1 | -1;
  notes: string[];
}

type Side = 'left' | 'right' | null;

// ------------------------------------------------------------------ entry

/**
 * Map a loaded character. `gltfJson` / `associations`: from GLTFLoader (`gltf.parser.json`,
 * `gltf.parser.associations`) to read VRM humanoid data when present.
 */
export function mapHumanoid(root: THREE.Object3D, gltfJson?: unknown, associations?: Map<unknown, { nodes?: number }>): HumanoidMapping {
  root.updateMatrixWorld(true);
  const bones = collectBones(root);
  const notes: string[] = [];
  if (!bones.length) return { bones: {}, source: 'none', ok: false, missing: [...REQUIRED], facing: 1, notes: ['no skeleton (static model)'] };
  const tries: HumanoidMapping[] = [];
  const vrm = fromVrm(bones, gltfJson, associations);
  if (vrm) tries.push(finish(vrm, 'vrm', bones, notes));
  tries.push(finish(fromNames(bones), 'names', bones, notes));
  tries.push(finish(fromStructure(bones, notes), 'structure', bones, notes));
  // Best: valid first, then fewest missing bones.
  tries.sort((a, b) => Number(b.ok) - Number(a.ok) || a.missing.length - b.missing.length);
  const best = tries[0];
  // Fill gaps of the winner from the other strategies when consistent.
  for (const t of tries.slice(1)) for (const k of Object.keys(t.bones) as HumanBone[]) if (!best.bones[k] && t.bones[k] && !Object.values(best.bones).includes(t.bones[k])) best.bones[k] = t.bones[k];
  return finish(best.bones, best.source as HumanoidMapping['source'], bones, best.notes);
}

function collectBones(root: THREE.Object3D): THREE.Bone[] {
  const set = new Set<THREE.Bone>();
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) set.add(o as THREE.Bone);
    const sk = (o as THREE.SkinnedMesh).skeleton;
    if (sk) for (const b of sk.bones) set.add(b);
  });
  return [...set];
}

// ------------------------------------------------------------------ 1. VRM

const VRM0_NAMES: Record<string, HumanBone> = {
  hips: 'hips', spine: 'spine', chest: 'chest', upperChest: 'upperChest', neck: 'neck', head: 'head',
  leftShoulder: 'leftShoulder', leftUpperArm: 'leftUpperArm', leftLowerArm: 'leftLowerArm', leftHand: 'leftHand',
  rightShoulder: 'rightShoulder', rightUpperArm: 'rightUpperArm', rightLowerArm: 'rightLowerArm', rightHand: 'rightHand',
  leftUpperLeg: 'leftUpperLeg', leftLowerLeg: 'leftLowerLeg', leftFoot: 'leftFoot', leftToes: 'leftToes',
  rightUpperLeg: 'rightUpperLeg', rightLowerLeg: 'rightLowerLeg', rightFoot: 'rightFoot', rightToes: 'rightToes',
};

function fromVrm(bones: THREE.Bone[], json: unknown, assoc?: Map<unknown, { nodes?: number }>): Partial<Record<HumanBone, THREE.Bone>> | null {
  const ext = (json as { extensions?: Record<string, unknown> } | undefined)?.extensions;
  if (!ext || !assoc) return null;
  const byNode = new Map<number, THREE.Bone>();
  for (const b of bones) { const a = assoc.get(b); if (a?.nodes !== undefined) byNode.set(a.nodes, b); }
  const out: Partial<Record<HumanBone, THREE.Bone>> = {};
  const v1 = ext.VRMC_vrm as { humanoid?: { humanBones?: Record<string, { node: number }> } } | undefined;
  const v0 = ext.VRM as { humanoid?: { humanBones?: { bone: string; node: number }[] } } | undefined;
  if (v1?.humanoid?.humanBones) {
    for (const [k, v] of Object.entries(v1.humanoid.humanBones)) if (VRM0_NAMES[k] && byNode.has(v.node)) out[VRM0_NAMES[k]] = byNode.get(v.node)!;
  } else if (v0?.humanoid?.humanBones) {
    for (const v of v0.humanoid.humanBones) if (VRM0_NAMES[v.bone] && byNode.has(v.node)) out[VRM0_NAMES[v.bone]] = byNode.get(v.node)!;
  } else return null;
  return out;
}

// ------------------------------------------------------------------ 2. names

/** Lower-case words of a bone name without rig prefixes; side detected separately. */
function normalise(name: string): { words: string; side: Side } {
  let n = name;
  // Rig prefixes.
  n = n.replace(/^mixamorig\d*[:_]?/i, '').replace(/^(def|org|mch|deform)[-_.]/i, '').replace(/^bip0?\d*[ _]?/i, '')
    .replace(/^cc_base_/i, '').replace(/^character\d*_/i, '').replace(/^armature[|_.:]?/i, '').replace(/^b_/i, '').replace(/^bone_/i, '');
  // VRoid: J_Bip_L_UpperArm / J_Bip_C_Hips.
  let side: Side = null;
  const jb = /^j_(?:bip|adj|sec)_([lrc])_(.*)$/i.exec(n);
  if (jb) { side = jb[1].toLowerCase() === 'l' ? 'left' : jb[1].toLowerCase() === 'r' ? 'right' : null; n = jb[2]; }
  // Side as a trailing capital letter, optionally with a segment number (Rigify after the
  // loader strips dots: "DEF-thighL", "DEF-upper_armL001"; MakeHuman: "upperarm01L").
  if (!side) {
    const m = /^(.*[a-z0-9_.\-])([LR])(?:[._]?(\d+))?$/.exec(n);
    if (m) { side = m[2] === 'L' ? 'left' : 'right'; n = m[1] + (m[3] ? ' ' + m[3] : ''); }
  }
  // camelCase → words, separators → spaces.
  let w = n.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.\-:|]+/g, ' ').toLowerCase().trim();
  if (!side) {
    if (/(^|\s)(left|lft)(\s|$)/.test(w) || /^l\s/.test(w) || /\sl$/.test(w)) side = 'left';
    else if (/(^|\s)(right|rgt)(\s|$)/.test(w) || /^r\s/.test(w) || /\sr$/.test(w)) side = 'right';
  }
  w = w.replace(/(^|\s)(left|right|lft|rgt|l|r)(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  return { words: w, side };
}

const NAME_RULES: [HumanBone | 'upperArmS' | 'lowerArmS' | 'handS' | 'shoulderS' | 'upperLegS' | 'lowerLegS' | 'footS' | 'toesS', RegExp][] = [
  ['hips', /^(hips?|pelvis|root hips)$/],
  ['spine', /^(spine|spine ?0*1|spine1|abdomen|waist|torso|spine lower|lower ?back)$/],
  ['chest', /^(chest|spine ?0*2|spine2|spine upper|upper ?back|thorax|ribcage)$/],
  ['upperChest', /^(upper ?chest|spine ?0*3|spine3|chest ?upper)$/],
  ['neck', /^(neck|neck ?0*1|neck1)$/],
  ['head', /^(head|head ?0*1)$/],
  ['shoulderS', /^(shoulder|clavicle|collar ?bone|collar)$/],
  ['upperArmS', /^(upper ?arm|arm|arm ?upper|up ?arm|upperarm ?0*1|humerus)$/],
  ['lowerArmS', /^(fore ?arm|lower ?arm|arm ?lower|elbow|lowerarm ?0*1)$/],
  ['handS', /^(hand|wrist|palm) ?\d*$/],
  ['upperLegS', /^(up ?leg|upper ?leg|thigh|leg ?upper|upperleg ?0*1|femur)$/],
  ['lowerLegS', /^(leg|lower ?leg|calf|shin|knee|leg ?lower|lowerleg ?0*1)$/],
  ['footS', /^(foot|ankle)$/],
  ['toesS', /^(toes?|toe ?base|ball|toe ?0*1)$/],
];

/** Rigify numbers its torso chain from the pelvis: DEF-spine = hips … DEF-spine.006 = head. */
const RIGIFY_SPINE: Record<string, HumanBone> = {
  'def-spine': 'hips', 'def-spine.001': 'spine', 'def-spine.002': 'chest', 'def-spine.003': 'upperChest',
  'def-spine.004': 'neck', 'def-spine.006': 'head',
};

function fromNames(bones: THREE.Bone[]): Partial<Record<HumanBone, THREE.Bone>> {
  const out: Partial<Record<HumanBone, THREE.Bone>> = {};
  const rigify = bones.some((b) => /^def-spine[._]?00\d$/i.test(b.name));
  if (rigify) for (const b of bones) { const k = RIGIFY_SPINE[b.name.toLowerCase().replace(/^(def-spine)[._]?(\d+)$/, '$1.$2')]; if (k) out[k] = b; }
  for (const b of bones) {
    const { words, side } = normalise(b.name);
    if (rigify && /^def-spine/i.test(b.name)) continue;
    for (const [key, re] of NAME_RULES) {
      if (!re.test(words)) continue;
      let k: HumanBone;
      if (key.endsWith('S')) {
        if (!side) break;
        const part = key.slice(0, -1);
        k = (side + part[0].toUpperCase() + part.slice(1)) as HumanBone;
      } else k = key as HumanBone;
      // Keep the one closest to the root (e.g. "Head" over "HeadTop_End" is excluded anyway).
      if (!out[k] || depth(b) < depth(out[k]!)) out[k] = b;
      break;
    }
  }
  return out;
}

function depth(b: THREE.Object3D): number { let d = 0; for (let p = b.parent; p; p = p.parent) d++; return d; }

// ------------------------------------------------------------------ 3. structure

const _v = new THREE.Vector3();
function wpos(b: THREE.Object3D): THREE.Vector3 { return b.getWorldPosition(new THREE.Vector3()); }
function boneKids(b: THREE.Object3D): THREE.Bone[] { return b.children.filter((c) => (c as THREE.Bone).isBone) as THREE.Bone[]; }
/** Lowest / highest world y over a bone's subtree. */
function extent(b: THREE.Object3D): { lo: number; hi: number; n: number } {
  let lo = Infinity, hi = -Infinity, n = 0;
  b.traverse((o) => { if ((o as THREE.Bone).isBone) { const y = o.getWorldPosition(_v).y; lo = Math.min(lo, y); hi = Math.max(hi, y); n++; } });
  return { lo, hi, n };
}
/** Follow the longest bone chain below b (by subtree size) up to n steps. */
function chain(b: THREE.Bone, n: number): THREE.Bone[] {
  const out = [b];
  let c = b;
  for (let i = 1; i < n; i++) {
    const k = boneKids(c);
    if (!k.length) break;
    c = k.sort((p, q) => extent(q).n - extent(p).n)[0];
    out.push(c);
  }
  return out;
}

function fromStructure(bones: THREE.Bone[], notes: string[]): Partial<Record<HumanBone, THREE.Bone>> {
  const out: Partial<Record<HumanBone, THREE.Bone>> = {};
  // Hips: two children subtrees reaching well below it, symmetric in x, plus one going up.
  let hips: THREE.Bone | null = null, legs: THREE.Bone[] = [], up: THREE.Bone | null = null, best = -Infinity;
  for (const b of bones) {
    const k = boneKids(b);
    if (k.length < 2) continue;
    const p = wpos(b);
    const total = extent(b);
    const height = total.hi - total.lo || 1;
    const down = k.filter((c) => extent(c).lo < p.y - height * 0.3);
    const ups = k.filter((c) => extent(c).hi > p.y + height * 0.2);
    if (down.length < 2 || !ups.length) continue;
    const [a, c] = down.sort((x, y) => extent(x).lo - extent(y).lo);
    const ax = wpos(a).x - p.x, cx = wpos(c).x - p.x;
    const sym = ax * cx < 0 ? 1 - Math.abs(Math.abs(ax) - Math.abs(cx)) / (Math.abs(ax) + Math.abs(cx) + 1e-6) : 0;
    const score = sym * 2 + total.n * 0.01;
    if (score > best) { best = score; hips = b; legs = [a, c]; up = ups.sort((x, y) => extent(y).n - extent(x).n)[0]; }
  }
  if (!hips || !up) { notes.push('structure: no hips found'); return out; }
  out.hips = hips;
  // Spine: follow upwards until a bone whose children split into two arms (sideways) + neck.
  let cur: THREE.Bone = up;
  const spine: THREE.Bone[] = [];
  let chestSplit: THREE.Bone | null = null;
  for (let i = 0; i < 8 && cur; i++) {
    spine.push(cur);
    const k = boneKids(cur);
    if (k.length >= 3) { chestSplit = cur; break; }
    if (!k.length) break;
    cur = k.sort((p, q) => extent(q).n - extent(p).n)[0];
  }
  if (!chestSplit) { notes.push('structure: no chest split'); return out; }
  out.spine = spine[0];
  if (spine.length >= 3) out.chest = spine[spine.length - 2];
  if (spine.length >= 4) out.upperChest = spine[spine.length - 1];
  else if (spine.length >= 2) out.chest = spine[spine.length - 1];
  const cp = wpos(chestSplit);
  const kids = boneKids(chestSplit);
  const neck = kids.sort((p, q) => (wpos(q).y - wpos(p).y) - (Math.abs(wpos(q).x - cp.x) - Math.abs(wpos(p).x - cp.x)))[0];
  const nc = chain(neck, 3);
  if (nc.length >= 2) { out.neck = nc[0]; out.head = nc[1]; } else out.head = nc[0];
  // Facing from the feet: toes are in front of the ankles.
  const legChains = legs.map((l) => chain(l, 5));
  let fz = 0;
  for (const lc of legChains) if (lc.length >= 2) { const a = wpos(lc[lc.length - 2]), t = wpos(lc[lc.length - 1]); fz += t.z - a.z; }
  const facing: 1 | -1 = fz < -1e-4 ? -1 : 1;
  // Character's left is +x when facing +z.
  const sideOf = (b: THREE.Bone): Side => ((wpos(b).x - cp.x) * facing > 0 ? 'left' : 'right');
  for (const lc of legChains) {
    // Skip a short "pelvis side" bone if present (first bone barely below the hips).
    const c = lc.slice();
    if (c.length >= 5 && Math.abs(wpos(c[0]).y - wpos(hips).y) < 0.05 * (extent(hips).hi - extent(hips).lo)) c.shift();
    const s = sideOf(c[c.length - 1]);
    if (!s) continue;
    out[`${s}UpperLeg` as HumanBone] = c[0];
    if (c[1]) out[`${s}LowerLeg` as HumanBone] = c[1];
    if (c[2]) out[`${s}Foot` as HumanBone] = c[2];
    if (c[3]) out[`${s}Toes` as HumanBone] = c[3];
  }
  for (const a of kids.filter((k) => k !== neck)) {
    const c = chain(a, 5);
    const s = sideOf(c[c.length - 1]);
    if (!s) continue;
    // Shoulder (clavicle) when the chain is long enough: clavicle, upper, lower, hand.
    const off = c.length >= 4 ? 1 : 0;
    if (off) out[`${s}Shoulder` as HumanBone] = c[0];
    if (c[off]) out[`${s}UpperArm` as HumanBone] = c[off];
    if (c[off + 1]) out[`${s}LowerArm` as HumanBone] = c[off + 1];
    if (c[off + 2]) out[`${s}Hand` as HumanBone] = c[off + 2];
  }
  return out;
}

// ------------------------------------------------------------------ validation

const PARENT: Partial<Record<HumanBone, HumanBone[]>> = {
  spine: ['hips'], head: ['spine'], leftUpperArm: ['spine'], rightUpperArm: ['spine'],
  leftLowerArm: ['leftUpperArm'], rightLowerArm: ['rightUpperArm'], leftHand: ['leftLowerArm'], rightHand: ['rightLowerArm'],
  leftUpperLeg: ['hips'], rightUpperLeg: ['hips'], leftLowerLeg: ['leftUpperLeg'], rightLowerLeg: ['rightUpperLeg'],
  leftFoot: ['leftLowerLeg'], rightFoot: ['rightLowerLeg'],
};

function isAncestor(a: THREE.Object3D, b: THREE.Object3D): boolean { for (let p = b.parent; p; p = p.parent) if (p === a) return true; return false; }

function finish(bones: Partial<Record<HumanBone, THREE.Bone>>, source: HumanoidMapping['source'], all: THREE.Bone[], notes: string[]): HumanoidMapping {
  const n = notes.slice();
  const missing = REQUIRED.filter((k) => !bones[k]) as HumanBone[];
  let ok = missing.length === 0;
  // Hierarchy sanity: each bone below its expected ancestor.
  for (const [k, parents] of Object.entries(PARENT) as [HumanBone, HumanBone[]][]) {
    const b = bones[k];
    if (!b) continue;
    for (const p of parents) if (bones[p] && !isAncestor(bones[p]!, b)) { ok = false; n.push(`${source}: ${k} not below ${p}`); }
  }
  // Human proportions (rejects quadrupeds and odd rigs that only look right by name):
  // the spine runs mostly upwards, the head is well above the hips, the hips well above the feet.
  if (ok) {
    let lo = Infinity, hi = -Infinity;
    for (const b of all) { const y = wpos(b).y; lo = Math.min(lo, y); hi = Math.max(hi, y); }
    const H = Math.max(1e-6, hi - lo);
    const hip = wpos(bones.hips!), head = wpos(bones.head!);
    const feet = (wpos(bones.leftFoot!).y + wpos(bones.rightFoot!).y) / 2;
    const up = head.y - hip.y, side = Math.hypot(head.x - hip.x, head.z - hip.z);
    if (up < H * 0.2 || up < side * 1.5) { ok = false; n.push(`${source}: spine not upright (not a standing humanoid)`); }
    if (hip.y - feet < H * 0.25) { ok = false; n.push(`${source}: legs too short / not below the hips`); }
  }
  // Facing: from the feet if mapped.
  let facing: 1 | -1 = 1;
  const lf = bones.leftFoot, lt = bones.leftToes;
  if (lf && lt) facing = wpos(lt).z - wpos(lf).z < 0 ? -1 : 1;
  else if (bones.leftUpperLeg && bones.hips) facing = (wpos(bones.leftUpperLeg).x - wpos(bones.hips).x) < 0 ? -1 : 1;
  return { bones, source, ok, missing, facing, notes: n };
}
