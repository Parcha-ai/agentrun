---
packages: @parcha/agentrun-computer
kind: fix
---
Conformance runs on groundbox, smol cloud and boxd now report a release whose run folder was not let go cleanly, as the other hosted providers already did. The drifted twins of E2B and Modal report it too. An E2B run keeps a `COMPUTER_E2B_MAX_LIFETIME_MS` shorter than 30 minutes instead of raising it to 30, and `COMPUTER_E2B_MAX_LIFETIME_MS=0` is refused in words instead of silently giving 30 minutes.
