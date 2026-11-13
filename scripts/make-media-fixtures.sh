#!/usr/bin/env bash
# Generates the animated-media test fixtures in test/fixtures/media/ with the system ffmpeg.
#
# Idempotent: every run overwrites the same files with the same parameters, so re-running it
# only changes bytes if ffmpeg itself changed. The outputs are committed so tests do not need
# ffmpeg; this script is how they were made. Each file is kept under 300 KB, except clip.mp4 and clip-noaudio.mp4,
# which are kept under 600 KB.
#
#   anim.gif       320x180, 3 s, 10 fps (30 frames, 100 ms each), loop forever. testsrc2 content, adaptive palette
#                  with sierra2_4a dithering (a real GIF encoder's output, not ffmpeg's fixed rgb8 default).
#   still.gif      one frame of the same source (a static GIF; animationOf must return undefined).
#   anim.webp      the same 3 s animation as animated WebP (libwebp_anim, loop forever).
#   anim.png       the same 3 s animation as APNG (-f apng -plays 0).
#   still.png      one frame as PNG (a static PNG; animationOf must return undefined).
#   text.gif       480x270, 2 s, 10 fps: a screen-recording style GIF. Static text (drawtext in Liberation
#                  Sans, or a plain-box fallback when that font is missing) and a small moving box.
#   clip.mp4       1280x720, 8 s, 30 fps, H.264 CRF 23, AAC audio from a sine tone (for `<video>` tests).
#                  Natural content: a smooth gradient (gradients filter) with a dark panel and two text lines,
#                  a hero-loop look. The earlier testsrc2 clip at CRF 50 had block artifacts that the
#                  SSIMULACRA2 guard punishes, so it could not represent a real served video.
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
# GIF with an adaptive palette (split, palettegen, paletteuse with sierra2_4a dithering), as real GIF encoders
# (ezgif, Photoshop, gifski, screen recorders) write them. ffmpeg's default GIF output is a fixed rgb8 palette with
# crude dithering, which the still guard then reads as loss.
ff -f lavfi -i "testsrc2=size=320x180:rate=10:duration=3" \
  -filter_complex "[0:v]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a" \
  -loop 0 "$OUT/anim.gif"
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
HERO_VF="drawbox=x=60:y=420:w=560:h=240:color=black@0.45:t=fill,drawtext=fontfile=$FONT:text=Summer sale:fontsize=72:fontcolor=white:x=100:y=460,drawtext=fontfile=$FONT:text=Up to 40 percent off:fontsize=36:fontcolor=white:x=100:y=560"
ff -f lavfi -i "gradients=s=1280x720:speed=0.02:r=30:d=8:seed=7" \
  -f lavfi -i "sine=frequency=440:duration=8" -vf "$HERO_VF" \
  -c:v libx264 -preset slower -crf 23 -pix_fmt yuv420p -movflags +faststart \
  -c:a aac -b:a 64k -shortest "$OUT/clip.mp4"
ff -f lavfi -i "gradients=s=1280x720:speed=0.02:r=30:d=8:seed=7" -vf "$HERO_VF" \
  -c:v libx264 -preset slower -crf 23 -pix_fmt yuv420p -movflags +faststart -an "$OUT/clip-noaudio.mp4"
ff -f lavfi -i "testsrc2=size=640x360:rate=60:duration=3" \
  -c:v libx264 -preset slower -crf 40 -pix_fmt yuv420p -movflags +faststart -an "$OUT/clip60.mp4"
ff -f lavfi -i "testsrc2=size=640x360:rate=30:duration=4" \
  -c:v libvpx-vp9 -crf 45 -b:v 0 -deadline good -cpu-used 5 -row-mt 1 -an "$OUT/clip.webm"

# Report the sizes and fail if a fixture is over its budget: 300 KB, or 600 KB for the two 8 s clips.
status=0
for f in "$OUT"/*; do
  bytes=$(wc -c < "$f")
  limit=307200
  case "$(basename "$f")" in clip.mp4|clip-noaudio.mp4) limit=614400 ;; esac
  printf '%-22s %8d bytes\n' "$(basename "$f")" "$bytes"
  if [ "$bytes" -gt "$limit" ]; then
    echo "over budget: $f" >&2
    status=1
  fi
done
exit "$status"
