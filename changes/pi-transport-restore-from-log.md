---
packages: @parcha/pi-transport
kind: feature
---
A session whose box is gone can be restored from the host's log alone (`./home`): `recoverHome({ ..., restoreFromLog: true })`, when no
checkpoint checks out, replays every shipped commit from the first into an empty store, gives the new box an empty workspace and takes
the lease at the next epoch. A job that never rests takes no checkpoint, so before this its whole-box loss was `no_checkpoint`. It needs
a log whole from commit 1, is off by default, and the model is told that no checkpoint existed and no file came back.
`restoreNotice(undefined, ...)` makes that text.
