---
packages: @parcha/agentrun-serve
kind: fix
---
A run's spend cap reads on the runner as it did before the cutover:
- A run paused at its cap shows the server's row "Paused at the run's cap" on its timeline, and, while it waits, "Waiting for you to raise the cap". The banner keeps the pause's sentence (`pending.said`). Before, nothing on the timeline said the run had paused.
- A run whose booked spend passed its cap shows by how much, after its usage row ("Spent $0.50, $0.20 over the run's cap of $0.30"), or that a cache miss did it within its bound.
- A run that passed its cap (`spend_cap_reached`) keeps the answer it paid for as `result.final_answer`, cut as it came. Before, its result was null.
- A run on a model with no price (a `--faux` module whose `cost` is `"unknown"`) costs unknown (`null`), never $0.
- Upgrading: nothing to change.
