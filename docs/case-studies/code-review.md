# Case study: code review for 18 cents

We wanted a code reviewer that finds more real bugs than the one we were paying for, and costs almost nothing to run.
So we took AgentRun's `code-review` template, pointed it at particle-1, a small model that costs 5 cents per million
input tokens on OpenRouter, and tuned it on this repository's own pull requests until it got there.

<p align="center">
  <img alt="On 30 pull requests it never trained on: AgentRun code review caught 42% of the real defects to Greptile's 26%, and 5 of the 8 serious bugs to Greptile's 1" src="../assets/case-studies/chart-code-review.png" width="100%">
</p>

## The result

| | AgentRun `code-review` | Greptile |
| --- | --- | --- |
| Real defects caught, 30 PRs it never trained on | **42%** (33 of 78) | 26% (20 of 78) |
| Serious bugs caught (P0/P1) | **5 of 8** | 1 of 8 |
| Cost per review | **about $0.18** | per seat |

About 18 cents buys one parent agent and eight reviewers on every pull request, and one comment-only review on GitHub.
It never approves and never requests changes. It tells you what's broken and where.

## What ships

One parent agent and eight reviewers, each in a fresh context:

- **Five quick reviewers** for breadth: each reads the whole change and flags what looks wrong.
- **Three deep reviewers** for the serious stuff: they trace state, ordering and untrusted input through the code.
- **The parent** merges what they find, drops duplicates, checks each finding against the code, and posts one review.

Every reviewer works on a read-only checkout of the PR with read-only bash. No network, no keys, no writes. They read
the code instead of guessing about it.

The template is one folder in [`packages/serve/templates/code-review/`](../../packages/serve/templates/code-review/):
the agent's instructions, its review skill, its rules, the findings schema and its eval cases. Plain files you can read,
change and version.

## How we got there

**1. Give the cheap model a shell.** Reading the diff alone, particle-1 was wrong 70% of the time. With read-only bash on
a checkout of the PR it was wrong 7% of the time. A cheap model is plenty smart once it can look at the code. That
became two platform features every template can use: `checkout: pull_request` and a `read-only` bash policy.

**2. Build a graded set from our own history.** 70 merged AgentRun pull requests, each with the review Greptile posted on
it, for tuning. And 30 newer ones we never looked at while tuning, for the final score.

**3. Grade blind.** An Opus 5.5 judge labels every finding from every reviewer as real, nit or wrong, without knowing
who wrote it. Every real defect anyone found goes into one answer key, so a reviewer gets credit for bugs nobody else
caught.

**4. Change one thing at a time.** A change stayed only if serious-bug recall held on both sets and the wrong rate stayed
under the bar. Four things moved the numbers:

- **Variety beats copies.** Five quick reviewers plus three deep ones beat eight copies of either.
- **Don't let the parent talk reviewers out of real bugs.** Our first parent dropped any finding it couldn't prove
  reachable, and it threw away real bugs doing it. The shipped parent drops a finding only when a line of code it
  printed contradicts it. Serious bugs caught on the tuning set went from 16 to 23 of 38.
- **Cutting noise can cost recall.** A version that cut wrong findings in half also lost serious bugs. Serious bugs win.
- **Count the reviews that never posted.** A runner timeout once killed 4 slow reviews, and that version looked 15
  points worse than it was. A review that didn't post counts as zero, so fix the timeout, not the reviewer.

**5. Ship the winner.** That's the version in the template today.

## How we measured

- The 30 PRs are the newest merged AgentRun pull requests, newer than anything the template's repo knowledge was
  built from, each with the review Greptile posted on the same commit.
- Opus 5.5 labels every finding blind; a Sonnet 5.5 matcher maps findings onto the answer key of 78 real
  defects, 8 of them serious. Ours count only where the judge called the finding real; Greptile gets credit wherever it
  described the same defect.
- The reviewers saw a checkout of the PR's head and base history and nothing else: no network, no Greptile comments,
  no answer key.
- The cost is what OpenRouter billed at particle-1's price for the parent and all eight reviewers, averaged over 70
  reviews.

It posts more findings than Greptile does, on purpose: we'd rather show you a finding the parent checked against the
code than bury a real P1.

## Run it on your repo

1. Start a server with a box (`AGENTRUN_BOXES=docker`, the default). The read-only shell runs there.
2. In the console, **Templates → Apply → code-review**, pick the repo and tick the GitHub tools it asks for. It sets up
   its own pull request trigger.
3. Add a `docs/CODEREVIEW.md` to your repo: what matters, what never to flag. Every reviewer reads it.
4. Turn on `"learning": true`, and the agent keeps notes from its own reviews.

Then make it yours: [Tune a template on your own code](../tutorials/tune-a-template.md) is the loop we ran, step by step.
