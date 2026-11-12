---
description: The same PR after a fix commit, with the earlier finding in previous_findings; the review does not repeat it and resolves it.
runs: 3
max_cost_usd: 0.10
---
Review this pull request again. Its head is now 6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192; last_reviewed_sha was 1f0c6a3d2b9e8f7a6c5d4e3b2a1908f7e6d5c4b3. There is no checkout, the diff below is the whole PR at the new head.

previous_findings:

```json
[{"fingerprint": "src/users.js:displayname:null-deref", "path": "src/users.js", "line": 3, "priority": "P1", "failure": "user can be undefined when no user has the id, so user.name throws", "state": "active", "reply": null}]
```

```diff
--- a/src/users.js
+++ b/src/users.js
@@ -1,4 +1,4 @@
 export function displayName(users, id) {
   const user = users.find((u) => u.id === id);
-  return user ? user.name : "unknown";
+  return user ? user.name.trim() : "unknown";
 }
```
