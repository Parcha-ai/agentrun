#!/usr/bin/env bash
# Cuts the slice a run reads with no network from the checked files of ../sources.json, into this directory.
# Usage: slice/cut.sh <a directory holding sources.json's files, checked> (the work/ of a --fetch-sources run kept with --dir is one).
# slice.json fixes each result by size and SHA-256, and the test checks them; these commands, with pypdf 6.15.0 and ffmpeg 6.1.1
# (libvpx), give those bytes. Another version of either may give other bytes for the same cut.
set -euo pipefail
src=${1:?usage: slice/cut.sh <directory of checked files>}
out=$(cd "$(dirname "$0")" && pwd)

# The scanned transcript's pages 317 to 319: mission time 04 06 43 35 to 04 06 48 10, the last minutes of the descent and "The
# Eagle has landed" (page 319). The page objects are copied unchanged: the scan's CCITT images and its text layer.
python3 -I - "$src/transcript-tec.pdf" 317 319 "$out/transcript-tec-p317-319.pdf" <<'EOF'
import sys
from pypdf import PdfReader, PdfWriter
source, first, last, target = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
reader = PdfReader(source)
writer = PdfWriter()
for index in range(first - 1, last):
    writer.add_page(reader.pages[index])
writer.compress_identical_objects(remove_duplicates=True, remove_unreferenced=True)
with open(target, 'wb') as file:
    writer.write(file)
EOF

# NASA's typed transcript, the entries typed 04 06 43 00 to 04 06 48 59 (every time those pages hold), byte for byte.
awk '/^[0-9][0-9] [0-9][0-9] [0-9][0-9] [0-9][0-9] / { t = substr($0, 1, 11); keep = (t >= "04 06 43 00" && t < "04 06 49 00") } keep' \
  "$src/transcript-tec-typed.html" > "$out/transcript-tec-typed-p317-319.html"

# 18 seconds of the descent film from second 1206: the lunar surface through Eagle's window. VP9 in WebM, no audio, its size kept.
ffmpeg -v error -y -ss 1206 -i "$src/film-descent.mp4" -t 18 -an -sn -map_metadata -1 -map_chapters -1 -c:v libvpx-vp9 -b:v 0 \
  -crf 40 -row-mt 0 -threads 1 -deadline good -cpu-used 2 -pix_fmt yuv420p -fflags +bitexact -flags:v +bitexact "$out/film-descent-1206-1224.webm"

# One photograph of each class, NASA's files unchanged (the smallest of each class in sources.json).
for id in photo-AS11-36-5355 photo-AS11-44-6581 photo-AS11-40-5863 photo-AS11-44-6665 photo-AS11-45-6704; do
  cp "$src/$id.jpg" "$out/$id.jpg"
done
