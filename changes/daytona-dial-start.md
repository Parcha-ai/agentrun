---
packages: @parcha/agentrun-computer
kind: fix
---
Daytona on connect dial starts `agentrun-dial` itself in a toolbox session once the sandbox reads `started`, so a box snapshot with no entrypoint dials. A dial timeout now ends with `agentrun-dial`'s last lines (`MachineHost.dialLog`), the token replaced.
- A session Daytona refuses, or a sandbox it fails while starting, fails create in Daytona's words, and the sandbox is deleted.
