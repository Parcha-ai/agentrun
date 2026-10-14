---
packages: @parcha/pi-transport
kind: feature
---
`moveHome` and `recoverHome` (`./home`): a session's home moves between boxes with no shared disk in seven
steps, the take of a numbered lease the one point of no return; a host that starts again finishes the move from
the lease, which keeps the move's id and the seal; the store keeps the workspace it last ran in.
`registerMoveConformance` (`./testing`) kills the host, the source or the target before each step.
