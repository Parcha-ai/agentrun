---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: feature
---
A run whose cost isn't fully known now says what it cost so far and how many charges have no price, instead of a bare "unknown". This covers a stop, a cancel, a request a crash cut, a cost still pending, a model with no price, or a paid tool charge no one knows. `cost.usd` stays null, so nothing reads a partial sum as the cost. Beside it, `so_far_usd` is the sum of every charge whose cost is known, and `unpriced` counts the charges that have none: model requests, a workflow's decisions, and paid tool calls. Both are present only while `usd` is null, on the run, the run list and the timeline's usage row (`x-agentrun-serve: "costsofar/1"`). No ceiling is claimed. The usage row's summary reads "Cost so far: $0.0123 known, 1 not priced, over 7 model requests".
- A run that ended with its cost unknown keeps both figures in its meta file, so its list row says them after the server no longer holds it. The agent store is unchanged, and so are `/v2/usage` and `/v2/stats`.
