---
type: llm
---
The change puts back the guard for a missing `user` and adds `.trim()` to the name. Pass only if all of these hold:

1. `resolve` contains `src/users.js:displayname:null-deref`, and `findings` holds no finding about an undefined `user`.
2. `risk_score` is 1 or 2.
3. Every other finding is hedged as the code-review skill hedges a finding it can't fully show: priority P2, `confidence`
   0.6, and a `failure` that names the triggering input and carries the literal `Not shown: <fact>`. Nothing in this
   case shows what values a user's `name` can hold, so a finding that rests on a name that isn't a string passes only
   in that form.

Fail if the earlier finding is repeated or not resolved, if the risk score is 3 or more, or if any other finding is
firmer than that hedge: P0 or P1, `confidence` above 0.6, or no `Not shown:`.
