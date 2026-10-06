"""
Picker thumbnails of the built-in characters (run with Blender's Python, e.g. pip bpy):
    python thumbs.py public/assets/bodies/woman.glb public/assets/bodies/woman.png
"""
import math
import sys

import bpy

src, dst = sys.argv[-2], sys.argv[-1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
sc = bpy.context.scene
for o in sc.objects:
    if o.name.startswith('Icosphere'):
        o.hide_render = True
dg = bpy.context.evaluated_depsgraph_get()
zs = [(e.matrix_world @ v.co).z for o in sc.objects if o.type == 'MESH' and not o.hide_render
      for e in [o.evaluated_get(dg)] for v in e.data.vertices]
lo, hi = min(zs), max(zs)
sc.render.engine = 'CYCLES'
sc.cycles.samples = 48
sc.cycles.device = 'CPU'
sc.render.film_transparent = True
sc.render.resolution_x = sc.render.resolution_y = 192
w = bpy.data.worlds.new('w')
sc.world = w
w.use_nodes = True
w.node_tree.nodes['Background'].inputs[1].default_value = 0.9
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
sun.data.energy = 3
sun.rotation_euler = (math.radians(50), 0, math.radians(20))
sc.collection.objects.link(sun)
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
cam.data.type = 'ORTHO'
cam.data.ortho_scale = (hi - lo) * 1.06
cam.location = (0, -5, (lo + hi) / 2)
cam.rotation_euler = (math.radians(90), 0, 0)
sc.collection.objects.link(cam)
sc.camera = cam
sc.render.filepath = dst
bpy.ops.render.render(write_still=True)
