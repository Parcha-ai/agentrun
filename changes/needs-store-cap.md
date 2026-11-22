---
packages: @parcha/agentrun-serve
kind: fix
---
A stored agent body refuses a sandbox's `computer.needs` of more than 32 programs, as the API already did, in the API's words: the store, the API document and a template's `needs` now read one rule.
