---
packages: @parcha/pi-transport
kind: fix
---
The tests of "a phase that moves no byte is not a stall" no longer race on a loaded machine: once a slowed setup call ends, tar has the stall limit to move a first byte, and 25 or 400 ms is less than the spawn of a real process can take on a busy runner (a failure of the form "no byte moved for 25 ms, after 0 bytes" on other pull requests). The limit is now one second and the slowed phase is three times that, so the claim is tested with no scheduling noise. Tests only.
