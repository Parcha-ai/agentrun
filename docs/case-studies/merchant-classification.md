# Case study: expensive learns, cheap runs

Give a strong, expensive agent a repetitive job and the feedback a reviewer would give it. It learns the job, writes
down the path it keeps taking as a workflow, and hands that workflow to a cheap model. It gets called back only for the
hard cases. On merchant classification that took the cost from **$0.89 to $0.124 a merchant: 7x cheaper.**

<p align="center">
  <img alt="Cost per merchant every 100 runs: $0.210 for runs 1 to 100, then between $0.131 and $0.165 for every block after, against $0.89 for Opus by hand" src="../assets/case-studies/chart-merchant-codes.png" width="100%">
</p>

## The job

Every new merchant a payments company signs needs a Merchant Category Code (MCC): the 4-digit code card networks use to
say what a business sells (5812 restaurants, 5691 clothing stores, 7011 hotels). Someone reads the merchant's website,
searches a bit, and picks one code out of several hundred. Thousands of times, a judgment call each time.

The agent gets a merchant's **name and website** and answers with the **exact 4-digit code**, plus the URL and the quote
that decided it. It has web search, a page fetcher, a real browser, a document reader and the MCC tables. No
description, no category hint, nobody else's answer.

## The result

On 198 held-out merchants, with everything billed (Opus, the cheap model, the hand-backs and the learning):

| | Cost a merchant | Exact 4-digit code | Strict Opus re-check (117 of them) |
| --- | --- | --- | --- |
| Opus by hand | $0.89 | 173 of 198 | 109 of 117 (93%) |
| **Learned workflow** (cheap model, Opus on hand-backs) | **$0.124** | 167 of 198 | **112 of 117 (96%)** |

The workflow finished 179 of the 198 merchants on its own. It handed 19 back to Opus, and Opus got all 19 right.

## How it works

1. **Start expensive.** One agent on Opus 5.5 with a short instruction file and one skill, "classify a merchant". It
   does every merchant from scratch.
2. **Give it a reviewer.** After each answer, the agent sees the reference code next to its own, with its tool calls.
   Right or wrong, same feedback.
3. **It writes down what it learns.** Notes (short rules for itself), skills (reusable how-tos) and, most important, a
   **workflow**: the path it keeps taking, as fixed steps that call the tools directly, with small judgment steps where
   a decision is needed.
4. **The workflow runs on a cheap model.** Its judgment steps run on gpt-6-luna, not Opus. AgentRun runs the workflow
   first on every new merchant.
5. **Hard cases go back to Opus.** When the workflow can't read the site, or can't back its code with a quote from a
   page it read, it hands the job to the full Opus agent.
6. **A new revision earns its place.** A rewritten workflow is checked against held-out merchants and promoted only
   after clean runs. The learning turns are billed and counted like everything else.

The workflow Opus wrote, in 10 steps:

1. Fetch the merchant's home page.
2. A cheap check: is the text readable, or does it need a real browser?
3. Fetch again, or open it in the browser.
4. Still no text: hand the job back to Opus.
5. A small step on the cheap model reads the site: is it live, and what does the business sell?
6. A small step on the cheap model, with the MCC tables, picks the 4-digit code.
7. A judge checks that the quote the code rests on is on a page the run actually read.
8. Not supported: hand the job back to Opus.
9. Score the risk fields.
10. Put the answer together.

## Where the money went

555 merchants in a row, learning on:

| Path | Merchants | Share | Cost a merchant |
| --- | --- | --- | --- |
| Workflow finished alone (cheap model) | 479 | 86% | **$0.085** |
| Workflow handed back to Opus | 54 | 10% | $0.63 |
| Opus by hand, before the workflow took over | 9 | 2% | $0.88 |
| The agent ran its own workflow draft | 13 | 2% | $0.27 |

The workflow took over at run 21. From there the cost per merchant sat between $0.13 and $0.17 for the rest of the
stream. Across all 555, 90% of the answers matched the reference code exactly.

## Learning makes the cheap model better too

We also ran the cheap model by itself, with learning off and on, on a sealed test set of 157 merchants that nothing was
ever tuned on:

| gpt-6-luna | Learning off | Learning on |
| --- | --- | --- |
| Exact 4-digit code | 75.2% | **81.4%** |
| Same MCC group | 85.7% | **91.1%** |

**6.2 points more accurate with learning on** (95% CI +1.8 to +10.8), after a stream of only 36 merchants, at about a
cent an answer.

## How we measured

- 950 merchants, each with a reference code from our production classifier: 555 to learn on, 40 to vet new
  workflow revisions, 198 held out to compare, 157 sealed for the final test.
- The sealed set is locked with salted hashes before any run and checked at the start of every run.
- The sealed runs read a recorded web: every arm reads the same internet, and pages that state a merchant's code are
  scrubbed, so nobody looks the answer up.
- Every cost is all-in: Opus, the cheap model, the hand-backs and the learning turns.

## Do it with your own job

Any repetitive judgment job works the same way: an agent on a strong model, `"learning": true`, a reviewer's verdict
after each run, and a cheap model for the workflow's steps.
[Teach an expensive agent, run a cheap one](../tutorials/learn-then-hand-off.md) shows how, step by step.
