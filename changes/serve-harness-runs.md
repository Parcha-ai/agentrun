---
packages: @parcha/agentrun-serve
kind: feature
---
**Runs on claude-agent and codex, durable in the run's own store**
- An agentic revision whose `harness` is `claude-agent` or `codex` runs on that harness's adapter in the run's own process, behind the run's door: a message starts a turn, a message during a turn waits for its end, a stop interrupts. The session is kept in the run's store, so a run whose process dies mid-turn resumes on the next one.
- Every paid request is booked once by the adapters' runner booking and shows in the timeline as one model request with its cost, as for pi; a request cut by a crash, or one whose price is unknown, makes the run's cost unknown, never 0. A run opened again reads the cost of all its openings, unknown included.
- Such a run gets pi's own `read`, `write` and `edit`, with pi's confinement to the run's workspace; `read` may run again after a crash, `write` and `edit` never. `ask_person` stays pi's: on another harness it is a warning, and its runs are refused.
- `--faux-harness MODULE` (`fauxHarness` for `startServe`) runs every harness but pi on a scripted faux harness, for tests.
