---
packages: @parcha/pi-vision
kind: fix
---
A program `vision.transcribe` starts (ffprobe, for a recording's length) gets the child environment `read`'s programs get: the host's `env` option, or by default only what `inheritedEnv()` copies, and never the rest of the host process's environment. `vision.see` and `vision.judge` are handed the same environment. Before, a code-mode global ran its programs on the environment the host handed it as it was, and pi's environments give a program all of `process.env`.
