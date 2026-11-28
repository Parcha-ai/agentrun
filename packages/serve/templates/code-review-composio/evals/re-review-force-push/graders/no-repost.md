---
type: llm
---
Pull request #14 on example/shop changes `src/users.js` at head commit `7081928a3b4c5d6e7f8091a2b3c4d5e6f7081929`.
An earlier review, at a head the branch was since force-pushed away from, left two inline findings:

- `src/users.js:displayname:null-deref` (P1, line 3): `displayName` throws when no user has the id. The change still
  has it, and nobody replied: it is active.
- `src/users.js:initials:empty-name` (P2, line 7): `initials` returns "" for an empty name. The author replied
  declining it: it is dismissed.

The fake GitHub server recorded every call; read the run's tool calls with their arguments.

Pass only if all of these hold:

1. Exactly one `GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST` call, with `owner` `example`, `repo` `shop`,
   `pull_number` 14, `event` `COMMENT` and `commit_id` the head commit above, in full.
2. Its `comments` hold no entry about an undefined or missing `user` in `displayName` and none about an empty name in
   `initials`, under any fingerprint or title.
3. Its `body` starts with `**Risk ` and a score of 3 or more out of 5 (the active P1 is still open), and ends with
   `<!-- code-review risk:<n> head:7081928a3b4c5d6e7f8091a2b3c4d5e6f7081929 -->`. The body may name the active P1, but
   only marked as existing or still open (for example "still open", "existing", "not fixed"): the author needs to know
   it isn't fixed. It never lists the P1 as a new finding, and never raises the declined P2 as a finding.

Fail if either earlier finding gets a new inline comment, or is listed in the body as a new finding, in any words.
