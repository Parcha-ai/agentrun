---
packages: @parcha/agentrun-computer
kind: fix
---
A Daytona computer on connect dial now has the session buses in `/tmp` (`/tmp/dbus-*`) closed to its user before `agentrun-dial` starts, as on exec and on E2B's dial. Its session command runs the same launch line as E2B's dial, the steps joined by `&&`, so a step that fails starts nothing and the machine never dials.
