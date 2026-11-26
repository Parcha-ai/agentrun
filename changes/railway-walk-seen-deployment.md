---
packages: repo
kind: ci
---
The Railway template walk's timeout report now names the last deployment it saw even when a later poll lists none. Before, a deployment list that went empty during the 20-minute wait made the report say Railway listed no deployment.
