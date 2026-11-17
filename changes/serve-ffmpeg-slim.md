---
packages: @parcha/agentrun-serve
kind: fix
---
The image's ffmpeg is one static binary of about 6 MB built for the screen recorder alone (PNG and JPEG frames in, H.264 in fragmented MP4 out), in place of Debian's `ffmpeg` and its libraries: the image is 163 MB smaller than with Debian's, and 2.8 MB larger than with no ffmpeg at all. FFmpeg 9.0.2, x264 and zlib, each pinned by sha256, cross-compiled for arm64. The image build runs the recorder on it and fails unless it makes H.264 files from both kinds of frame. It is GPL, as Debian's ffmpeg is; the licence files are in `/usr/local/share/doc/ffmpeg`.
