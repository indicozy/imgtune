# Audio

`scan` finds the audio files a page loads and reports each one with its bytes per view, the bytes a re-encode saves, and the
command to apply it.

## What is checked

Covered: `mp3`, `wav`, `ogg`, `m4a`, `aac`, `flac` and `opus` files, and `audio/*` responses. HLS and DASH segments are left
out.

Each file is read with the system `ffprobe`. A file is re-encoded when it is:

- lossless (WAV, FLAC);
- lossy above 128 kbps stereo or 64 kbps mono;
- stereo with identical channels (it becomes mono).

The target is Opus at 96 kbps stereo, or 64 kbps mono, with AAC as the fallback for older Safari. The saving is measured on a
10-second sample and extrapolated to the file, so it is an estimate. A re-encode is reported only when it saves at least
5 KB and 10% of the bytes per view.

A file the page downloads on load (`autoplay`, or `preload="auto"`) also gets the lazy-loading fix: `preload="none"`, or no
autoplay, so the file is fetched on play. Its saving is the whole file.

## ffmpeg

Without ffmpeg on `PATH`, the analyzer reports the bytes and the extension only, and asks you to install ffmpeg. Nothing is
claimed without it. ImgTune uses the system ffmpeg and does not bundle it.

## Budget

The sample encodes count against `--resource-time` (default 60 seconds per run). A file over the budget keeps its cheap
finding and is marked not measured. See [Resources](/guide/resources).

## Limits

- Measurements come from the bodies the browser returned. Chromium returns no body for a range (206) media response, so
  such a file has to be fetched again to be probed.
- The stereo-to-mono check looks at the first 10 seconds. It cannot tell speech from music.
