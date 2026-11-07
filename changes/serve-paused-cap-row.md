---
packages: @parcha/agentrun-serve
kind: fix
---
A run paused at its spend cap says the cap's sentence once, in `pending.said`. Its timeline's row for the refused request is now the server's `phase` row, "Paused at the run's cap", marked `paused: true`, with `origin: "server"` and its id ending `:note` (so it counts as no message, as the wrap-up's row), in place of an `error` row that repeated the sentence. The waiting row still follows it while the run waits; once the cap is raised the phase row stays, as the run's history, before the follow-up's message. A refusal that fails the run (one no cap fixes, such as a model with no output ceiling) stays an `error` row, without the marker, and so does the end-of-run learning turn's refusal, which pauses nothing. The row is read from the refusal and the run's kind, never from the run's status, so it is the same live, on a full re-read and from a server started again.
