---
packages: @parcha/agentrun-serve
kind: docs
---
The serve README's spend cap section says why a stopped request on a Claude model that thinks adaptively counts its whole thinking budget: the provider reports the thinking it billed only at the end of its stream, which a stopped stream never receives, so that budget is the safe figure.
