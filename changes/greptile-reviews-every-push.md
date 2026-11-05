---
packages: repo
kind: ci
---
Greptile reviews every push to a pull request, not only its opening (`greptile.json`, `"triggerOnUpdates": true`). A later push no longer waits for someone to ask for another review. Every other review setting stays as the Greptile dashboard has it.
