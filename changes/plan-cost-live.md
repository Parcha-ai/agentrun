---
packages: @parcha/agentrun-serve
kind: fix
---
A live run on your Claude plan (or a ChatGPT plan) no longer reads "not priced" while a request is in flight: the run's cost counts that request at $0 on the plan, as the ended run does, so the header reads its tokens and "On your Claude plan" and the timeline's "Cost so far" counts no plan request as not priced.
