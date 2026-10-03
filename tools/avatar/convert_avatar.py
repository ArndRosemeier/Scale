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


def character_objects(objs):
    """The character: the armature with the most bones and the meshes it deforms
    (or, without an armature, all meshes). Cameras, lights, props are left out."""
    arms = sorted([o for o in objs if o.type == 'ARMATURE'], key=lambda o: -len(o.data.bones))
    arm = arms[0] if arms else None
    if not arm:
        return None, [o for o in objs if o.type == 'MESH']
    meshes = [o for o in objs if o.type == 'MESH' and (o.parent == arm or any(m.type == 'ARMATURE' and m.object == arm for m in o.modifiers))]
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
    for a in list(bpy.data.actions):
        if getattr(a, 'id_root', 'OBJECT') == 'KEY' or a.name.startswith('Key'):
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
    bpy.ops.export_scene.gltf(
        filepath=out, export_format='GLB', export_yup=True, use_selection=True, export_def_bones=rigify,
        export_skins=True, export_animations=True, export_animation_mode='ACTIONS',
        export_materials='EXPORT', export_image_format='AUTO', export_apply=True,
    )
    with open(os.path.splitext(out)[0] + '.json', 'w') as f:
        json.dump(report, f, indent=2)
    print('[avatar] ' + json.dumps({k: v for k, v in report.items() if k != 'bones'}))


main()
