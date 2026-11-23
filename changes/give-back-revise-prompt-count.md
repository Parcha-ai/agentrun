---
packages: @parcha/agentrun-serve
kind: fix
---
A connected agent's give-back hold now says "1 of your inputs was checked before it was held" in its revise prompt, where it used to say "were". The README now says two failed revise drafts stop such a hold. It no longer says the hold is "never stopped for good", and it names both kinds of give-back that are never counted: a cancel, and a start that was never admitted. The eve-learning example works out its task count from its own `compile_after` in place of a fixed "thirteen".
