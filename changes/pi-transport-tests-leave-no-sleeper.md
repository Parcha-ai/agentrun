---
packages: @parcha/pi-transport
kind: ci
---
The box-env offline tests no longer leave a `sleep 3600` running after a run: a test that held a process group of its own ended the shell that started it, not the group. The file now marks its own process, so every child it starts carries the mark, and an after-all check fails the file, naming each process it left behind, if any survives it.
