---
packages: @parcha/agentrun-web, @parcha/agentrun-serve
kind: fix
---
A provider setting named `constructor` or `__proto__` is now reported as a setting the provider does not take; before, checking it threw. The server holds a keyless provider for at most 25 hours from now, even when its Retry-After or reset names a later time.
