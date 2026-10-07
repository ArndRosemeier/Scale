#!/bin/sh
# Rebuilds the Woman/Man base bodies (tools/avatar/base-bodies/bodies/; conform.py fits every human onto them) from woman-source.glb:
#   sh tools/avatar/base-bodies/build.sh
# Needs python3 with numpy and Pillow.
set -e
here=$(dirname "$0")
out="$here/bodies"
tmp=$(mktemp -d)
python3 "$here/make_male.py" "$here/woman-source.glb" "$tmp/man.glb"
python3 "$here/paint_skin.py" "$here/woman-source.glb" "$out/woman.glb"
python3 "$here/paint_skin.py" "$tmp/man.glb" "$out/man.glb" --male --ref "$here/woman-source.glb"
rm -r "$tmp"
