---
packages: repo
kind: fix
---
Computerd's desktop `screen.watch` counts its 15-a-second cap from the start of each frame's read, so reading and encoding a frame happen inside the gap and are no longer added to it. On E2B and Agent37 desktops a 1280x800 frame's encode takes 20 to 30 ms, and a screen that changed all the time got 10 to 11 frames a second where it should have had 15.
