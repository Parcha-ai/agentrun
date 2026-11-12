# Tune a template on your own code

This is how we got `code-review` to [catch 1.6x the real bugs Greptile did](../case-studies/code-review.md). Code
review is the example, but it works for any template.

## 1. Apply it

In the console, **Templates → Apply → code-review**. Pick the repo and tick the GitHub tools. It sets up its own PR
trigger and posts comment-only reviews. It needs a box (Docker, on by default) for its read-only shell.

## 2. Tell it about your repo

- `docs/CODEREVIEW.md`: what matters, what to never flag. Every reviewer reads it.
- `.agents/skills/code-review-knowledge/SKILL.md`: rules by path, like "anything under `billing/` must...".
- `"learning": true`: it keeps notes from every review.

That alone gets you most of the way.

## 3. Build a test set

Grab 30 to 70 merged PRs, with what your current reviewer said and any bug later traced back to each one. Put the
newest 20 or 30 aside and don't touch them until the end.

## 4. Grade blind

Have a strong model mark every finding real, nit or wrong without knowing who wrote it. Put every real bug anyone found
into one answer key, and credit every reviewer the same way, your old one included.

Watch four numbers: bugs caught, serious bugs caught, wrong findings, cost. A review that timed out counts as zero.

## 5. Change one thing at a time

Keep a change only if serious bugs caught holds up. What moved ours: the mix of reviewers, what the parent is allowed
to drop, effort per reviewer, and the `CODEREVIEW.md`.

## 6. Lock it in

Copy the template's folder, [`packages/serve/templates/code-review/`](../../packages/serve/templates/code-review/), into
your repo, keeping its name: a template's folder and the `name` in its `agent.md` have to match. Turn every PR that
taught you something into an eval case under its `evals/`, then run:

```sh
npx @parcha/agentrun template eval ./code-review
```

[Template packages](../../packages/serve/templates/README.md) has the format.
