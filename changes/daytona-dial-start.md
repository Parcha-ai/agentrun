---
packages: @parcha/agentrun-computer
kind: fix
---
A Daytona computer on connect dial dials from a box snapshot registered without an entrypoint. Daytona runs a snapshot's entrypoint, never the image's CMD, so a snapshot made from the published box image with name, image and resources alone never ran `agentrun-dial`, and create failed after 120 s with a bare "did not dial". Daytona's create now leaves `AGENTRUN_ATTACH_URL` out of the sandbox's env, waits for the sandbox to read `started`, and starts `agentrun-dial` itself in a toolbox session of its own, the URL on its command's line and the token in the env alone. A snapshot whose entrypoint is the box CMD sleeps instead, so `agentrun-dial` never runs twice.
- A dial machine that never dials now fails with what `agentrun-dial` wrote (`; agentrun-dial said: <its last 10 lines>`), or `; agentrun-dial never started`, read through the new optional `MachineHost.dialLog`. Daytona's is the session command's log, the machine's token replaced by `<token>`. A host without it keeps the old message.
- A session Daytona refuses, or a sandbox it fails while starting, fails create in Daytona's words, and the sandbox is deleted.
