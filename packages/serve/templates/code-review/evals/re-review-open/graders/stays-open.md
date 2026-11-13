---
type: llm
---
Pass only if the answer's `findings` does not contain the fingerprint `src/users.js:displayname:null-deref` (or any other finding about an undefined `user` in `displayName`), `resolve` does not contain it, because the guard is still missing, and `risk_score` is 3, 4 or 5, because that P1 is still open. Fail if the finding is posted again under any fingerprint, if it is resolved, or if the risk score is 1 or 2. A finding about `initials` is allowed only if it names a concrete input that breaks it.
