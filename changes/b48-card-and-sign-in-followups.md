---
packages: @parcha/agentrun-serve, @parcha/agentrun
kind: fix
---
The share-card renderer draws what it is given:
- A columns chart of a year by day draws every column. Past about 268 bars it drew none.
- Under a title that wraps, the rows drop from the end, in reading order. Before, the 3rd and 6th rows went missing from the middle. `cardCapacity` says how many rows draw, beside each chart's bar count.
- The image's alt text reads only what is drawn, each value as its bar shows it.

A ChatGPT sign-in that fails with an authorize code its step never sends (any local process can answer the sign-in's callback) is said on the terminal as `authorize_other`. The server's log keeps the code. A sign-in's change that the server failed to take is taken again one read at a time, so reads at once no longer each relist and probe.
