---
packages: @parcha/agentrun-serve
kind: fix
---
A run a paid call stopped for good (a fal job settled past the cap, a monid charge above its hold) now stays stopped when a call that passed the tool gate beside it is admitted after the stop and refused for room. Before, that refusal replaced the stop, so a script's next call ran; the run still ended failed at its next model request.
