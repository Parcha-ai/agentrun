---
packages: @parcha/agentrun-serve
kind: fix
---
With `learning.repick: true`, a learned workflow whose answer is written by a composed workflow now re-picks from the pages in that composed workflow, where before it was committed as compiled without a word. A re-pick the rewrite still does not reach (one that is not a single model step, or whose marker names are taken) is kept as compiled, and the server's log says so.
