---
packages: @parcha/agentrun-kernel
kind: fix
---
The parent-watch shim (`parentWatched`'s `shim` watch, used where `setpriv --pdeathsig` is not) takes TERM, INT and HUP before it starts its child. Before, a TERM that reached it in the moment after the child started ended the shim alone and left the child running with nothing watching it: a Claude sign-in stopped as it opened kept its CLI.
