---
packages: @parcha/agentrun-serve
kind: ci
---
The webhook ledger test closes its first server once each try has its answer, not once the receiver has the request, so a slow CI runner no longer cuts a try and gets the message twice; the test is out of quarantine.
