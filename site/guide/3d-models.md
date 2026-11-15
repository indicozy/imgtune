# 3D models

`scan` finds the 3D models a page loads and reports each one with its bytes per view, the bytes a fix saves, and the command
to apply it.

## What is checked

Covered: glTF (`.gltf`) and GLB (`.glb`). Informational only, with no saving claimed: USDZ, KTX2, Draco (`.drc`), OBJ,
FBX, splats and PLY.

- **Geometry.** A glTF or GLB is repacked and run through meshopt with gltf-transform, the same transform as
  `--compress meshopt`. The saving is measured, not estimated. Meshopt quantizes positions and normals, so check the model
  visually after the change.
- **Base64 buffers.** A glTF that embeds its buffers as base64 is about a third larger. Writing it as a GLB removes that on
  its own, and the hint says how much.
- **Textures.** Each PNG or JPEG texture gets a WebP (q80) re-encode. Textures over 4 megapixels are estimated from a
  2048 px copy. When the display box of a `<model-viewer>` is known, a texture much larger than the box gets a resize line.
- **Already compressed.** A file with Draco or meshopt geometry is reported, and its geometry is not measured again.
- **External buffers.** A glTF whose `.bin` files are separate is reported with no measured saving: the `.bin` files are not
  in the scan.

The fix for a model, for example:

    npx @gltf-transform/cli optimize in.glb out.glb --compress meshopt --texture-compress webp

## Install the measurement packages

The gltf-transform packages and meshoptimizer are optional dependencies: `@gltf-transform/core`,
`@gltf-transform/extensions`, `@gltf-transform/functions` and `meshoptimizer`. Without them, each model is reported with its
bytes and no measured saving, and one note says what to install.

## Budget

The heavy work on a model (the repack and the texture re-encodes) counts against `--resource-time` (default 60 seconds
per run). A model over the budget keeps its cheap finding and is marked not measured. See [Resources](/guide/resources).

## Limits

- The scan loads the page and scrolls it. A model that the page requests only after a user action (a click, a tab, an
  opened viewer) is not seen.
- The Chromium flags keep WebGL on, so a viewer that renders its model on load requests the file. Only a WebGL page pays
  the extra CPU.
- A model with external `.bin` buffers has no measured saving (see above).
