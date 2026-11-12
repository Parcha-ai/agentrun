# Tune a template on your own code

> **The loop:** build a graded set, hold some out, grade blind, change one thing at a time, lock it in with evals.
> It's how we got `code-review` to
> [1.6x the real bugs Greptile caught, for 18 cents a review](../case-studies/code-review.md).

Code review is the example here. The same loop works for `kyb`, `inbound-lead` or any template you write.

## 1. Apply it

In the console: **Templates → Apply → code-review**. Pick the repo, tick the GitHub tools. It sets up its own PR
trigger and posts comment-only reviews. It needs a box (Docker, on by default) for its read-only shell.

Or from code:

```sh
curl -X POST "$AGENTRUN_BASE_URL/templates/code-review/apply" \
  -H "Authorization: Bearer $AGENTRUN_API_KEY" -H "Content-Type: application/json" \
  -d '{"parameters": {"repo": "your-org/your-repo"}}'
```

Any model works. We used particle-1: cheap, and sharp once it has a shell.

## 2. Teach it your repo

Three files, no loop needed:

- `docs/CODEREVIEW.md`: what matters here, what never to flag. Every reviewer reads it.
- `.agents/skills/code-review-knowledge/SKILL.md`: rules by path ("anything under `billing/` must...").
- `"learning": true` on the agent: it keeps notes from every review.

## 3. Build a graded set

- Take 30 to 70 merged PRs.
- For each: what your current reviewer said, plus any bug later traced back to it.
- **Hold out the newest 20 to 30.** Don't look at them while tuning. They're your final score.

## 4. Grade blind

- A strong model labels every finding real, nit or wrong, without knowing who wrote it.
- Pool every real bug from every reviewer into one answer key.
- Credit your old reviewer the same way: wherever it found the same bug.

## 5. Track four numbers

- Recall: how much of the answer key it caught.
- Serious-bug recall: same, for P0 and P1. The one that matters most.
- Wrong rate: how many findings were wrong.
- Cost per review.

A review that timed out counts as zero. One slow runner made a good version of ours look 15 points worse.

## 6. Change one thing at a time

Keep a change only if serious-bug recall holds and the wrong rate stays under your bar. What moved ours:

- The mix of reviewers. 5 quick plus 3 deep beat 8 of either.
- What the parent may drop. Only what the code contradicts.
- Effort and tool-call budgets per reviewer.
- Your `CODEREVIEW.md`.

## 7. Lock it in

Every PR that taught you something becomes an eval case in `evals/<case>/`. Then one command catches a regression:

```sh
npx @parcha/agentrun template eval ./my-code-review
```

[Template packages](../../packages/serve/templates/README.md) has the case format.
