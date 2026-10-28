---
packages: @parcha/pi-transport
kind: fix
---
**`moveWorkspace` no longer refuses a correct copy of a file whose time is just short of the next second**
- The target check compares a file's whole seconds, the part a tar header keeps. It read them as a number, so a source time in the last ~120 ns of a second rounded up to the next second, and a copy that was right failed with `mismatch` ("has another modification time"). It now reads the seconds from the time's text. The message names both times.
