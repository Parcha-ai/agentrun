---
packages: @parcha/agentrun-serve
kind: fix
---
A key a run brings in `keys` or `model_key` is text of 8 or more characters with no space or control character: a shorter one could not be cut from what the run writes, so it is now 422 `invalid` at `keys.<NAME>` or `model_key`, the value never echoed. With `AGENTRUN_RUN_KEYS=1`, no trigger is made whose firings would run an agent without the tool keys each of its runs must bring: a template's apply skips such triggers with a warning at `triggers.<N>` (`not_set_up_here`, the apply still 201) unless the launch hook is set, and `POST /v2/triggers`, or a `PATCH` that moves a trigger, is 409 `agent_not_runnable` naming the keys for one that would start such runs with no hook, or message one of them.
