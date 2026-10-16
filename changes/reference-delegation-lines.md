---
packages: repo
kind: feature
---
The supervisor writes `delegation` host lines from `place.status()`'s `delegations` when one appears or its orphaned or pending state changes, and a `revoke` line from `recover()`'s `{ revoked, ms }`; a place without them writes none.
