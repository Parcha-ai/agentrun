---
description: After a force-push, a new defect one line above a finding the author dismissed, in the same function; the review reports the new one and does not raise the dismissed one again.
runs: 3
max_cost_usd: 0.30
---
Review this pull request again. Its head is now 7081928a3b4c5d6e7f8091a2b3c4d5e6f7081929. The branch was force-pushed, so the head last reviewed, 6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192, is no longer in it: last_reviewed_sha is none. There is no checkout, the diff below is the whole PR at the new head.

previous_findings:

```json
[{"fingerprint": "src/users.js:displayname:null-deref", "path": "src/users.js", "line": 3, "priority": "P1", "failure": "user can be undefined when no user has the id, so user.name throws", "state": "dismissed", "reply": "Declining: displayName is only called with ids taken from this same users list, so find never misses."}]
```

```diff
--- a/src/users.js
+++ b/src/users.js
@@ -1,4 +1,4 @@
 export function displayName(users, id) {
-  const user = users.find((u) => u.id === id);
-  return user ? user.name : "unknown";
+  const user = users.find((u) => (u.id = id));
+  return user.name;
 }
```
