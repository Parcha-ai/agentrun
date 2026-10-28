---
packages: @parcha/agentrun-dsl
kind: fix
---
Under `withRecovery`, a decision is never paid for twice across a crash. Each request to the host's `runJudge` is committed as a `decision.request` before the judge is asked, and ends with one outcome: `answered`, or `failed` in its own process (asked again by the next as its next attempt). A later process that finds a request asked and never answered (its process died, or a cancel cut the call) does not ask again: it books the request `interrupted` at an unknown cost (`cost_usd: null`, never 0) and ends the run escalated, with kind `decision_interrupted` (exported as `DECISION_INTERRUPTED`) and stage `decision`, for review. A decision whose answered receipt the host keeps still replays from it at no cost. A pause now waits for a decision in flight to finish, as it waits for an effect.
- The driver keeps the requests in its frame by node path (`decisions`, optional in older checkpoints), so a map item's requests live in its own record in the keyed layout. `driver.decisionRequests()` reads them back.
- A host that keeps no decision receipts now escalates, instead of asking again, when an answered decision's node never committed: that answer was paid for and is lost.
