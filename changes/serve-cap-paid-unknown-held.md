---
packages: @parcha/agentrun-serve
kind: fix
---
Under a `max_cost_usd`, a `monid.run` that may have charged and says no cost (stopped by the run's stop, past its wait, `TIMED_OUT`, `FAILED`, or one whose sending failed) now counts at what it was held at (the price an inspect quoted, else the $1 allowance), the same bound the cap let it go at. Before this it made the run's spend unknown, so every later model request and paid call was refused with `spend_cap_reached`, in the run's process and in one opened again from its store. A capped run whose monid call is stopped or times out now goes on while its cap allows, on pi, claude-agent and codex alike. Its cost still reads unknown (`null`), and `/usage`'s `tools` meter does too: the hold is the cap's bound, never a charge.
