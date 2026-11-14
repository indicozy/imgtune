# 3D models and audio

`scan` also measures the 3D models and the audio files a page loads. Each one is a finding with its bytes per view, the
bytes a fix saves, and the command to apply it.

## 3D models

Covered: glTF (`.gltf`), GLB (`.glb`), and, as informational entries, USDZ, KTX2, Draco (`.drc`), OBJ, FBX, splats and PLY.

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

## Audio

Covered: `mp3`, `wav`, `ogg`, `m4a`, `aac`, `flac` and `opus` files, and `audio/*` responses. HLS and DASH segments are left out.

Each file is read with the system `ffprobe`. A file is re-encoded when it is:

- lossless (WAV, FLAC);
- lossy above 128 kbps stereo or 64 kbps mono;
- stereo with identical channels (it becomes mono).

The target is Opus at 96 kbps stereo, or 64 kbps mono, with AAC as the fallback for older Safari. The saving is measured on a
10-second sample and extrapolated to the file, so it is an estimate. A re-encode is reported only when it saves at least
5 KB and 10% of the bytes per view.

A file the page downloads on load (`autoplay`, or `preload="auto"`) also gets the lazy-loading fix: `preload="none"`, or no
autoplay, so the file is fetched on play. Its saving is the whole file.

Without ffmpeg on `PATH`, the analyzer reports the bytes and the extension only, and asks you to install ffmpeg. Nothing is
claimed without it.

## Limits

- Measurements come from the bodies the browser returned. Chromium returns no body for a range (206) media response, so
  such a file has to be fetched again to be probed.
- The Chromium flags in the scan turn WebGL off, so a 3D model that only loads with WebGL is not seen.
- The stereo-to-mono check looks at the first 10 seconds. It cannot tell speech from music.
