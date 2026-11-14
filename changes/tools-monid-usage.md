---
packages: @parcha/agentrun-serve
kind: feature
---
monid endpoints priced by usage (per result, per unit, metered, or a matrix or tier with a usage part) can be granted again, by name and through `monid:<provider>/*`. A run's spend cap is a hard stop for everything except the charge of one such call, which can pass its estimate; when it does, the run stops at once.
- They are pinned at the save like fixed-price endpoints, and the save's `warnings` name each one (`reason` `priced_by_usage`): "monid:<provider>/<endpoint> is priced by usage: monid can't cap what it charges, so a call can cost more than its estimate and more than the run's cap allows." A wildcard no longer leaves them out, and a provider priced only by usage no longer refuses the save.
- Each call is held at monid's estimate for its own input. AgentRun reads the estimate by sending the call with `maxCost` 0, which monid refuses unrun and uncharged, naming the estimate. It then sends the call with that estimate as `maxCost`. A call monid estimates at $0 is a free run that `maxCost` 0 lets through, so reading its estimate runs it, held at $0. That read's charge is booked under the call; a charge above $0 stops the run as below, and the call is refused rather than asked.
- The approval card reads "Priced by usage, about $X (monid's estimate), can cost more". The run's `pending.price` is `{estimate_usd}`. The estimate is read when the card is first made. An answer after the run parked reads nothing again, and a stop or a lost claim cuts the read off.
- A charge above the estimate is booked as charged, and the run ends failed with "monid charged $X, more than the $Y held; the run stopped".
- An endpoint monid has moved to usage pricing since the save is no longer refused per call. It is held at its pinned price and sent with that as `maxCost`, so monid runs it only at an estimate within the price its card showed. A charge above it stops the run as above. A fixed-price call that does not fit the cap is refused before anything is sent to monid, as before.
- The controls are which endpoints an agent may call: named grants, `monid:<provider>/*`, and deny or ask per tool.
