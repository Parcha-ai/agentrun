---
packages: @parcha/agentrun-computer
kind: fix
---
A `screen.shot` cancelled while the X server is slow to send the image now answers aborted at once and gives the display back. Before, its reads of the screen's size, the image and the pointer each waited up to 30 s with no look at the cancel, and every later `screen.shot` and `input.actions` on that display waited behind it. The connection to the display stays open: the late answer is read past and dropped, and an error it brings is not taken for one of the next batch's requests. A cancelled `screen.watch` stops its read of the screen the same way, and a cancelled `input.actions` stops if it is cancelled during its first read of the screen's size, before it has pressed anything. One case stays as before: a shot cancelled while its request is still being written, to a server that has stopped reading, waits out that write's 30 s bound.
