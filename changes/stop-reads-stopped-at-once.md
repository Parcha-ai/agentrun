---
packages: @parcha/agentrun-serve
kind: fix
---
A run a person stops no longer reads as waiting on them with nothing to answer. Before, for up to half a second after the runner cut the turn and before it ended the run stopped, `GET /runs/{id}` could read `input_required` and `idle` with nothing pending. Now a stop that is accepted and not yet applied reads stopped as soon as nothing in the run is working: at once for a run waiting on an approval, a person or a browser, and from the turn's cut for a run mid-request (until then it reads working, so its cost is never the known sum while the cut request is still unbooked).

While the stop is not yet applied, every tool call still waiting for approval reads withdrawn in the timeline, as an answer sent then is already refused with `withdrawn`. The `run.needs_input` webhook tells the stop once, after the run's end, as before.
