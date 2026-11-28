---
packages: @parcha/agentrun-computer
kind: fix
---
A Groundbox computer says what it was given: its vCPUs, memory and disk, as Groundbox's own answer for the sandbox says them (`CreatedComputer.resources`). A sandbox made with no size named was priced by nothing, since only Groundbox's answer says the size it gives then; its computer time is now counted and priced like a sized one's.
