---
packages: @parcha/agentrun-serve
kind: breaking
---
A forgotten browser sign-in's pointer is kept for good (the server kept only the newest 32 per agent), so what an agent learned and what a run it was handed shows stay cut of it however many sign-ins are forgotten since. A run handed a pointer the server would have dropped is now served cut instead of withheld. Pointers dropped before the upgrade are gone and not read back from anywhere, so they are not cut.
Upgrading: if an agent forgot more than 32 sign-ins before the upgrade, read its learning for a sign-in pointer it forgot long ago and retire any note that holds one.
