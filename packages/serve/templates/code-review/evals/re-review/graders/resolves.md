---
type: llm
---
Pass only if the answer's `findings` does not contain the fingerprint `src/users.js:displayname:null-deref` (or any finding about a null `user` on that line), `resolve` contains `src/users.js:displayname:null-deref`, because the guard is back, and `risk_score` is 1 or 2. Fail if the finding is repeated, if it is not resolved, if the risk score is 3 or more, or if a new finding is invented (for example about `trim` on a non-string name with no evidence names can be non-strings).
