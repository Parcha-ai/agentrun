---
packages: @parcha/pi-vision
kind: fix
---
The `look` skill cuts a video window by encoding it without B-frames, not by stream copy, so its second 0 is the window's start for every decoder: a copy starts at the keyframe before the window, and a decoder that ignores the edit list counted its seconds from there. The bitexact flags still make the same window the same bytes, from an MP4 or a WebM. Its PDF pages render with `-cropbox`, the area a citation's `#xywh=percent:` is of, not the whole sheet with its margins.
