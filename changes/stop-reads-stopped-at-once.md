---
packages: @parcha/agentrun-serve
kind: fix
---
A run a person stops reads stopped from the moment the stop is accepted. Before, for up to half a second while the runner cut the turn, `GET /runs/{id}` could read `input_required` and `idle` with nothing pending, a run that seemed to wait on its person with nothing to answer.

While the stop is not yet applied, every tool call still waiting for approval reads withdrawn in the timeline, as an answer sent then is already refused with `withdrawn`. The `run.needs_input` webhook tells the stop once, after the run's end, as before.
