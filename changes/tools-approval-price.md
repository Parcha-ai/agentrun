---
packages: @parcha/agentrun-serve
kind: fix
---
A `monid.run` approval card shows its price, on every harness.
- Before, the card for a `monid.run` call asked for approval with no price, although the call is held at a known figure.
- The card now shows what the call is held at: the price an `monid.inspect` in the run quoted for that endpoint, else the $1 allowance a run with no quote is held at. It is the same figure the run's cap and ledger count the call at.
- Other tools' cards are unchanged.
