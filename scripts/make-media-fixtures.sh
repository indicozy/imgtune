#!/usr/bin/env bash
# Generates the animated-media test fixtures in test/fixtures/media/ with the system ffmpeg.
#
# Idempotent: every run overwrites the same files with the same parameters, so re-running it
# only changes bytes if ffmpeg itself changed. The outputs are committed so tests do not need
# ffmpeg; this script is how they were made. Each file is kept under 300 KB.
#
#   anim.gif       320x180, 3 s, 10 fps (30 frames, 100 ms each), loop forever. testsrc2 content.
#   still.gif      one frame of the same source (a static GIF; animationOf must return undefined).
#   anim.webp      the same 3 s animation as animated WebP (libwebp_anim, loop forever).
#   anim.png       the same 3 s animation as APNG (-f apng -plays 0).
#   still.png      one frame as PNG (a static PNG; animationOf must return undefined).
#   text.gif       480x270, 2 s, 10 fps: a screen-recording style GIF. Static text (drawtext in Liberation
#                  Sans, or a plain-box fallback when that font is missing) and a small moving box.
#   clip.mp4       1280x720, 8 s, 30 fps, H.264 CRF 50, AAC audio from a sine tone (for `<video>` tests).
#                  CRF 50, not 40: testsrc2 is detail-heavy and CRF 40 gives ~520 KB, over the 300 KB budget.
#   clip-noaudio.mp4  the same picture as clip.mp4 with no audio track (muted-video tests).
#   clip60.mp4     640x360, 3 s, 60 fps, H.264 CRF 40 (frame-rate informational tests).
#   clip.webm      640x360, 4 s, 30 fps, VP9 at CRF 45 (second codec for `<source>` tests).
#
# Usage: bash scripts/make-media-fixtures.sh   (wrap in: nice -n 19 taskset -c 8-19 ...)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/test/fixtures/media"
FFMPEG="${FFMPEG:-ffmpeg}"
FONT="/usr/share/fonts/liberation-sans-fonts/LiberationSans-Regular.ttf"

mkdir -p "$OUT"
ff() { "$FFMPEG" -hide_banner -loglevel error -y "$@"; }

# Animated GIF, APNG, WebP: the same 3 s testsrc2 source.
ff -f lavfi -i "testsrc2=size=320x180:rate=10:duration=3" -loop 0 "$OUT/anim.gif"
ff -f lavfi -i "testsrc2=size=320x180:rate=10:duration=3" -c:v libwebp_anim -loop 0 -an "$OUT/anim.webp"
ff -f lavfi -i "testsrc2=size=320x180:rate=10:duration=3" -f apng -plays 0 "$OUT/anim.png"

# Single-frame counterparts.
ff -f lavfi -i "testsrc2=size=320x180:rate=10:duration=3" -frames:v 1 "$OUT/still.gif"
ff -f lavfi -i "testsrc2=size=320x180:rate=10:duration=3" -frames:v 1 -c:v png "$OUT/still.png"

# Screen recording: static text and header bar, a small box that moves left to right.
if [ -f "$FONT" ]; then
  TEXT_FILTER="drawtext=fontfile=$FONT:text='imgtune screen recording':fontsize=22:fontcolor=black:x=20:y=20,drawtext=fontfile=$FONT:text='Settings  >  Images  >  Quality':fontsize=16:fontcolor=0x333333:x=20:y=60"
else
  # No font: a dark header bar stands in for the text, which keeps the same flat-colour, hard-edge look.
  TEXT_FILTER="drawbox=x=20:y=20:w=300:h=24:color=black@1:t=fill,drawbox=x=20:y=60:w=260:h=16:color=0x333333@1:t=fill"
fi
ff -f lavfi -i "color=c=0xf4f4f4:size=480x270:rate=10:duration=2" \
  -vf "$TEXT_FILTER,drawbox=x='mod(t*200,420)':y=200:w=40:h=40:color=0x2a7ae2@1:t=fill" \
  -loop 0 "$OUT/text.gif"

# Video. clip.mp4 and clip-noaudio.mp4 share the picture; clip.mp4 adds a sine tone as AAC audio.
ff -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=8" \
  -f lavfi -i "sine=frequency=440:duration=8" \
  -c:v libx264 -preset slower -crf 50 -pix_fmt yuv420p -movflags +faststart \
  -c:a aac -b:a 64k -shortest "$OUT/clip.mp4"
ff -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=8" \
  -c:v libx264 -preset slower -crf 50 -pix_fmt yuv420p -movflags +faststart -an "$OUT/clip-noaudio.mp4"
ff -f lavfi -i "testsrc2=size=640x360:rate=60:duration=3" \
  -c:v libx264 -preset slower -crf 40 -pix_fmt yuv420p -movflags +faststart -an "$OUT/clip60.mp4"
ff -f lavfi -i "testsrc2=size=640x360:rate=30:duration=4" \
  -c:v libvpx-vp9 -crf 45 -b:v 0 -deadline good -cpu-used 5 -row-mt 1 -an "$OUT/clip.webm"

# Report the sizes and fail if any fixture is over the 300 KB budget.
status=0
for f in "$OUT"/*; do
  bytes=$(wc -c < "$f")
  printf '%-22s %8d bytes\n' "$(basename "$f")" "$bytes"
  if [ "$bytes" -gt 307200 ]; then
    echo "over 300 KB: $f" >&2
    status=1
  fi
done
exit "$status"
