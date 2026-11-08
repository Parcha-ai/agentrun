# Review rules

The reviewer reads this file from the base branch before every review. Edit it like code. Learned notes are added to
the agent's learning and exported here.

## What to flag

- Defects: wrong results, crashes, broken caller contracts, unhandled errors, races, leaks, data loss.
- Security: untrusted input reaching a shell, query, path or prompt; secrets in code or logs; missing authorization.
- Tests that can't fail, or a behavior change with no test where the repo tests that area.

## What not to flag

- Formatting, lint and type errors: CI catches them.
- Naming, style and structure preferences, unless a rule below asks for them.
- Generated files, lockfiles, vendored code, snapshots.
- Anything you can't tie to a `path:line` and a concrete input.
- Speculative issues: "could be a problem if…" with no input in this code that gets there.
- Plainly intentional changes, and behavior a comment or lint-ignore marks as deliberate.
- Missing hardening or defense in depth where nothing untrusted reaches the code.
- Unchanged code, unless this change triggers or exposes the defect (then it's `pre-existing`, in the summary).
- Denial of service by resource exhaustion or rate limiting, unless a rule below asks for it.

## Limits

- Nits: at most 5 on a full review, 2 on a push.
- Pre-existing findings: at most 3.
- Documentation findings: at most 1 per review, and only when the docs now describe behavior wrongly enough to mislead a
  caller. Wording, typos and missing docs are not findings.
- Never block a merge. Findings are advice.

## Repo rules

<!-- One rule per line. Start a line with a glob and a colon to scope it, e.g.
packages/serve/src/**: every route checks the caller's key. -->

## Commands

- `@<bot> review` or `/review`: a full re-review of the PR.
- `@<bot> <question>` or `/ask <question>`: an answer in the thread, not a review.
- Only people with write access to the repo can trigger the bot (checked with the code host, not inferred from the comment), and bots never can.
