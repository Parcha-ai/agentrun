---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: fix
---
A learned workflow this release's DSL refuses is held with the DSL's reason and recompiled once; it no longer reads `serving` while every run hands back.
  - The first run a refused revision serves hands back as before, and writes one promotion hold for that digest: `reason` "this release's workflow DSL refuses it: <code> at <path>: ...", cut of the host's secrets, with neither `check` nor `audit`. Concurrent and later runs write nothing more; the agent takes them. The promotions read says `held`, and the agent's next run asks the one recompile with that reason; a recompile that is held again stops.
  - Shadow audits draw only runs the workflow answered alone (path `workflow`). A run it handed back is never drawn and never counts as a served run for `learning.audit_later_after`, `learning.stop_window` or `not_auditable`.
