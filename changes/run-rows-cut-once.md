---
packages: @parcha/agentrun-serve
kind: fix
---
A run's rows are cut of its held values once per text, not once per read. A reader that follows a run (the console's live Timeline, a run's view polled) renders its rows on each change, and each render cut every text of the run again, so a long run cost the server work that grew with the square of its turns and slowed the run itself: a run of 61 web searches spent most of its time redacting what it had already redacted. A second read now cuts no text again; a key saved, rotated or reordered since cuts them all again, what is kept is bounded at 32 MiB per store (the oldest dropped first), and a deleted or purged run's texts are dropped from memory with its answer.
