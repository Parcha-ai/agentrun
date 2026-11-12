# Tune a template on your own code

A template works out of the box. Tuned on your own history, it gets a lot better. This is the loop we ran to take the
`code-review` template to [1.6 times the real bugs our previous reviewer found, at about 18 cents a review](../case-studies/code-review.md).
Code review is the running example, but the same loop works for `kyb`, `inbound-lead` or any template you write.

You need an AgentRun server, a model key, and a few dozen past examples of the job with known outcomes.

## 1. Apply the template

Start a server with a box (`AGENTRUN_BOXES=docker` is the default); `code-review` runs read-only bash on a checkout of
each pull request, and apply tells you if there's no box to run it in.

In the console, **Templates → Apply → code-review**, pick the repo and tick the GitHub tools it asks for. It sets up its
own pull request trigger and posts comment-only reviews. Or from code:

```sh
curl -X POST "$AGENTRUN_BASE_URL/templates/code-review/apply" \
  -H "Authorization: Bearer $AGENTRUN_API_KEY" -H "Content-Type: application/json" \
  -d '{"parameters": {"repo": "your-org/your-repo"}}'
```

Any model works. We used particle-1 because it's cheap and, with a shell, plenty sharp.

## 2. Teach it your repo, no loop needed

Three files get you most of the way:

- **`docs/CODEREVIEW.md`** in your repo: what matters here and what never to flag. Every reviewer reads it from the PR's
  base, after the template's own rules.
- **`.agents/skills/code-review-knowledge/SKILL.md`**: invariants by path ("anything under `billing/` must...").
- **`"learning": true`** on the agent: it keeps notes from its own reviews, and the next review starts from them.

## 3. Build a graded set

Take 30 to 70 merged pull requests. For each, collect what your current reviewer said (a bot, a person) and any bug that
was later traced back to that PR.

Then **hold some out.** Put the newest 20 to 30 aside and don't look at them while you tune. They're your final score.
If you mine repo knowledge for step 2 from past PRs, mine it only from PRs older than the holdout.

## 4. Grade blind

Have a strong model label every finding as real, nit or wrong without knowing which reviewer wrote it. Pool every real
defect from every reviewer into one answer key, so a reviewer gets credit for a bug nobody else caught. Credit your old
reviewer the same way you credit the new one: wherever it described the same defect.

## 5. Measure four things

- **Recall:** the share of the answer key it caught.
- **Serious-bug recall:** the same, for P0 and P1 only. This is the one that matters most.
- **Wrong rate:** the share of findings the judge called wrong.
- **Cost per review.**

A review that failed or timed out counts as zero, not as missing. One slow runner once made a good version of ours look
15 points worse.

## 6. Change one thing at a time

Rerun after each change and keep it only if serious-bug recall holds on both sets and the wrong rate stays under your
bar. The knobs that moved our numbers:

- **The number and mix of reviewers.** Five quick ones for breadth plus three deep ones for serious bugs beat eight of
  either.
- **What the parent may drop.** Let it drop a finding only when the code contradicts it, never because it couldn't
  prove the bug reachable.
- **Effort and tool-call budgets per reviewer.**
- **Your `CODEREVIEW.md`.**

## 7. Lock it in

Every PR that taught you something becomes an eval case, `evals/<case>/` in your copy of the template. Then one command
catches a regression before it ships:

```sh
npx @parcha/agentrun template eval ./my-code-review
```

It runs each case as a real run on a throwaway server and grades it. [Template packages](../../packages/serve/templates/README.md)
has the case format.
