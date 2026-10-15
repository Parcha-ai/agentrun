---
packages: @parcha/pi-transport
kind: feature
---
`moveHome` and `recoverHome` (`./home`): a session's home moves between boxes with no shared disk in seven
steps, the take of a numbered lease the one point of no return; a host that starts again finishes the move from
the lease, which keeps the move's id and the seal; the store keeps the workspace it last ran in. A home holds its
store alone: a second runner at the same place is `busy`, and `recoverHome` stops a runner still running there first
(`stopRunner`). `boxRunner` starts a runner in a box over its own `exec`. A session can move back to a place it left.
Recovering a home sealed at the lease's epoch first takes the next epoch for that place, so it moves the epoch; when a
move took that epoch first, recovery is `lost`, opens nothing, and says where the lease puts the session.
`registerMoveConformance` (`./testing`) kills the host, the source or the target before each step.
