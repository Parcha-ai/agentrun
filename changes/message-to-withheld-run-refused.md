---
packages: @parcha/agentrun-serve
kind: fix
---
A message to a run whose launch's sealed part doesn't open under this server's seal key (the key changed or is missing, or what was sealed is damaged or lost) is refused: `409 not_continuable`, `details.reason` `withheld`, and nothing is written. A trigger's firing that messages such a run is skipped with the same words. Before, the message was written with none of the run's handed keys cut from it, so a message that repeated one showed it in the run's view, timeline and share once the run ended. Start a new run of the agent to go on.
