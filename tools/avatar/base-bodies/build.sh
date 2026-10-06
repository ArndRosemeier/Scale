#!/bin/sh
# Rebuilds the built-in characters (public/assets/bodies/) from woman-source.glb:
#   sh tools/avatar/base-bodies/build.sh
# Needs python3 with numpy and Pillow. Thumbnails: see thumbs.py (needs Blender's bpy).
set -e
here=$(dirname "$0")
out="$here/../../../public/assets/bodies"
tmp=$(mktemp -d)
python3 "$here/make_male.py" "$here/woman-source.glb" "$tmp/man.glb"
python3 "$here/paint_skin.py" "$here/woman-source.glb" "$out/woman.glb"
python3 "$here/paint_skin.py" "$tmp/man.glb" "$out/man.glb" --male --ref "$here/woman-source.glb"
rm -r "$tmp"
