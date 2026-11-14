---
packages: repo, @parcha/agentrun-computer
kind: feature
---
Computerd's `screen.watch` on a Linux desktop sends a frame when the screen changes, up to 15 a second, in place of reading the whole screen every 200 ms. It learns what changed from the X server's DAMAGE extension and reads only that rectangle; a screen that does not change costs no reads. A server without DAMAGE is still read every 200 ms. Hello lists a new feature, `screen.ahead`: such a computer takes a second ask one frame past the newest (`after` = newest `seq` + 1), which waits as an ask for the newest frame does. `watchScreen` keeps two asks in flight on a computer that lists it, so frames come at the screen's pace and not one each round trip; on any other computer it asks one frame at a time, as before.
