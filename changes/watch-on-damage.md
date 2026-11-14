---
packages: repo, @parcha/agentrun-computer
kind: feature
---
Computerd's `screen.watch` on a Linux desktop sends a frame when the screen changes, up to 15 a second, in place of reading the whole screen every 200 ms. It learns what changed from the X server's DAMAGE extension and reads only that rectangle; a screen that does not change costs no reads.
