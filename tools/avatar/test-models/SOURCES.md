# Avatar test models (not shipped)

Used to test the humanoid mapper (`src/avatar/HumanoidMap.ts`) and the converter.

| File | Source | Licence | Rig |
| --- | --- | --- | --- |
| Xbot.glb, Soldier.glb, Michelle.glb, RobotExpressive.glb | three.js repo, examples/models/gltf | see three.js repo (examples assets) | Mixamo (robot: stylised) |
| Samba_Dancing.glb | three.js repo, examples/models/fbx/Samba Dancing.fbx, converted with `npm run avatar` | see three.js repo | Mixamo FBX |
| CesiumMan.glb, RiggedFigure.glb, Fox.glb | KhronosGroup/glTF-Sample-Assets | see each model's README there | unnamed bones / quadruped |
| VRM1_Constraint_Twist_Sample.vrm | pixiv/three-vrm examples | see three-vrm repo | VRM 1.0 |
| AG_male.glb | ../AssetGenerator/assets/humans | own | Unreal-style |
| rigify_test.glb | generated in Blender (Rigify human metarig) | own | Rigify |

Probe in the dev server console: `(await import('/src/debug/avatarProbe.ts')).probe([...urls])`
(serve the files temporarily under /public to load them).
