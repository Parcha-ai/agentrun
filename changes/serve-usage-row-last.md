---
packages: @parcha/agentrun-serve
kind: fix
---
The usage row (`Cost so far`) is always a run's last timeline row. It used to keep the place it first appeared, after the run's first answer, while its count and timestamp moved on with every answer after, so it sat above rows it postdated. When a row is served after it, it now moves to the end with a new `seq`, a change a cursor sees.
