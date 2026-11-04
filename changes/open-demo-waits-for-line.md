---
packages: repo
kind: ci
---
The `--open` demo test waits for the stub opener's whole line, not just its file: the stub's `>>` creates the file before its `printf` writes, so a read in between got an empty string and failed the test on a loaded CI runner. Its wait is also 15 s instead of 5 s.
