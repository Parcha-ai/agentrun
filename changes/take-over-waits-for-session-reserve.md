---
packages: @parcha/agentrun-serve
kind: fix
---
Runs with a spend cap: an owner who takes over a run's browser just as the agent's call that opened its session returns no longer takes the room that call kept for the session's reserve. Before, the take-over could be held in that room and the reserve refused, so the run paused at its cap for a step the agent never took. The take-over is now judged once the reserve is held, and refused in the cap's words when the two don't both fit.
