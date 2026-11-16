---
packages: @parcha/agentrun-computer
kind: feature
---
E2B and Modal computers can dial the server instead of being reached through the vendor's exec: set `connect: "dial"` (the server's `e2bConnect` or `modalConnect` setting, or `COMPUTER_E2B_CONNECT` / `COMPUTER_MODAL_CONNECT` for the conformance modules). Exec stays the default. On dial a Modal sandbox runs the box image's `agentrun-dial` with the boot env as a Modal Secret; an E2B sandbox has `agentrun-dial` started once by create, since a template's start command never sees a create's env. Both take kind linux alone and no Archil mount on dial, and their conformance modules' `dialKit()` refuse: a dial machine's Core run happens inside the public server's process. On dial each module's run image is the box image, which holds `agentrun-dial`.
