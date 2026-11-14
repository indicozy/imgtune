# Video and animated images

`scan` also measures animated media: animated GIFs, animated WebP and APNG, and self-hosted `<video>` elements with a plain file
source. Animated GIFs can sit in an `<img>` or a CSS background. Static GIFs (one frame) get the normal image hints.

## What is detected

- **Animated GIF, WebP and APNG** in an `<img>` or a CSS background.
- **`<video>`** with a file source the page serves itself. Its `<source>` files are read, and the bytes are measured.
- **Posters** are images, so they go through the image pipeline and get the image hints.

Not reported:

- **Adaptive streams** (HLS, DASH, Mux, Cloudflare Stream). The bytes depend on the player, so they are left out.
- **Third-party iframes** (YouTube, Vimeo).

A video hosted on another site is read like any other third-party request, so `--block-third-party` and `--allow-host` apply to
it.

## ffmpeg

ImgTune uses the `ffmpeg` on your `PATH`. It does not bundle it. Without ffmpeg, `scan` still reports each animated image's and
video's bytes and the width it needs, and prints one note: `install ffmpeg for verified video and GIF hints`. The encodes need
ffmpeg, so the hints that carry a size do too.

## The hints

- **A large animated GIF** gets `<video autoplay muted loop playsinline>`, with AV1 first and an H.264 fallback. The
  animated-image alternative is shown beside it, with its size.
- **A small `<img>` GIF, or a CSS background** gets an animated AVIF or WebP. For an `<img>`, only its `src` changes.
- **A `<video>`** gets a hint that names each lever: the width per breakpoint (`<source media>`), the CRF, the codec, the audio
  track of a muted video, and `preload`. A poster is audited as an image.

Duration and frame rate are shown for information. They are not part of the claimed saving.

## Per view and per play

Each video has two byte numbers:

- **Per view** is what the first view fetches. An autoplay video counts its full file. `preload="auto"` counts the bytes the
  scan saw, which depends on the browser. `preload="metadata"` or `"none"` counts 0. The claim and the priority order use this
  number.
- **Per play** is the full file. It is shown for every video, so a large click-to-play file is not missed.

Animated images stay in the image totals. `<video>` has its own Video section in the report, with both numbers.

## How the quality is checked

The encodes are sample encodes. The scan encodes 2 seconds of the video (one sample for a video of up to 6 s, three for a longer
one) and takes the full-file bytes from those samples, labelled as an estimate. Nothing is encoded in full.

- A candidate must reach **VMAF 93** (`--video-bar`) against the served file at its display size.
- A **still-frame guard** (SSIMULACRA2 on the stillest frames) must reach `--video-still-bar` (default 65). It catches blurred
  text in screen recordings. The bar is lowered to at most 10 points below the best the codec reaches on that content, and never
  below 20.

Motion hides artifacts, so the video bar is looser than the image bar. GIF dither is not counted as a loss the encode adds.

## Flags and defaults

| flag | default | what it does |
| --- | --- | --- |
| `--media-budget <N>` | 20 (0 to 1000) | encodes at most N animated images and videos per run, heaviest first |
| `--media-time <s>` | 600 (1 to 3600) | time limit of the media encodes |
| `--video-bar <n>` | 93 | minimum VMAF of an encode |
| `--video-still-bar <n>` | 65 | minimum SSIMULACRA2 of the still-frame guard |
| `--max-video-widths <n>` | 2 (1 to 3) | the most widths each video is served at |

Assets over `--media-budget` keep their cheap hints and are marked "over --media-budget". Each video is served at most
`--max-video-widths` widths: each viewport gets the smallest kept width that covers its display width times its device pixel
ratio. `audit` does not choose. It reports the bytes at one, two and three widths, and the agent decides.

`--no-quality` and `--survey` make no encodes. The bytes and the widths are still measured.

## Checking an agent's output

`imgtune image` checks a re-encoded file against the original, with the same bars:

```sh
imgtune image hero.mp4 --reference hero-original.mp4
```

It prints one line, `VMAF <v> (bar <b>) still p10 <s> (bar <sb>): pass` or `fail`, and exits 0 on pass and 1 on fail. Without
`--reference`, an animated file gets its candidates (animated AVIF, animated WebP and AV1 MP4), which needs ffmpeg.

## GPU encodes (experimental)

`--gpu-encode` moves the sample encodes to the GPU (NVENC, and CUDA VMAF when the ffmpeg on `PATH` has it). It is off by
default, and it is **experimental**. NVENC needs more bytes at the same quality, so its bytes are scaled by 1 / 1.4 to a CPU
encode and labelled `est. (GPU-encoded, scaled to a CPU encode ÷1.4)`. In our measurements it was slower than the CPU on 2 s
samples, so the CPU stays the default. The hint's recipe is the CPU one.

See the [CLI reference](/reference/cli#animated-media-and-video) for every flag, and [Output JSON](/reference/output-json)
for the `videos` and `fix.animated` fields.
