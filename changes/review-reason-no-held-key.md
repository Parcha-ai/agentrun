---
packages: @parcha/agentrun-serve
kind: fix
---
An escalated workflow run's review reason, its escalate node's summary interpolated from the run's input, is served with no held key in it, on the run's page and in the runs list (Mission Control's), and a key saved after the run ended is redacted from the next read.
