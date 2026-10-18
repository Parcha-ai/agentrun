#!/usr/bin/env bash
# Cuts the clip a run on fakes reads with no network from the checked film of ../sources.json, into this directory.
# Usage: clip/cut.sh <the checked film, eagle-has-landed.mp4>. clip.json fixes the result by size and SHA-256, and the test
# checks it; this command, with ffmpeg 6.1.1 (libvpx, libopus), gives those bytes. Another version may give other bytes.
set -euo pipefail
film=${1:?usage: clip/cut.sh <the checked film>}
out=$(cd "$(dirname "$0")" && pwd)

# Three pieces of the film, one after the other (clip.json says where each is in the film): the opening, where the landing
# call is first heard over the title cards (118 to 128 s); the landing itself (798 to 808 s); the flag planted (1016 to
# 1030 s). VP9 and Opus in WebM, a keyframe each second.
ffmpeg -v error -y -i "$film" -filter_complex \
  "[0:v]trim=118:128,setpts=PTS-STARTPTS[v1];[0:a]atrim=118:128,asetpts=PTS-STARTPTS[a1];[0:v]trim=798:808,setpts=PTS-STARTPTS[v2];[0:a]atrim=798:808,asetpts=PTS-STARTPTS[a2];[0:v]trim=1016:1030,setpts=PTS-STARTPTS[v3];[0:a]atrim=1016:1030,asetpts=PTS-STARTPTS[a3];[v1][a1][v2][a2][v3][a3]concat=n=3:v=1:a=1[v][a]" \
  -map '[v]' -map '[a]' -sn -map_metadata -1 -map_chapters -1 -c:v libvpx-vp9 -b:v 0 -crf 38 -g 15 -row-mt 0 -threads 1 \
  -deadline good -cpu-used 2 -pix_fmt yuv420p -c:a libopus -b:a 32k -ac 1 -fflags +bitexact -flags:v +bitexact -flags:a +bitexact \
  "$out/eagle-heard-and-seen.webm"
