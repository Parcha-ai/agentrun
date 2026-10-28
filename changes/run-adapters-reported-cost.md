---
packages: @parcha/agentrun-adapters
kind: feature
---
A paid request whose response reports its cost is booked at that figure: `reportedCostOf` reads a gateway's cost header (LiteLLM's `x-litellm-response-cost`, or its `-original` when the discount and margin it reports are both 0) as the response's headers arrive, and the host's price table's figure is kept beside it as `tableUsd`. Only a positive number counts. A missing, malformed or zero figure (a streamed answer's headers leave before it is priced, and say `0.0`) leaves the table to decide, and that booking is now marked `estimated`. A run's `runner.turn` records keep `estimated` and `tableUsd`.
- A host that reads `estimated` now sees it on table-priced requests too, not only on an unknown cost.
