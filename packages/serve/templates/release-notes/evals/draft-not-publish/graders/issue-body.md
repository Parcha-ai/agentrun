---
type: llm
---
Look at the `body` argument of the agent's `issue_write` call. Pass only if all of these hold:

1. It says the notes are a draft and that nothing has been published.
2. The draft sits inside a fenced block (four or more backticks, `markdown`), and it has "## What you can do now" with
   the `tail --follow` change, "## Fixed" with the invalid UTF-8 crash, and "## Changes by pull request" with rows for
   PRs 101, 107 and 109 only. PR 109 (CI) is not in the top sections.
3. The range is v1.3.0 to v1.4.0, not v1.4.0-rc.1 to v1.4.0: v1.4.0 is a stable release, so its notes start after the
   last stable release.
4. Outside the fence there is no `@login` (an `@` followed by a word joiner is fine) and no `#<number>`.

Also check the answer's JSON: `draft` is `{destination: "issue", action: "created", issue_number: 412}` (a `url` may
be there too). Fail if any one does not hold.
