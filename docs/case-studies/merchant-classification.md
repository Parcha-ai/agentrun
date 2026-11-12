# Opus learns the job. A cheap model runs it.

> **TL;DR**
> - **7x cheaper.** $0.89 a merchant down to $0.124.
> - **86% of merchants** done by the cheap workflow alone.
> - **96% right** on a strict Opus re-check. Opus by hand: 93%.

<p align="center">
  <img alt="Cost per merchant every 100 runs: $0.210 for runs 1 to 100, then between $0.131 and $0.165 for every block after, against $0.89 for Opus by hand" src="../assets/case-studies/chart-merchant-codes.png" width="100%">
</p>

## The job

Every merchant a payments company signs needs a 4-digit Merchant Category Code: 5812 for restaurants, 7011 for hotels,
and several hundred more. Someone reads the website and picks one. Thousands of times.

The agent gets a name and a website. It answers with the code, plus the URL and the quote that prove it.

## How it works

1. **Opus does the job,** with learning on.
2. **A reviewer tells it the right code** after every answer.
3. **It writes down the path it keeps taking** as a workflow.
4. **From run 21 on, a cheap model runs that workflow** (gpt-6-luna).
5. **Hard cases go back to Opus.** If the workflow can't read the site or can't back its answer with a quote, Opus
   takes over.

<details>
<summary>The 10-step workflow Opus wrote</summary>

1. Fetch the merchant's home page.
2. Check the text is readable, or whether it needs a real browser.
3. Fetch again, or open it in the browser.
4. Still nothing: hand it to Opus.
5. Cheap model reads the site: is it live, what does it sell?
6. Cheap model picks the code from the MCC tables.
7. A judge checks the quote is on a page the run actually read.
8. Not backed up: hand it to Opus.
9. Score the risk fields.
10. Put the answer together.

</details>

## The numbers

On 198 merchants it never learned on, all costs in:

| | Cost a merchant | Strict Opus re-check (117 of them) |
| --- | --- | --- |
| Opus by hand | $0.89 | 109 of 117 (93%) |
| **Learned workflow** | **$0.124** | **112 of 117 (96%)** |

Where the money went over 555 merchants:

| Who finished it | Share | Cost a merchant |
| --- | --- | --- |
| The cheap workflow, alone | 86% | **$0.085** |
| Handed back to Opus | 10% | $0.63 |
| Everything else (early runs, drafts) | 4% | $0.27 to $0.88 |

## Bonus: learning makes the cheap model smarter too

gpt-6-luna on its own, on a sealed set of 157 merchants nothing was tuned on:

- Learning off: **75.2%** exact codes.
- Learning on: **81.4%**. That's **+6.2 points** after only 36 merchants of learning, at about a cent an answer.

## How we scored it

- 950 merchants with reference codes from our production classifier.
- 555 to learn on, 40 to check new workflow versions, 198 held out, 157 sealed.
- The sealed set is locked with salted hashes before any run, and its runs read a recorded web with the answers
  scrubbed out.
- Every cost is all-in: Opus, the cheap model, the hand-backs and the learning.

## Do it with your own job

Anything you do over and over with different inputs works the same way.
[Teach an expensive agent, run a cheap one](../tutorials/learn-then-hand-off.md).
