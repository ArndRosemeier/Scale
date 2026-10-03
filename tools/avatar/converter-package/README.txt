Scale avatar converter (Windows)
================================

Turns character models into GLB files the game can import:
FBX (e.g. Mixamo), .blend, glTF/GLB, OBJ, DAE.

How to use
  1. Unzip this folder anywhere.
  2. Drag your character file onto Convert.bat.
     Optional: drag animation files for the same rig together with it
     (Mixamo: character.fbx + Idle.fbx + Walking.fbx ...); they become named clips.
  3. A .glb appears next to your file. In the game's start screen, use
     "Import model..." or drag the .glb onto the start screen.

First run
  Downloads the official portable Blender 4.5.12 (about 350 MB) from
  https://download.blender.org and verifies its SHA-256 checksum. It is stored in
  the "blender" folder next to Convert.bat; delete that folder to remove it.
  To use an existing Blender instead, set the environment variable BLENDER_BIN
  to its blender.exe.

Notes
  - Windows may warn about running a downloaded script. Convert.bat only starts
    convert.ps1 (plain text, readable) with PowerShell.
  - Materials: Blender's standard (Principled BSDF) materials and image textures
    convert; purely procedural shader-node materials do not.
  - Characters with several armatures: the one with the most bones is used.
