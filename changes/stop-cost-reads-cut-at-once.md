---
packages: @parcha/agentrun-serve
kind: fix
---
A run stopped mid-answer reads its cost as unknown plus what is known so far, with the stopped request as one charge with no price, from the moment it reads stopped. Before, until the turn's end reached the server from the run's process, it read the known sum as its cost (`cost.usd` the earlier turns' total, no `unpriced`). The served cost and the usage row only: the spend cap's reads (the run's store) and its bounds are unchanged.
