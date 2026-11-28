---
packages: @parcha/agentrun-serve
kind: feature
---
`AGENTRUN_NO_COST_WORDS=1` serves a run's Timeline rows with no cost in their words, for a backend that prices runs its own way. The usage row reads "2 model requests and 1 paid tool call" where it read "Cost: $0.0624 over 2 model requests and 1 paid tool call", a paid tool's row reads "mcp:fal/run_model via fal" where it read "Tool cost: fal charged $0.0600 for mcp:fal/run_model", the over-cap row reads "Over the run's cap", and a reply the cap cut short reads "…: all that was left of the run's cap could buy.", with no figures. Each row's `usage` is unchanged, so a reader that shows a cost reads it there. It covers `GET /v2/runs/{id}/timeline`, its stream and the run's export. Unset, every row reads as before; any value other than `1` or `0` stops the start.
