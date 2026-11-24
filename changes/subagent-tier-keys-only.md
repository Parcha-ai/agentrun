---
packages: @parcha/agentrun-serve
kind: fix
---
A run that grants the subagent tool now gives its subagent tiers only the saved model keys of the models those tiers run on (the revision's `model_tiers`, else `AGENT_MODEL_FAST` / `AGENT_MODEL_STRONG`), or the gateway's key behind a gateway. That holds whether the run has a process of its own, which is now handed only those keys, or routes its tiers in the runner. It used to hand every saved model key. A tier whose provider has no saved key fails on that tier with words saying so, and never falls back to another key.
