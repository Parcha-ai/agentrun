---
packages: @parcha/pi-transport
kind: fix
---
`launchStop` no longer waits out a 15-second lock that a killed watchdog's last command took after the stop removed it. The stop ended the supervisor's and the watchdog's shells alone, and a command the watchdog was running, the `mkdir` of its output's trim lock, lived on: when it ran after the stop removed the lock, it took the lock with no live holder, and the stop's own trim waited until the lock broke (16 s on a loaded runner). With `setsid`, the stop now kills each one's process group, which holds what it started, and goes on once the groups are empty; without it, the stop stops each shell, kills its children and then it, and goes on once they are gone. Either wait ends after 2 s at most. Clearing a launch directory ends them the same way.
