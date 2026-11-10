---
packages: @parcha/agentrun-serve
kind: fix
---
A run's live view no longer holds a secret the runner holds. The live view (the running tools with their arguments and the output they have streamed so far, and the answer still being written) was written as the run's tools and model produced it, so a tool that echoed a key, or an answer that quoted one, put it there in the clear, where the live stream a console watches served it.
- Every value of a run's live view is now cut with the run's one redactor before it is written: the same one its record's text goes through, holding the runner's secrets and every key the run's claim opened.
- Output still streaming and the answer still being written hold back a tail as long as a held key's widest form, so a key paused halfway at a write shows none of itself; the settled record replaces it once it ends. A tool argument that is a held key written as a number is withheld, as is an argument object two of whose names would come out the same once cut.
- A run whose loop has no redactor, or one that does not know its values, has no live view at all, rather than an uncut one.
