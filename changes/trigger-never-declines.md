---
packages: @parcha/agentrun-serve
kind: fix
---
A trigger's message to a run that waits on its person (a tool call parked for its owner's approval, a question, a pause at its cap) is refused and its firing skipped, "The run is waiting on a person.", even while another message to the run is in flight: it never declines the approval, nor answers. A person's own message still declines a parked call, as before. Upgrading: nothing to do.
