---
packages: @parcha/agentrun-serve
kind: fix
---
A spend cap's wrap-up told before the run's own model has a priced request (a small cap on a pricey model, due at its first request) now says "This run's budget is about $X, enough for little work: answer as soon as you can." instead of asking it to finish before it has started. Later it says, as before, "About $X left of this run's budget: finish now with your answer." Both read from the same priced requests live and after a restart.
