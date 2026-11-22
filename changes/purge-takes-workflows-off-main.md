---
packages: @parcha/agentrun-serve
kind: fix
---
A run's purge takes each learned workflow whose `workflow.json` it changed last off main, its README.md too, so both file reads are `404`, the learning view no longer lists it, and the next compile turn is never asked to revise its text. Before, its README.md and description were still served and a held revision of it went into the next run's compile prompt; a run purged before this takes its workflows off when its `DELETE` is sent again.
