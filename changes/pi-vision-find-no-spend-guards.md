---
packages: @parcha/pi-vision
kind: fix
---
The `find` skill drops its spend guards: the "request budget" section and its host-cap framing, `maxJudges`, the per-step `budgetUsd` and every `stopped: "budget"` path with the reserve of three requests, and the request counting that served only them. The search strategy stays: a coarse pass of 40 frames, halving around the candidate, then the three-frame check. Each score and each completed check is still saved as it comes, so a run cut short asks nothing twice, and the price of the search is still reported. How much a run may spend is the host's single dollar stop, not the skill's.
