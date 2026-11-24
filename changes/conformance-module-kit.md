---
packages: @parcha/agentrun-computer
kind: fix
---
Conformance runs on groundbox, smol cloud and boxd now report a release whose run folder was not let go cleanly, as the other hosted providers already did. The drifted twins of E2B and Modal report it too, dial as the run's provider does, and Modal's twin keeps the computer kind. An E2B run keeps a `COMPUTER_E2B_MAX_LIFETIME_MS` shorter than 30 minutes instead of raising it to 30.
