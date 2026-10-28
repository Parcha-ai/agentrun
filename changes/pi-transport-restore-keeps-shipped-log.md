---
packages: @parcha/pi-transport
kind: fix
---
`recoverHome` no longer loses the commits shipped after a checkpoint when it cannot replay them. A log that could not be read, a commit that did not apply (also after some did) or a replayed store that could not be sealed was taken for "nothing shipped": the restore brought back the checkpoint alone and dropped those commits from the host's log. It now fails with the new `MoveError` code `replay` before it makes a box, and the log keeps every shipped commit, so a later recovery can replay them. A log that does not start where the checkpoint ends, and the commits beyond a break, are handled as before.
