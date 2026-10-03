"""
Avatar converter (runs inside headless Blender): any character Blender can read
(FBX, glTF/GLB, OBJ, DAE, .blend) -> one GLB the game imports.

    blender -b --factory-startup -P convert_avatar.py -- out.glb model.fbx [anim1.fbx anim2.fbx ...]

- The first input is the character (mesh + armature). Further inputs are animation
  files for the same rig (e.g. Mixamo: one clip per FBX); their actions are added to
  the character under the file name ("Walking.fbx" -> clip "Walking").
- Mixamo-style FBX: automatic bone orientation, leaf "_end" bones dropped.
- The result is metric, Y-up, with skin, all actions and embedded textures.
- A report (rig kind, bone names, height, clips) is written next to the GLB as
  <out>.json and printed; the game uses the rig kind to map bones.

Use tools/avatar/convert.mjs (npm run avatar) rather than calling this directly: it
finds Blender (BLENDER_BIN or AssetGenerator's pinned install).
"""
import bpy
import mathutils
import json
import os
import sys


def args():
    a = sys.argv
    a = a[a.index('--') + 1:] if '--' in a else []
    if len(a) < 2:
        raise SystemExit('usage: -- out.glb model [anims...]')
    return a[0], a[1], a[2:]


def clear():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()
    for coll in (bpy.data.meshes, bpy.data.armatures, bpy.data.actions, bpy.data.materials, bpy.data.images):
        for b in list(coll):
            if b.users == 0:
                coll.remove(b)


def import_any(path):
    """Import a file; returns the objects it created."""
    before = set(bpy.data.objects)
    ext = os.path.splitext(path)[1].lower()
    if ext == '.fbx':
        bpy.ops.import_scene.fbx(filepath=path, automatic_bone_orientation=True, ignore_leaf_bones=True, use_anim=True)
    elif ext in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == '.obj':
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == '.dae':
        bpy.ops.wm.collada_import(filepath=path)
    elif ext == '.blend':
        # A .blend is a whole scene: open it as such (keeps modifiers, packed textures,
        # actions); the character is picked out at export.
        bpy.ops.wm.open_mainfile(filepath=path)
        bpy.ops.file.unpack_all(method='USE_LOCAL') if any(i.packed_file for i in bpy.data.images) else None
        return list(bpy.data.objects)
    else:
        raise SystemExit(f'unsupported format: {ext}')
    return [o for o in bpy.data.objects if o not in before]


def rig_kind(arm):
    names = [b.name for b in arm.data.bones] if arm else []
    joined = ' '.join(names).lower()
    if any(n.startswith('mixamorig') for n in names):
        return 'mixamo'
    if 'j_bip_' in joined:
        return 'vrm'
    if 'pelvis' in joined and 'spine_01' in joined and 'clavicle_l' in joined:
        return 'unreal'
    if 'def-upper_arm' in joined:
        return 'rigify'
    if 'upperarm01' in joined and 'lowerarm01' in joined:
        return 'makehuman'
    if 'hips' in joined and 'spine' in joined:
        return 'generic'
    return 'unknown' if arm else 'static'


def height_of(objs):
    lo, hi = float('inf'), float('-inf')
    for o in objs:
        if o.type != 'MESH':
            continue
        for c in o.bound_box:
            w = o.matrix_world @ mathutils.Vector(c)
            lo, hi = min(lo, w.z), max(hi, w.z)
    return hi - lo if hi > lo else 0.0


def game_rig(arm):
    """Rigify "game rig" step: deform bones hang off control (ORG/MCH) bones, which are not
    exported, so the deform skeleton would fall apart into loose roots. Re-parent every DEF
    bone to the DEF counterpart of its nearest ancestor (ORG-x -> DEF-x), keeping offsets."""
    bpy.context.view_layer.objects.active = arm
    for o in bpy.context.view_layer.objects:
        o.select_set(o == arm)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    names = {b.name for b in eb}

    def counterpart(n):
        for pre in ('ORG-', 'MCH-', 'DEF-'):
            if n.startswith(pre):
                d = 'DEF-' + n[len(pre):]
                return d if d in names else None
        return 'DEF-' + n if 'DEF-' + n in names else None

    changed = 0
    for b in list(eb):
        if not b.name.startswith('DEF-'):
            continue
        p = b.parent
        while p is not None:
            c = p.name if p.name.startswith('DEF-') else counterpart(p.name)
            if c and c != b.name and not eb[c].name == b.name:
                # Never parent to a descendant (would make a cycle).
                q, cyc = eb[c], False
                while q is not None:
                    if q == b:
                        cyc = True
                        break
                    q = q.parent
                if not cyc:
                    if b.parent != eb[c]:
                        b.use_connect = False
                        b.parent = eb[c]
                        changed += 1
                    break
            p = p.parent
    bpy.ops.object.mode_set(mode='OBJECT')
    print(f'[avatar] game rig: re-parented {changed} deform bones')


def weighted_bones(arm, meshes):
    """Bones that actually move the exported meshes (vertex groups with weight)."""
    names = {b.name for b in arm.data.bones}
    out = set()
    for o in meshes:
        idx = {g.index: g.name for g in o.vertex_groups if g.name in names}
        if not idx:
            continue
        for v in o.data.vertices:
            for g in v.groups:
                if g.weight > 1e-3 and g.group in idx:
                    out.add(idx[g.group])
    return out


def game_skeleton(arm, meshes):
    """Rigs whose deform bones hang off control bones (BlenRig, many hand-made rigs): keep
    only the bones that weight the mesh and re-parent each one to the kept bone it attaches
    to (the forearm's tail is at the hand's head), else to the nearest kept ancestor or its
    deform counterpart. The rest stops deforming and is not exported."""
    kept = weighted_bones(arm, meshes)
    if len(kept) < 8:
        return False
    bones = arm.data.bones
    broken = any(bones[n].parent and bones[n].parent.name not in kept for n in kept)
    if not broken:
        return False
    bpy.context.view_layer.objects.active = arm
    for o in bpy.context.view_layer.objects:
        o.select_set(o == arm)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    size = max(arm.dimensions) or 1.0
    tol = size * 0.012
    orig_anc = {}
    for b in eb:
        a, p = [], b.parent
        while p is not None:
            a.append(p.name)
            p = p.parent
        orig_anc[b.name] = a
    new_parent = {}

    def creates_cycle(child, parent):
        q = parent
        while q is not None:
            if q == child:
                return True
            q = new_parent.get(q, None)
        return False

    def counterpart(n):
        for pre in ('ORG-', 'MCH-', 'INT.', 'INT-', 'IK.', 'FK.', 'MCH.', 'DEF.', 'DEF-'):
            if n.startswith(pre):
                n = n[len(pre):]
                break
        for pre in ('DEF.', 'DEF-', 'DEF_'):
            if pre + n in kept:
                return pre + n
        return None

    order = sorted(kept, key=lambda n: len(orig_anc[n]))
    for n in order:
        b = eb[n]
        choice = None
        # 1. A kept bone ending where this one starts (not one of its own descendants).
        best = tol
        for k in kept:
            if k == n or n in orig_anc[k]:
                continue
            d = (eb[k].tail - b.head).length
            if d < best or (d == best and k in orig_anc[n]):
                if not creates_cycle(n, k):
                    best, choice = d, k
        # 2. Nearest kept ancestor, or the deform counterpart of an ancestor.
        if choice is None:
            for a in orig_anc[n]:
                c = a if a in kept else counterpart(a)
                if c and c != n and not creates_cycle(n, c):
                    choice = c
                    break
        new_parent[n] = choice
    for n, p in new_parent.items():
        eb[n].use_connect = False
        eb[n].parent = eb[p] if p else None
    bpy.ops.object.mode_set(mode='OBJECT')
    for b in arm.data.bones:
        b.use_deform = b.name in kept
    print(f'[avatar] game skeleton: {len(kept)} weighted bones of {len(bones)}')
    return True


HUMANOID = [
    ('Hips', False, r'(pelvis|hips?)'),
    ('Spine', False, r'(spine|spine_?0*1|abdomen)'),
    ('Chest', False, r'(chest|spine_?0*2)'),
    ('Neck', False, r'(neck|neck_?0*1)'),
    ('Head', False, r'(head)'),
    ('Shoulder', True, r'(clavicle|shoulder)'),
    ('UpperArm', True, r'(upper_?arm|upper_?arm_?0*1|arm)'),
    ('LowerArm', True, r'(lower_?arm|lower_?arm[._]?0*1|fore_?arm|fore_?arm[._]?0*1)'),
    ('Hand', True, r'(hand)'),
    ('UpperLeg', True, r'(thigh|thigh_?0*1|upper_?leg)'),
    ('LowerLeg', True, r'(shin|shin[._]?0*1|calf|lower_?leg)'),
    ('Foot', True, r'(foot)'),
    ('Toes', True, r'(toes?|toe_?0*1)'),
]


def humanoid_names(arm):
    """Give the main body bones standard names (Hips, LeftUpperArm, ...) when the rig uses
    a naming the game may not know (BlenRig, custom Rigify variants). Only deforming bones
    count, prefixed deform bones (DEF.) win over helpers; nothing is renamed unless every
    required bone is found."""
    import re
    cands = {}
    for b in arm.data.bones:
        if not b.use_deform:
            continue
        n, prio = b.name, 2
        m = re.match(r'^(DEF[-._]|MCH-DEF[-._])', n)
        if m:
            prio = 0 if m.group(1).startswith('DEF') else 1
            n = n[len(m.group(1)):]
        elif re.match(r'^(ORG|MCH|INT|IK|FK|tweak|CTRL)[-._]', n, re.I):
            continue
        side = None
        sm = re.match(r'^(.*?)[._-]?([LR])$', n) or re.match(r'^(.*?)[._-](left|right)$', n, re.I)
        if sm:
            n, side = sm.group(1), 'Left' if sm.group(2).lower() in ('l', 'left') else 'Right'
        cands.setdefault((n.lower(), side), []).append((prio, b.name))
    found = {}
    for canon, sided, rx in HUMANOID:
        for side in (('Left', 'Right') if sided else (None,)):
            hits = []
            for (n, s), lst in cands.items():
                if s == side and re.fullmatch(rx, n):
                    hits += [(p, -len(n), name) for p, name in lst]
            if hits:
                hits.sort()
                found[(side or '') + canon] = hits[0][2]
    required = ['Hips', 'Spine', 'Head'] + [s + c for s in ('Left', 'Right') for c in ('UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot')]
    if any(r not in found for r in required) or len(set(found.values())) != len(found):
        print('[avatar] humanoid bones: not all found (' + ', '.join(r for r in required if r not in found) + ')')
        return {}
    taken = {b.name for b in arm.data.bones}
    for canon, old in found.items():
        if canon != old and canon in taken:
            arm.data.bones[canon].name = canon + '_orig'
        arm.data.bones[old].name = canon
    print('[avatar] humanoid bones: ' + ', '.join(f'{k}={v}' for k, v in found.items()))
    return found


# Expected body hierarchy: child -> parent chain to hang it under if it is not already below.
BODY_PARENT = [
    ('Spine', 'Hips'), ('Chest', 'Spine'), ('Neck', 'Chest'), ('Neck', 'Spine'), ('Head', 'Neck'), ('Head', 'Spine'),
    ('LeftShoulder', 'Chest'), ('RightShoulder', 'Chest'),
    ('LeftUpperArm', 'LeftShoulder'), ('RightUpperArm', 'RightShoulder'), ('LeftUpperArm', 'Spine'), ('RightUpperArm', 'Spine'),
    ('LeftLowerArm', 'LeftUpperArm'), ('RightLowerArm', 'RightUpperArm'), ('LeftHand', 'LeftLowerArm'), ('RightHand', 'RightLowerArm'),
    ('LeftUpperLeg', 'Hips'), ('RightUpperLeg', 'Hips'), ('LeftLowerLeg', 'LeftUpperLeg'), ('RightLowerLeg', 'RightUpperLeg'),
    ('LeftFoot', 'LeftLowerLeg'), ('RightFoot', 'RightLowerLeg'), ('LeftToes', 'LeftFoot'), ('RightToes', 'RightFoot'),
]


def body_hierarchy(arm):
    """The game moves the body from the hips down the hierarchy: every body bone must sit
    below its anatomical parent (hips and spine as siblings, or a foot hanging off the
    pelvis, would tear the mesh apart). Fix such bones by hanging them under the bone of
    the parent's chain they touch (a foot under the lower shin segment)."""
    bpy.context.view_layer.objects.active = arm
    for o in bpy.context.view_layer.objects:
        o.select_set(o == arm)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    fixed = []

    def below(b, a):
        q = b.parent
        while q is not None:
            if q == a:
                return True
            q = q.parent
        return False

    for child, parent in BODY_PARENT:
        c, p = eb.get(child), eb.get(parent)
        if not c or not p or below(c, p):
            continue
        if any(child == ch and eb.get(pa) and below(c, eb[pa]) for ch, pa in BODY_PARENT if pa != parent):
            continue  # already below an accepted alternative parent
        cands = [p] + [d for d in p.children_recursive if d.use_deform and d != c and not below(d, c)]
        best = min(cands, key=lambda d: min((d.tail - c.head).length, (d.head - c.head).length * 1.5))
        c.use_connect = False
        c.parent = best
        fixed.append(f'{child}->{best.name}')
    bpy.ops.object.mode_set(mode='OBJECT')
    if fixed:
        print('[avatar] body hierarchy: ' + ', '.join(fixed))


def character_objects(objs):
    """The character: the armature with the most bones and the meshes it deforms
    (or, without an armature, all meshes). Cameras, lights, props are left out."""
    arms = sorted([o for o in objs if o.type == 'ARMATURE'], key=lambda o: -len(o.data.bones))
    arm = arms[0] if arms else None
    if not arm:
        return None, [o for o in objs if o.type == 'MESH']
    meshes = [o for o in objs if o.type == 'MESH' and (o.parent == arm or any(m.type == 'ARMATURE' and m.object == arm for m in o.modifiers))]
    # Not part of the look: meshes hidden from rendering, cages that drive other meshes.
    cages = {m.object for o in meshes for m in o.modifiers if m.type in ('MESH_DEFORM', 'SURFACE_DEFORM', 'LATTICE') and getattr(m, 'object', None)}
    meshes = [o for o in meshes if not o.hide_render and o not in cages]
    return arm, meshes


def main():
    out, model, anims = args()
    clear()
    objs = import_any(model)
    arm, meshes = character_objects(objs)
    clips = []
    if arm and arm.animation_data and arm.animation_data.action:
        act = arm.animation_data.action
        # Importers name actions after the armature ("Armature|mixamo.com|Layer0"): use the file name.
        if '|' in act.name or act.name.startswith('Armature'):
            act.name = os.path.splitext(os.path.basename(model))[0]
        clips.append(act.name)
    # Extra animation files: take their action, give it to the character, drop the rest.
    for path in anims:
        new = import_any(path)
        src = next((o for o in new if o.type == 'ARMATURE' and o.animation_data and o.animation_data.action), None)
        if src and arm:
            act = src.animation_data.action
            act.name = os.path.splitext(os.path.basename(path))[0]
            act.use_fake_user = True
            if not arm.animation_data:
                arm.animation_data_create()
            tr = arm.animation_data.nla_tracks.new()
            tr.name = act.name
            tr.strips.new(act.name, int(act.frame_range[0]), act)
            clips.append(act.name)
        else:
            print(f'[avatar] warning: no armature animation in {path}')
        for o in new:
            bpy.data.objects.remove(o, do_unlink=True)
    # Every action of the rig is exported as its own clip; shape-key (morph) actions that
    # importers create are not animations of the character.
    def animates_bones(a):
        try:
            return any(fc.data_path.startswith('pose.bones') for fc in a.fcurves)
        except Exception:
            return True
    for a in list(bpy.data.actions):
        if getattr(a, 'id_root', 'OBJECT') in ('KEY', 'NODETREE', 'MATERIAL') or a.name.startswith('Key') or a.name == 'PoseLib' or not animates_bones(a):
            bpy.data.actions.remove(a)
        else:
            a.use_fake_user = True
    report = {
        'source': os.path.basename(model),
        'rig': rig_kind(arm),
        'bones': [b.name for b in arm.data.bones] if arm else [],
        'height': round(height_of(meshes), 3),
        'meshes': len(meshes),
        'clips': [a.name for a in bpy.data.actions],
    }
    os.makedirs(os.path.dirname(os.path.abspath(out)) or '.', exist_ok=True)
    # Export only the character; modifiers (mirror, subdivision…) are applied, the
    # armature modifier stays as skinning.
    for o in bpy.context.view_layer.objects:
        o.hide_set(False)
        o.select_set(o == arm or o in meshes)
    # Rigify and similar rigs: only the deform skeleton ("DEF-" bones) belongs in the game.
    rigify = bool(arm) and any(bn.name.startswith('DEF-') for bn in arm.data.bones)
    if rigify:
        game_rig(arm)
    cleaned = bool(arm) and not rigify and game_skeleton(arm, meshes)
    if arm and report['rig'] not in ('mixamo', 'vrm', 'unreal') and humanoid_names(arm):
        report['rig'] = 'humanoid'
        body_hierarchy(arm)
    if arm:
        report['bones'] = [b.name for b in arm.data.bones if b.use_deform or not (rigify or cleaned)]
    # (game_rig selects only the armature for edit mode: select the character again.)
    for o in bpy.context.view_layer.objects:
        o.select_set(o == arm or o in meshes)
    bpy.ops.export_scene.gltf(
        filepath=out, export_format='GLB', export_yup=True, use_selection=True, export_def_bones=rigify or cleaned,
        export_skins=True, export_animations=True, export_animation_mode='ACTIONS',
        export_materials='EXPORT', export_image_format='AUTO', export_apply=True,
    )
    with open(os.path.splitext(out)[0] + '.json', 'w') as f:
        json.dump(report, f, indent=2)
    print('[avatar] ' + json.dumps({k: v for k, v in report.items() if k != 'bones'}))


main()
