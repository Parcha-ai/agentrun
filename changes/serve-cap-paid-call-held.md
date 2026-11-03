---
packages: @parcha/agentrun-serve
kind: fix
---
Under a `max_cost_usd`, a `monid.run` under way holds what it is held at (the price an inspect quoted, else the $1 allowance) until its charge is in, and a model request checked meanwhile counts it beside what the run has spent, on pi and on claude-agent and codex. Before this, a model request sent while a paid call was out was checked against the spend alone, so the two together could pass the cap. A paid call that fails without an answer counts at its held figure in the run's process, as its unsettled mark already counts once that process is gone.
