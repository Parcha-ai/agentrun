---
packages: @parcha/agentrun-serve
kind: fix
---
Daytona and E2B sandboxes start on a server with the default box allow-list. A run's computer now asks for a network its provider makes, as the provider declares it: a remote computer, which makes only network `none`, gets `none` instead of the allow-list it refused at create; Docker keeps the run's list. Its lifetime is capped at the provider's longest (an E2B computer lives at most an hour), which E2B also refused before.
