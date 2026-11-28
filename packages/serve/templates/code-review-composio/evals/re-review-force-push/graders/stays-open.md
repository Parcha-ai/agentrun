---
type: llm
---
Pass only if the answer's `findings` holds neither `src/users.js:displayname:null-deref` nor
`src/users.js:initials:empty-name`, nor any other finding about an undefined `user` in `displayName` or an empty name
in `initials`; `resolve` holds neither, because the guard is still missing and a declined finding is not fixed; and
`risk_score` is 3, 4 or 5, because the active P1 is still open. Fail if either is raised again under any fingerprint,
if either is resolved, or if the risk score is 1 or 2.
