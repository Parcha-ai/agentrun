#!/usr/bin/env bash
# Cuts the clip a run on fakes reads with no network from the checked film of ../sources.json, into this directory.
# Usage: clip/cut.sh <the checked film, eagle-has-landed.mp4>. clip.json fixes the result by size and SHA-256, and the test
# checks it; this command, with ffmpeg 6.1.1 (libvpx, libopus), gives those bytes. Another version may give other bytes.
set -euo pipefail
film=${1:?usage: clip/cut.sh <the checked film>}
out=$(cd "$(dirname "$0")" && pwd)

# 24 seconds of the film from second 360, the launch, with its narration: VP9 and Opus in WebM, a keyframe each second so a
# window cut with -c copy starts where it is asked to.
ffmpeg -v error -y -ss 360 -i "$film" -t 24 -map 0:v:0 -map 0:a:0 -sn -map_metadata -1 -map_chapters -1 -c:v libvpx-vp9 -b:v 0 \
  -crf 38 -g 30 -row-mt 0 -threads 1 -deadline good -cpu-used 2 -pix_fmt yuv420p -c:a libopus -b:a 32k -ac 1 \
  -fflags +bitexact -flags:v +bitexact -flags:a +bitexact "$out/eagle-clip-360-384.webm"
