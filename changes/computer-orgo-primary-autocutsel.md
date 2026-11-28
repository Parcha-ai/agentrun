---
packages: @parcha/agentrun-computer
kind: fix
---
On an Orgo Linux desktop, a cut or copy of files in a file manager now survives a text selection before the paste. Orgo's desktop runs two `autocutsel`s as root, one for CLIPBOARD and one for PRIMARY, and both sync through the X cut buffer. Selecting text (Ctrl+L selects a file manager's location) set PRIMARY, the PRIMARY one copied that text into the cut buffer, and the CLIPBOARD one then replaced the clipboard with it, so Ctrl+V pasted the location's text instead of the files (`linux.files.move` failed on Orgo every time). Before any tool runs, create (and an attach that installs the daemon again) now ends the process whose whole command line is `autocutsel -fork -selection PRIMARY`, and says so in its notes. The CLIPBOARD one keeps running, so the clipboard still reaches Orgo's VNC viewer. If that process outlives SIGTERM, the create is refused and the computer deleted.
