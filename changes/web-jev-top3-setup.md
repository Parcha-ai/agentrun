---
packages: @parcha/agentrun-web
kind: feature
---
A new Jev setup, `"top3-best300-found8"`: the 3 most relevant search results stay whole, each later one shows only its passage (at most 300 characters) Jev scores most likely to hold what the search needs, and a fetch's objective keeps 8 found chunks, as `"shipped"` does. Pick it with `jevWebDecider(jev, "top3-best300-found8")`. The default stays `"shipped"`.
