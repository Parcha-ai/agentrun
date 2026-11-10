---
packages: @parcha/agentrun-serve
kind: fix
---
A run's live view no longer holds a secret the runner holds. The live view (the running tools with their arguments and the output they have streamed so far, and the answer still being written) was written as the run's tools and model produced it, so a tool that echoed a key, or an answer that quoted one, put it there in the clear, where the live stream a console watches served it.
- Every value of a run's live view is now cut with the run's one redactor before it is written: the same one its record's text goes through, holding the runner's secrets and every key the run's claim opened.
- A run whose loop has no redactor has no live view at all, rather than an uncut one.
