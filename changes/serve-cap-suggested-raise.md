---
packages: @parcha/agentrun-serve
kind: fix
---
The raise a run paused at its cap is offered (`pending.suggested_cap_usd`) scales from what it needs: `spent_usd` plus 10 times `needs_usd`, still rounded up to a whole dollar from a dollar on, but under a dollar, for a cap under one, rounded up to the cent. A $0.0002 cap needing $0.0024 is now offered $0.03 instead of $1.
