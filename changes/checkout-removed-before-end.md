---
packages: @parcha/agentrun-serve
kind: fix
---
A run's pull request checkout is removed from its folder before the run's end is committed, so a run that reads completed never still holds the pull request's code in its folder. Before, the removal ran at the claim's release, after the end, and for that window a finished run's folder kept the checkout.
