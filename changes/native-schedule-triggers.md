---
packages: @parcha/agentrun-serve
kind: fix
---
A schedule (or any other) trigger can now start a connected agent's runs (`native connect`, Claude Code or Codex). Before, every trigger run had to be capped in dollars, and a connected agent refuses a cap because its own CLI keeps its own limits, so a trigger on one was refused at creation without a cap and every firing was refused with one. A trigger whose target is a connected agent now needs no `max_cost_usd`, and refuses one (on the target or as the agent's default) with `422 not_allowed`. Its runs start uncapped, as a connected agent's runs started by hand already do. An `effort` on such a target is refused the same way, as the run start refuses one. Every other trigger's runs are still capped.
