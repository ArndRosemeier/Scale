"""
Avatar converter (runs inside headless Blender): any rigged character Blender can read
(FBX, glTF/GLB, OBJ, DAE, .blend) -> one GLB the game imports, or a clear refusal.

    blender -b --factory-startup -P convert_avatar.py -- out.glb model.fbx [anim1.fbx anim2.fbx ...]

The first input is the character. Further inputs are animation files for the same rig
(e.g. Mixamo: one clip per FBX); their actions become clips named after the file.

Hand-made rigs (.blend files from the web) move their mesh through control bones,
constraints, drivers, IK, deform cages, lattices, extra armatures and objects parented
to bones: none of that survives in a game file. So the converter does not export the rig
as it is. It measures what the rig does and rebuilds it:

 1. Picks the character: the armature that moves the most visible, renderable mesh and
    every mesh it moves (directly, through cages/lattices or as children of bones).
 2. Bakes the meshes in their rest shape (mirror, subdivision etc. applied).
 3. Measures every vertex's bone weights by moving each bone that can move the mesh
    (constraints and drivers off, bones unparented) and watching where the vertices go.
    This turns cages, lattices, bone-parented props and second armatures into ordinary
    skin weights.
 4. Builds a clean skeleton from the bones that carry weight: control/deform twins
    (ORG-x / DEF-x, copy-transforms pairs) become one bone, each bone hangs under the bone
    it actually follows in the rig.
 5. Finds the humanoid body bones (names in several languages, else the body's shape),
    names them Hips, Spine, LeftUpperArm ... and puts them in a proper body hierarchy, so
    the game can drive the character with its own animation system.
 6. Bakes the rig's animations onto the new skeleton (clips the game can play).
 7. Checks the result (all body bones found, mesh stays in one piece in test poses). If a
    check fails, it says why and writes no file, instead of producing a broken avatar.

A report (rig kind, bones, height, clips, warnings) is written next to the GLB as
<out>.json and printed; the game uses the bone names to map the body.

Use tools/avatar/convert.mjs (npm run avatar) rather than calling this directly: it
finds Blender (BLENDER_BIN or AssetGenerator's pinned install).
"""
import bpy
import json
import math
import os
import re
import sys
from mathutils import Matrix, Vector

try:
    import numpy as np
except ImportError:  # Blender always ships numpy; keep the error readable if not.
    np = None


class ConversionError(Exception):
    pass


T0 = __import__('time').time()


def log(msg):
    if os.environ.get('AVATAR_DEBUG'):
        msg = f'{__import__("time").time() - T0:6.1f}s ' + msg
    print('[avatar] ' + msg, flush=True)


WARNINGS = []


def warn(msg):
    WARNINGS.append(msg)
    log('warning: ' + msg)


def args():
    a = sys.argv
    a = a[a.index('--') + 1:] if '--' in a else []
    if len(a) < 2:
        raise SystemExit('usage: -- out.glb model [anims...]')
    return a[0], a[1], a[2:]


def clear():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
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
    elif ext in ('.glb', '.gltf', '.vrm'):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == '.obj':
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == '.dae':
        bpy.ops.wm.collada_import(filepath=path)
    elif ext == '.blend':
        # A .blend is a whole scene: open it as such (keeps modifiers, packed textures,
        # actions); the character is picked out of it.
        bpy.ops.wm.open_mainfile(filepath=path)
        if any(i.packed_file for i in bpy.data.images):
            try:
                bpy.ops.file.unpack_all(method='USE_LOCAL')
            except Exception as e:
                warn(f'could not unpack textures ({e})')
        return list(bpy.data.objects)
    else:
        raise ConversionError(f'unsupported format: {ext}')
    return [o for o in bpy.data.objects if o not in before]


# ------------------------------------------------------------------ picking the character

DEFORMERS = ('MESH_DEFORM', 'SURFACE_DEFORM', 'LATTICE', 'CURVE', 'HOOK', 'SHRINKWRAP', 'CAST', 'WARP')
PHYSICS = ('CLOTH', 'SOFT_BODY', 'COLLISION', 'DYNAMIC_PAINT', 'OCEAN', 'FLUID', 'PARTICLE_SYSTEM', 'PARTICLE_INSTANCE', 'EXPLODE')


def shown(o):
    """Would the object appear in a render of the file as the author left it?"""
    if o.hide_render or o.name not in bpy.context.view_layer.objects:
        return False
    if any(c.hide_render for c in o.users_collection):
        return False
    return True


def renders_as_mesh(o):
    if o.type != 'MESH' or not shown(o) or not len(o.data.vertices):
        return False
    # Particle emitters (hair, eyebrows) usually hide their emitter mesh in renders.
    if any(m.type == 'PARTICLE_SYSTEM' for m in o.modifiers) and not o.show_instancer_for_render:
        return False
    return True


def movers(o):
    """Objects whose motion moves o: parent, armature and deformer targets, constraint targets."""
    out = []
    if o.parent:
        out.append(o.parent)
    for m in o.modifiers:
        t = getattr(m, 'object', None)
        if m.type == 'ARMATURE' and t and m.show_viewport | m.show_render:
            out.append(t)
        elif m.type in DEFORMERS and t:
            out.append(t)
        if m.type in ('SURFACE_DEFORM', 'SHRINKWRAP') and getattr(m, 'target', None):
            out.append(m.target)
    for c in o.constraints:
        t = getattr(c, 'target', None)
        if t and not c.mute:
            out.append(t)
    return out


def armatures_moving(o, seen=None):
    seen = seen if seen is not None else set()
    if o in seen:
        return set()
    seen.add(o)
    out = set()
    for t in movers(o):
        if t.type == 'ARMATURE':
            out.add(t)
        out |= armatures_moving(t, seen)
    return out


def top_armature(a):
    p, top = a.parent, a
    while p is not None:
        if p.type == 'ARMATURE':
            top = p
        p = p.parent
    return top


def pick_character(objs):
    """The armature that moves the most visible mesh, its helper armatures and the meshes."""
    meshes = [o for o in objs if renders_as_mesh(o)]
    visible = [o for o in meshes if o.visible_get()]
    if visible:
        meshes = visible
    # Meshes used as deform cages or collision shapes are helpers, not part of the look.
    cages = set()
    for o in meshes:
        for m in o.modifiers:
            if m.type in DEFORMERS and getattr(m, 'object', None) and m.object.type == 'MESH':
                cages.add(m.object)
    meshes = [o for o in meshes if o not in cages]
    groups = {}
    for o in meshes:
        for a in {top_armature(a) for a in armatures_moving(o)}:
            groups.setdefault(a, []).append(o)
    if not groups:
        return None, [], meshes
    main = max(sorted(groups, key=lambda a: a.name), key=lambda a: sum(len(o.data.vertices) for o in groups[a]))
    chosen = groups[main]
    family = sorted({a for o in chosen for a in armatures_moving(o) if top_armature(a) == main}, key=lambda a: (a != main, a.name))
    others = [a.name for a in groups if a != main]
    if others:
        log(f'character: armature "{main.name}" ({len(chosen)} meshes); also in the file: ' + ', '.join(others))
    return main, family, chosen


def evaluable(objs):
    """Make sure the dependency graph evaluates these objects (hidden ones are skipped)."""
    vl = bpy.context.view_layer
    scene_coll = bpy.context.scene.collection
    for o in objs:
        if o.name not in vl.objects:
            scene_coll.objects.link(o)
        o.hide_viewport = False
        for c in o.users_collection:
            c.hide_viewport = False

    def walk(lc):
        if lc.exclude and any(o in objs for o in lc.collection.all_objects):
            lc.exclude = False
        lc.hide_viewport = False
        for ch in lc.children:
            walk(ch)
    walk(vl.layer_collection)
    vl.update()
    for o in objs:
        if o.name in vl.objects:
            o.hide_set(False)


def closure(meshes):
    """The meshes plus every object that moves them (recursively)."""
    out, todo = set(), list(meshes)
    while todo:
        o = todo.pop()
        if o in out:
            continue
        out.add(o)
        todo += movers(o)
        # Children of armatures in the family can be moved by them too (bone parents).
    return out


# ------------------------------------------------------------------ rig state

class RigState:
    """Puts the rig into a neutral, inspectable state and back: no action, constraints and
    drivers of the armatures muted, every pose bone at rest."""

    def __init__(self, family):
        self.family = family
        self.saved = []

    def neutral(self):
        for a in self.family:
            ad = a.animation_data
            s = {'arm': a, 'action': None, 'nla': [], 'drivers': [], 'cons': [], 'pose': {}, 'pose_position': a.data.pose_position}
            if ad:
                s['action'] = ad.action
                ad.action = None
                for t in ad.nla_tracks:
                    s['nla'].append((t, t.mute))
                    t.mute = True
            for owner in (a, a.data):
                if owner.animation_data:
                    for fc in owner.animation_data.drivers:
                        s['drivers'].append((fc, fc.mute))
                        fc.mute = True
            for pb in a.pose.bones:
                s['pose'][pb.name] = pb.matrix_basis.copy()
                pb.matrix_basis = Matrix()
                for c in pb.constraints:
                    s['cons'].append((c, c.mute))
                    c.mute = True
            a.data.pose_position = 'POSE'
            self.saved.append(s)
        bpy.context.view_layer.update()

    def restore(self):
        for s in self.saved:
            a = s['arm']
            for c, m in s['cons']:
                c.mute = m
            for fc, m in s['drivers']:
                fc.mute = m
            for t, m in s['nla']:
                t.mute = m
            if a.animation_data:
                a.animation_data.action = s['action']
            for n, mb in s['pose'].items():
                a.pose.bones[n].matrix_basis = mb
            a.data.pose_position = s['pose_position']
        self.saved = []
        bpy.context.view_layer.update()


def edit_mode(arm):
    bpy.context.view_layer.objects.active = arm
    for o in bpy.context.view_layer.objects:
        o.select_set(o == arm)
    bpy.ops.object.mode_set(mode='EDIT')


def object_mode():
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')


def unparent_bones(arm):
    """Detach every bone from its parent (rest unchanged); returns what to restore."""
    edit_mode(arm)
    saved = {}
    for eb in arm.data.edit_bones:
        saved[eb.name] = (eb.parent.name if eb.parent else None, eb.use_connect)
        eb.use_connect = False
        eb.parent = None
    object_mode()
    return saved


def reparent_bones(arm, saved):
    edit_mode(arm)
    eb = arm.data.edit_bones
    for n, (p, conn) in saved.items():
        if n in eb:
            eb[n].parent = eb[p] if p and p in eb else None
            eb[n].use_connect = conn
    object_mode()


# ------------------------------------------------------------------ measuring the rig

def mesh_coords(objs):
    """World-space vertex positions of the evaluated meshes."""
    dg = bpy.context.evaluated_depsgraph_get()
    out = []
    for o in objs:
        eo = o.evaluated_get(dg)
        me = eo.data
        n = len(me.vertices)
        co = np.empty(n * 3, dtype=np.float64)
        me.vertices.foreach_get('co', co)
        co = co.reshape(n, 3)
        mw = np.array(eo.matrix_world)
        out.append(co @ mw[:3, :3].T + mw[:3, 3])
    return out


def probe_bones(family, meshes):
    """Bones that can move the meshes: weighted deform bones of armature modifiers on the
    meshes and their cages / lattices, and bones that objects are parented or constrained to."""
    objs = closure(meshes)
    wanted = {a: set() for a in family}
    for o in objs:
        if o.type in ('MESH', 'LATTICE'):
            # All groups, not only those with weight: a Mirror modifier fills the other
            # side's groups (".R" from ".L") only after the mesh is evaluated.
            used = {g.name for g in o.vertex_groups}
            for m in o.modifiers:
                if m.type == 'ARMATURE' and m.object in wanted:
                    bones = m.object.data.bones
                    if m.use_vertex_groups:
                        wanted[m.object] |= {n for n in used if n and n in bones and bones[n].use_deform}
                    if m.use_bone_envelopes:
                        wanted[m.object] |= {b.name for b in bones if b.use_deform}
        if o.parent in wanted and o.parent_type == 'BONE' and o.parent_bone in o.parent.data.bones:
            wanted[o.parent].add(o.parent_bone)
        for c in o.constraints:
            if getattr(c, 'target', None) in wanted and getattr(c, 'subtarget', '') in c.target.data.bones and not c.mute:
                wanted[c.target].add(c.subtarget)
    return [(a, n) for a in family for n in sorted(wanted[a])]


def measure_weights(family, meshes, height):
    """Each vertex's weight per bone, by moving bones one axis at a time: with constraints
    off and bones unparented, a vertex moves by w * t when its bone moves by t, whatever the
    mechanism in between (armature, cage, lattice, bone parent, second armature)."""
    probes = probe_bones(family, meshes)
    log(f'measuring weights: {len(probes)} bones, {sum(len(o.data.vertices) for o in meshes)} vertices before modifiers')
    saved = {a: unparent_bones(a) for a in family}
    bpy.context.view_layer.update()
    rest = mesh_coords(meshes)
    t = max(height, 1e-6) * 0.002
    weights = [dict() for _ in meshes]  # per mesh: probe -> (idx, w)
    # One bone at a time: effects like Corrective Smooth work in the surface's own frame and
    # would mix up the axes if several bones moved at once.
    axis = Vector((0.5773, 0.5774, 0.5773)).normalized()
    ax = np.array(axis)
    for i, (a, n) in enumerate(probes):
        pb = a.pose.bones[n]
        m = (a.matrix_world @ a.data.bones[n].matrix_local).to_3x3()
        pb.matrix_basis = Matrix.Translation(m.inverted_safe() @ (axis * t))
        bpy.context.view_layer.update()
        now = mesh_coords(meshes)
        if os.environ.get('AVATAR_DEBUG') and i % 50 == 0:
            log(f'  probe {i}/{len(probes)}')
        pb.matrix_basis = Matrix()
        for mi, (r, c) in enumerate(zip(rest, now)):
            if len(c) != len(r):
                raise ConversionError(f'mesh "{meshes[mi].name}" changes its vertex count when the rig moves (a modifier like Weld or Remesh); it cannot be skinned')
            w = ((c - r) @ ax) / t
            idx = np.nonzero(np.abs(w) > 2e-3)[0]
            if len(idx):
                weights[mi][(a.name, n)] = (idx, w[idx])
    for a in family:
        a.pose.bones.foreach_set('matrix_basis', [x for pb in a.pose.bones for x in (1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)])
        reparent_bones(a, saved[a])
    bpy.context.view_layer.update()
    return probes, weights, rest


# ------------------------------------------------------------------ skeleton

PREFIX = re.compile(r'^(DEF|ORG|MCH|CTRL|CTL|INT|IK|FK|TGT|MSTR|DEF_|DEF\.)[-_.]', re.I)


def base_name(n):
    n = re.sub(r'^mixamorig\d*[:_]', '', n, flags=re.I)
    while PREFIX.match(n):
        n = PREFIX.sub('', n, count=1)
    return n


class Bone:
    """One bone of the rebuilt skeleton (a class of bones of the rig that move together)."""

    def __init__(self, key, arm):
        self.key, self.arm = key, arm
        self.members = [key]
        self.name = key[1]
        b = arm.data.bones[key[1]]
        mw = arm.matrix_world
        self.head = mw @ b.head_local
        self.tail = mw @ b.tail_local
        self.zaxis = ((mw.to_3x3() @ b.matrix_local.to_3x3()) @ Vector((0, 0, 1))).normalized()
        self.mass = 0.0
        self.parent = None
        self.children = []
        self.role = None

    @property
    def length(self):
        return (self.tail - self.head).length


def strong_target(arm, n):
    """Bone this one copies its whole transform from, if any (Rigify DEF-x copies ORG-x)."""
    pb = arm.pose.bones[n]
    loc = rot = None
    for c, _ in [(c, None) for c in pb.constraints]:
        if c.mute or c.influence < 0.99 or getattr(c, 'target', None) != arm or not getattr(c, 'subtarget', ''):
            continue
        if c.type in ('COPY_TRANSFORMS', 'CHILD_OF', 'ARMATURE'):
            return c.subtarget
        if c.type == 'COPY_LOCATION':
            loc = c.subtarget
        if c.type == 'COPY_ROTATION':
            rot = c.subtarget
    return loc if loc and loc == rot else None


def build_classes(family, probes, weights, rest, height):
    """Merge bones that move together, keep the ones that carry weight."""
    tol = height * 0.01
    parent = {}

    def find(k):
        while parent.get(k, k) != k:
            k = parent[k]
        return k

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for a in family:
        bones = a.data.bones
        by_base = {}
        for b in bones:
            by_base.setdefault(base_name(b.name), []).append(b)
            t = strong_target(a, b.name)
            if t and t in bones and (bones[t].head_local - b.head_local).length * a.matrix_world.median_scale < tol:
                union((a.name, t), (a.name, b.name))
        for lst in by_base.values():
            for b in lst[1:]:
                b0 = lst[0]
                if (b.head_local - b0.head_local).length * a.matrix_world.median_scale < tol and (b.tail_local - b0.tail_local).length * a.matrix_world.median_scale < tol:
                    union((a.name, b0.name), (a.name, b.name))
    # Weight mass per probe.
    mass = {}
    for wm in weights:
        for k, (idx, w) in wm.items():
            mass[k] = mass.get(k, 0.0) + float(np.clip(w, 0, None).sum())
    arms = {a.name: a for a in family}
    classes = {}
    for k in mass:
        classes.setdefault(find(k), []).append(k)
    # Bones without weight that hold the weighted ones together are kept too, they make the
    # chains readable: deform bones above weighted ones (an unweighted hand above the
    # fingers) and any bone two or more kept bones hang on (a control thigh carrying the
    # deforming muscle helpers, a root carrying hips and spine).
    changed = True
    while changed:
        changed = False
        for a in family:
            for b in a.data.bones:
                k = (a.name, b.name)
                if find(k) in classes:
                    continue
                kept_kids = {find((a.name, c.name)) for c in b.children if find((a.name, c.name)) in classes}
                if (b.use_deform and any(find((a.name, c.name)) in classes for c in b.children_recursive)) or len(kept_kids) >= 2:
                    classes.setdefault(find(k), []).append(k)
                    changed = True
    out = {}
    for root, keys in classes.items():
        members = [k for k in keys]
        # Every rig bone in the class (also the weightless twins) for hierarchy lookups.
        for a in family:
            for b in a.data.bones:
                k = (a.name, b.name)
                if find(k) == root and k not in members:
                    members.append(k)

        def score(k):
            b = arms[k[0]].data.bones[k[1]]
            return (mass.get(k, 0.0) > 0, b.use_deform, k[1].upper().startswith('DEF'), mass.get(k, 0.0))
        rep = max(members, key=score)
        bone = Bone(rep, arms[rep[0]])
        bone.members = members
        bone.mass = sum(mass.get(k, 0.0) for k in members)
        bone.weighted = bone.mass > 0
        out[rep] = bone
    owner = {}
    for rep, bone in out.items():
        for k in bone.members:
            owner[k] = bone
    return out, owner, mass


def rig_parent_chain(arms, key):
    """Bones above key in the rig, nearest first; a helper armature continues at the bone
    its object hangs on."""
    a = arms[key[0]]
    b = a.data.bones[key[1]].parent
    while True:
        while b is not None:
            yield (a.name, b.name)
            b = b.parent
        if a.parent and a.parent.name in arms and a.parent_type == 'BONE' and a.parent_bone:
            p = arms[a.parent.name]
            a, b = p, p.data.bones.get(a.parent_bone)
            continue
        return


def build_tree(bones, owner, arms, height):
    """Parent of each kept bone: the kept bone it follows in the rig (through its parents
    and those of its twins); a bone whose head sits at the tail of a kept bone further down
    that branch hangs there instead (IK hands parented to the chest)."""
    tol = height * 0.02
    for bone in bones.values():
        best = None
        for k in sorted(bone.members, key=lambda k: (k != bone.key, not arms[k[0]].data.bones[k[1]].use_deform)):
            for anc in rig_parent_chain(arms, k):
                o = owner.get(anc)
                if o is not None and o is not bone:
                    best = o
                    break
            if best:
                break
        bone.parent = best

    def ancestors(b):
        seen = []
        p = b.parent
        while p is not None and p not in seen:
            seen.append(p)
            p = p.parent
        return seen

    # Spatial refinement down the same branch.
    for bone in bones.values():
        cands = [q for q in bones.values() if q is not bone and (q.tail - bone.head).length < tol]
        cands = [q for q in cands if bone not in ancestors(q) and (bone.parent is None or bone.parent in ancestors(q) or q is bone.parent)]
        # Only where the bone continues that bone's line (a hand after a forearm), not a
        # side branch that happens to start there.
        d = (bone.tail - bone.head).normalized()
        cands = [q for q in cands if (q.tail - q.head).length > 1e-9 and (q.tail - q.head).normalized().dot(d) > 0.5]
        if cands:
            q = min(cands, key=lambda q: ((q.tail - bone.head).length, -len(ancestors(q))))
            if q is not bone.parent:
                bone.parent = q
    for bone in bones.values():
        bone.children = []
    for bone in bones.values():
        if bone.parent:
            bone.parent.children.append(bone)


def subtree(b):
    out, todo = [], [b]
    while todo:
        x = todo.pop()
        out.append(x)
        todo += x.children
    return out


# ------------------------------------------------------------------ humanoid mapping

REQUIRED = ['Hips', 'Spine', 'Head'] + [s + c for s in ('Left', 'Right') for c in ('UpperArm', 'LowerArm', 'Hand', 'UpperLeg', 'LowerLeg', 'Foot')]
OPTIONAL = ['Chest', 'Neck', 'LeftShoulder', 'RightShoulder', 'LeftToes', 'RightToes']

# Words for each body part (English, Spanish, German, French, Italian, Portuguese, common rig names).
WORDS = [
    ('Hips', False, r'hips?|pelvis|root_?hips|cadera|caderas|becken|huefte|hufte|hüfte|bassin|hanches?|bacino|anca|quadril'),
    ('Spine', False, r'spine|abdomen|waist|lower_?back|columna|espina|wirbels(ae|ä)ule|ruecken|rücken|colonne|spina|colonna|coluna|torso'),
    ('Chest', False, r'chest|ribs|ribcage|thorax|upper_?back|pecho|torax|tórax|brust|brustkorb|poitrine|thorax|petto|torace|peito'),
    ('Neck', False, r'neck|cuello|hals|nacken|cou|collo|pesco(c|ç)o'),
    ('Head', False, r'head|cabeza|kopf|t(e|ê)te|testa|cabe(c|ç)a'),
    ('Shoulder', True, r'shoulder|clavicle|collar(_?bone)?|hombro|clav(i|í)cula|schulter|schl(ue|ü)sselbein|(e|é)paule|clavicule|spalla|clavicola|ombro'),
    ('UpperArm', True, r'upper_?arm|up_?arm|arm|humerus|brazo|oberarm|bras|braccio|bra(c|ç)o'),
    ('LowerArm', True, r'fore_?arm|lower_?arm|low_?arm|elbow|antebrazo|unterarm|avant_?bras|avambraccio|antebra(c|ç)o'),
    ('Hand', True, r'hand|wrist|palm|mano|handgelenk|main|poignet|polso|m(a|ã)o|pulso|mu(n|ñ)eca'),
    ('UpperLeg', True, r'thigh|upper_?leg|up_?leg|femur|muslo|antepierna|oberschenkel|cuisse|coscia|coxa'),
    ('LowerLeg', True, r'shin|calf|lower_?leg|low_?leg|leg|knee|tibia|pierna|unterschenkel|bein|knie|jambe|gamba|perna|canela'),
    ('Foot', True, r'foot|ankle|pie|fu(ss|ß)|knoechel|pied|cheville|piede|caviglia|p(e|é)|tobillo'),
    ('Toes', True, r'toes?|toe_?base|ball|dedos?(_?pie)?|zehen?|orteils?|dita|dedos?_?(do_?)?p(e|é)'),
]


def parse_name(n):
    """Base words, side ('Left'/'Right'/None) and segment number of a bone name."""
    n = base_name(n)
    n = re.sub(r'^(bip0?\d*|cc_base|character\d*|armature|bone)[ _.:|]', '', n, flags=re.I)
    side = None
    m = re.match(r'^j_(?:bip|adj|sec)_([lrc])_(.*)$', n, re.I)
    if m:
        side = {'l': 'Left', 'r': 'Right'}.get(m.group(1).lower())
        n = m.group(2)
    seg = 0
    m = re.match(r'^(.*?)[._-]?(\d+)$', n)
    if m and m.group(1):
        n, seg = m.group(1), int(m.group(2))
    if side is None:
        for rx, s in ((r'^(.*?)[._ -]?([LR])$', None), (r'^([LR])[._ -](.*)$', 'pre')):
            m = re.match(rx, n)
            if m:
                letter, rest = (m.group(2), m.group(1)) if s is None else (m.group(1), m.group(2))
                side = 'Left' if letter == 'L' else 'Right'
                n = rest
                break
    if side is None:
        m = re.match(r'^(.+?)[._ -]([lr])$', n)
        if m:
            side, n = ('Left' if m.group(2) == 'l' else 'Right'), m.group(1)
    if side is None:
        m = re.search(r'(left|right|links|rechts|izquierd[oa]|derech[oa]|gauche|droite|sinistr[oa]|destr[oa]|esquerd[oa]|direit[oa])', n, re.I)
        if m:
            w = m.group(1).lower()
            side = 'Left' if w.startswith(('left', 'links', 'izq', 'gauche', 'sinistr', 'esquerd')) else 'Right'
            n = (n[:m.start()] + n[m.end():])
    if seg == 0:
        m = re.match(r'^(.*?)[._-]?(\d+)$', n)
        if m and m.group(1):
            n, seg = m.group(1), int(m.group(2))
    n = re.sub(r'([a-z])([A-Z])', r'\1_\2', n).lower()
    n = re.sub(r'[ .\-:|]+', '_', n).strip('_')
    return n, side, seg


def map_by_names(bones):
    """Body bones from names (several languages, Rigify's numbered spine)."""
    parsed = {b: parse_name(b.name) for b in bones}
    found = {}
    # Rigify numbers its torso from the pelvis: spine = hips ... spine.006 = head.
    spine = {seg: b for b, (n, s, seg) in parsed.items() if n == 'spine' and s is None}
    if 0 in spine and 6 in spine and not any(n in ('hips', 'head') for n, _, _ in parsed.values()):
        found = {'Hips': spine[0], 'Spine': spine.get(1), 'Chest': spine.get(2), 'Neck': spine.get(4), 'Head': spine[6]}
        found = {k: v for k, v in found.items() if v}
    for canon, sided, rx in WORDS:
        for side in (('Left', 'Right') if sided else (None,)):
            key = (side or '') + canon
            if key in found:
                continue
            hits = [b for b, (n, s, seg) in parsed.items() if s == side and re.fullmatch(rx, n) and b not in found.values()]
            if not hits:
                continue
            # The first segment (closest to the body), then the biggest.
            pick = min(hits, key=lambda b: (not b.weighted, parsed[b][2], -b.mass))
            found[key] = pick
    # A spine split into several bones without a "chest": the top one is the chest.
    if 'Chest' not in found and 'Spine' in found:
        sp = [b for b, (n, s, seg) in parsed.items() if s is None and re.fullmatch(WORDS[1][2], n) and b is not found.get('Hips')]
        if len(sp) >= 2:
            found['Spine'] = min(sp, key=lambda b: b.head.z)
            top = max(sp, key=lambda b: b.head.z)
            if top is not found['Spine']:
                found['Chest'] = top
    return found


def joints_of(chain):
    return [b.head for b in chain]


def chain_down(b, key):
    out = [b]
    while out[-1].children:
        out.append(max(out[-1].children, key=key))
    return out


def map_by_shape(bones, height, floor, cx):
    """Body bones from the skeleton's shape: hips where two legs branch, chest where both
    arms branch, limb joints from the bone lengths."""
    tol = height * 0.03
    sub = {b: subtree(b) for b in bones}
    low = {b: min(min(x.head.z, x.tail.z) for x in sub[b]) for b in bones}
    high = {b: max(max(x.head.z, x.tail.z) for x in sub[b]) for b in bones}
    side_reach = {b: max(abs(x.tail.x - cx) for x in sub[b]) for b in bones}
    found, notes = {}, []
    # Hips: the deepest bone with two child branches reaching the floor on both sides.
    hips, legs = None, None
    for b in bones:
        down = [c for c in b.children if low[c] < floor + 0.15 * height and low[c] < b.head.z - 0.25 * height]
        if len(down) < 2:
            continue
        down.sort(key=lambda c: low[c])
        pair = None
        for i in range(len(down)):
            for j in range(i + 1, len(down)):
                xi = sum(x.head.x for x in sub[down[i]]) / len(sub[down[i]]) - cx
                xj = sum(x.head.x for x in sub[down[j]]) / len(sub[down[j]]) - cx
                if xi * xj < 0:
                    pair = (down[i], down[j])
                    break
            if pair:
                break
        if pair and (hips is None or len(sub[b]) < len(sub[hips])):
            hips, legs = b, pair
    if not hips:
        return {}, ['no hips (no bone where two legs branch)']
    found['Hips'] = hips
    # Spine: the branch going up from the hips, or a twin root starting at the same point.
    ups = [c for c in hips.children if c not in legs and high[c] > hips.head.z + 0.25 * height]
    near = [b for b in bones if b not in sub[hips] and b.parent is not None and b.parent not in sub[hips] and (b.head - hips.head).length < tol and high[b] > hips.head.z + 0.25 * height]
    near += [b for b in bones if b.parent is None and b is not hips and (b.head - hips.head).length < tol * 2]
    if hips.parent is not None:
        near += [c for c in hips.parent.children if c is not hips and high[c] > hips.head.z + 0.25 * height and (c.head - hips.head).length < tol * 3]
    above = set()
    p = hips.parent
    while p is not None:
        above.add(p)
        p = p.parent
    cands = [c for c in ups + near if c not in above]
    if not cands:
        return found, ['no spine above the hips']
    spine_root = max(cands, key=lambda b: len(sub[b]))
    # Chest: the first bone up the spine with an arm branch on each side.
    chain, chest, arms = [], None, None
    b = spine_root
    for _ in range(12):
        chain.append(b)
        lat = [c for c in b.children if side_reach[c] > 0.15 * height and high[c] < high[b] + tol and min(abs(x.head.x - cx) for x in sub[c]) < 0.25 * height]
        left = [c for c in lat if sum(x.head.x for x in sub[c]) / len(sub[c]) > cx]
        right = [c for c in lat if sum(x.head.x for x in sub[c]) / len(sub[c]) < cx]
        if left and right:
            chest, arms = b, (max(left, key=lambda c: side_reach[c]), max(right, key=lambda c: side_reach[c]))
            break
        rest = [c for c in b.children if high[c] >= high[b] - tol]
        if not rest:
            break
        b = max(rest, key=lambda c: len(sub[c]))
    if not chest:
        return found, ['no chest (no bone where both arms branch)']
    found['Spine'] = chain[0]
    if chest is not chain[0]:
        found['Chest'] = chest
    # Neck and head: the branch of the chest reaching highest.
    ups = [c for c in chest.children if c not in arms and high[c] > chest.head.z]
    if ups:
        top = max(ups, key=lambda c: high[c])
        nc = chain_down(top, key=lambda c: high[c])
        nc = [x for x in nc if x.head.z >= top.head.z - tol]
        if len(nc) >= 2:
            found['Neck'] = nc[0]
            found['Head'] = max(nc[1:4], key=lambda x: x.mass)
        else:
            found['Head'] = nc[0]
    leg_chains = [chain_down(l, key=lambda c: -low[c]) for l in legs]

    def foot_index(lc):
        """The first low bone that runs more forward than down."""
        for i, x in enumerate(lc):
            d = x.tail - x.head
            if i >= 2 and x.head.z < floor + 0.15 * height and abs(d.z) < 0.8 * d.length:
                return i
        cand = [i for i, x in enumerate(lc) if i >= 2 and x.head.z < floor + 0.15 * height]
        return cand[0] if cand else None
    # Facing: feet point forward (Blender's default front, -Y, if they do not say);
    # the character's left is up x forward.
    fwd = Vector((0, 0, 0))
    for lc in leg_chains:
        fi = foot_index(lc)
        if fi is not None:
            fwd += lc[fi].tail - lc[fi].head
    fwd.z = 0
    fwd = fwd.normalized() if fwd.length > 1e-6 else Vector((0, -1, 0))
    left_dir = Vector((0, 0, 1)).cross(fwd)

    def side_of(chain):
        p = chain[-1].tail
        return 'Left' if (p.x - hips.head.x) * left_dir.x + (p.y - hips.head.y) * left_dir.y > 0 else 'Right'

    def limb(chain, ratio, end_index):
        """Pick (upper start, lower start) joints by the bone-length ratio."""
        J = [b.head for b in chain]
        e_end = J[end_index]
        best = None
        for s in range(0, end_index - 1):
            for e in range(s + 1, end_index):
                up = (J[e] - J[s]).length
                lo = (e_end - J[e]).length
                if up < 0.05 * height or lo < 0.05 * height:
                    continue
                r = up / lo
                if not (0.6 < r < 1.7):
                    continue
                # Joints between must lie on the straight line (no detour through a clavicle).
                def straight(a, b, js):
                    d = (b - a)
                    for j in js:
                        t = max(0.0, min(1.0, (j - a).dot(d) / d.length_squared))
                        if (a + d * t - j).length > 0.15 * d.length:
                            return False
                    return True
                if not straight(J[s], J[e], J[s + 1:e]) or not straight(J[e], e_end, J[e + 1:end_index]):
                    continue
                score = abs(math.log(r / ratio))
                if best is None or score < best[0] - 1e-9 or (abs(score - best[0]) < 0.08 and s > best[1]):
                    best = (score, s, e)
        return best

    for lc in leg_chains:
        side = side_of(lc)
        fi = foot_index(lc)
        if fi is None:
            notes.append(f'{side} leg: no foot')
            continue
        r = limb(lc, 1.05, fi)
        if not r:
            notes.append(f'{side} leg: no knee')
            continue
        _, s, e = r
        found[side + 'UpperLeg'], found[side + 'LowerLeg'], found[side + 'Foot'] = lc[s], lc[e], lc[fi]
        if fi + 1 < len(lc) and lc[fi + 1].head.z < floor + 0.1 * height:
            found[side + 'Toes'] = lc[fi + 1]
    for a in arms:
        ac = chain_down(a, key=lambda c: side_reach[c])
        side = side_of(ac)
        # Wrist: the first bone past the shoulder region that fans out into fingers.
        wi = None
        for i, x in enumerate(ac):
            if i >= 2 and sum(1 for c in x.children if c.children) >= 2:
                wi = i
                break
        if wi is None:
            wi = len(ac) - 1
        r = limb(ac, 1.15, wi)
        if not r:
            notes.append(f'{side} arm: no elbow')
            continue
        _, s, e = r
        found[side + 'UpperArm'], found[side + 'LowerArm'], found[side + 'Hand'] = ac[s], ac[e], ac[wi]
        if s >= 1:
            found[side + 'Shoulder'] = ac[s - 1]
    return found, notes


def check_body(found, height, floor, cx):
    """Plausibility of a mapping (Blender Z-up world). Returns a list of problems."""
    probs = [f'{k} missing' for k in REQUIRED if k not in found]
    if probs:
        return probs
    if len(set(found.values())) != len(found):
        return ['one bone used for two body parts']
    g = lambda k: found[k].head
    if g('Head').z < g('Hips').z + 0.2 * height:
        probs.append('head not well above the hips')
    for s in ('Left', 'Right'):
        if not (g(s + 'UpperLeg').z > g(s + 'LowerLeg').z + 0.1 * height > g(s + 'Foot').z + 0.1 * height):
            probs.append(f'{s} leg joints not in order (hip above knee above ankle)')
        if g(s + 'Foot').z > floor + 0.25 * height:
            probs.append(f'{s} foot far above the ground')
        u, l, h = g(s + 'UpperArm'), g(s + 'LowerArm'), g(s + 'Hand')
        if (h - u).length < (l - u).length + 0.05 * height:
            probs.append(f'{s} hand not beyond the elbow')
        if u.z < g('Hips').z:
            probs.append(f'{s} shoulder below the hips')
    sx = lambda k: found[k].head.x - cx
    if sx('LeftUpperArm') * sx('RightUpperArm') >= 0 or sx('LeftUpperLeg') * sx('RightUpperLeg') >= 0:
        probs.append('left and right limbs on the same side')
    elif sx('LeftUpperArm') * sx('LeftUpperLeg') < 0:
        probs.append('left arm and left leg on different sides')
    return probs


# Body hierarchy the game expects: bone -> parents to try, in order.
BODY_PARENT = {
    'Spine': ['Hips'], 'Chest': ['Spine'], 'Neck': ['Chest', 'Spine'], 'Head': ['Neck', 'Chest', 'Spine'],
    'LeftShoulder': ['Chest', 'Spine'], 'RightShoulder': ['Chest', 'Spine'],
    'LeftUpperArm': ['LeftShoulder', 'Chest', 'Spine'], 'RightUpperArm': ['RightShoulder', 'Chest', 'Spine'],
    'LeftLowerArm': ['LeftUpperArm'], 'RightLowerArm': ['RightUpperArm'], 'LeftHand': ['LeftLowerArm'], 'RightHand': ['RightLowerArm'],
    'LeftUpperLeg': ['Hips'], 'RightUpperLeg': ['Hips'], 'LeftLowerLeg': ['LeftUpperLeg'], 'RightLowerLeg': ['RightUpperLeg'],
    'LeftFoot': ['LeftLowerLeg'], 'RightFoot': ['RightLowerLeg'], 'LeftToes': ['LeftFoot'], 'RightToes': ['RightFoot'],
}


def seg_dist(p, a, b):
    d = b - a
    if d.length_squared < 1e-12:
        return (p - a).length
    t = max(0.0, min(1.0, (p - a).dot(d) / d.length_squared))
    return (a + d * t - p).length


def apply_body(bones, found):
    """Name the body bones and hang them in the body hierarchy; other bones keep the parent
    they follow in the rig. Loose bones go under the nearest body bone."""
    for k, b in found.items():
        b.role = k
    for k, b in found.items():
        if k == 'Hips':
            b.parent = None
            continue
        for p in BODY_PARENT.get(k, []):
            if p in found:
                b.parent = found[p]
                break
    hips = found.get('Hips')

    def ancestors(b):
        seen, p = [], b.parent
        while p is not None and p not in seen:
            seen.append(p)
            p = p.parent
        return seen
    body = list(found.values())
    for b in bones.values():
        if b.role:
            continue
        anc = ancestors(b)
        if b in anc:  # cycle
            b.parent = None
            anc = []
        if b.parent is None or (hips and hips not in anc):
            pool = body or [x for x in bones.values() if x is not b]
            pool = [x for x in pool if b not in ancestors(x) and x is not b]
            if pool:
                b.parent = min(pool, key=lambda x: seg_dist(b.head, x.head, x.tail))
    for b in bones.values():
        b.children = []
    for b in bones.values():
        if b.parent:
            b.parent.children.append(b)


AIMING = ('STRETCH_TO', 'DAMPED_TRACK', 'TRACK_TO', 'LOCKED_TRACK', 'IK')
BLENDING = ('COPY_ROTATION', 'COPY_TRANSFORMS', 'CHILD_OF', 'ARMATURE')


def read_constraints(family):
    """The rig's active bone constraints (read before the rig is put to rest): per bone a
    list of (kind, [(armature, bone, share)], point) where point is the aimed-at spot."""
    arms = {a.name for a in family}
    out = {}
    for a in family:
        for pb in a.pose.bones:
            lst = []
            for c in pb.constraints:
                if c.mute or c.influence <= 0.01:
                    continue
                if c.type == 'ARMATURE':
                    tg = [(t.target.name, t.subtarget, t.weight * c.influence) for t in c.targets if t.target and t.target.name in arms and t.subtarget]
                    if tg:
                        lst.append(('blend', tg, None))
                    continue
                t = getattr(c, 'target', None)
                sub = getattr(c, 'subtarget', '')
                if not t or t.name not in arms or not sub or sub not in t.data.bones:
                    continue
                if c.type in AIMING:
                    if c.type == 'IK' and getattr(c, 'chain_count', 0) != 1:
                        continue
                    tb = t.data.bones[sub]
                    ht = getattr(c, 'head_tail', 0.0)
                    point = t.matrix_world @ (tb.head_local + (tb.tail_local - tb.head_local) * ht)
                    lst.append(('aim', [(t.name, sub, c.influence)], point))
                elif c.type in BLENDING and c.influence < 0.99:
                    lst.append(('blend', [(t.name, sub, c.influence)], None))
            if lst:
                out[(a.name, pb.name)] = lst
    return out


def helper_spans(bones, owner, arms, cons, found, height):
    """For helper bones (not body bones) that the rig stretches or turns towards another
    bone: which kept bone their far end / their share follows."""
    body = list(found.values())

    def resolve(key):
        o = owner.get(key)
        if o is not None:
            return o
        for anc in rig_parent_chain(arms, key):
            o = owner.get(anc)
            if o is not None:
                return o
        return None

    spans = []
    for h in bones.values():
        if h.role:
            continue
        infos = []
        for m in h.members:
            for kind, targets, point in cons.get(m, []):
                if any(owner.get((t[0], t[1])) is h for t in targets):
                    continue
                infos.append((kind, targets, point))
        if not infos:
            continue
        aim = next((i for i in infos if i[0] == 'aim'), None)
        if aim:
            _, targets, point = aim
            near = max(0.6 * h.length, 0.04 * height)
            r = resolve((targets[0][0], targets[0][1]))
            if r is None or r is h or seg_dist(point, r.head, r.tail) > near:
                cand = [b for b in body if b is not h]
                r = min(cand, key=lambda b: seg_dist(point, b.head, b.tail)) if cand else None
                if r is None or seg_dist(point, r.head, r.tail) > near:
                    r = None
            if r is not None and (h.tail - point).length < max(0.5 * h.length, 0.04 * height):
                spans.append((h, 'aim', r))
            continue
        parts = []
        for kind, targets, point in infos:
            for an, bn, f in targets:
                r = resolve((an, bn))
                if r is None or r is h or seg_dist(h.head, r.head, r.tail) > 0.3 * height:
                    continue
                parts.append((r, f))
        tot = sum(f for _, f in parts)
        if parts and tot > 0:
            if tot > 1:
                parts = [(r, f / tot) for r, f in parts]
            spans.append((h, 'blend', parts))
    if spans:
        log(f'helper bones shared with their neighbours: {len(spans)}')
    return spans


def prune(bones, owner):
    """Drop weightless leaf bones that are not body bones (IK targets, mechanism chains)."""
    changed = True
    while changed:
        changed = False
        for k, b in list(bones.items()):
            if not b.children and not b.weighted and not b.role:
                if b.parent:
                    b.parent.children.remove(b)
                del bones[k]
                for m in b.members:
                    if owner.get(m) is b:
                        del owner[m]
                changed = True


# ------------------------------------------------------------------ building the result

def bake_meshes(meshes, G):
    """New mesh objects with the evaluated rest shape (modifiers applied), in G-space."""
    dg = bpy.context.evaluated_depsgraph_get()
    out = []
    for o in meshes:
        eo = o.evaluated_get(dg)
        me = bpy.data.meshes.new_from_object(eo, preserve_all_data_layers=True, depsgraph=dg)
        mw = G @ eo.matrix_world
        me.transform(mw)
        if mw.determinant() < 0:
            me.flip_normals()
        name = o.name
        o.name = name + '~rig'
        me.name = name
        n = bpy.data.objects.new(name, me)
        n.vertex_groups.clear()  # the rig's groups; the measured weights replace them
        if me.shape_keys:
            n.shape_key_clear()
        out.append(n)
    return out


def unique_names(bones, found):
    used = set(found)
    for b in bones.values():
        if b.role:
            b.out_name = b.role
            continue
        n = b.name if b.key[0] == list(bones.values())[0].key[0] or True else b.name
        n = re.sub(r'[^\w.\-]', '_', n) or 'bone'
        base, i = n, 1
        while n in used:
            i += 1
            n = f'{base}.{i:03d}'
        used.add(n)
        b.out_name = n


def build_armature(bones, G, name):
    data = bpy.data.armatures.new(name)
    arm = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(arm)
    edit_mode(arm)
    eb = data.edit_bones
    made = {}
    G3 = G.to_3x3()
    for b in bones.values():
        e = eb.new(b.out_name)
        e.head = G @ b.head
        tail = G @ b.tail
        if (tail - e.head).length < 1e-5:
            tail = e.head + Vector((0, 0, 0.01))
        e.tail = tail
        e.align_roll((G3 @ b.zaxis).normalized())
        e.use_deform = True
        made[b] = e
    for b, e in made.items():
        if b.parent:
            e.parent = made[b.parent]
    object_mode()
    return arm


def skin(new_meshes, weights, probes_owner, rest, arm, root_name, spans):
    """Vertex groups from the measured weights (max 4 per vertex, normalised); weight that
    no bone accounts for (the part that follows the armature object itself) goes to the root."""
    stats = {'bad': 0, 'total': 0}
    for o, wm, pts in zip(new_meshes, weights, rest):
        n = len(pts)
        acc = {}
        for key, (idx, w) in wm.items():
            bone = probes_owner.get(key)
            if bone is None:
                continue
            a = acc.get(bone.out_name)
            if a is None:
                a = acc[bone.out_name] = np.zeros(n)
            a[idx] += w
        # Helper bones that span two bones in the rig (muscles stretched between them,
        # twist bones turning partly with the hand): share their weight between the two.
        for h, kind, parts in spans:
            w = acc.get(h.out_name)
            if w is None:
                continue
            if kind == 'aim':
                target = parts
                d = np.array(h.tail - h.head)
                s_ = np.clip(((pts - np.array(h.head)) @ d) / max(float(d @ d), 1e-12), 0.0, 1.0)
                moved = w * s_
                acc.setdefault(target.out_name, np.zeros(n))
                acc[target.out_name] += moved
                acc[h.out_name] = w - moved
            else:
                rest_w = w.copy()
                for target, f in parts:
                    acc.setdefault(target.out_name, np.zeros(n))
                    acc[target.out_name] += w * f
                    rest_w -= w * f
                acc[h.out_name] = rest_w
        names = list(acc)
        if names:
            W = np.stack([acc[k] for k in names], axis=1)
        else:
            W = np.zeros((n, 0))
        tot = W.sum(axis=1) if W.shape[1] else np.zeros(n)
        bad = (W < -0.15).any(axis=1) | (tot > 1.2) if W.shape[1] else np.zeros(n, dtype=bool)
        stats['bad'] += int(bad.sum())
        stats['total'] += n
        if bad.sum():
            stats.setdefault('where', []).append((int(bad.sum()), o.name))
        W = np.clip(W, 0, None)
        resid = np.clip(1.0 - W.sum(axis=1), 0, None) if W.shape[1] else np.ones(n)
        if root_name not in names:
            names.append(root_name)
            W = np.concatenate([W, np.zeros((n, 1))], axis=1) if W.shape[1] else np.zeros((n, 1))
        ri = names.index(root_name)
        W[:, ri] += np.where(resid > 0.02, resid, 0)
        # Top 4 per vertex.
        if W.shape[1] > 4:
            cut = np.argsort(-W, axis=1)[:, 4:]
            np.put_along_axis(W, cut, 0, axis=1)
        W[W < 0.01] = 0
        s = W.sum(axis=1)
        s[s == 0] = 1
        W = W / s[:, None]
        for j, nm in enumerate(names):
            col = W[:, j]
            nz = np.nonzero(col)[0]
            if not len(nz):
                continue
            vg = o.vertex_groups.new(name=nm)
            # Group by equal weight for speed.
            vals = np.round(col[nz], 4)
            for v in np.unique(vals):
                vg.add(nz[vals == v].tolist(), float(v), 'REPLACE')
        mod = o.modifiers.new('Armature', 'ARMATURE')
        mod.object = arm
        o.parent = arm
    return stats


# ------------------------------------------------------------------ checks

def edge_arrays(objs):
    out = []
    for o in objs:
        me = o.data
        e = np.empty(len(me.edges) * 2, dtype=np.int64)
        me.edges.foreach_get('vertices', e)
        out.append(e.reshape(-1, 2))
    return out


TEST_POSES = [
    # (bone, world axis, degrees): game-like motion on every main joint.
    [('LeftUpperArm', 'Y', 45), ('RightUpperArm', 'Y', -45), ('LeftLowerArm', 'Z', 60), ('RightLowerArm', 'Z', -60)],
    [('LeftUpperLeg', 'X', 50), ('LeftLowerLeg', 'X', -70), ('RightUpperLeg', 'X', -30), ('RightFoot', 'X', 25)],
    [('Spine', 'X', 20), ('Chest', 'Z', 25), ('Neck', 'Z', 20), ('Head', 'X', -20), ('LeftHand', 'Y', 40), ('RightHand', 'X', 40)],
    [('Hips', 'Z', 30), ('LeftShoulder', 'Y', 15), ('RightShoulder', 'Y', -15), ('LeftUpperArm', 'X', 60), ('RightUpperLeg', 'X', 45), ('RightLowerLeg', 'X', -60)],
]


def pose_test(arm, new_meshes, found, height):
    """Pose the new skeleton like the game will and look for torn or exploding geometry:
    edges that get much longer, vertices flung far away. Returns problems found."""
    bpy.context.view_layer.update()
    rest = mesh_coords(new_meshes)
    edges = edge_arrays(new_meshes)
    probs = []
    worst = 0.0
    for pose in TEST_POSES:
        for pb in arm.pose.bones:
            pb.matrix_basis = Matrix()
        bpy.context.view_layer.update()
        for name, axis, deg in sorted(pose, key=lambda p: len(arm.pose.bones[p[0]].parent_recursive) if p[0] in arm.pose.bones else 0):
            if name not in arm.pose.bones:
                continue
            pb = arm.pose.bones[name]
            h = pb.head.copy()
            R = Matrix.Rotation(math.radians(deg), 4, axis)
            pb.matrix = Matrix.Translation(h) @ R @ Matrix.Translation(-h) @ pb.matrix
            bpy.context.view_layer.update()
        now = mesh_coords(new_meshes)
        for o, r, c, e in zip(new_meshes, rest, now, edges):
            if not len(e):
                continue
            l0 = np.linalg.norm(r[e[:, 0]] - r[e[:, 1]], axis=1)
            l1 = np.linalg.norm(c[e[:, 0]] - c[e[:, 1]], axis=1)
            ok = l0 > height * 0.002
            stretch = np.where(ok, l1 / np.maximum(l0, 1e-9), 1.0)
            torn = (stretch > 3.0) & (l1 > height * 0.02)
            frac = float(torn.mean())
            worst = max(worst, float(np.percentile(stretch, 99.9)) if len(stretch) else 0)
            if torn.sum() > max(3, 0.002 * len(e)):
                probs.append(f'"{o.data.name}" tears apart when posed ({int(torn.sum())} stretched edges)')
                if os.environ.get('AVATAR_DEBUG'):
                    vs = set(e[torn].ravel().tolist())
                    tally = {}
                    gn = {g.index: g.name for g in o.vertex_groups}
                    for vi in vs:
                        for g in o.data.vertices[vi].groups:
                            tally[gn[g.group]] = tally.get(gn[g.group], 0) + g.weight
                    log(f'  debug pose {[p[0] for p in pose]}: torn verts by bone ' + ', '.join(f'{k}:{v:.1f}' for k, v in sorted(tally.items(), key=lambda x: -x[1])[:8]))
                    for vi in list(vs)[:3]:
                        log('    v%d: ' % vi + ', '.join(f'{gn[g.group]}={g.weight:.2f}' for g in o.data.vertices[vi].groups))
            jump = np.linalg.norm(c - r, axis=1)
            if np.any(jump > height * 1.5):
                probs.append(f'"{o.data.name}" has vertices flying away when posed')
    for pb in arm.pose.bones:
        pb.matrix_basis = Matrix()
    bpy.context.view_layer.update()
    return sorted(set(probs)), worst


# ------------------------------------------------------------------ animations

def animated_actions(arm):
    out = []
    for a in bpy.data.actions:
        try:
            paths = [fc.data_path for fc in a.fcurves]
        except Exception:
            continue
        names = {re.search(r'pose\.bones\["(.+?)"\]', p).group(1) for p in paths if p.startswith('pose.bones["')}
        if names & {b.name for b in arm.data.bones}:
            out.append(a)
    return out


def bake_clips(main, family, bones, new_arm, G):
    """Play each action on the original rig and record the kept bones on the new skeleton."""
    acts = [a for a in animated_actions(main) if a.name != 'PoseLib' and not a.name.startswith('PoseLib')]
    if not acts:
        return []
    scene = bpy.context.scene
    # Only the armatures (and what their constraints look at) need evaluating per frame.
    need = set(family)
    for a in family:
        for pb in a.pose.bones:
            for c in pb.constraints:
                t = getattr(c, 'target', None)
                if t:
                    need.add(t)
    hidden = [o for o in bpy.context.view_layer.objects if o not in need and not o.hide_viewport]
    for o in hidden:
        o.hide_viewport = True
    ad = main.animation_data or main.animation_data_create()
    old_action = ad.action
    tracks = [(t, t.mute) for t in ad.nla_tracks]
    for t in ad.nla_tracks:
        t.mute = True
    arms = {a.name: a for a in family}
    order = []
    seen = set()

    def visit(b):
        if b in seen:
            return
        if b.parent:
            visit(b.parent)
        seen.add(b)
        order.append(b)
    for b in bones.values():
        visit(b)
    rest = {b: new_arm.data.bones[b.out_name].matrix_local.copy() for b in order}
    clips = []
    new_ad = new_arm.animation_data or new_arm.animation_data_create()
    for act in acts:
        f0, f1 = int(math.floor(act.frame_range[0])), int(math.ceil(act.frame_range[1]))
        if f1 - f0 > 900:
            warn(f'animation "{act.name}" is long ({f1 - f0} frames): only the first 900 are kept')
            f1 = f0 + 900
        ad.action = act
        frames = list(range(f0, f1 + 1))
        rec = {b: [] for b in order}
        for f in frames:
            scene.frame_set(f)
            for b in order:
                a = arms[b.key[0]]
                rec[b].append(G @ a.matrix_world @ a.pose.bones[b.key[1]].matrix)
        # Skip actions that do not move any kept bone (face shapes on a face rig we dropped).
        moved = False
        for b in order:
            m0 = rec[b][0]
            for m in rec[b][1:]:
                if (m.translation - m0.translation).length > 1e-4 or m.to_quaternion().rotation_difference(m0.to_quaternion()).angle > 1e-3:
                    moved = True
                    break
            if moved:
                break
        if not moved:
            continue
        new = bpy.data.actions.new(act.name)
        for b in order:
            pn = b.out_name
            curves = {}
            for path, n in (('location', 3), ('rotation_quaternion', 4), ('scale', 3)):
                curves[path] = [new.fcurves.new(f'pose.bones["{pn}"].{path}', index=i, action_group=pn) for i in range(n)]
            vals = {p: [[] for _ in c] for p, c in curves.items()}
            prev_q = None
            for fi, f in enumerate(frames):
                pw = rec[b][fi]
                # Pose matrix relative to rest, within the parent's posed frame.
                if b.parent:
                    pp = rec[b.parent][fi]
                    basis = rest[b].inverted() @ rest[b.parent] @ pp.inverted() @ pw
                else:
                    basis = rest[b].inverted() @ pw
                loc, rot, scl = basis.decompose()
                if prev_q is not None and rot.dot(prev_q) < 0:
                    rot = -rot
                prev_q = rot
                for i in range(3):
                    vals['location'][i] += [f, loc[i]]
                    vals['scale'][i] += [f, scl[i]]
                for i in range(4):
                    vals['rotation_quaternion'][i] += [f, rot[i]]
            for path, cs in curves.items():
                for i, fc in enumerate(cs):
                    fc.keyframe_points.add(len(frames))
                    fc.keyframe_points.foreach_set('co', vals[path][i])
                    fc.update()
        new.use_fake_user = True
        tr = new_ad.nla_tracks.new()
        tr.name = act.name
        tr.strips.new(act.name, f0, new)
        clips.append(act.name)
    ad.action = old_action
    for t, m in tracks:
        t.mute = m
    for o in hidden:
        o.hide_viewport = False
    return clips


# ------------------------------------------------------------------ static models

def export_static(out, meshes, report):
    for o in bpy.context.view_layer.objects:
        o.select_set(o in meshes)
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_yup=True, use_selection=True,
                              export_materials='EXPORT', export_image_format='AUTO', export_apply=True, export_animations=False)
    return report


# ------------------------------------------------------------------ main

VERTEX_BUDGET = 100000


def limit_detail(meshes):
    """Subdivision (Subsurf, Multires) can multiply a mesh far beyond what a game character
    needs: lower the levels, most detailed mesh first, until the whole character fits."""
    def count():
        dg = bpy.context.evaluated_depsgraph_get()
        return {o: len(o.evaluated_get(dg).data.vertices) for o in meshes}
    bpy.context.view_layer.update()
    c = count()
    total0 = total = sum(c.values())
    while total > VERTEX_BUDGET:
        subs = [(o, m) for o in meshes for m in o.modifiers if m.type in ('SUBSURF', 'MULTIRES') and m.show_viewport and m.levels > 0]
        if not subs:
            break
        o, m = max(subs, key=lambda om: (c[om[0]], om[1].levels))
        m.levels -= 1
        bpy.context.view_layer.update()
        c = count()
        total = sum(c.values())
    if total < total0:
        log(f'detail: {total0} -> {total} vertices (subdivision lowered)')
    elif total > VERTEX_BUDGET:
        warn(f'the character has {total} vertices; it may slow the game down')

def convert(out, model, anims):
    clear()
    objs = import_any(model)
    main_arm, family, meshes = pick_character(objs)
    if not meshes:
        raise ConversionError('no visible mesh found in the file')
    report = {'source': os.path.basename(model), 'meshes': len(meshes)}
    if main_arm is None:
        warn('the model has no skeleton: it will stand still in the game')
        lo = min((o.matrix_world @ Vector(c)).z for o in meshes for c in o.bound_box)
        hi = max((o.matrix_world @ Vector(c)).z for o in meshes for c in o.bound_box)
        report.update({'rig': 'static', 'bones': [], 'height': round(hi - lo, 3), 'clips': []})
        export_static(out, meshes, report)
        return report
    # Extra animation files: their action goes to the character's armature.
    for path in anims:
        new = import_any(path)
        src = next((o for o in new if o.type == 'ARMATURE' and o.animation_data and o.animation_data.action), None)
        if src:
            act = src.animation_data.action
            act.name = os.path.splitext(os.path.basename(path))[0]
            act.use_fake_user = True
        else:
            warn(f'no armature animation in {os.path.basename(path)}')
        for o in new:
            bpy.data.objects.remove(o, do_unlink=True)
    if main_arm.animation_data and main_arm.animation_data.action:
        act = main_arm.animation_data.action
        # Importers name actions after the armature ("Armature|mixamo.com|Layer0"): use the file name.
        if '|' in act.name or act.name.startswith('Armature'):
            act.name = os.path.splitext(os.path.basename(model))[0]
    log(f'character: "{main_arm.name}" with ' + ', '.join(f'"{o.name}"' for o in meshes) + (f'; helper armatures: ' + ', '.join(a.name for a in family[1:]) if len(family) > 1 else ''))
    evaluable(closure(meshes) | set(family))
    # Simulations and particles cannot be skinned: keep the static shape.
    for o in closure(meshes):
        for m in getattr(o, 'modifiers', []):
            if m.type in PHYSICS:
                m.show_viewport = False
            elif m.show_render != m.show_viewport:
                m.show_viewport = m.show_render
    limit_detail(meshes)
    cons = read_constraints(family)
    state = RigState(family)
    state.neutral()
    rest0 = mesh_coords(meshes)
    allc = np.concatenate(rest0)
    lo, hi = allc.min(axis=0), allc.max(axis=0)
    height = float(hi[2] - lo[2])
    if height <= 0:
        raise ConversionError('the model has no height')
    probes, weights, rest = measure_weights(family, meshes, height)
    bones, owner, mass = build_classes(family, probes, weights, rest, height)
    if not bones:
        raise ConversionError('no bone of the skeleton moves the mesh')
    arms = {a.name: a for a in family}
    build_tree(bones, owner, arms, height)
    # Unit scale and origin: feet at 0, centred; characters far from 1.8 m are scaled.
    s = 1.0 if 0.5 < height < 3.0 else 1.75 / height
    cx, cy = float(allc[:, 0].mean()), float(allc[:, 1].mean())
    floor = float(lo[2])
    G = Matrix.Scale(s, 4) @ Matrix.Translation((-cx, -cy, -floor))
    # Humanoid body: names first, else the skeleton's shape.
    tries = []
    blist = list(bones.values())
    byname = map_by_names(blist)
    tries.append(('names', byname, check_body(byname, height, floor, cx), []))
    byshape, notes = map_by_shape(blist, height, floor, cx)
    tries.append(('shape', byshape, check_body(byshape, height, floor, cx), notes))
    ok = [t for t in tries if not t[2]]
    found, how = {}, None
    if ok:
        how, found = ok[0][0], ok[0][1]
        # Fill optional bones the other strategy found, if consistent.
        for t in tries:
            if t[0] != how and not t[2]:
                for k, v in t[1].items():
                    if k not in found and v not in found.values():
                        found[k] = v
        log(f'humanoid body ({how}): ' + ', '.join(f'{k}={v.name}' for k, v in found.items()))
    else:
        for name, f, p, n in tries:
            log(f'humanoid body by {name}: ' + '; '.join((p or [])[:4] + n[:3]))
    if found:
        apply_body(bones, found)
    else:
        # Still one tree: loose bones under the nearest bone of the biggest tree.
        roots = [b for b in bones.values() if b.parent is None]
        main_root = max(roots, key=lambda b: len(subtree(b)))
        for r in roots:
            if r is not main_root:
                pool = [x for x in bones.values() if x not in subtree(r)]
                r.parent = min(pool, key=lambda x: seg_dist(r.head, x.head, x.tail))
                r.parent.children.append(r)
    prune(bones, owner)
    unique_names(bones, found)
    spans = helper_spans(bones, owner, arms, cons, found, height)
    if os.environ.get('AVATAR_DEBUG'):
        with open(os.path.splitext(out)[0] + '.tree.txt', 'w') as f:
            def dump(b, d):
                f.write('  ' * d + f'{b.out_name}  [{b.name}] mass={b.mass:.1f} members={[k[1] for k in b.members][:6]}\n')
                for c in b.children:
                    dump(c, d + 1)
            for r in [b for b in bones.values() if b.parent is None]:
                dump(r, 0)
    root = found.get('Hips') or next(b for b in bones.values() if b.parent is None)
    # New scene content: baked meshes, clean skeleton, weights.
    new_meshes = bake_meshes(meshes, G)
    base = re.sub(r'[^\w]+', '_', os.path.splitext(os.path.basename(model))[0]).strip('_') or 'Character'
    new_arm = build_armature(bones, G, base)
    for o in new_meshes:
        bpy.context.scene.collection.objects.link(o)
    stats = skin(new_meshes, weights, owner, rest, new_arm, root.out_name, spans)
    if stats['total'] and stats['bad'] > 0.02 * stats['total']:
        where = ', '.join(f'"{n}"' for _, n in sorted(stats['where'], reverse=True)[:3])
        warn(f'{stats["bad"]} of {stats["total"]} vertices (mostly {where}) move in ways a skin cannot copy exactly (shrinkwrap, displace, corrective smooth); they are approximated')
    if stats['total'] and stats['bad'] > 0.25 * stats['total']:
        raise ConversionError('most of the mesh is moved by effects a game skin cannot reproduce (not by bones)')
    problems = []
    if not found:
        why = tries[1][3][:2] or tries[1][2][:3] or tries[0][2][:3]
        problems.append('no humanoid body found (' + '; '.join(why) + ')')
    probs, worst = pose_test(new_arm, new_meshes, found, height * s)
    log(f'pose test: worst edge stretch {worst:.2f}' + (': ' + '; '.join(probs) if probs else ', no tearing'))
    # Animations of the original rig, baked onto the new skeleton.
    state.restore()
    clips = bake_clips(main_arm, family, bones, new_arm, G)
    if found and probs and not os.environ.get('AVATAR_FORCE'):
        raise ConversionError('the converted body deforms badly: ' + '; '.join(probs))
    if not found and not clips:
        raise ConversionError('the game cannot animate this character: ' + '; '.join(problems) + ', and it has no animations of its own')
    if not found:
        warn('not a humanoid the game can drive: it will only play its own animations (' + ', '.join(clips) + ')')
    if probs:
        warn('; '.join(probs))
    report.update({
        'rig': 'humanoid' if found else 'custom',
        'mapping': how,
        'bones': [b.out_name for b in bones.values()],
        'height': round(height * s, 3),
        'scale': round(s, 5),
        'clips': clips,
    })
    os.makedirs(os.path.dirname(os.path.abspath(out)) or '.', exist_ok=True)
    for o in bpy.context.view_layer.objects:
        o.select_set(o == new_arm or o in new_meshes)
    bpy.ops.export_scene.gltf(
        filepath=out, export_format='GLB', export_yup=True, use_selection=True, export_def_bones=False,
        export_skins=True, export_animations=bool(clips), export_animation_mode='NLA_TRACKS' if clips else 'ACTIONS',
        export_materials='EXPORT', export_image_format='AUTO', export_apply=False,
    )
    return report


def main():
    out, model, anims = args()
    json_path = os.path.splitext(out)[0] + '.json'
    for p in (out, json_path):
        if os.path.exists(p):
            os.remove(p)
    try:
        report = convert(out, model, anims)
    except ConversionError as e:
        log(f'FAILED: {e}')
        log('No file was written: the result would not work in the game.')
        with open(json_path, 'w') as f:
            json.dump({'source': os.path.basename(model), 'error': str(e), 'warnings': WARNINGS}, f, indent=2)
        sys.stdout.flush()
        if bpy.app.background:
            os._exit(2)
        return 2
    report['warnings'] = WARNINGS
    with open(json_path, 'w') as f:
        json.dump(report, f, indent=2)
    log(json.dumps({k: v for k, v in report.items() if k != 'bones'}))
    return 0


if __name__ == '__main__':
    code = main()
    sys.stdout.flush()
    os._exit(code or 0)
