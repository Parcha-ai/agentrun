---
packages: @parcha/pi-vision
kind: feature
---
Video: `probeVideo`, `videoFrames` (frames found by seek, never an fps filter over a long span), `videoClip` (a window by stream copy, else one re-encode at 1280 px and 6 frames a second, stopped at the inline budget: never the whole file), `videoAsIs` (a file within the inline budget, no program run), `videoWindow` and `describeVideo`, each returning its result or a typed miss; `ffmpegProvider()` runs ffmpeg and ffprobe through the environment, opens only local files in real video containers, and keeps nothing it derives. Without ffmpeg every operation but `videoAsIs` is a `needs` miss.
