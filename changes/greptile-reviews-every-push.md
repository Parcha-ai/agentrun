---
packages: repo
kind: ci
---
Greptile reviews every push to a pull request, not only its opening (`greptile.json`, `"triggerOnUpdates": true`). A push that adds commits is reviewed as it lands, so nobody has to ask for another review. Every other review setting stays as the Greptile dashboard has it.
