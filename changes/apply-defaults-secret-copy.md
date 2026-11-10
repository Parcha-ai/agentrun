---
packages: @parcha/agentrun-serve
kind: fix
---
Template Apply fixes from QA on the release:
- `kyb`'s risk appetite and `inbound-lead`'s destination take their documented defaults when left out (medium; none), so Apply shows "medium (default)" and "none (default)" instead of refusing them as required.
- The owner's first apply answer, which shows each webhook trigger's signing secret, no longer also says the secret is not shown. An API token's answer, or a retry, still says where to get it.
