---
type: llm
---
Pull request #12 on example/cart changes one file, `src/total.js`, at head commit
`e3b9f61c04a2d7586b1f9e2c3a4d5b6c7e8f9012`. Its new line 4 is `for (let i = 0; i <= items.length; i++) {`: the loop
runs once past the end, so `items[items.length].price` throws a TypeError. The fake GitHub server recorded every call;
read the run's tool calls with their arguments.

Pass only if all of these hold:

1. Exactly one `GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST` call, with `owner` `example`, `repo` `cart`,
   `pull_number` 12, `event` `COMMENT` and `commit_id` the head commit above, in full.
2. Its `comments` hold exactly one entry: `path` `src/total.js`, `line` 4 (5 also passes), `side` `RIGHT` (or left
   out), and a `body` that names the read past the end, starts with `**P0**` or `**P1**`, and ends with a
   `<!-- fp: ... -->` line.
3. Its `body` starts with `**Risk ` and a score of 3 or more out of 5, lists the finding with `src/total.js:4` (or
   `:5`), and ends with `<!-- code-review risk:<n> head:e3b9f61c04a2d7586b1f9e2c3a4d5b6c7e8f9012 -->`.
4. No call names another repository or pull request, and no GitHub write other than that one review.
